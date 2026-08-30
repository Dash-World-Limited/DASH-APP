/**
 * Customer ordering: quote, checkout, track, cancel.
 *
 * The single most important rule in this file: **the client never sends a
 * price.** It sends item ids, quantities, and modifier ids. Every naira is
 * recomputed on the server from the database. A request claiming a ₦5 jollof
 * rice produces a ₦3,500 jollof rice.
 *
 * The same applies to the delivery fee, the discount, the surge multiplier, the
 * membership benefit, and the wallet balance. All are derived, none accepted.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { generatePin, generateReference, hashOtp } from '@dash/domain/crypto';
import { add, kobo, ZERO, type Kobo } from '@dash/domain/money';
import {
  assertTransition,
  customerLabel,
  evaluateCustomerCancellation,
  isActive,
  phaseOf,
  type OrderStatus,
} from '@dash/domain/orders';
import {
  buildQuote,
  checkMinimumOrder,
  computeSettlement,
  type AppliedDiscount,
  type MembershipBenefits,
  type PricingRules,
} from '@dash/domain/pricing';
import { buildOrderCapture } from '@dash/domain/ledger';
import { computeRiderPay, DEFAULT_RIDER_PAY_RULES } from '@dash/domain/pay';
import { postLedgerTransaction, writeAudit, type PrismaClient } from '@dash/db';
import { ApiError } from '../http/errors.js';
import { actorOf, requirePermission, requireScope, withIdempotency } from '../http/context.js';

const basketItemSchema = z.object({
  itemId: z.string().min(1),
  quantity: z.number().int().min(1).max(50),
  modifierIds: z.array(z.string().min(1)).max(20).default([]),
  instructions: z.string().trim().max(280).optional(),
});

const quoteRequestSchema = z.object({
  branchId: z.string().min(1),
  items: z.array(basketItemSchema).min(1, 'Add at least one item').max(60),
  mode: z.enum(['delivery', 'pickup']).default('delivery'),
  addressId: z.string().min(1).optional(),
  promoCode: z.string().trim().max(40).optional(),
  tip: z.number().int().min(0).max(10_000_00).default(0),
  useWalletCredit: z.boolean().default(false),
});

const checkoutSchema = quoteRequestSchema.extend({
  paymentMethod: z.enum(['card', 'wallet', 'cash']).default('card'),
  contactless: z.boolean().default(false),
  instructions: z.string().trim().max(280).optional(),
});

/**
 * Price a basket entirely from the database.
 *
 * Returns both the quote and the resolved line items so the checkout path can
 * persist exactly what was priced, with no second lookup that might disagree.
 */
