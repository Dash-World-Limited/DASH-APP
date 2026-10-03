/**
 * Vendor portal routes.
 *
 * Every handler here loads the record, then calls `requireScope` before doing
 * anything with it. Holding `vendor:order:accept` means you may accept vendor
 * orders — it does not mean you may accept *this* one.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pickupCodeMatches } from '../orders/pickup-code.js';
import { assertTransition, type OrderStatus } from '@dash/domain/orders';
import { writeAudit } from '@dash/db';
import { ApiError } from '../http/errors.js';
import { readMaskedPayoutDetails, setPayoutDetails } from '../vendor/payout.js';
import { enqueueViaOutbox, flushOutbox } from '../events/outbox.js';
import { recordOrderChange } from '../realtime/notify.js';
import {
  actorOf,
  requirePermission,
  requireScope,
  transitionActorFor,
} from '../http/context.js';

export async function registerVendorRoutes(app: FastifyInstance): Promise<void> {
  const { prisma, queue, config } = app.services;

  /** Load an order and prove it belongs to the acting vendor. */
  async function loadScopedOrder(request: Parameters<typeof actorOf>[0], orderId: string) {
    const actor = actorOf(request);
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        code: true,
        status: true,
        vendorId: true,
        branchId: true,
        pickupCodeHash: true,
        estimatedReadyAt: true,
      },
    });
    if (!order) throw ApiError.notFound();
    requireScope(actor, { vendorId: order.vendorId, branchId: order.branchId });
    return { actor, order };
  }

  /**
   * Resolve the vendor behind this session once, from the server-built actor.
   *
   * No vendor id is accepted from a query string or request body. That keeps
   * the dashboard useful to owners who can see every branch and safe for staff
   * accounts that are limited to one branch.
   */
  function vendorActor(request: Parameters<typeof actorOf>[0]) {
    const actor = actorOf(request);
    if (!actor.vendorId) throw ApiError.forbidden('This account is not linked to a vendor.');
    return actor as typeof actor & { vendorId: string };
  }

  // -------------------------------------------------------------------------
  // GET /v1/vendor/dashboard — identity, branches, catalogue and reviews
  // -------------------------------------------------------------------------
  app.get(
    '/v1/vendor/dashboard',
    { preHandler: requirePermission('vendor:catalog:read') },
    async (request) => {
      const actor = vendorActor(request);
      const vendor = await prisma.vendor.findUnique({
        where: { id: actor.vendorId },
        select: {
          id: true,
          name: true,
          slug: true,
          description: true,
          category: true,
          status: true,
          logoKey: true,
          coverKey: true,
          ratingAverage: true,
          ratingCount: true,
          autoAcceptSeconds: true,
          branches: {
            where: {
              isActive: true,
              ...(actor.branchId ? { id: actor.branchId } : {}),
            },
            orderBy: { createdAt: 'asc' },
            select: {
              id: true,
              name: true,
              address: true,
              phone: true,
              state: true,
              busyExtraMinutes: true,
              minimumOrder: true,
              defaultPrepMinutes: true,
              supportsDelivery: true,
              supportsPickup: true,
              supportsVendorDelivery: true,
            },
          },
          categories: {
            where: { isActive: true },
            orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
            select: {
              id: true,
              name: true,
              description: true,
              sortOrder: true,
              items: {
                where: { archivedAt: null },
                orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
                select: {
                  id: true,
                  name: true,
                  description: true,
                  imageKey: true,
                  price: true,
                  prepMinutes: true,
                  isAvailable: true,
                  requiresAgeCheck: true,
                  updatedAt: true,
                  modifierGroups: {
                    orderBy: { sortOrder: 'asc' },
                    select: {
                      id: true,
                      name: true,
                      minSelect: true,
                      maxSelect: true,
                      sortOrder: true,
                      options: {
                        orderBy: { sortOrder: 'asc' },
                        select: {
                          id: true,
                          name: true,
                          priceDelta: true,
                          isAvailable: true,
                          sortOrder: true,
                        },
                      },
                    },
                  },
                  stock: {
                    where: actor.branchId
                      ? { branchId: actor.branchId }
                      : { branch: { isActive: true } },
                    select: {
                      branchId: true,
                      quantity: true,
                      isAvailable: true,
                      updatedAt: true,
                    },
                  },
                },
              },
            },
          },
          reviews: {
            where: { status: 'published' },
            orderBy: { createdAt: 'desc' },
            take: 20,
            select: {
              id: true,
              rating: true,
              comment: true,
              vendorResponse: true,
              respondedAt: true,
              createdAt: true,
              order: { select: { code: true } },
              customer: { select: { identity: { select: { displayName: true } } } },
            },
          },
        },
      });

      if (!vendor) throw ApiError.notFound();

      return {
        vendor: {
          ...vendor,
          reviews: vendor.reviews.map((review) => ({
            id: review.id,
            rating: review.rating,
            comment: review.comment,
            vendorResponse: review.vendorResponse,
            respondedAt: review.respondedAt,
            createdAt: review.createdAt,
            orderCode: review.order.code,
            customerName:
              review.customer.identity.displayName?.split(' ')[0] ?? 'DASH customer',
          })),
        },
      };
    },
  );

  // -------------------------------------------------------------------------
  // POST /v1/vendor/categories — create a catalogue section
  // -------------------------------------------------------------------------
  app.post(
    '/v1/vendor/categories',
    { preHandler: requirePermission('vendor:catalog:write') },
    async (request) => {
      const actor = vendorActor(request);
      const body = z
        .object({
          name: z.string().trim().min(2).max(80),
          description: z.string().trim().max(240).nullable().optional(),
        })
        .parse(request.body);

      const last = await prisma.menuCategory.findFirst({
        where: { vendorId: actor.vendorId },
        orderBy: { sortOrder: 'desc' },
        select: { sortOrder: true },
      });
      const category = await prisma.menuCategory.create({
        data: {
          vendorId: actor.vendorId,
          name: body.name,
          description: body.description ?? null,
          sortOrder: (last?.sortOrder ?? -1) + 1,
        },
        select: { id: true, name: true, description: true, sortOrder: true },
      });

      return { category };
    },
  );

  // -------------------------------------------------------------------------
  // POST /v1/vendor/items — add a product to the vendor's own catalogue
  // -------------------------------------------------------------------------
  app.post(
    '/v1/vendor/items',
    { preHandler: requirePermission('vendor:catalog:write') },
    async (request) => {
      const actor = vendorActor(request);
      const body = z
        .object({
          categoryId: z.string().trim().min(1),
          name: z.string().trim().min(2).max(120),
          description: z.string().trim().max(1_000).nullable().optional(),
          price: z.number().int().min(0).max(100_000_000),
          prepMinutes: z.number().int().min(0).max(360).default(15),
          quantity: z.number().int().min(0).max(100_000).nullable().optional(),
          requiresAgeCheck: z.boolean().default(false),
        })
        .parse(request.body);

      const category = await prisma.menuCategory.findUnique({
        where: { id: body.categoryId },
        select: { id: true, vendorId: true },
      });
      if (!category) throw ApiError.notFound();
      requireScope(actor, { vendorId: category.vendorId });

      const branches = await prisma.branch.findMany({
        where: {
          vendorId: actor.vendorId,
          isActive: true,
          ...(actor.branchId ? { id: actor.branchId } : {}),
        },
        select: { id: true },
      });

      const item = await prisma.menuItem.create({
        data: {
          vendorId: actor.vendorId,
          categoryId: category.id,
          name: body.name,
          description: body.description ?? null,
          price: body.price,
          prepMinutes: body.prepMinutes,
          requiresAgeCheck: body.requiresAgeCheck,
          isAvailable: body.quantity !== 0,
          stock:
            branches.length > 0
              ? {
                  create: branches.map((branch) => ({
                    branchId: branch.id,
                    quantity: body.quantity ?? null,
                    isAvailable: body.quantity !== 0,
                  })),
                }
              : undefined,
        },
        select: {
          id: true,
          categoryId: true,
          name: true,
          description: true,
          price: true,
          prepMinutes: true,
          isAvailable: true,
          requiresAgeCheck: true,
        },
      });

      await writeAudit(prisma, {
        identityId: actor.identityId,
        action: 'vendor.catalog.item_created',
        resourceType: 'menu_item',
        resourceId: item.id,
        after: { categoryId: item.categoryId, name: item.name, price: item.price },
        requestId: request.id,
      });

      return { item };
    },
  );

  // -------------------------------------------------------------------------
  // PATCH /v1/vendor/items/:id — edit a product without crossing vendors
  // -------------------------------------------------------------------------
  app.patch<{ Params: { id: string } }>(
    '/v1/vendor/items/:id',
    { preHandler: requirePermission('vendor:catalog:write') },
    async (request) => {
      const actor = vendorActor(request);
      const body = z
        .object({
          categoryId: z.string().trim().min(1).optional(),
          name: z.string().trim().min(2).max(120).optional(),
          description: z.string().trim().max(1_000).nullable().optional(),
          price: z.number().int().min(0).max(100_000_000).optional(),
          prepMinutes: z.number().int().min(0).max(360).optional(),
          requiresAgeCheck: z.boolean().optional(),
        })
        .refine((value) => Object.keys(value).length > 0, 'At least one change is required.')
        .parse(request.body);

      const current = await prisma.menuItem.findUnique({
        where: { id: request.params.id },
        select: { id: true, vendorId: true },
      });
      if (!current) throw ApiError.notFound();
      requireScope(actor, { vendorId: current.vendorId });

      if (body.categoryId) {
        const category = await prisma.menuCategory.findUnique({
          where: { id: body.categoryId },
          select: { vendorId: true },
        });
        if (!category) throw ApiError.notFound();
        requireScope(actor, { vendorId: category.vendorId });
      }

      const item = await prisma.menuItem.update({
        where: { id: current.id },
        data: body,
        select: {
          id: true,
          categoryId: true,
          name: true,
          description: true,
          price: true,
          prepMinutes: true,
          isAvailable: true,
          requiresAgeCheck: true,
        },
      });

      await writeAudit(prisma, {
        identityId: actor.identityId,
        action: 'vendor.catalog.item_changed',
        resourceType: 'menu_item',
        resourceId: item.id,
        after: body,
        requestId: request.id,
      });

      return { item };
    },
  );

  // -------------------------------------------------------------------------
  // PUT /v1/vendor/items/:id/modifiers — replace this product's choice groups
  //
  // Full replacement keeps the dashboard contract simple while preserving the
  // ids of groups/options the vendor is editing. Existing carts with a removed
  // option are deliberately rejected at quote time instead of silently
  // substituting another choice.
  // -------------------------------------------------------------------------
  app.put<{ Params: { id: string } }>(
    '/v1/vendor/items/:id/modifiers',
    { preHandler: requirePermission('vendor:catalog:write') },
    async (request) => {
      const actor = vendorActor(request);
      const optionSchema = z.object({
        id: z.string().trim().min(1).optional(),
        name: z.string().trim().min(1).max(80),
        priceDelta: z.number().int().min(-100_000_000).max(100_000_000).default(0),
        isAvailable: z.boolean().default(true),
      });
      const groupSchema = z
        .object({
          id: z.string().trim().min(1).optional(),
          name: z.string().trim().min(1).max(80),
          minSelect: z.number().int().min(0).max(20).default(0),
          maxSelect: z.number().int().min(1).max(20).default(1),
          options: z.array(optionSchema).min(1).max(30),
        })
        .superRefine((group, context) => {
          if (group.minSelect > group.maxSelect) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['minSelect'],
              message: 'Minimum selections cannot exceed maximum selections.',
            });
          }
          if (group.maxSelect > group.options.length) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['maxSelect'],
              message: 'Maximum selections cannot exceed the number of options.',
            });
          }
          const available = group.options.filter((option) => option.isAvailable).length;
          if (group.minSelect > available) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['minSelect'],
              message: 'Required selections cannot exceed the available options.',
            });
          }
        });
      const body = z.object({ groups: z.array(groupSchema).max(12) }).parse(request.body);

      const item = await prisma.menuItem.findUnique({
        where: { id: request.params.id },
        select: {
          id: true,
          vendorId: true,
          modifierGroups: {
            select: {
              id: true,
              options: { select: { id: true } },
            },
          },
        },
      });
      if (!item) throw ApiError.notFound();
      requireScope(actor, { vendorId: item.vendorId });

      const currentGroups = new Map(item.modifierGroups.map((group) => [group.id, group]));
      const submittedGroupIds = body.groups.flatMap((group) => (group.id ? [group.id] : []));

      if (new Set(submittedGroupIds).size !== submittedGroupIds.length) {
        throw ApiError.badRequest('The same option group was submitted more than once.');
      }

      for (const group of body.groups) {
        if (!group.id) continue;
        const current = currentGroups.get(group.id);
        if (!current) throw ApiError.notFound();

        const currentOptionIds = new Set(current.options.map((option) => option.id));
        const submittedOptionIds = group.options.flatMap((option) => (option.id ? [option.id] : []));
        if (new Set(submittedOptionIds).size !== submittedOptionIds.length) {
          throw ApiError.badRequest('The same option was submitted more than once.');
        }
        if (submittedOptionIds.some((id) => !currentOptionIds.has(id))) throw ApiError.notFound();
      }

      await prisma.$transaction(async (tx) => {
        await tx.modifierGroup.deleteMany({
          where: {
            itemId: item.id,
            ...(submittedGroupIds.length > 0 ? { id: { notIn: submittedGroupIds } } : {}),
          },
        });

        for (const [groupIndex, group] of body.groups.entries()) {
          if (!group.id) {
            await tx.modifierGroup.create({
              data: {
                itemId: item.id,
                name: group.name,
                minSelect: group.minSelect,
                maxSelect: group.maxSelect,
                sortOrder: groupIndex,
                options: {
                  create: group.options.map((option, optionIndex) => ({
                    name: option.name,
                    priceDelta: option.priceDelta,
                    isAvailable: option.isAvailable,
                    sortOrder: optionIndex,
                  })),
                },
              },
            });
            continue;
          }

          await tx.modifierGroup.update({
            where: { id: group.id },
            data: {
              name: group.name,
              minSelect: group.minSelect,
              maxSelect: group.maxSelect,
              sortOrder: groupIndex,
            },
          });

          const submittedOptionIds = group.options.flatMap((option) => (option.id ? [option.id] : []));
          await tx.modifier.deleteMany({
            where: {
              groupId: group.id,
              ...(submittedOptionIds.length > 0 ? { id: { notIn: submittedOptionIds } } : {}),
            },
          });

          for (const [optionIndex, option] of group.options.entries()) {
            if (option.id) {
              await tx.modifier.update({
                where: { id: option.id },
                data: {
                  name: option.name,
                  priceDelta: option.priceDelta,
                  isAvailable: option.isAvailable,
                  sortOrder: optionIndex,
                },
              });
            } else {
              await tx.modifier.create({
                data: {
                  groupId: group.id,
                  name: option.name,
                  priceDelta: option.priceDelta,
                  isAvailable: option.isAvailable,
                  sortOrder: optionIndex,
                },
              });
            }
          }
        }
      });

      const groups = await prisma.modifierGroup.findMany({
        where: { itemId: item.id },
        orderBy: { sortOrder: 'asc' },
        select: {
          id: true,
          name: true,
          minSelect: true,
          maxSelect: true,
          sortOrder: true,
          options: {
            orderBy: { sortOrder: 'asc' },
            select: {
              id: true,
              name: true,
              priceDelta: true,
              isAvailable: true,
              sortOrder: true,
            },
          },
        },
      });

      await writeAudit(prisma, {
        identityId: actor.identityId,
        action: 'vendor.catalog.modifiers_changed',
        resourceType: 'menu_item',
        resourceId: item.id,
        after: {
          groups: groups.map((group) => ({
            id: group.id,
            name: group.name,
            minSelect: group.minSelect,
            maxSelect: group.maxSelect,
            optionCount: group.options.length,
          })),
        },
        requestId: request.id,
      });

      return { groups };
    },
  );

  // -------------------------------------------------------------------------
  // POST /v1/vendor/reviews/:id/respond
  // -------------------------------------------------------------------------
  app.post<{ Params: { id: string } }>(
    '/v1/vendor/reviews/:id/respond',
    { preHandler: requirePermission('vendor:review:respond') },
    async (request) => {
      const actor = vendorActor(request);
      const body = z.object({ response: z.string().trim().min(2).max(500) }).parse(request.body);
      const review = await prisma.review.findUnique({
        where: { id: request.params.id },
        select: { id: true, vendorId: true },
      });
      if (!review || !review.vendorId) throw ApiError.notFound();
      requireScope(actor, { vendorId: review.vendorId });

      const updated = await prisma.review.update({
        where: { id: review.id },
        data: { vendorResponse: body.response, respondedAt: new Date() },
        select: { id: true, vendorResponse: true, respondedAt: true },
      });
      return { review: updated };
    },
  );

  // -------------------------------------------------------------------------
  // GET /v1/vendor/orders — the live queue
  // -------------------------------------------------------------------------
  app.get(
    '/v1/vendor/orders',
    { preHandler: requirePermission('vendor:order:read') },
    async (request) => {
      const actor = actorOf(request);
      if (!actor.vendorId) throw ApiError.forbidden('This account is not linked to a vendor.');

      const query = z
        .object({
          status: z.enum(['incoming', 'active', 'completed']).default('incoming'),
          limit: z.coerce.number().int().min(1).max(100).default(50),
        })
        .parse(request.query);

      const statusIn =
        query.status === 'incoming'
          ? ['placed', 'vendor_reviewing']
          : query.status === 'active'
            ? ['accepted', 'preparing', 'ready', 'rider_assigned', 'rider_arrived']
            : ['picked_up', 'en_route', 'arrived', 'delivered', 'cancelled', 'rejected'];

      const orders = await prisma.order.findMany({
        where: {
          // Scoped by the actor's own vendorId, never by a query parameter.
          vendorId: actor.vendorId,
          ...(actor.branchId ? { branchId: actor.branchId } : {}),
          status: { in: statusIn },
        },
        select: {
          id: true,
          code: true,
          status: true,
          mode: true,
          itemsSubtotal: true,
          total: true,
          createdAt: true,
          placedAt: true,
          estimatedReadyAt: true,
          // Whether the kitchen has said the food is ready — the only signal
          // once a rider has taken the order and the status is theirs.
          readyAt: true,
          instructions: true,
          items: {
            select: {
              nameSnapshot: true,
              priceSnapshot: true,
              quantity: true,
              lineTotal: true,
              modifiers: true,
              instructions: true,
            },
          },
          // The vendor sees the customer's first name only. They do not need the
          // phone number or the full address to cook the food; the rider does.
          customer: { select: { identity: { select: { displayName: true } } } },
          rider: { select: { identity: { select: { displayName: true } } } },
        },
        orderBy: { createdAt: query.status === 'completed' ? 'desc' : 'asc' },
        take: query.limit,
      });

      // The console's own section, read once rather than repeated on every
      // order: this board belongs to one vendor, so the vocabulary it should
      // speak is a property of the console, not of each row.
      const vendor = await prisma.vendor.findUnique({
        where: { id: actor.vendorId },
        select: { category: true },
      });

      return {
        vendor: { category: vendor?.category ?? null },
        orders: orders.map((order) => ({
          ...order,
          customer: { name: order.customer.identity.displayName?.split(' ')[0] ?? 'Customer' },
          rider: order.rider ? { name: order.rider.identity.displayName } : null,
          items: order.items.map((item) => ({
            ...item,
            modifiers: item.modifiers ? (JSON.parse(item.modifiers) as unknown) : [],
          })),
        })),
      };
    },
  );

  // -------------------------------------------------------------------------
  // POST /v1/vendor/orders/:id/accept
  // -------------------------------------------------------------------------
  app.post<{ Params: { id: string } }>(
    '/v1/vendor/orders/:id/accept',
    { preHandler: requirePermission('vendor:order:accept') },
    async (request) => {
      const body = z
        .object({ prepMinutes: z.number().int().min(1).max(180).default(20) })
        .parse(request.body ?? {});

      const { actor, order } = await loadScopedOrder(request, request.params.id);
      const actingAs = transitionActorFor(actor);
      assertTransition(order.status as OrderStatus, 'accepted', actingAs);

      const readyAt = new Date(Date.now() + body.prepMinutes * 60_000);

      // The accept and the intent to dispatch commit together or not at all.
      // This used to be a dual write — the update committed, then `enqueue` was
      // a separate network call — so a Redis outage in the gap left an accepted
      // order that no rider was ever sent to, with nothing recording that one
      // was supposed to be. See events/outbox.ts.
      await prisma.$transaction(async (tx) => {
        // Claim the acceptance, rather than assume it.
        //
        // This is the button most likely to be pressed twice — a counter
        // tablet on a slow connection, two staff working the same queue, a
        // retried request — and `assertTransition` judged a status read from
        // before this transaction opened. Both attempts could therefore find
        // the order `placed`, both judge `accepted` legal, and both write it.
        // The status converged, so nothing looked wrong; the record did not.
        // Two status events, two revision bumps, two realtime notifications,
        // and `acceptedAt` overwritten — the field a rider's billable waiting
        // time is measured from.
        //
        // Naming the expected prior status makes this a compare-and-set: the
        // first request to commit accepts the order, the second matches no row
        // and rolls back everything it was about to write. The same pattern
        // guards the `preparing` transition below and the rider's own
        // transitions in routes/rider.ts.
        const claimed = await tx.order.updateMany({
          where: { id: order.id, status: order.status },
          data: {
            status: 'accepted',
            acceptedAt: new Date(),
            estimatedReadyAt: readyAt,
          },
        });
        if (claimed.count === 0) {
          throw ApiError.conflict('That order has already been accepted.');
        }

        await tx.orderStatusEvent.create({
          data: {
            orderId: order.id,
            fromStatus: order.status,
            toStatus: 'accepted',
            actorType: actingAs,
            actorId: actor.identityId,
          },
        });

        // Accepting deliberately does NOT dispatch a rider.
        //
        // Accept and "start preparing" are two decisions, and only the second
        // one commits the kitchen. A vendor may accept a queue of orders and
        // begin them in whatever sequence suits the kitchen; dispatching on
        // accept would send riders for food nobody has started cooking, and
        // they would wait at the counter for an order that is fourth in line.
        //
        // The prep-time delay this replaces was worse in the other direction:
        // `(prepMinutes - 8)` minutes meant a 25-minute prep pushed the search
        // 17 minutes into the future, and it looked exactly like dispatch being
        // broken. Neither timer is the right answer — the vendor telling us
        // they have started is.
        //
        // See the `preparing` branch in the progress route below.

        // The customer's tracking screen is waiting on exactly this. Recorded
        // in the same transaction for the same reason the dispatch intent is:
        // a notification sent before the commit can describe a state the order
        // never reached, and one sent after can be lost in the gap with nothing
        // remembering it was owed.
        await recordOrderChange(tx, order.id);
      });

      // Publish now if the queue is reachable; the scheduled relay covers it
      // if not. Never raises — the row is already durable.
      await flushOutbox(prisma, queue);

      await writeAudit(prisma, {
        identityId: actor.identityId,
        action: actingAs === 'vendor' ? 'vendor.order.accepted' : 'ops.order.accepted',
        resourceType: 'order',
        resourceId: order.id,
        after: { prepMinutes: body.prepMinutes },
        requestId: request.id,
      });

      return { accepted: true, estimatedReadyAt: readyAt };
    },
  );

  // -------------------------------------------------------------------------
  // POST /v1/vendor/orders/:id/reject
  // -------------------------------------------------------------------------
  app.post<{ Params: { id: string } }>(
    '/v1/vendor/orders/:id/reject',
    { preHandler: requirePermission('vendor:order:reject') },
    async (request) => {
      const body = z
        .object({
          // A reason is mandatory. "Rejected" with no cause is unauditable and
          // makes vendor quality impossible to manage.
          reasonCode: z.enum([
            'out_of_stock',
            'too_busy',
            'closing_soon',
            'cannot_fulfil_instructions',
            'other',
          ]),
          note: z.string().trim().max(280).optional(),
        })
        .parse(request.body);

      const { actor, order } = await loadScopedOrder(request, request.params.id);
      const actingAs = transitionActorFor(actor);
      assertTransition(order.status as OrderStatus, 'rejected', actingAs);

      // The rejection and the refund it obliges commit together. A refund that
      // was owed and never queued is the worst of the dual-write failures here:
      // the customer is charged, the order is dead, and nothing in the system
      // remembers that money has to go back.
      await prisma.$transaction(async (tx) => {
        await tx.order.update({
          where: { id: order.id },
          data: {
            status: 'rejected',
            cancelledAt: new Date(),
            cancelledBy: actor.identityId,
            cancellationReason: body.note ?? body.reasonCode,
            statusEvents: {
              create: {
                fromStatus: order.status,
                toStatus: 'rejected',
                actorType: actingAs,
                actorId: actor.identityId,
                reasonCode: body.reasonCode,
                reason: body.note ?? null,
              },
            },
          },
        });

        // A rejected customer is never at fault, so the refund is queued
        // automatically rather than waiting for them to ask for it.
        await enqueueViaOutbox(tx, {
          name: 'refund.full',
          payload: { orderId: order.id, reason: 'vendor_rejected' },
          idempotencyKey: `refund_${order.id}`,
        });

        await recordOrderChange(tx, order.id);
      });

      // Publish now if the queue is reachable; the scheduled relay covers it
      // if not. Never raises — the row is already durable.
      await flushOutbox(prisma, queue);

      await writeAudit(prisma, {
        identityId: actor.identityId,
        action: actingAs === 'vendor' ? 'vendor.order.rejected' : 'ops.order.rejected',
        resourceType: 'order',
        resourceId: order.id,
        after: { reasonCode: body.reasonCode },
        requestId: request.id,
      });

      return { rejected: true, refundQueued: true };
    },
  );

  // -------------------------------------------------------------------------
  // POST /v1/vendor/orders/:id/progress — preparing → ready
  // -------------------------------------------------------------------------
  app.post<{ Params: { id: string } }>(
    '/v1/vendor/orders/:id/progress',
    { preHandler: requirePermission('vendor:order:progress') },
    async (request) => {
      const body = z.object({ to: z.enum(['preparing', 'ready']) }).parse(request.body);
      const { actor, order } = await loadScopedOrder(request, request.params.id);

      // Food ready after a rider has already accepted.
      //
      // Dispatch starts at `preparing`, so a rider usually accepts while the
      // kitchen is still cooking and the order moves on to `rider_assigned`.
      // The kitchen finishing is then a fact about the food, not a move in
      // the delivery: the status is the rider's, and `rider_assigned → ready`
      // is reserved for ops reassignment, which re-enters dispatch. Refusing
      // it — as this route did — made the vendor's Ready button fail for
      // most orders and lost the signal entirely. It is recorded as `readyAt`
      // (once) and announced, and the status is left where the rider put it.
      if (body.to === 'ready' && (order.status === 'rider_assigned' || order.status === 'rider_arrived')) {
        await prisma.$transaction(async (tx) => {
          await tx.order.updateMany({ where: { id: order.id, readyAt: null }, data: { readyAt: new Date() } });
          await recordOrderChange(tx, order.id);
        });
        await flushOutbox(prisma, queue);
        return { status: order.status, foodReady: true };
      }

      const actingAs = transitionActorFor(actor);
      assertTransition(order.status as OrderStatus, body.to, actingAs);

      // Wrapped in a transaction so the notification commits with the
      // transition. It was a bare update before there was anything to announce.
      await prisma.$transaction(async (tx) => {
        // Claim the transition, rather than assume it.
        //
        // `assertTransition` above judged a status read before this
        // transaction opened, so two near-simultaneous requests can both see
        // `accepted`, both judge `preparing` legal, and both arrive here. The
        // outbox does not stop them: `OutboxEvent.idempotencyKey` is
        // deliberately not unique, because the same key may legitimately be
        // enqueued again once an earlier job's dedupe window has passed. The
        // result was two `dispatch.find_rider` intents for one order — two
        // rounds of offers, and a rider sent for food another rider may
        // already be riding to collect.
        //
        // Naming the expected prior status in the `where` makes the update a
        // compare-and-set: whichever request commits first moves the order,
        // and the other matches no row, throws, and takes its outbox write
        // down with it. The winner is arbitrary, which is correct — they are
        // the same request — but exactly one of them happens.
        const claimed = await tx.order.updateMany({
          where: { id: order.id, status: order.status },
          data: {
            status: body.to,
            ...(body.to === 'ready' ? { readyAt: new Date() } : {}),
          },
        });
        if (claimed.count === 0) {
          throw ApiError.conflict(`A vendor cannot change an order that is ${body.to}.`);
        }

        await tx.orderStatusEvent.create({
          data: {
            orderId: order.id,
            fromStatus: order.status,
            toStatus: body.to,
            actorType: actingAs,
            actorId: actor.identityId,
          },
        });

        // `preparing` is the ONE trigger for normal rider dispatch.
        //
        // Not checkout, not accept, and not `ready`. Checkout is before the
        // vendor has agreed to make the order; accept is agreement without
        // commitment, and a vendor may accept several orders and start them in
        // whatever order suits the kitchen; `ready` is too late, because the
        // food is then sitting on the counter while a rider is still being
        // found. Starting to prepare is the moment the kitchen commits, which
        // makes it the moment a rider is worth spending — and dispatching here
        // lets the rider travel to the vendor while the food is being made.
        //
        // The only other paths that enqueue this job are exceptions, not normal
        // dispatch: an ops reassignment (routes/admin.ts, keyed on the audit
        // event) and the worker's own re-rounding when a round expires
        // (workers/dispatch.ts, keyed on the round number).
        //
        // The key is scoped to this transition. An order enters `preparing`
        // once — `assertTransition` refuses `preparing → preparing`, so a
        // double-tapped button is rejected by the state machine before it gets
        // here — and the key stops the queue running a redelivered publication
        // of this same event twice. Neither a retry nor a duplicate publish can
        // produce a second round of offers.
        if (body.to === 'preparing') {
          await enqueueViaOutbox(tx, {
            name: 'dispatch.find_rider',
            payload: { orderId: order.id },
            idempotencyKey: `dispatch_${order.id}_preparing`,
          });
        }

        await recordOrderChange(tx, order.id);
      });

      await flushOutbox(prisma, queue);

      return { status: body.to };
    },
  );

  // -------------------------------------------------------------------------
  // POST /v1/vendor/orders/:id/verify-pickup
  //
  // The rider reads a code from their app; the vendor types it in. This is what
  // stops food being handed to the wrong rider.
  // -------------------------------------------------------------------------
  app.post<{ Params: { id: string } }>(
    '/v1/vendor/orders/:id/verify-pickup',
    {
      preHandler: requirePermission('vendor:order:progress'),
      config: { rateLimit: { max: 10, timeWindow: '5 minutes' } },
    },
    async (request) => {
      const body = z.object({ code: z.string().trim().regex(/^\d{4}$/) }).parse(request.body);
      const { order } = await loadScopedOrder(request, request.params.id);

      // The code the assigned rider is shown (see orders/pickup-code.ts).
      if (!pickupCodeMatches(order.id, body.code, config.JWT_ACCESS_SECRET)) {
        throw ApiError.badRequest('That pickup code is not correct.');
      }

      return { verified: true };
    },
  );

  // -------------------------------------------------------------------------
  // PATCH /v1/vendor/branch/:id/state — open / busy / closed
  // -------------------------------------------------------------------------
  app.patch<{ Params: { id: string } }>(
    '/v1/vendor/branch/:id/state',
    { preHandler: requirePermission('vendor:hours:write') },
    async (request) => {
      const body = z
        .object({
          state: z.enum(['open', 'busy', 'closed']),
          busyExtraMinutes: z.number().int().min(0).max(60).default(0),
        })
        .parse(request.body);

      const actor = actorOf(request);
      const branch = await prisma.branch.findUnique({
        where: { id: request.params.id },
        select: { id: true, vendorId: true, state: true },
      });
      if (!branch) throw ApiError.notFound();
      requireScope(actor, { vendorId: branch.vendorId });

      await prisma.branch.update({
        where: { id: branch.id },
        data: {
          state: body.state,
          busyExtraMinutes: body.state === 'busy' ? body.busyExtraMinutes : 0,
        },
      });

      await writeAudit(prisma, {
        identityId: actor.identityId,
        action: 'vendor.branch.state_changed',
        resourceType: 'branch',
        resourceId: branch.id,
        before: { state: branch.state },
        after: { state: body.state },
        requestId: request.id,
      });

      return { state: body.state };
    },
  );

  // -------------------------------------------------------------------------
  // PATCH /v1/vendor/items/:id/availability
  // -------------------------------------------------------------------------
  app.patch<{ Params: { id: string } }>(
    '/v1/vendor/items/:id/availability',
    { preHandler: requirePermission('vendor:inventory:write') },
    async (request) => {
      const body = z
        .object({
          isAvailable: z.boolean(),
          quantity: z.number().int().min(0).max(100_000).nullable().optional(),
        })
        .parse(request.body);

      const actor = actorOf(request);
      const item = await prisma.menuItem.findUnique({
        where: { id: request.params.id },
        select: { id: true, vendorId: true, name: true },
      });
      if (!item) throw ApiError.notFound();
      requireScope(actor, { vendorId: item.vendorId });

      await prisma.menuItem.update({
        where: { id: item.id },
        data: { isAvailable: body.isAvailable },
      });

      if (body.quantity !== undefined && actor.branchId) {
        await prisma.itemStock.updateMany({
          where: { itemId: item.id, branchId: actor.branchId },
          data: { quantity: body.quantity, isAvailable: body.isAvailable },
        });
      }

      return { id: item.id, isAvailable: body.isAvailable };
    },
  );

  // -------------------------------------------------------------------------
  // GET /v1/vendor/payout-details — masked, never the account number
  // -------------------------------------------------------------------------
  app.get(
    '/v1/vendor/payout-details',
    { preHandler: requirePermission('vendor:settlement:read') },
    async (request) => {
      const actor = actorOf(request);
      if (!actor.vendorId) throw ApiError.forbidden('This account is not linked to a vendor.');

      return { payoutDetails: await readMaskedPayoutDetails(prisma, actor.vendorId) };
    },
  );

  // -------------------------------------------------------------------------
  // PUT /v1/vendor/payout-details
  //
  // Write-only. There is no route that reads the account number back, because
  // nothing needs to: settlement will decrypt it server-side and hand it to the
  // provider. Step-up is enforced by `vendor:payout:write` being in
  // STEP_UP_PERMISSIONS — redirecting settlements is the highest-value single
  // edit available to a vendor, and a borrowed session must not be enough.
  // -------------------------------------------------------------------------
  app.put(
    '/v1/vendor/payout-details',
    {
      preHandler: requirePermission('vendor:payout:write'),
      config: { rateLimit: { max: 5, timeWindow: '60 minutes' } },
    },
    async (request) => {
      const body = z
        .object({
          bankName: z.string().trim().min(2).max(80),
          accountNumber: z.string().trim().min(10).max(20),
          accountName: z.string().trim().min(2).max(120),
        })
        .parse(request.body);

      const actor = actorOf(request);
      if (!actor.vendorId) throw ApiError.forbidden('This account is not linked to a vendor.');

      const before = await readMaskedPayoutDetails(prisma, actor.vendorId);

      const result = await setPayoutDetails(prisma, app.services.keyring, {
        vendorId: actor.vendorId,
        bankName: body.bankName,
        accountNumber: body.accountNumber,
        accountName: body.accountName,
      });

      await writeAudit(prisma, {
        identityId: actor.identityId,
        action: 'vendor.payout_details.changed',
        resourceType: 'vendor',
        resourceId: actor.vendorId,
        // Masked on both sides. The audit log is one of the widest-read tables
        // in the system; an account number written here has leaked.
        before: { bankName: before.bankName, masked: before.accountNumberMasked },
        after: { bankName: result.bankName, masked: result.accountNumberMasked },
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
        requestId: request.id,
      });

      return { payoutDetails: result };
    },
  );

  // -------------------------------------------------------------------------
  // GET /v1/vendor/reports/summary
  // -------------------------------------------------------------------------
  app.get(
    '/v1/vendor/reports/summary',
    { preHandler: requirePermission('vendor:report:read') },
    async (request) => {
      const actor = actorOf(request);
      if (!actor.vendorId) throw ApiError.forbidden('This account is not linked to a vendor.');

      const query = z
        .object({ days: z.coerce.number().int().min(1).max(90).default(7) })
        .parse(request.query);
      const since = new Date(Date.now() - query.days * 86_400_000);

      const [delivered, rejected, cancelled, revenue] = await Promise.all([
        prisma.order.count({
          where: { vendorId: actor.vendorId, status: 'delivered', createdAt: { gte: since } },
        }),
        prisma.order.count({
          where: { vendorId: actor.vendorId, status: 'rejected', createdAt: { gte: since } },
        }),
        prisma.order.count({
          where: { vendorId: actor.vendorId, status: 'cancelled', createdAt: { gte: since } },
        }),
        prisma.order.aggregate({
          where: { vendorId: actor.vendorId, status: 'delivered', createdAt: { gte: since } },
          _sum: { itemsSubtotal: true },
        }),
      ]);

      const total = delivered + rejected + cancelled;

      return {
        periodDays: query.days,
        orders: { delivered, rejected, cancelled, total },
        // Vendor-facing revenue is the food subtotal. Platform fees and rider
        // pay are not the vendor's money and are excluded deliberately.
        itemsRevenue: revenue._sum.itemsSubtotal ?? 0,
        rejectionRate: total === 0 ? 0 : Math.round((rejected / total) * 10_000) / 100,
      };
    },
  );
}
