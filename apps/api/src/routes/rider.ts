/**
 * Rider app routes.
 *
 * Two things here get more care than the rest of the API:
 *
 *   1. **Location ingestion.** Every point is validated for plausibility before
 *      it enters the tracking stream, because rider pay is partly distance-based
 *      and a spoofed GPS trail is a direct route to fraud.
 *   2. **Delivery completion.** A rider cannot mark an order delivered without
 *      the PIN the customer reads aloud. Knowing the order id is not enough.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { verifyOtp } from '@dash/domain/crypto';
import { checkLocationJump, coarsen } from '@dash/domain/geo';
import { assertTransition, RIDER_HOLDING_STATUSES, type OrderStatus } from '@dash/domain/orders';
import { writeAudit } from '@dash/db';
import { ApiError } from '../http/errors.js';
import { actorOf, requirePermission, requireScope } from '../http/context.js';

/**
 * The fastest plausible sustained speed for a Lagos rider, in metres/second.
 * 25 m/s is 90 km/h — generous for an okada in traffic, tight enough that a
 * teleport is caught.
 */
const MAX_PLAUSIBLE_SPEED_MPS = 25;

export async function registerRiderRoutes(app: FastifyInstance): Promise<void> {
  const { prisma } = app.services;

  function riderIdOf(request: Parameters<typeof actorOf>[0]): string {
    const actor = actorOf(request);
    if (!actor.riderId) throw ApiError.forbidden('This account is not a rider account.');
    return actor.riderId;
  }

  // -------------------------------------------------------------------------
  // POST /v1/rider/availability
  // -------------------------------------------------------------------------
  app.post(
    '/v1/rider/availability',
    { preHandler: requirePermission('rider:availability:set') },
    async (request) => {
      const body = z
        .object({ availability: z.enum(['offline', 'idle', 'on_break']) })
        .parse(request.body);

      const riderId = riderIdOf(request);

      const rider = await prisma.rider.findUnique({
        where: { id: riderId },
        select: { status: true, availability: true },
      });
      if (!rider) throw ApiError.notFound();

      // An unapproved rider cannot go online, whatever they send.
      if (rider.status !== 'approved' && body.availability !== 'offline') {
        throw ApiError.forbidden('Your rider account is not approved yet.');
      }
      // A rider holding food cannot simply go offline and disappear with it.
      if (rider.availability === 'on_delivery' && body.availability === 'offline') {
        throw ApiError.conflict('Finish or hand off your current delivery before going offline.');
      }

      await prisma.rider.update({
        where: { id: riderId },
        data: { availability: body.availability },
      });

      return { availability: body.availability };
    },
  );

  // -------------------------------------------------------------------------
  // POST /v1/rider/location
  // -------------------------------------------------------------------------
  app.post(
    '/v1/rider/location',
    {
      preHandler: requirePermission('rider:location:report'),
      // Generous — riders report every few seconds — but not unbounded.
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
    },
    async (request) => {
      const body = z
        .object({
          latitude: z.number().min(-90).max(90),
          longitude: z.number().min(-180).max(180),
          accuracy: z.number().min(0).max(10_000).optional(),
          heading: z.number().min(0).max(360).optional(),
          speed: z.number().min(0).max(100).optional(),
          recordedAt: z.coerce.date().optional(),
        })
        .parse(request.body);

      const riderId = riderIdOf(request);
      const recordedAt = body.recordedAt ?? new Date();

      // A client-supplied timestamp far in the future would let a rider poison
      // the staleness check and stay "fresh" while parked.
      if (recordedAt.getTime() > Date.now() + 60_000) {
        throw ApiError.badRequest('That location timestamp is not valid.');
      }

      const rider = await prisma.rider.findUnique({
        where: { id: riderId },
        select: {
          id: true,
          availability: true,
          lastLatitude: true,
          lastLongitude: true,
          locationReportedAt: true,
        },
      });
      if (!rider) throw ApiError.notFound();

      // Location is collected only while the rider is actually working. An
      // offline rider's position is not the platform's business.
      if (rider.availability === 'offline') {
        return { accepted: false, reason: 'rider_offline' };
      }

      const next = { latitude: body.latitude, longitude: body.longitude };

      if (rider.lastLatitude !== null && rider.lastLongitude !== null && rider.locationReportedAt) {
        const check = checkLocationJump(
          { latitude: rider.lastLatitude, longitude: rider.lastLongitude },
          rider.locationReportedAt,
          next,
          recordedAt,
          MAX_PLAUSIBLE_SPEED_MPS,
        );

        if (!check.acceptable) {
          // Recorded, not silently dropped — a repeated pattern is evidence.
          await prisma.riderLocation.create({
            data: {
              riderId,
              latitude: body.latitude,
              longitude: body.longitude,
              accuracy: body.accuracy ?? null,
              recordedAt,
              rejectedReason: `implausible_speed_${Math.round(check.impliedMetresPerSecond)}mps`,
            },
          });
          request.log.warn(
            { riderId, impliedSpeed: check.impliedMetresPerSecond, metres: check.metres },
            'rejected implausible rider location',
          );
          return { accepted: false, reason: 'implausible_movement' };
        }
      }

      await prisma.$transaction([
        prisma.riderLocation.create({
          data: {
            riderId,
            latitude: body.latitude,
            longitude: body.longitude,
            accuracy: body.accuracy ?? null,
            heading: body.heading ?? null,
            speed: body.speed ?? null,
            recordedAt,
          },
        }),
        prisma.rider.update({
          where: { id: riderId },
          data: {
            lastLatitude: body.latitude,
            lastLongitude: body.longitude,
            locationReportedAt: recordedAt,
          },
        }),
      ]);

      return { accepted: true };
    },
  );

  // -------------------------------------------------------------------------
  // GET /v1/rider/offers
  // -------------------------------------------------------------------------
  app.get(
    '/v1/rider/offers',
    { preHandler: requirePermission('rider:offer:respond') },
    async (request) => {
      const riderId = riderIdOf(request);

      const offers = await prisma.dispatchOffer.findMany({
        where: { riderId, status: 'pending', expiresAt: { gt: new Date() } },
        select: {
          id: true,
          expiresAt: true,
          pickupEtaSeconds: true,
          pickupDistanceMetres: true,
          order: {
            select: {
              id: true,
              code: true,
              mode: true,
              distanceMetres: true,
              estimatedReadyAt: true,
              branch: { select: { name: true, address: true, latitude: true, longitude: true } },
              // The drop-off area, not the exact address. A rider who has not
              // accepted yet has no business knowing where the customer lives.
              address: { select: { latitude: true, longitude: true } },
              items: { select: { quantity: true } },
            },
          },
        },
        orderBy: { createdAt: 'asc' },
      });

      return {
        offers: offers.map((offer) => ({
          id: offer.id,
          expiresAt: offer.expiresAt,
          pickupEtaSeconds: offer.pickupEtaSeconds,
          pickupDistanceMetres: offer.pickupDistanceMetres,
          order: {
            code: offer.order.code,
            pickup: {
              name: offer.order.branch.name,
              address: offer.order.branch.address,
              latitude: offer.order.branch.latitude,
              longitude: offer.order.branch.longitude,
            },
            dropoffArea: offer.order.address
              ? coarsen(
                  { latitude: offer.order.address.latitude, longitude: offer.order.address.longitude },
                  3,
                )
              : null,
            tripDistanceMetres: offer.order.distanceMetres,
            itemCount: offer.order.items.reduce((total, item) => total + item.quantity, 0),
            estimatedReadyAt: offer.order.estimatedReadyAt,
          },
        })),
      };
    },
  );

  // -------------------------------------------------------------------------
  // POST /v1/rider/offers/:id/respond
  // -------------------------------------------------------------------------
  app.post<{ Params: { id: string } }>(
    '/v1/rider/offers/:id/respond',
    { preHandler: requirePermission('rider:offer:respond') },
    async (request) => {
      const body = z
        .object({
          accept: z.boolean(),
          declineReason: z.string().trim().max(120).optional(),
        })
        .parse(request.body);

      const actor = actorOf(request);
      const riderId = riderIdOf(request);

      const offer = await prisma.dispatchOffer.findUnique({
        where: { id: request.params.id },
        select: {
          id: true,
          riderId: true,
          status: true,
          expiresAt: true,
          order: { select: { id: true, status: true } },
        },
      });
      if (!offer) throw ApiError.notFound();
      requireScope(actor, { riderId: offer.riderId });

      if (offer.status !== 'pending') {
        throw ApiError.conflict('That offer is no longer available.');
      }
      if (offer.expiresAt.getTime() < Date.now()) {
        await prisma.dispatchOffer.update({
          where: { id: offer.id },
          data: { status: 'expired' },
        });
        throw ApiError.conflict('That offer has expired.');
      }

      if (!body.accept) {
        await prisma.dispatchOffer.update({
          where: { id: offer.id },
          data: {
            status: 'declined',
            respondedAt: new Date(),
            declineReason: body.declineReason ?? null,
          },
        });
        return { accepted: false };
      }

      // Claim the order atomically. `updateMany` with a riderId: null guard
      // means two riders accepting simultaneously cannot both win — the second
      // update matches zero rows.
      const claimed = await prisma.order.updateMany({
        where: { id: offer.order.id, riderId: null },
        data: { riderId, status: 'rider_assigned' },
      });

      if (claimed.count === 0) {
        await prisma.dispatchOffer.update({
          where: { id: offer.id },
          data: { status: 'withdrawn', respondedAt: new Date() },
        });
        throw ApiError.conflict('Another rider took that order first.');
      }

      await prisma.$transaction([
        prisma.dispatchOffer.update({
          where: { id: offer.id },
          data: { status: 'accepted', respondedAt: new Date() },
        }),
        prisma.orderStatusEvent.create({
          data: {
            orderId: offer.order.id,
            fromStatus: offer.order.status,
            toStatus: 'rider_assigned',
            actorType: 'rider',
            actorId: actor.identityId,
          },
        }),
        prisma.rider.update({
          where: { id: riderId },
          data: { availability: 'on_delivery', lastAssignedAt: new Date() },
        }),
      ]);

      return { accepted: true, orderId: offer.order.id };
    },
  );

  // -------------------------------------------------------------------------
  // GET /v1/rider/deliveries/:id — full detail, only once assigned
  // -------------------------------------------------------------------------
  app.get<{ Params: { id: string } }>(
    '/v1/rider/deliveries/:id',
    { preHandler: requirePermission('rider:delivery:progress') },
    async (request) => {
      const actor = actorOf(request);

      const order = await prisma.order.findUnique({
        where: { id: request.params.id },
        select: {
          id: true,
          code: true,
          status: true,
          riderId: true,
          mode: true,
          contactless: true,
          instructions: true,
          distanceMetres: true,
          estimatedReadyAt: true,
          branch: { select: { name: true, address: true, phone: true, latitude: true, longitude: true } },
          address: {
            select: {
              line1: true,
              landmark: true,
              instructions: true,
              contactPhone: true,
              latitude: true,
              longitude: true,
            },
          },
          items: { select: { nameSnapshot: true, quantity: true } },
          vendor: { select: { name: true } },
        },
      });

      if (!order) throw ApiError.notFound();
      // Only the assigned rider sees this. Everyone else gets a 404, including
      // riders who merely guessed the id.
      requireScope(actor, { riderId: order.riderId ?? undefined });

      return { delivery: order };
    },
  );

  // -------------------------------------------------------------------------
  // POST /v1/rider/deliveries/:id/progress
  // -------------------------------------------------------------------------
  app.post<{ Params: { id: string } }>(
    '/v1/rider/deliveries/:id/progress',
    { preHandler: requirePermission('rider:delivery:progress') },
    async (request) => {
      const body = z
        .object({ to: z.enum(['rider_arrived', 'picked_up', 'en_route', 'arrived']) })
        .parse(request.body);

      const actor = actorOf(request);
      const order = await prisma.order.findUnique({
        where: { id: request.params.id },
        select: { id: true, status: true, riderId: true },
      });
      if (!order) throw ApiError.notFound();
      requireScope(actor, { riderId: order.riderId ?? undefined });

      assertTransition(order.status as OrderStatus, body.to, 'rider');

      await prisma.order.update({
        where: { id: order.id },
        data: {
          status: body.to,
          ...(body.to === 'picked_up' ? { pickedUpAt: new Date() } : {}),
          statusEvents: {
            create: {
              fromStatus: order.status,
              toStatus: body.to,
              actorType: 'rider',
              actorId: actor.identityId,
            },
          },
        },
      });

      return { status: body.to };
    },
  );

  // -------------------------------------------------------------------------
  // POST /v1/rider/deliveries/:id/complete
  //
  // Requires the PIN the customer reads aloud. This is the whole proof of
  // delivery: without it, a rider could mark every order delivered from their
  // sofa. The attempt limit is what keeps a 4-digit PIN meaningful.
  // -------------------------------------------------------------------------
  app.post<{ Params: { id: string } }>(
    '/v1/rider/deliveries/:id/complete',
    {
      preHandler: requirePermission('rider:delivery:progress'),
      config: { rateLimit: { max: 8, timeWindow: '10 minutes' } },
    },
    async (request) => {
      const body = z
        .object({
          pin: z.string().trim().regex(/^\d{4}$/, 'Enter the 4-digit code'),
          latitude: z.number().min(-90).max(90).optional(),
          longitude: z.number().min(-180).max(180).optional(),
        })
        .parse(request.body);

      const actor = actorOf(request);
      const order = await prisma.order.findUnique({
        where: { id: request.params.id },
        select: { id: true, status: true, riderId: true, deliveryPinHash: true },
      });
      if (!order) throw ApiError.notFound();
      requireScope(actor, { riderId: order.riderId ?? undefined });

      if (!RIDER_HOLDING_STATUSES.has(order.status as OrderStatus)) {
        throw ApiError.conflict('This order is not ready to be completed.');
      }
      if (!order.deliveryPinHash) throw ApiError.conflict('This order has no delivery PIN.');

      if (!(await verifyOtp(body.pin, order.deliveryPinHash))) {
        throw ApiError.badRequest('That delivery code is not correct.');
      }

      assertTransition(order.status as OrderStatus, 'delivered', 'rider');

      await prisma.$transaction(async (tx) => {
        await tx.order.update({
          where: { id: order.id },
          data: {
            status: 'delivered',
            deliveredAt: new Date(),
            statusEvents: {
              create: {
                fromStatus: order.status,
                toStatus: 'delivered',
                actorType: 'rider',
                actorId: actor.identityId,
              },
            },
          },
        });

        await tx.deliveryProof.create({
          data: {
            orderId: order.id,
            kind: 'pin_verified',
            // Coarsened before storage — proof that the rider was near the
            // address, without building a precise movement history.
            ...(body.latitude !== undefined && body.longitude !== undefined
              ? coarsen({ latitude: body.latitude, longitude: body.longitude }, 4)
              : {}),
          },
        });

        if (order.riderId) {
          await tx.rider.update({
            where: { id: order.riderId },
            data: { availability: 'idle' },
          });
        }
      });

      await writeAudit(prisma, {
        identityId: actor.identityId,
        action: 'rider.delivery.completed',
        resourceType: 'order',
        resourceId: order.id,
        requestId: request.id,
      });

      return { delivered: true };
    },
  );

  // -------------------------------------------------------------------------
  // GET /v1/rider/earnings
  // -------------------------------------------------------------------------
  app.get(
    '/v1/rider/earnings',
    { preHandler: requirePermission('rider:earnings:read:own') },
    async (request) => {
      const riderId = riderIdOf(request);

      // Earnings are read from the ledger, not from a running total column.
      const entries = await prisma.ledgerEntry.findMany({
        where: { accountKind: 'rider_payable', ownerId: riderId },
        select: { amount: true, memo: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 100,
      });

      // Liability: credits are negative, so the balance owed is the negation.
      const balance = -entries.reduce((total, entry) => total + entry.amount, 0);

      const deliveries = await prisma.order.count({
        where: { riderId, status: 'delivered' },
      });

      return {
        balanceOwed: balance,
        completedDeliveries: deliveries,
        recentEntries: entries.map((entry) => ({
          amount: -entry.amount,
          memo: entry.memo,
          at: entry.createdAt,
        })),
      };
    },
  );
}