async function priceBasket(
  prisma: PrismaClient,
  geo: { route: (from: { latitude: number; longitude: number }, to: { latitude: number; longitude: number }) => Promise<{ distanceMetres: number; durationSeconds: number; source: string }> },
  input: z.infer<typeof quoteRequestSchema>,
  customerId: string,
) {
  const branch = await prisma.branch.findUnique({
    where: { id: input.branchId },
    select: {
      id: true,
      vendorId: true,
      zoneId: true,
      latitude: true,
      longitude: true,
      state: true,
      minimumOrder: true,
      defaultPrepMinutes: true,
      busyExtraMinutes: true,
      supportsDelivery: true,
      supportsPickup: true,
      isActive: true,
      vendor: { select: { id: true, name: true, status: true, cityId: true, commissionBasisPoints: true } },
      zone: { select: { id: true, isActive: true, surgeMultiplier: true } },
    },
  });

  if (!branch || !branch.isActive || branch.vendor.status !== 'approved') {
    throw ApiError.notFound();
  }
  if (branch.state === 'closed') {
    throw ApiError.unprocessable('This vendor is closed right now.');
  }
  if (input.mode === 'delivery' && !branch.supportsDelivery) {
    throw ApiError.unprocessable('This vendor does not deliver.');
  }
  if (input.mode === 'pickup' && !branch.supportsPickup) {
    throw ApiError.unprocessable('This vendor does not offer pickup.');
  }

  // --- Resolve every item and modifier from the database --------------------
  const itemIds = [...new Set(input.items.map((line) => line.itemId))];
  const items = await prisma.menuItem.findMany({
    where: { id: { in: itemIds }, vendorId: branch.vendorId, archivedAt: null },
    select: {
      id: true,
      name: true,
      price: true,
      prepMinutes: true,
      isAvailable: true,
      modifierGroups: {
        select: {
          id: true,
          name: true,
          minSelect: true,
          maxSelect: true,
          options: { select: { id: true, name: true, priceDelta: true, isAvailable: true } },
        },
      },
    },
  });

  const itemsById = new Map(items.map((item) => [item.id, item]));

  // An item id that belongs to a different vendor simply will not be found —
  // this is what stops a basket mixing vendors or reaching a hidden item.
  for (const line of input.items) {
    if (!itemsById.has(line.itemId)) {
      throw ApiError.unprocessable('One of the items in your basket is no longer available.');
    }
  }

  const stock = await prisma.itemStock.findMany({
    where: { branchId: branch.id, itemId: { in: itemIds } },
    select: { itemId: true, quantity: true, isAvailable: true },
  });
  const stockByItem = new Map(stock.map((row) => [row.itemId, row]));

  let itemsSubtotal: Kobo = ZERO;
  let maxPrepMinutes = branch.defaultPrepMinutes;
  const resolvedLines: {
    itemId: string;
    name: string;
    unitPrice: Kobo;
    quantity: number;
    modifiers: { id: string; name: string; priceDelta: number }[];
    lineTotal: Kobo;
    instructions?: string | undefined;
  }[] = [];

  for (const line of input.items) {
    const item = itemsById.get(line.itemId);
    if (!item) throw ApiError.unprocessable('One of the items in your basket is unavailable.');

    if (!item.isAvailable) {
      throw ApiError.unprocessable(`"${item.name}" is not available right now.`);
    }

    const stockRow = stockByItem.get(item.id);
    if (stockRow && !stockRow.isAvailable) {
      throw ApiError.unprocessable(`"${item.name}" is out of stock.`);
    }
    if (stockRow?.quantity !== null && stockRow?.quantity !== undefined) {
      if (stockRow.quantity < line.quantity) {
        throw ApiError.unprocessable(
          `Only ${stockRow.quantity} of "${item.name}" ${stockRow.quantity === 1 ? 'is' : 'are'} left.`,
        );
      }
    }

    // --- Modifier validation, enforced server-side -------------------------
    const selectedIds = new Set(line.modifierIds);
    const resolvedModifiers: { id: string; name: string; priceDelta: number }[] = [];

    for (const group of item.modifierGroups) {
      const chosen = group.options.filter((option) => selectedIds.has(option.id));

      for (const option of chosen) {
        if (!option.isAvailable) {
          throw ApiError.unprocessable(`"${option.name}" is not available right now.`);
        }
        resolvedModifiers.push({ id: option.id, name: option.name, priceDelta: option.priceDelta });
        selectedIds.delete(option.id);
      }

      // The min/max rules are the vendor's, and the UI is not trusted to have
      // applied them — a crafted request must fail here.
      if (chosen.length < group.minSelect) {
        throw ApiError.unprocessable(
          `Choose at least ${group.minSelect} option${group.minSelect === 1 ? '' : 's'} for "${group.name}".`,
        );
      }
      if (chosen.length > group.maxSelect) {
        throw ApiError.unprocessable(
          `Choose no more than ${group.maxSelect} option${group.maxSelect === 1 ? '' : 's'} for "${group.name}".`,
        );
      }
    }

    // Any modifier id left over did not belong to this item at all.
    if (selectedIds.size > 0) {
      throw ApiError.unprocessable('One of the options you chose is not valid for that item.');
    }

    const modifierTotal = resolvedModifiers.reduce((total, modifier) => total + modifier.priceDelta, 0);
    const unitPrice = kobo(item.price + modifierTotal);
    const lineTotal = kobo(unitPrice * line.quantity);

    itemsSubtotal = add(itemsSubtotal, lineTotal);
    maxPrepMinutes = Math.max(maxPrepMinutes, item.prepMinutes);

    resolvedLines.push({
      itemId: item.id,
      name: item.name,
      unitPrice,
      quantity: line.quantity,
      modifiers: resolvedModifiers,
      lineTotal,
      instructions: line.instructions,
    });
  }

  // --- Minimum order --------------------------------------------------------
  const minimum = checkMinimumOrder({
    itemsSubtotal,
    vendorMinimumOrder: kobo(branch.minimumOrder),
  });
  if (!minimum.meetsMinimum) {
    throw ApiError.unprocessable(
      `This vendor has a minimum order. Add ₦${(minimum.shortfall / 100).toFixed(2)} more to continue.`,
      { shortfall: minimum.shortfall },
    );
  }

  // --- Trip -----------------------------------------------------------------
  let trip: { distanceMetres: number; durationMinutes: number; distanceSource: 'haversine_with_detour_factor' | 'routing_provider' } | undefined;
  let address: { id: string; latitude: number; longitude: number; customerId: string } | null = null;

  if (input.mode === 'delivery') {
    if (!input.addressId) throw ApiError.badRequest('Choose a delivery address.');

    address = await prisma.address.findUnique({
      where: { id: input.addressId },
      select: { id: true, latitude: true, longitude: true, customerId: true },
    });
    // Scope: the address must belong to this customer. Without this check, any
    // signed-in user could price a delivery to a stranger's home and learn
    // roughly where they live from the fee.
    if (!address || address.customerId !== customerId) throw ApiError.notFound();

    const route = await geo.route(
      { latitude: branch.latitude, longitude: branch.longitude },
      { latitude: address.latitude, longitude: address.longitude },
    );
    trip = {
      distanceMetres: Math.round(route.distanceMetres),
      durationMinutes: Math.round(route.durationSeconds / 60),
      distanceSource: route.source === 'routing_provider' ? 'routing_provider' : 'haversine_with_detour_factor',
    };
  }

  // --- Pricing rules, read from the database, not from code -----------------
  const rule = await prisma.pricingRule.findFirst({
    where: { cityId: branch.vendor.cityId, effectiveFrom: { lte: new Date() } },
    orderBy: { effectiveFrom: 'desc' },
  });
  if (!rule) throw ApiError.internal(`No pricing rule for city ${branch.vendor.cityId}`);

  const rules: PricingRules = {
    currency: 'NGN',
    baseDeliveryFee: kobo(rule.baseDeliveryFee),
    includedMetres: rule.includedMetres,
    perKilometreFee: kobo(rule.perKilometreFee),
    perMinuteFee: kobo(rule.perMinuteFee),
    minimumDeliveryFee: kobo(rule.minimumDeliveryFee),
    maximumDeliveryFee: kobo(rule.maximumDeliveryFee),
    serviceFeeBasisPoints: rule.serviceFeeBasisPoints,
    serviceFeeCap: kobo(rule.serviceFeeCap),
    smallOrderThreshold: kobo(rule.smallOrderThreshold),
    smallOrderFee: kobo(rule.smallOrderFee),
    taxBasisPoints: rule.taxBasisPoints,
    maximumSurgeMultiplier: rule.maximumSurgeMultiplier,
  };

  // --- Promotion, validated server-side -------------------------------------
  const discounts: AppliedDiscount[] = [];
  let promotionId: string | null = null;

  if (input.promoCode) {
    const code = input.promoCode.toUpperCase();
    const promotion = await prisma.promotion.findUnique({ where: { code } });

    const rejected = (message: string): never => {
      throw ApiError.unprocessable(message);
    };

    if (!promotion || !promotion.isActive) rejected('That promo code is not valid.');
    else if (promotion.startsAt > new Date()) rejected('That promo code is not active yet.');
    else if (promotion.endsAt && promotion.endsAt < new Date()) rejected('That promo code has expired.');
    else if (itemsSubtotal < promotion.minimumSubtotal) {
      rejected(
        `Spend at least ₦${(promotion.minimumSubtotal / 100).toFixed(2)} to use this code.`,
      );
    } else if (promotion.totalQuota !== null && promotion.usedCount >= promotion.totalQuota) {
      rejected('That promo code has been fully claimed.');
    } else {
      const usedByCustomer = await prisma.promotionRedemption.count({
        where: { promotionId: promotion.id, customerId },
      });
      if (usedByCustomer >= promotion.perCustomerQuota) {
        rejected('You have already used that promo code.');
      }
      if (promotion.firstOrderOnly) {
        const previousOrders = await prisma.order.count({
          where: { customerId, status: { notIn: ['draft', 'cancelled', 'rejected'] } },
        });
        if (previousOrders > 0) rejected('That code is for first orders only.');
      }

      promotionId = promotion.id;
      discounts.push({
        code: promotion.code,
        promotionId: promotion.id,
        kind: promotion.kind as AppliedDiscount['kind'],
        ...(promotion.basisPoints !== null ? { basisPoints: promotion.basisPoints } : {}),
        ...(promotion.amount !== null ? { amount: kobo(promotion.amount) } : {}),
        ...(promotion.maximumDiscount !== null
          ? { maximumDiscount: kobo(promotion.maximumDiscount) }
          : {}),
        fundedBy: promotion.fundedBy as AppliedDiscount['fundedBy'],
        ...(promotion.vendorShareBasisPoints !== null
          ? { vendorShareBasisPoints: promotion.vendorShareBasisPoints }
          : {}),
      });
    }
  }

  // --- Membership, read from the subscription, never from the request -------
  const subscription = await prisma.subscription.findFirst({
    where: { customerId, status: { in: ['active', 'trialing'] }, currentPeriodEnd: { gt: new Date() } },
  });
  const membership: MembershipBenefits | undefined = subscription
    ? {
        freeDeliveryEligible: true,
        freeDeliveryMinimumSubtotal: kobo(subscription.freeDeliveryMinimumSubtotal),
        serviceFeeDiscountBasisPoints: subscription.serviceFeeDiscountBasisPoints,
        surgeExempt: subscription.surgeExempt,
      }
    : undefined;

  // --- Wallet balance, derived from the ledger ------------------------------
  let walletCredit: Kobo = ZERO;
  if (input.useWalletCredit) {
    const aggregate = await prisma.ledgerEntry.aggregate({
      where: { accountKind: 'customer_wallet', ownerId: customerId },
      _sum: { amount: true },
    });
    // Liability account: credits are negative, so the balance is the negation.
    walletCredit = kobo(Math.max(0, -(aggregate._sum.amount ?? 0)));
  }

  const quote = buildQuote({
    rules,
    mode: input.mode,
    itemsSubtotal,
    ...(trip ? { trip } : {}),
    // Surge comes from the zone record, never from the client.
    surgeMultiplier: branch.zone?.surgeMultiplier ?? 1,
    discounts,
    ...(membership ? { membership } : {}),
    tip: kobo(input.tip),
    walletCredit,
  });

  return {
    quote,
    branch,
    address,
    trip,
    resolvedLines,
    promotionId,
    estimatedPrepMinutes: maxPrepMinutes + branch.busyExtraMinutes,
  };
}

