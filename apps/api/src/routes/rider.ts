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
import { checkLocationJump, coarsen, haversineMetres } from '@dash/domain/geo';
import {
  assertTransition,
  RIDER_CLAIMABLE_STATUSES,
  RIDER_HOLDING_STATUSES,
  RIDER_RELEASABLE_STATUSES,
  type OrderStatus,
} from '@dash/domain/orders';
import { kobo } from '@dash/domain/money';
import { computeRiderPay, DEFAULT_RIDER_PAY_RULES } from '@dash/domain/pay';
import { buildRiderAssignment } from '@dash/domain/ledger';
import {
  DEFAULT_CONFIG,
  judgeAcceptance,
  shouldRedispatch,
  VEHICLE_CAPACITY,
  type AcceptanceRefusal,
  type VehicleType,
} from '@dash/domain/dispatch';
import { parseJsonColumn, postLedgerTransaction, writeAudit, type PrismaClient } from '@dash/db';
import { ApiError } from '../http/errors.js';
import { actorOf, requirePermission, requireScope } from '../http/context.js';
import { enqueueViaOutbox, flushOutbox } from '../events/outbox.js';
import { recordOrderChange } from '../realtime/notify.js';
import { PICKUP_CODE_VISIBLE, pickupCodeFor } from '../orders/pickup-code.js';
import { enqueueNextRound, releaseRiderBeforePickup } from '../orders/rider-release.js';

/**
 * The fastest plausible sustained speed for a Lagos rider, in metres/second.
 * 25 m/s is 90 km/h — generous for an okada in traffic, tight enough that a
 * teleport is caught.
 */
const MAX_PLAUSIBLE_SPEED_MPS = 25;

/** Thrown inside the acceptance transaction to roll back an offer claim whose order was lost. */
class LostClaim extends Error {}

/** Why a rider is giving back a job they accepted. Mandatory and recorded on the order. */
const RELEASE_REASONS = [
  'vehicle_problem',
  'emergency',
  'vendor_closed_or_unreachable',
  'order_not_ready_too_long',
  'unsafe_location',
  'other',
] as const;

/**
 * The statuses that mean "this rider still owes someone this order".
 *
 * From accepting the offer until it is delivered or cancelled — which is
 * deliberately wider than `RIDER_HOLDING_STATUSES` in the domain. That set is
 * about physical custody (`picked_up` onwards) and gates things like refusing
 * to go offline with food. This one is about assignment: a rider riding to the
 * vendor is holding nothing yet, but the job is theirs and must stay on their
 * screen.
 */
/**
 * What a refused acceptance says to the rider.
 *
 * Written to be actionable and to avoid implying fault: a rider who was woken
 * by a push and could not get a GPS fix in time has done nothing wrong, and
 * telling them "you are too far" when their phone simply had not located them
 * yet would be both wrong and infuriating.
 */
const ACCEPTANCE_REFUSAL_MESSAGES: Record<AcceptanceRefusal, string> = {
  offer_not_pending: 'That offer is no longer available.',
  offer_expired: 'That offer has expired.',
  not_approved: 'Your rider account cannot take deliveries right now.',
  not_online: 'Go online before accepting a delivery.',
  lease_expired: 'You were signed out of work. Go online again to take deliveries.',
  not_available: 'Go online before accepting a delivery.',
  at_capacity: 'You are already carrying as many deliveries as you can.',
  location_missing: 'DASH could not confirm your location. Check location is on and try again.',
  location_stale: 'DASH needs a current location before you can accept. Try again in a moment.',
  zone_not_permitted: 'That pickup is outside the area you are approved to work in.',
  too_far: 'You are too far from the pickup to take this delivery.',
};

const ACTIVE_DELIVERY_STATUSES = [
  'rider_assigned',
  'rider_arrived',
  'picked_up',
  'en_route',
  'arrived',
] as const;

/**
 * What an assigned rider may see of an order.
 *
 * Identical to the single-delivery projection below, deliberately: two shapes
 * would drift, and the list is the one a rider's screen hydrates from after a
 * restart. Nothing here belongs to the customer beyond what delivering the
 * order requires — no email, no order total, no payment detail. The full
 * address is included because the rider is already assigned and has to go
 * there; the pickup and delivery codes are not, because they are held only as
 * hashes and are the other party's to speak aloud.
 */
