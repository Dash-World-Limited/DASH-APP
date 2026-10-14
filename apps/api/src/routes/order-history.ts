/**
 * Order history, read from what each order froze when it was placed.
 *
 * An order's items (name, unit price, modifiers, line total) are frozen on
 * OrderItem; its delivery address and seller name on Order. These views read
 * only those, falling back to the live address or vendor name solely for
 * orders placed before the snapshot columns existed. A vendor renaming,
 * repricing or deleting a product, or a customer editing a saved address,
 * changes nothing here.
 *
 * Kept out of routes/rider.ts, which is the dispatch path; these routes only
 * read.
 */

import type { FastifyInstance } from 'fastify';
import { customerLabel, deliveryAddressOf, type OrderStatus } from '@dash/domain/orders';
import { ApiError } from '../http/errors.js';
import { actorOf, requirePermission } from '../http/context.js';

const LIVE_ADDRESS_SELECT = {
  select: { label: true, line1: true, landmark: true, instructions: true, contactPhone: true, latitude: true, longitude: true },
} as const;

function parseModifiers(raw: string | null): Array<{ name: string; priceDelta: number }> {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const { name, priceDelta } = entry as { name?: unknown; priceDelta?: unknown };
      return typeof name === 'string' ? [{ name, priceDelta: typeof priceDelta === 'number' ? priceDelta : 0 }] : [];
    });
  } catch {
    return [];
  }
}

