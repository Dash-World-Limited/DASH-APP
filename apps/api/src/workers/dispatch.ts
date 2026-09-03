/**
 * Dispatch worker.
 *
 * Consumes `dispatch.find_rider`, runs the scoring engine from
 * `@dash/domain/dispatch`, and drives the offer → timeout → re-offer → escalate
 * cycle.
 *
 * This is the piece that turns a paid order into a rider on a motorcycle.
 * Everything it decides is recorded — the score, every factor that produced it,
 * and every rider who was excluded and why — so a dispatcher can answer "why
 * that rider?" months later from the database alone.
 */

import { randomUUID } from 'node:crypto';
import {
  decideDispatch,
  DEFAULT_CONFIG,
  OFFER_TIMEOUT_SECONDS,
  resolveOfferRound,
  type DispatchConfig,
  type RiderCandidate,
  type VehicleType,
} from '@dash/domain/dispatch';
import { parseJsonColumn, type PrismaClient } from '@dash/db';
import type { QueuePort } from '@dash/domain/ports';
import type { FastifyBaseLogger } from 'fastify';
import { flushOutbox } from '../events/outbox.js';
import { recordOrderChange } from '../realtime/notify.js';

export interface FindRiderJob {
  orderId: string;
  /** Which offer round this is. Starts at 1. */
  round?: number;
}

/** Statuses from which an order may still be assigned a rider. */
const ASSIGNABLE = new Set(['accepted', 'preparing', 'ready', 'placed', 'vendor_reviewing']);