export async function registerOrderRoutes(app: FastifyInstance): Promise<void> {
  const { prisma, geo, payments, queue } = app.services;

  // -------------------------------------------------------------------------
  // GET /v1/addresses — the customer's saved delivery addresses
  // -------------------------------------------------------------------------
  app.get(
    '/v1/addresses',
    { preHandler: requirePermission('address:manage:own') },
    async (request) => {
      const actor = actorOf(request);
      if (!actor.customerId) throw ApiError.forbidden('Only customers have saved addresses.');

      const addresses = await prisma.address.findMany({
        // Scoped by the actor's own customerId. There is no way to ask for
        // someone else's addresses because the id is never taken from input.
        where: { customerId: actor.customerId, archivedAt: null },
        select: {
          id: true,
          label: true,
          line1: true,
          landmark: true,
          instructions: true,
          contactPhone: true,
          latitude: true,
          longitude: true,
          isDefault: true,
        },
        orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
      });

      return { addresses };
    },
  );

  // -------------------------------------------------------------------------
  // POST /v1/addresses
  // -------------------------------------------------------------------------
  app.post(
    '/v1/addresses',
    { preHandler: requirePermission('address:manage:own') },
    async (request) => {
      const actor = actorOf(request);
      if (!actor.customerId) throw ApiError.forbidden('Only customers have saved addresses.');

      const body = z
        .object({
          label: z.string().trim().max(40).optional(),
          line1: z.string().trim().min(3).max(200),
          landmark: z.string().trim().max(120).optional(),
          instructions: z.string().trim().max(280).optional(),
          contactPhone: z.string().trim().regex(/^\+[1-9]\d{7,14}$/),
          latitude: z.number().min(-90).max(90),
          longitude: z.number().min(-180).max(180),
          isDefault: z.boolean().default(false),
        })
        .parse(request.body);

      // Refuse to save an address we cannot deliver to, rather than letting the
      // customer discover it at checkout.
      const cities = await prisma.city.findMany({ where: { isLive: true }, select: { id: true } });
      let serviceable = false;
      for (const city of cities) {
        const zones = await geo.zonesContaining(
          { latitude: body.latitude, longitude: body.longitude },
          city.id,
        );
        if (zones.length > 0) {
          serviceable = true;
          break;
        }
      }
      if (!serviceable) {
        throw ApiError.unprocessable('DASH APP does not deliver to that location yet.');
      }

      if (body.isDefault) {
        await prisma.address.updateMany({
          where: { customerId: actor.customerId },
          data: { isDefault: false },
        });
      }

      const address = await prisma.address.create({
        data: {
          customerId: actor.customerId,
          label: body.label ?? null,
          line1: body.line1,
          landmark: body.landmark ?? null,
          instructions: body.instructions ?? null,
          contactPhone: body.contactPhone,
          latitude: body.latitude,
          longitude: body.longitude,
          isDefault: body.isDefault,
        },
        select: { id: true, label: true, line1: true, isDefault: true },
      });

      return { address };
    },
  );

  // -------------------------------------------------------------------------
  // POST /v1/orders/quote — price a basket without committing to it
  // -------------------------------------------------------------------------
  app.post(
    '/v1/orders/quote',
    { preHandler: requirePermission('order:create') },
    async (request) => {
      const actor = actorOf(request);
      if (!actor.customerId) throw ApiError.forbidden('Only customers can place orders.');

      const body = quoteRequestSchema.parse(request.body);
      const priced = await priceBasket(prisma, geo, body, actor.customerId);

      return {
        quote: priced.quote,
        estimatedPrepMinutes: priced.estimatedPrepMinutes,
        estimatedDeliveryMinutes:
          priced.estimatedPrepMinutes + (priced.trip ? Math.round(priced.trip.durationMinutes) : 0),
      };
    },
  );

  // -------------------------------------------------------------------------
  // POST /v1/orders — checkout
  // -------------------------------------------------------------------------
  app.post(
    '/v1/orders',
    { preHandler: requirePermission('order:create') },
    async (request) => {
      const actor = actorOf(request);
      if (!actor.customerId) throw ApiError.forbidden('Only customers can place orders.');
      const customerId = actor.customerId;

      const body = checkoutSchema.parse(request.body);

      // Idempotent: a retried checkout returns the original order rather than
      // placing a second one and charging twice.
      return withIdempotency(request, 'POST /v1/orders', async () => {
        const priced = await priceBasket(prisma, geo, body, customerId);
        const { quote, branch, address, trip, resolvedLines } = priced;

        const deliveryPin = generatePin(4);
        const pickupCode = generatePin(4);

        const order = await prisma.$transaction(async (tx) => {
          const created = await tx.order.create({
            data: {
              code: generateReference('DASH'),
              customerId,
              vendorId: branch.vendorId,
              branchId: branch.id,
              addressId: address?.id ?? null,
              zoneId: branch.zoneId,
              status: 'payment_pending',
              mode: body.mode,
              itemsSubtotal: quote.itemsSubtotal,
              discountTotal: quote.discountTotal,
              deliveryFee: quote.deliveryFee,
              serviceFee: quote.serviceFee,
              smallOrderFee: quote.smallOrderFee,
              surgeAmount: quote.surgeAmount,
              tax: quote.tax,
              tip: quote.tip,
              walletApplied: quote.walletCreditApplied,
              total: quote.total,
              vendorFundedDiscount: quote.vendorFundedDiscount,
              platformFundedDiscount: quote.platformFundedDiscount,
              quoteBreakdown: JSON.stringify(quote),
              pricingRuleVersion: quote.ruleVersion,
              distanceMetres: trip?.distanceMetres ?? null,
              durationMinutes: trip?.durationMinutes ?? null,
              distanceSource: trip?.distanceSource ?? null,
              deliveryPinHash: await hashOtp(deliveryPin),
              pickupCodeHash: await hashOtp(pickupCode),
              contactless: body.contactless,
              instructions: body.instructions ?? null,
              estimatedReadyAt: new Date(Date.now() + priced.estimatedPrepMinutes * 60_000),
              items: {
                create: resolvedLines.map((line) => ({
                  itemId: line.itemId,
                  nameSnapshot: line.name,
                  priceSnapshot: line.unitPrice,
                  quantity: line.quantity,
                  modifiers: JSON.stringify(line.modifiers),
                  lineTotal: line.lineTotal,
                  instructions: line.instructions ?? null,
                })),
              },
              statusEvents: {
                create: { fromStatus: 'draft', toStatus: 'payment_pending', actorType: 'customer', actorId: actor.identityId },
              },
            },
            select: { id: true, code: true, total: true },
          });

          if (priced.promotionId) {
            await tx.promotion.update({
              where: { id: priced.promotionId },
              data: { usedCount: { increment: 1 } },
            });
            await tx.promotionRedemption.create({
              data: {
                promotionId: priced.promotionId,
                customerId,
                orderId: created.id,
                amountApplied: quote.discountTotal,
              },
            });
          }

          return created;
        });

        // --- Payment ---------------------------------------------------------
        const intent = await payments.initialize({
          amount: quote.total,
          currency: 'NGN',
          reference: `${order.code}`,
          customerEmail: `${customerId}@customer.dashapp.test`,
          idempotencyKey: `order_${order.id}`,
        });

        await prisma.payment.create({
          data: {
            orderId: order.id,
            provider: payments.providerName,
            providerReference: intent.providerReference,
            amount: quote.total,
            method: body.paymentMethod,
            status: intent.status,
            idempotencyKey: `order_${order.id}`,
            authorizationUrl: intent.authorizationUrl ?? null,
            failureReason: intent.providerMessage ?? null,
            ...(intent.status === 'captured' ? { capturedAt: new Date() } : {}),
          },
        });

        if (intent.status === 'failed') {
          // Return the order to a basket so the customer can retry with another
          // method rather than losing everything they assembled.
          await prisma.order.update({
            where: { id: order.id },
            data: {
              status: 'draft',
              statusEvents: {
                create: { fromStatus: 'payment_pending', toStatus: 'draft', actorType: 'system', reason: 'payment_failed' },
              },
            },
          });
          throw ApiError.unprocessable('That payment did not go through. Try another method.');
        }

        if (intent.status === 'captured') {
          await confirmOrderPaid(prisma, order.id, actor.identityId);
          await queue.enqueue({
            name: 'dispatch.find_rider',
            payload: { orderId: order.id },
            delayMs: 5_000,
            idempotencyKey: `dispatch_${order.id}`,
          });
        }

        await writeAudit(prisma, {
          identityId: actor.identityId,
          action: 'order.created',
          resourceType: 'order',
          resourceId: order.id,
          after: { code: order.code, total: order.total },
          ipAddress: request.ip,
          requestId: request.id,
        });

        return {
          order: { id: order.id, code: order.code, total: order.total },
          payment: {
            status: intent.status,
            authorizationUrl: intent.authorizationUrl ?? null,
          },
          // Shown to the customer once, to read aloud to the rider on arrival.
          deliveryPin,
        };
      });
    },
  );

  // -------------------------------------------------------------------------
  // GET /v1/orders — the customer's own history
  // -------------------------------------------------------------------------
  app.get('/v1/orders', { preHandler: requirePermission('order:read:own') }, async (request) => {
    const actor = actorOf(request);
    if (!actor.customerId) throw ApiError.forbidden('Only customers have an order history.');

    const query = z
      .object({
        status: z.enum(['active', 'past', 'all']).default('all'),
        limit: z.coerce.number().int().min(1).max(50).default(20),
        cursor: z.string().max(64).optional(),
      })
      .parse(request.query);

    const statusFilter =
      query.status === 'active'
        ? { status: { in: ['placed', 'vendor_reviewing', 'accepted', 'preparing', 'ready', 'rider_assigned', 'rider_arrived', 'picked_up', 'en_route', 'arrived'] } }
        : query.status === 'past'
          ? { status: { in: ['delivered', 'cancelled', 'rejected', 'refunded'] } }
          : {};

    const orders = await prisma.order.findMany({
      // The customerId filter is the scope check — a customer can only ever see
      // their own orders, whatever they put in the query string.
      where: { customerId: actor.customerId, ...statusFilter, ...(query.cursor ? { id: { lt: query.cursor } } : {}) },
      select: {
        id: true,
        code: true,
        status: true,
        total: true,
        createdAt: true,
        deliveredAt: true,
        vendor: { select: { id: true, name: true, slug: true } },
        items: { select: { nameSnapshot: true, quantity: true } },
      },
      orderBy: { id: 'desc' },
      take: query.limit + 1,
    });

    const hasMore = orders.length > query.limit;
    const page = hasMore ? orders.slice(0, query.limit) : orders;

    return {
      orders: page.map((order) => ({
        ...order,
        statusLabel: customerLabel(order.status as OrderStatus),
        phase: phaseOf(order.status as OrderStatus),
      })),
      nextCursor: hasMore ? page[page.length - 1]?.id ?? null : null,
    };
  });

  // -------------------------------------------------------------------------
  // GET /v1/orders/:id
  // -------------------------------------------------------------------------
  app.get<{ Params: { id: string } }>(
    '/v1/orders/:id',
    { preHandler: requirePermission('order:read:own') },
    async (request) => {
      const actor = actorOf(request);

      const order = await prisma.order.findUnique({
        where: { id: request.params.id },
        select: {
          id: true,
          code: true,
          status: true,
          mode: true,
          customerId: true,
          itemsSubtotal: true,
          discountTotal: true,
          deliveryFee: true,
          serviceFee: true,
          smallOrderFee: true,
          surgeAmount: true,
          tax: true,
          tip: true,
          walletApplied: true,
          total: true,
          quoteBreakdown: true,
          contactless: true,
          instructions: true,
          createdAt: true,
          placedAt: true,
          acceptedAt: true,
          readyAt: true,
          pickedUpAt: true,
          deliveredAt: true,
          estimatedReadyAt: true,
          estimatedDeliveryAt: true,
          cancellationReason: true,
          vendor: { select: { id: true, name: true, slug: true } },
          branch: { select: { id: true, name: true, address: true, latitude: true, longitude: true } },
          address: { select: { line1: true, landmark: true, instructions: true, latitude: true, longitude: true } },
          items: { select: { nameSnapshot: true, priceSnapshot: true, quantity: true, modifiers: true, lineTotal: true, instructions: true } },
          statusEvents: { select: { toStatus: true, createdAt: true, actorType: true }, orderBy: { createdAt: 'asc' } },
          // The rider's live position, but only their name and coarse location —
          // never their phone number or identity id.
          rider: {
            select: {
              id: true,
              lastLatitude: true,
              lastLongitude: true,
              locationReportedAt: true,
              vehicleType: true,
              identity: { select: { displayName: true } },
            },
          },
        },
      });

      if (!order) throw ApiError.notFound();
      requireScope(actor, { customerId: order.customerId });

      const status = order.status as OrderStatus;

      return {
        order: {
          ...order,
          // Never leak the customer id back out in the payload shape.
          customerId: undefined,
          statusLabel: customerLabel(status),
          phase: phaseOf(status),
          quoteBreakdown: JSON.parse(order.quoteBreakdown) as unknown,
          // The rider's position is only shared while they are actually
          // carrying this order. Before and after, it is nobody's business.
          rider:
            order.rider && isActive(status)
              ? {
                  name: order.rider.identity.displayName,
                  vehicleType: order.rider.vehicleType,
                  latitude: order.rider.lastLatitude,
                  longitude: order.rider.lastLongitude,
                  reportedAt: order.rider.locationReportedAt,
                  // The client shows a "last seen" warning rather than a
                  // confidently wrong pin when the signal has dropped.
                  isStale:
                    !order.rider.locationReportedAt ||
                    Date.now() - order.rider.locationReportedAt.getTime() > 90_000,
                }
              : null,
        },
        cancellation: evaluateCustomerCancellation(status),
      };
    },
  );

  // -------------------------------------------------------------------------
  // POST /v1/orders/:id/cancel
  // -------------------------------------------------------------------------
  app.post<{ Params: { id: string } }>(
    '/v1/orders/:id/cancel',
    { preHandler: requirePermission('order:cancel:own') },
    async (request) => {
      const actor = actorOf(request);
      const body = z
        .object({ reason: z.string().trim().max(280).optional() })
        .parse(request.body ?? {});

      const order = await prisma.order.findUnique({
        where: { id: request.params.id },
        select: { id: true, customerId: true, status: true, total: true },
      });
      if (!order) throw ApiError.notFound();
      requireScope(actor, { customerId: order.customerId });

      const status = order.status as OrderStatus;
      const outcome = evaluateCustomerCancellation(status);
      if (!outcome.allowed) throw ApiError.conflict(outcome.explanation);

      assertTransition(status, 'cancelled', 'customer');

      await prisma.order.update({
        where: { id: order.id },
        data: {
          status: 'cancelled',
          cancelledAt: new Date(),
          cancelledBy: actor.identityId,
          cancellationReason: body.reason ?? outcome.reasonCode,
          statusEvents: {
            create: {
              fromStatus: status,
              toStatus: 'cancelled',
              actorType: 'customer',
              actorId: actor.identityId,
              reasonCode: outcome.reasonCode,
              reason: body.reason ?? null,
            },
          },
        },
      });

      await writeAudit(prisma, {
        identityId: actor.identityId,
        action: 'order.cancelled',
        resourceType: 'order',
        resourceId: order.id,
        after: { reasonCode: outcome.reasonCode, refundBasisPoints: outcome.refundBasisPoints },
        ipAddress: request.ip,
        requestId: request.id,
      });

      return {
        cancelled: true,
        refund: {
          basisPoints: outcome.refundBasisPoints,
          estimatedAmount: kobo(Math.round((order.total * outcome.refundBasisPoints) / 10_000)),
          explanation: outcome.explanation,
        },
      };
    },
  );
}