export async function registerOrderHistoryRoutes(app: FastifyInstance): Promise<void> {
  const { prisma } = app.services;

  // -------------------------------------------------------------------------
  // GET /v1/rider/history/:id — one delivery this rider completed
  //
  // Only the rider who delivered it, and only once delivered. Everyone else,
  // including another rider guessing the id, gets a 404.
  // -------------------------------------------------------------------------
  app.get<{ Params: { id: string } }>(
    '/v1/rider/history/:id',
    { preHandler: requirePermission('rider:delivery:progress') },
    async (request) => {
      const actor = actorOf(request);
      if (!actor.riderId) throw ApiError.forbidden('This account is not a rider account.');

      const order = await prisma.order.findFirst({
        where: { id: request.params.id, riderId: actor.riderId, status: 'delivered' },
        select: {
          id: true,
          code: true,
          status: true,
          placedAt: true,
          pickedUpAt: true,
          deliveredAt: true,
          vendorNameSnapshot: true,
          vendor: { select: { name: true } },
          branch: { select: { name: true, address: true } },
          deliveryAddressSnapshot: true,
          address: LIVE_ADDRESS_SELECT,
          items: { select: { nameSnapshot: true, quantity: true }, orderBy: { id: 'asc' } },
        },
      });
      if (!order) throw ApiError.notFound();

      const deliveredTo = deliveryAddressOf(order.deliveryAddressSnapshot, order.address);
      return {
        delivery: {
          id: order.id,
          code: order.code,
          status: order.status,
          placedAt: order.placedAt,
          pickedUpAt: order.pickedUpAt,
          deliveredAt: order.deliveredAt,
          vendorName: order.vendorNameSnapshot ?? order.vendor.name,
          branch: order.branch,
          // Where it went. The customer's phone is not repeated once the job
          // is over.
          deliveryAddress: deliveredTo
            ? { line1: deliveredTo.line1, landmark: deliveredTo.landmark, instructions: deliveredTo.instructions }
            : null,
          items: order.items.map((item) => ({ name: item.nameSnapshot, quantity: item.quantity })),
        },
      };
    },
  );

  // -------------------------------------------------------------------------
  // GET /v1/admin/orders/:ref — the full historical record, by id or code
  //
  // For staff who may read any order (`ops:order:read:all`): support,
  // dispatch, finance, platform and super admins.
  // -------------------------------------------------------------------------
  app.get<{ Params: { ref: string } }>(
    '/v1/admin/orders/:ref',
    { preHandler: requirePermission('ops:order:read:all') },
    async (request, reply) => {
      const ref = request.params.ref.trim();
      if (!ref || ref.length > 64) throw ApiError.notFound();
      const byCode = /^DASH-/i.test(ref);

      const order = await prisma.order.findFirst({
        where: byCode ? { code: ref.toUpperCase() } : { id: ref },
        select: {
          id: true,
          code: true,
          status: true,
          mode: true,
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
          contactless: true,
          instructions: true,
          createdAt: true,
          placedAt: true,
          acceptedAt: true,
          readyAt: true,
          pickedUpAt: true,
          deliveredAt: true,
          cancelledAt: true,
          cancellationReason: true,
          cancelledBy: true,
          vendorNameSnapshot: true,
          deliveryAddressSnapshot: true,
          vendor: { select: { id: true, name: true, category: true } },
          branch: { select: { name: true, address: true } },
          address: LIVE_ADDRESS_SELECT,
          customer: { select: { id: true, identity: { select: { displayName: true, email: true, phone: true } } } },
          rider: { select: { id: true, vehicleType: true, identity: { select: { displayName: true, phone: true } } } },
          items: {
            select: {
              itemId: true,
              nameSnapshot: true,
              priceSnapshot: true,
              quantity: true,
              modifiers: true,
              lineTotal: true,
              instructions: true,
              item: { select: { name: true, price: true } },
            },
            orderBy: { id: 'asc' },
          },
          statusEvents: {
            select: { fromStatus: true, toStatus: true, actorType: true, reasonCode: true, createdAt: true },
            orderBy: { createdAt: 'asc' },
          },
          payments: {
            select: {
              provider: true,
              method: true,
              status: true,
              amount: true,
              createdAt: true,
              capturedAt: true,
              refunds: { select: { amount: true, status: true, refundedAt: true, createdAt: true } },
            },
            orderBy: { createdAt: 'asc' },
          },
          reviews: { where: { subject: 'rider' }, select: { rating: true, comment: true, createdAt: true }, take: 1 },
        },
      });
      if (!order) throw ApiError.notFound();

      const status = order.status as OrderStatus;
      reply.header('cache-control', 'no-store');
      return {
        order: {
          id: order.id,
          code: order.code,
          status: order.status,
          statusLabel: customerLabel(status, order.vendor.category),
          mode: order.mode,
          vendor: {
            id: order.vendor.id,
            // The name the customer bought from; today's, if it has changed.
            name: order.vendorNameSnapshot ?? order.vendor.name,
            currentName: order.vendor.name,
          },
          branch: order.branch,
          customer: {
            id: order.customer.id,
            name: order.customer.identity.displayName,
            email: order.customer.identity.email,
            phone: order.customer.identity.phone,
          },
          rider: order.rider
            ? {
                id: order.rider.id,
                name: order.rider.identity.displayName,
                phone: order.rider.identity.phone,
                vehicleType: order.rider.vehicleType,
              }
            : null,
          deliveryAddress: deliveryAddressOf(order.deliveryAddressSnapshot, order.address),
          deliveryAddressFrozen: order.deliveryAddressSnapshot !== null,
          items: order.items.map((item) => ({
            name: item.nameSnapshot,
            unitPrice: item.priceSnapshot,
            quantity: item.quantity,
            modifiers: parseModifiers(item.modifiers),
            lineTotal: item.lineTotal,
            instructions: item.instructions,
            // Whether the product is still on the menu, and what it is called
            // now. For context only; the receipt is the snapshot above.
            stillListed: item.item !== null,
            currentName: item.item?.name ?? null,
          })),
          totals: {
            itemsSubtotal: order.itemsSubtotal,
            discountTotal: order.discountTotal,
            deliveryFee: order.deliveryFee,
            serviceFee: order.serviceFee,
            smallOrderFee: order.smallOrderFee,
            surgeAmount: order.surgeAmount,
            tax: order.tax,
            tip: order.tip,
            walletApplied: order.walletApplied,
            total: order.total,
          },
          contactless: order.contactless,
          instructions: order.instructions,
          timestamps: {
            createdAt: order.createdAt,
            placedAt: order.placedAt,
            acceptedAt: order.acceptedAt,
            readyAt: order.readyAt,
            pickedUpAt: order.pickedUpAt,
            deliveredAt: order.deliveredAt,
            cancelledAt: order.cancelledAt,
          },
          cancellation: order.cancelledAt ? { reason: order.cancellationReason, by: order.cancelledBy } : null,
          payments: order.payments,
          statusEvents: order.statusEvents,
          riderRating: order.reviews[0] ?? null,
        },
      };
    },
  );
}