export function registerDispatchWorker(deps: {
  prisma: PrismaClient;
  queue: QueuePort;
  log: FastifyBaseLogger;
  config?: DispatchConfig;
}): void {
  const { prisma, queue, log } = deps;
  const config = deps.config ?? DEFAULT_CONFIG;

  queue.process<FindRiderJob>('dispatch.find_rider', async (job) => {
    const round = job.payload.round ?? 1;
    const now = new Date();

    const order = await prisma.order.findUnique({
      where: { id: job.payload.orderId },
      select: {
        id: true,
        code: true,
        status: true,
        riderId: true,
        zoneId: true,
        estimatedReadyAt: true,
        branch: { select: { latitude: true, longitude: true } },
        address: { select: { latitude: true, longitude: true } },
        payments: { select: { method: true, status: true } },
      },
    });

    if (!order) {
      log.warn({ orderId: job.payload.orderId }, 'dispatch: order no longer exists');
      return;
    }

    // The order may have been cancelled, rejected, or already assigned between
    // the job being queued and it running. All three are normal, not errors.
    if (order.riderId) {
      log.debug({ code: order.code }, 'dispatch: already has a rider');
      return;
    }
    if (!ASSIGNABLE.has(order.status)) {
      log.debug({ code: order.code, status: order.status }, 'dispatch: no longer assignable');
      return;
    }
    if (!order.address) {
      log.debug({ code: order.code }, 'dispatch: pickup-only order needs no rider');
      return;
    }

    const requiresCash = order.payments.some(
      (payment) => payment.method === 'cash' && payment.status !== 'captured',
    );

    // --- Candidate riders --------------------------------------------------
    // Deliberately broad: the domain layer applies the hard filters, and it
    // records why each rider was excluded. Filtering here would lose that.
    const riders = await prisma.rider.findMany({
      where: {
        status: 'approved',
        availability: { in: ['idle', 'on_delivery'] },
        lastLatitude: { not: null },
        lastLongitude: { not: null },
      },
      select: {
        id: true,
        lastLatitude: true,
        lastLongitude: true,
        locationReportedAt: true,
        availability: true,
        vehicleType: true,
        qualityScore: true,
        lastAssignedAt: true,
        allowedZoneIds: true,
        canCarryCash: true,
        cashFloatCap: true,
        cashFloatHeld: true,
        orders: {
          where: {
            status: { in: ['rider_assigned', 'rider_arrived', 'picked_up', 'en_route', 'arrived'] },
          },
          select: { id: true },
        },
      },
      take: 200,
    });

    // Riders already offered this order in an earlier round are not offered it
    // again — a rider who declined should not be pestered.
    const alreadyOffered = await prisma.dispatchOffer.findMany({
      where: { orderId: order.id },
      select: { riderId: true },
    });
    const excludedRiderIds = new Set(alreadyOffered.map((offer) => offer.riderId));

    const candidates: RiderCandidate[] = riders
      .filter((rider) => !excludedRiderIds.has(rider.id))
      .map((rider) => ({
        riderId: rider.id,
        location: { latitude: rider.lastLatitude ?? 0, longitude: rider.lastLongitude ?? 0 },
        locationReportedAt: rider.locationReportedAt ?? new Date(0),
        availability: rider.availability as RiderCandidate['availability'],
        vehicleType: rider.vehicleType as VehicleType,
        activeDeliveryCount: rider.orders.length,
        qualityScore: rider.qualityScore,
        lastAssignedAt: rider.lastAssignedAt ?? undefined,
        allowedZoneIds: parseJsonColumn<string[]>(rider.allowedZoneIds, []),
        // A rider at their float cap cannot take another cash order.
        canCarryCash: rider.canCarryCash && rider.cashFloatHeld < rider.cashFloatCap,
      }));

    const decision = decideDispatch(
      {
        orderId: order.id,
        pickup: { latitude: order.branch.latitude, longitude: order.branch.longitude },
        dropoff: { latitude: order.address.latitude, longitude: order.address.longitude },
        zoneId: order.zoneId ?? '',
        minimumVehicle: 'bicycle',
        requiresCashHandling: requiresCash,
        readyAt: order.estimatedReadyAt ?? now,
        now,
      },
      candidates,
      config,
    );

    // The exclusion reasons are the whole point of the engine recording them:
    // "no rider was found" is unactionable, "all three were zone-restricted" is
    // a configuration fix. Summarised by reason so one busy log line answers it.
    const exclusionSummary = decision.excluded.reduce<Record<string, number>>((counts, entry) => {
      counts[entry.reason] = (counts[entry.reason] ?? 0) + 1;
      return counts;
    }, {});

    log.info(
      {
        code: order.code,
        round,
        ranked: decision.ranked.length,
        excluded: decision.excluded.length,
        exclusionsByReason: exclusionSummary,
        offerTo: decision.offerTo,
      },
      'dispatch: decision made',
    );

    // --- Nobody eligible ----------------------------------------------------
    const outcome = resolveOfferRound({
      round,
      remainingCandidates: decision.ranked.length,
    });

    if (decision.needsManualDispatch || outcome.action === 'escalate') {
      // Escalation is a first-class outcome, not a failure. The order sits on
      // the ops board flagged as unassigned rather than silently retrying.
      log.warn(
        { code: order.code, round, reason: outcome.reason },
        'dispatch: escalating to manual dispatch',
      );
      await prisma.$transaction(async (tx) => {
        await tx.orderStatusEvent.create({
          data: {
            orderId: order.id,
            fromStatus: order.status,
            toStatus: order.status,
            actorType: 'system',
            reasonCode: 'dispatch_escalated',
            reason: outcome.reason,
          },
        });

        // An escalation is exactly what a dispatcher's board exists to show,
        // and it is the one dispatch outcome nobody is watching a screen for —
        // it happens when the system has given up, often minutes after the
        // customer placed the order. Announcing it commits with the record of
        // it, so the board cannot be told about an escalation that rolled back.
        await recordOrderChange(tx, order.id);
      });

      await flushOutbox(prisma, queue);
      return;
    }

    // --- Create the offers ---------------------------------------------------
    const expiresAt = new Date(now.getTime() + OFFER_TIMEOUT_SECONDS * 1000);

    const offered: string[] = [];

    await prisma.$transaction(async (tx) => {
      for (const riderId of decision.offerTo) {
        const scored = decision.ranked.find((entry) => entry.riderId === riderId);
        if (!scored) continue;

        await tx.dispatchOffer.create({
          data: {
            orderId: order.id,
            riderId,
            round,
            status: 'pending',
            score: scored.score,
            // The full factor breakdown. This is what makes an assignment
            // explainable rather than a number nobody can defend.
            scoreBreakdown: JSON.stringify(scored.factors),
            ruleVersion: decision.ruleVersion,
            pickupEtaSeconds: scored.pickupEtaSeconds,
            pickupDistanceMetres: scored.pickupDistanceMetres,
            expiresAt,
          },
        });
        offered.push(riderId);
      }

      if (offered.length === 0) return;

      // The offered riders are told on their own `rider:` topics, which is the
      // only place they could hear it: they have no relationship to this order
      // yet and `canReachOrder` would refuse them the order topic outright.
      // They answer by re-reading their own offer list, so the notification
      // grants them nothing they could not already ask for — and a rider who
      // declines never gains a way to watch the order afterwards.
      //
      // An offer has a timeout measured in seconds, so this is the one
      // notification where the difference between a push and a poll interval is
      // the difference between a rider seeing the job and missing it.
      await recordOrderChange(tx, order.id, {
        extraTopics: offered.map((riderId) => `rider:${riderId}`),
      });
    });

    await flushOutbox(prisma, queue);

    // --- Schedule the timeout sweep -----------------------------------------
    // A round that nobody answers must move on by itself. Without this, a rider
    // who ignores their phone silently holds the order forever.
    await queue.enqueue<FindRiderJob>({
      name: 'dispatch.expire_round',
      payload: { orderId: order.id, round },
      delayMs: (OFFER_TIMEOUT_SECONDS + 2) * 1000,
      idempotencyKey: `expire_${order.id}_${round}_${randomUUID()}`,
    });
  });

  // -------------------------------------------------------------------------
  // Round expiry
  // -------------------------------------------------------------------------
  queue.process<FindRiderJob>('dispatch.expire_round', async (job) => {
    const round = job.payload.round ?? 1;

    const order = await prisma.order.findUnique({
      where: { id: job.payload.orderId },
      select: { id: true, code: true, riderId: true, status: true },
    });
    if (!order) return;

    // Someone accepted while the timer ran. Nothing to do.
    if (order.riderId) return;
    if (!ASSIGNABLE.has(order.status)) return;

    const expired = await prisma.dispatchOffer.updateMany({
      where: { orderId: order.id, round, status: 'pending', expiresAt: { lte: new Date() } },
      data: { status: 'expired' },
    });

    if (expired.count > 0) {
      log.info({ code: order.code, round, expired: expired.count }, 'dispatch: round expired');
    }

    const next = resolveOfferRound({ round, remainingCandidates: 1 });
    if (next.action !== 'reoffer') {
      log.warn({ code: order.code, round, reason: next.reason }, 'dispatch: no further rounds');
      return;
    }

    await queue.enqueue<FindRiderJob>({
      name: 'dispatch.find_rider',
      payload: { orderId: order.id, round: next.nextRound ?? round + 1 },
      idempotencyKey: `dispatch_${order.id}_round_${next.nextRound}`,
    });
  });

  // -------------------------------------------------------------------------
  // Full refund (vendor rejection, ops cancellation)
  // -------------------------------------------------------------------------
  queue.process<{ orderId: string; reason: string }>('refund.full', async (job) => {
    const order = await prisma.order.findUnique({
      where: { id: job.payload.orderId },
      select: {
        id: true,
        code: true,
        total: true,
        payments: { where: { status: 'captured' }, select: { id: true, amount: true } },
      },
    });
    if (!order) return;

    const captured = order.payments[0];
    if (!captured) {
      log.info({ code: order.code }, 'refund: nothing was captured, nothing to return');
      return;
    }

    // Recorded as a pending refund for finance to approve rather than moving
    // money automatically. An automatic outbound payment path is exactly the
    // kind of thing that should require a human until it is proven.
    await prisma.refund.upsert({
      where: { idempotencyKey: `auto_refund_${order.id}` },
      create: {
        paymentId: captured.id,
        amount: captured.amount,
        reason: job.payload.reason,
        status: 'pending',
        idempotencyKey: `auto_refund_${order.id}`,
        requestedBy: 'system',
      },
      update: {},
    });

    log.info(
      { code: order.code, amount: captured.amount, reason: job.payload.reason },
      'refund: queued for finance approval',
    );
  });
}