/**
 * Move a paid order into the vendor queue and post the ledger entries.
 *
 * Exported so the payment webhook can call it too — a card payment that
 * completes asynchronously must land in exactly the same state as one that
 * captured inline, or the two paths will drift.
 */
export async function confirmOrderPaid(
  prisma: PrismaClient,
  orderId: string,
  actorId: string,
): Promise<void> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      status: true,
      customerId: true,
      vendorId: true,
      riderId: true,
      total: true,
      walletApplied: true,
      itemsSubtotal: true,
      distanceMetres: true,
      quoteBreakdown: true,
      vendorFundedDiscount: true,
      platformFundedDiscount: true,
      tip: true,
      serviceFee: true,
      deliveryFee: true,
      smallOrderFee: true,
      tax: true,
      vendor: { select: { commissionBasisPoints: true } },
    },
  });
  if (!order) return;

  // Idempotent by state: a duplicate webhook finds the order already placed and
  // does nothing, rather than posting the ledger entries a second time.
  if (order.status !== 'payment_pending') return;

  const quote = JSON.parse(order.quoteBreakdown) as Parameters<typeof computeSettlement>[0]['quote'];

  // Rider pay is reserved at capture, before a rider is even assigned, so the
  // money is committed the moment the customer pays rather than appearing later
  // out of nowhere. It is computed from the trip, NOT copied from the delivery
  // fee — the fee is what the market bears, the pay is what the work is worth,
  // and coupling them would let a surge discount quietly cut a rider's earnings.
  //
  // Vehicle type is unknown at this point, so the estimate assumes a
  // motorcycle. Milestone 4 note: when the rider is assigned, the difference
  // between this reservation and their actual entitlement is posted as an
  // adjusting ledger entry rather than by editing this one.
  const riderPay = computeRiderPay({
    rules: DEFAULT_RIDER_PAY_RULES,
    vehicleType: 'motorcycle',
    tripMetres: order.distanceMetres ?? 0,
    // No rider is assigned yet, so there is no approach leg to pay for.
    approachMetres: 0,
    waitingMinutes: 0,
    surgeMultiplier: quote.inputs?.surgeMultiplier ?? 1,
    tip: kobo(0),
  });

  const settlement = computeSettlement({
    quote,
    commissionBasisPoints: order.vendor.commissionBasisPoints,
    riderDeliveryPay: riderPay.deliveryPay,
  });

  await prisma.$transaction(async (tx) => {
    await tx.order.update({
      where: { id: order.id },
      data: {
        status: 'placed',
        placedAt: new Date(),
        statusEvents: {
          create: { fromStatus: 'payment_pending', toStatus: 'placed', actorType: 'system', actorId },
        },
      },
    });

    const draft = buildOrderCapture({
      orderId: order.id,
      idempotencyKey: `capture_${order.id}`,
      actorId: 'system',
      occurredAt: new Date(),
      cashReceived: kobo(order.total),
      walletApplied: kobo(order.walletApplied),
      customerId: order.customerId,
      vendorId: order.vendorId,
      vendorPayable: settlement.vendorPayable,
      riderPayable: settlement.riderPayable,
      riderId: order.riderId ?? undefined,
      platformRevenue: settlement.platformRevenue,
      taxCollected: settlement.taxCollected,
      platformFundedItemDiscount: kobo(quote.platformFundedItemDiscount ?? 0),
    });

    await postLedgerTransaction(tx as unknown as PrismaClient, draft);
  });
}