const ACTIVE_DELIVERY_SELECT = {
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
} as const;

export async function registerRiderRoutes(app: FastifyInstance): Promise<void> {
  const { prisma, queue } = app.services;

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
        data: {
          availability: body.availability,
          // The Online lease.
          //
          // Going online is a claim the server now has to be able to verify,
          // because a stale position may itself wake a rider and can therefore
          // no longer act as the backstop that eventually stopped a dead app
          // being offered work. The lease is renewed on every accepted position
          // report, so a living app never expires; going offline deliberately
          // clears it outright, which is what makes an explicit sign-off take
          // effect immediately rather than in fifteen minutes.
          onlineUntil:
            body.availability === 'offline'
              ? null
              : new Date(Date.now() + DEFAULT_CONFIG.onlineLeaseSeconds * 1000),
          // Going offline clears the location baseline.
          //
          // Two reasons, and both matter.
          //
          // Correctness: the plausibility check divides distance by elapsed
          // time. A rider who ends a shift, travels home, and comes back on has
          // their first ping compared against a position they left hours or
          // kilometres ago — and it is rejected as a teleport. A rejected ping
          // does not update the baseline, so the rider stays stale, and
          // dispatch excludes riders with stale locations. They sit online,
          // available, and invisible until enough wall-clock time passes for
          // the implied speed to fall below the threshold. For a 20km commute
          // that is over ten minutes of lost earnings at the start of a shift.
          //
          // Privacy: we state that location is collected only while a rider is
          // online. Keeping their last position after they go offline, and then
          // using it to judge movement we deliberately did not observe, is
          // inconsistent with that promise.
          ...(body.availability === 'offline'
            ? { lastLatitude: null, lastLongitude: null, locationReportedAt: null }
            : {}),
        },
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
            // Renew the lease. A rider whose app is alive reports every twenty
            // seconds and so never lapses; one whose app was killed stops
            // renewing and falls out of dispatch when the lease runs down.
            onlineUntil: new Date(Date.now() + DEFAULT_CONFIG.onlineLeaseSeconds * 1000),
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
          round: true,
          eligibilityMode: true,
          // The pickup point, so acceptance can re-measure distance and zone
          // against the rider's *fresh* position rather than trusting the one
          // dispatch used — which, for a grace offer, was deliberately stale.
          order: {
            select: {
              id: true,
              status: true,
              branch: { select: { latitude: true, longitude: true, zoneId: true } },
            },
          },
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
        // A decline moves the order on now. It used to close the offer and
        // nothing else, so the order sat with nobody looking for a rider until
        // the round's expiry sweep — up to the whole offer window plus two
        // seconds — while the customer and vendor waited on a rider who had
        // already said no.
        await prisma.$transaction(async (tx) => {
          const closed = await tx.dispatchOffer.updateMany({
            where: { id: offer.id, status: 'pending' },
            data: {
              status: 'declined',
              respondedAt: new Date(),
              declineReason: body.declineReason ?? null,
            },
          });
          if (closed.count === 0) throw ApiError.conflict('That offer is no longer available.');

          const order = await tx.order.findUnique({
            where: { id: offer.order.id },
            select: { riderId: true, status: true },
          });
          if (!order || order.riderId || !RIDER_CLAIMABLE_STATUSES.has(order.status as OrderStatus)) return;

          // With more than one rider offered at once, the round is still live
          // while any of them can answer.
          const stillOpen = await tx.dispatchOffer.count({
            where: { orderId: offer.order.id, status: 'pending', expiresAt: { gt: new Date() } },
          });
          if (stillOpen > 0) return;

          // The same key the expiry sweep will use for this round, so when it
          // fires later it finds this job already done rather than starting
          // another round.
          await enqueueNextRound(tx, offer.order.id, { id: offer.id, round: offer.round });
        });
        await flushOutbox(prisma, queue);
        return { accepted: false };
      }

      // --- Is this rider still allowed to take it? ----------------------------
      //
      // Dispatch decided who could be *offered* this order. This decides who
      // may be *given* it, and since the grace path exists the two are no
      // longer the same question: a grace offer was created from a position
      // too old to assign on, purely so a sleeping rider could be woken by a
      // push. If this were absent, that stale position would flow straight
      // through to an assignment and the freshness rule would not have moved
      // here — it would be gone.
      //
      // Read now, not remembered from dispatch. Every gate is re-applied
      // against current state, including for a `fresh` offer: there is
      // deliberately no branch on `eligibilityMode`, so no future change to how
      // offers are made can route around the invariant.
      const state = await prisma.rider.findUnique({
        where: { id: riderId },
        select: {
          status: true,
          availability: true,
          onlineUntil: true,
          locationReportedAt: true,
          lastLatitude: true,
          lastLongitude: true,
          vehicleType: true,
          allowedZoneIds: true,
          orders: {
            where: { status: { in: [...ACTIVE_DELIVERY_STATUSES] } },
            select: { id: true },
          },
        },
      });
      if (!state) throw ApiError.notFound();

      const branch = offer.order.branch;
      const pickupDistanceMetres =
        state.lastLatitude !== null && state.lastLongitude !== null
          ? haversineMetres(
              { latitude: state.lastLatitude, longitude: state.lastLongitude },
              { latitude: branch.latitude, longitude: branch.longitude },
            )
          : null;

      const verdict = judgeAcceptance(
        {
          riderStatus: state.status,
          availability: state.availability,
          onlineUntil: state.onlineUntil,
          locationReportedAt: state.locationReportedAt,
          activeDeliveryCount: state.orders.length,
          capacity: VEHICLE_CAPACITY[state.vehicleType as VehicleType] ?? 1,
          allowedZoneIds: parseJsonColumn<string[]>(state.allowedZoneIds, []),
        },
        {
          now: new Date(),
          offerStatus: offer.status,
          offerExpiresAt: offer.expiresAt,
          pickupDistanceMetres,
          pickupZoneId: branch.zoneId,
        },
      );

      if (!verdict.allowed) {
        const refusal = verdict.refusal ?? 'location_stale';

        // Withdrawn rather than declined. The rider did not refuse the work —
        // they could not take it — and `countsAsDecline` exists to keep that
        // distinction from being lost. Counting a slow GPS as a refusal would
        // punish riders for their handset and push everyone towards leaving the
        // app open and draining battery.
        await prisma.dispatchOffer.updateMany({
          where: { id: offer.id, status: 'pending' },
          data: { status: 'withdrawn', respondedAt: new Date() },
        });

        // Send the order straight back to dispatch rather than letting it wait
        // out an offer that has already been proven unanswerable — the ninety
        // seconds of a grace offer were budgeted for waking someone, not for
        // holding an order after they turned out to be ineligible.
        if (shouldRedispatch(refusal) && offer.order.status === 'preparing') {
          await prisma.$transaction(async (tx) => {
            await enqueueViaOutbox(tx, {
              name: 'dispatch.find_rider',
              payload: { orderId: offer.order.id },
              idempotencyKey: `dispatch_${offer.order.id}_requeue_${offer.id}`,
            });
          });
          await flushOutbox(prisma, queue);
        }

        throw ApiError.conflict(ACCEPTANCE_REFUSAL_MESSAGES[refusal]);
      }

      // Claim the offer and the order together, each as a compare-and-set, in
      // one transaction.
      //
      // The order: `riderId: null` means two riders accepting simultaneously
      // cannot both win — the second update matches zero rows. The status
      // guard means an order that was cancelled while its offer was still
      // open cannot be claimed at all; without it, accepting that offer moved
      // the cancelled order back to `rider_assigned`.
      //
      // The offer: `status: 'pending'` means an offer withdrawn between the
      // read above and now — by a cancellation, a release, or a reassignment —
      // cannot be replayed into an assignment.
      //
      // The callback form rather than the array form, so the notification can
      // be recorded inside the same transaction. This transition changes who
      // may watch the order — the rider topic only exists once a rider is
      // assigned — so `recordOrderChange` recomputes the fan-out from the row
      // it has just claimed rather than from anything read earlier.
      const lost = await prisma.$transaction(async (tx) => {
        const offerClaimed = await tx.dispatchOffer.updateMany({
          where: { id: offer.id, status: 'pending' },
          data: { status: 'accepted', respondedAt: new Date() },
        });
        if (offerClaimed.count === 0) return 'offer' as const;

        const claimed = await tx.order.updateMany({
          where: { id: offer.order.id, riderId: null, status: { in: [...RIDER_CLAIMABLE_STATUSES] } },
          data: { riderId, status: 'rider_assigned' },
        });
        // Throwing rolls the offer claim back with it.
        if (claimed.count === 0) throw new LostClaim();

        await tx.orderStatusEvent.create({
          data: {
            orderId: offer.order.id,
            fromStatus: offer.order.status,
            toStatus: 'rider_assigned',
            actorType: 'rider',
            actorId: actor.identityId,
          },
        });
        await tx.rider.update({
          where: { id: riderId },
          data: { availability: 'on_delivery', lastAssignedAt: new Date() },
        });

        await recordOrderChange(tx, offer.order.id);
        return null;
      }).catch((caught: unknown) => {
        if (caught instanceof LostClaim) return 'order' as const;
        throw caught;
      });

      if (lost === 'offer') throw ApiError.conflict('That offer is no longer available.');
      if (lost === 'order') {
        await prisma.dispatchOffer.updateMany({
          where: { id: offer.id, status: 'pending' },
          data: { status: 'withdrawn', respondedAt: new Date() },
        });
        const now = await prisma.order.findUnique({ where: { id: offer.order.id }, select: { riderId: true } });
        throw ApiError.conflict(now?.riderId ? 'Another rider took that order first.' : 'That order is no longer available.');
      }

      await flushOutbox(prisma, queue);

      return { accepted: true, orderId: offer.order.id };
    },
  );

  // -------------------------------------------------------------------------
  // GET /v1/rider/deliveries — what this rider is carrying right now
  //
  // An accepted offer leaves `/v1/rider/offers` immediately, which is correct:
  // it is no longer pending. Without this endpoint the rider app had no way to
  // ask "what am I carrying?" — the order id existed only in the response to
  // the accept call, so the trip vanished from the screen the moment it was
  // taken, and closing the app lost it for good.
  //
  // Scoped by the actor's own rider id, never by a query parameter, so this
  // cannot be pointed at another rider's work.
  // -------------------------------------------------------------------------
  app.get(
    '/v1/rider/deliveries',
    { preHandler: requirePermission('rider:delivery:progress') },
    async (request) => {
      const riderId = riderIdOf(request);

      const deliveries = await prisma.order.findMany({
        where: {
          riderId,
          // Everything between accepting the job and finishing it. A delivered
          // or cancelled order is history and belongs in earnings, not here.
          status: { in: [...ACTIVE_DELIVERY_STATUSES] },
        },
        orderBy: { acceptedAt: 'asc' },
        select: ACTIVE_DELIVERY_SELECT,
      });

      return { deliveries };
    },
  );

  // -------------------------------------------------------------------------
  // GET /v1/rider/history — completed deliveries for this rider
  //
  // History is deliberately separate from /deliveries: the latter is the
  // rider's live workload and must stay small and unambiguous. This endpoint is
  // read-only, scoped to the authenticated rider, and returns only deliveries
  // that actually reached handover.
  // -------------------------------------------------------------------------
  app.get(
    '/v1/rider/history',
    { preHandler: requirePermission('rider:delivery:progress') },
    async (request) => {
      const riderId = riderIdOf(request);
      const history = await prisma.order.findMany({
        where: { riderId, status: 'delivered' },
        orderBy: [{ deliveredAt: 'desc' }, { updatedAt: 'desc' }],
        take: 50,
        select: {
          ...ACTIVE_DELIVERY_SELECT,
          deliveredAt: true,
        },
      });
      return { deliveries: history };
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
        select: ACTIVE_DELIVERY_SELECT,
      });

      if (!order) throw ApiError.notFound();
      // Only the assigned rider sees this. Everyone else gets a 404, including
      // riders who merely guessed the id.
      // An order with no rider is nobody's to touch here. `riderId: undefined`
      // would make the scope check pass for every rider, and the state machine
      // lets a rider move a `ready` order on, so a rider taken off an order
      // could otherwise walk straight back onto it.
      if (order.riderId === null) throw ApiError.notFound();
      requireScope(actor, { riderId: order.riderId });

      return {
        delivery: {
          ...order,
          // Shown at the counter; the vendor types it in. Only to the assigned
          // rider, and only until the order is picked up.
          pickupCode: PICKUP_CODE_VISIBLE.has(order.status) ? pickupCodeFor(order.id, app.services.config.JWT_ACCESS_SECRET) : null,
        },
      };
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
      // An order with no rider is nobody's to touch here. `riderId: undefined`
      // would make the scope check pass for every rider, and the state machine
      // lets a rider move a `ready` order on, so a rider taken off an order
      // could otherwise walk straight back onto it.
      if (order.riderId === null) throw ApiError.notFound();
      requireScope(actor, { riderId: order.riderId });

      assertTransition(order.status as OrderStatus, body.to, 'rider');

      // These are the transitions a customer watches most closely — picked up,
      // on the way, arrived — so the notification commits with each of them.
      await prisma.$transaction(async (tx) => {
        // Claim the transition, rather than assume it.
        //
        // `assertTransition` judged a status read before this transaction
        // opened, so two taps landing together can both find the order in the
        // prior state, both judge the move legal, and both write it. The status
        // converges — they write the same value — which is what made this easy
        // to miss. The record around it does not: a second `OrderStatusEvent`,
        // a second `revision` bump, and a second realtime notification for a
        // change that happened once. That record is what an operator reads to
        // reconstruct a disputed delivery, and `pickedUpAt` feeds the billable
        // waiting time a rider is paid for.
        //
        // Naming the expected prior status makes this a compare-and-set: the
        // first request to commit moves the delivery, and the second matches no
        // row, throws, and takes its own writes down with it.
        const claimed = await tx.order.updateMany({
          // The rider too: a release or reassignment landing first takes the
          // order off this rider, and their tap must then match nothing.
          where: { id: order.id, status: order.status, riderId: order.riderId },
          data: {
            status: body.to,
            ...(body.to === 'picked_up' ? { pickedUpAt: new Date() } : {}),
          },
        });
        if (claimed.count === 0) {
          throw ApiError.conflict('That delivery has already moved on.');
        }

        await tx.orderStatusEvent.create({
          data: {
            orderId: order.id,
            fromStatus: order.status,
            toStatus: body.to,
            actorType: 'rider',
            actorId: actor.identityId,
          },
        });

        await recordOrderChange(tx, order.id);
      });

      await flushOutbox(prisma, queue);

      return { status: body.to };
    },
  );

  // -------------------------------------------------------------------------
  // POST /v1/rider/deliveries/:id/release — "I can't do this delivery"
  //
  // Only before pickup. Until then the rider is holding nothing, so the job
  // can go straight back to dispatch and another rider sent. From `picked_up`
  // on they have the customer's order in their hands, and handing the job to
  // someone else automatically would leave that food unaccounted for; that is
  // an incident for DASH support, who can see who has it and act.
  // -------------------------------------------------------------------------
  app.post<{ Params: { id: string } }>(
    '/v1/rider/deliveries/:id/release',
    { preHandler: requirePermission('rider:delivery:progress') },
    async (request) => {
      const body = z
        .object({
          reasonCode: z.enum(RELEASE_REASONS),
          note: z.string().trim().max(280).optional(),
        })
        .parse(request.body);

      const actor = actorOf(request);
      const riderId = riderIdOf(request);
      const order = await prisma.order.findUnique({
        where: { id: request.params.id },
        select: { id: true, status: true, riderId: true, readyAt: true },
      });
      if (!order || order.riderId !== riderId) throw ApiError.notFound();

      if (RIDER_HOLDING_STATUSES.has(order.status as OrderStatus)) {
        throw ApiError.conflict(
          'You already have this order, so it cannot be passed to another rider from the app. Contact DASH support now so they can arrange what happens to it.',
        );
      }
      if (!RIDER_RELEASABLE_STATUSES.has(order.status as OrderStatus)) {
        throw ApiError.conflict('This delivery can no longer be given back.');
      }

      const released = await prisma.$transaction((tx) =>
        releaseRiderBeforePickup(tx, {
          orderId: order.id,
          expectedStatus: order.status as OrderStatus,
          riderId,
          readyAt: order.readyAt,
          actorType: 'rider',
          transitionActor: 'system',
          actorId: actor.identityId,
          reasonCode: `rider_released:${body.reasonCode}`,
          reason: body.note ?? null,
        }),
      );
      await flushOutbox(prisma, queue);

      await writeAudit(prisma, {
        identityId: actor.identityId,
        action: 'rider.delivery.released',
        resourceType: 'order',
        resourceId: order.id,
        before: { status: order.status, riderId },
        after: { status: released.status, reasonCode: body.reasonCode },
        ipAddress: request.ip,
        requestId: request.id,
      });

      return { released: true, status: released.status };
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
        select: {
          id: true,
          status: true,
          riderId: true,
          deliveryPinHash: true,
          distanceMetres: true,
          tip: true,
          quoteBreakdown: true,
          acceptedAt: true,
          pickedUpAt: true,
          rider: { select: { vehicleType: true } },
          offers: {
            where: { status: 'accepted' },
            select: { pickupDistanceMetres: true },
            take: 1,
          },
        },
      });
      if (!order) throw ApiError.notFound();
      // An order with no rider is nobody's to touch here. `riderId: undefined`
      // would make the scope check pass for every rider, and the state machine
      // lets a rider move a `ready` order on, so a rider taken off an order
      // could otherwise walk straight back onto it.
      if (order.riderId === null) throw ApiError.notFound();
      requireScope(actor, { riderId: order.riderId });

      if (!RIDER_HOLDING_STATUSES.has(order.status as OrderStatus)) {
        throw ApiError.conflict('This order is not ready to be completed.');
      }
      if (!order.deliveryPinHash) throw ApiError.conflict('This order has no delivery PIN.');

      if (!(await verifyOtp(body.pin, order.deliveryPinHash))) {
        throw ApiError.badRequest('That delivery code is not correct.');
      }

      assertTransition(order.status as OrderStatus, 'delivered', 'rider');

      await prisma.$transaction(async (tx) => {
        // Claim the completion, for the same reason as the progress route
        // above — with more at stake. Two completions racing wrote two status
        // events, two proofs of delivery, and two revision bumps for one
        // handover. The rider's pay was protected, but only by the ledger's own
        // idempotency key; everything the ledger does not guard duplicated
        // freely, and a proof of delivery is evidence in a dispute.
        const claimed = await tx.order.updateMany({
          where: { id: order.id, status: order.status },
          data: { status: 'delivered', deliveredAt: new Date() },
        });
        if (claimed.count === 0) {
          throw ApiError.conflict('This delivery has already been completed.');
        }

        await tx.orderStatusEvent.create({
          data: {
            orderId: order.id,
            fromStatus: order.status,
            toStatus: 'delivered',
            actorType: 'rider',
            actorId: actor.identityId,
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

          // --- Assign the reserved pay to the rider who actually rode --------
          // At capture no rider existed, so the delivery pay was reserved
          // against an unowned balance. Now the real numbers are known, so the
          // reservation is released and the rider is credited. Without this the
          // money sits in an account nobody can draw from and the rider's
          // earnings screen reads zero after a completed delivery.
          const quote = JSON.parse(order.quoteBreakdown) as {
            inputs?: { surgeMultiplier?: number };
          };

          const reserved = computeRiderPay({
            rules: DEFAULT_RIDER_PAY_RULES,
            vehicleType: 'motorcycle',
            tripMetres: order.distanceMetres ?? 0,
            approachMetres: 0,
            waitingMinutes: 0,
            surgeMultiplier: quote.inputs?.surgeMultiplier ?? 1,
            tip: kobo(0),
          });

          // Waiting time is measured from the rider arriving to the food being
          // handed over. Only the vendor's delay is billable.
          const waitingMinutes =
            order.acceptedAt && order.pickedUpAt
              ? Math.max(0, (order.pickedUpAt.getTime() - order.acceptedAt.getTime()) / 60_000)
              : 0;

          const actual = computeRiderPay({
            rules: DEFAULT_RIDER_PAY_RULES,
            vehicleType: (order.rider?.vehicleType ?? 'motorcycle') as VehicleType,
            tripMetres: order.distanceMetres ?? 0,
            approachMetres: order.offers[0]?.pickupDistanceMetres ?? 0,
            waitingMinutes,
            surgeMultiplier: quote.inputs?.surgeMultiplier ?? 1,
            tip: kobo(order.tip),
          });

          await postLedgerTransaction(
            tx as unknown as PrismaClient,
            buildRiderAssignment({
              orderId: order.id,
              riderId: order.riderId,
              idempotencyKey: `rider_assign_${order.id}`,
              actorId: actor.identityId,
              occurredAt: new Date(),
              reservedPay: reserved.deliveryPay,
              actualPay: actual.total,
            }),
          );
        }

        // The last transition an order makes, and the one the customer, the
        // vendor, and the board are all waiting to see.
        await recordOrderChange(tx, order.id);
      });

      await flushOutbox(prisma, queue);

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
