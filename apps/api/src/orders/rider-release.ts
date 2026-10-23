/**
 * Taking riders off orders, and stopping orders that still have riders on them.
 *
 * Every route that removes a rider or ends an order before delivery needs the
 * same four things to happen together, and when each route did its own subset
 * the gaps were real:
 *
 *   - a customer cancellation left a pending offer live, and a rider who
 *     accepted it moved the *cancelled* order back to `rider_assigned`;
 *   - the same cancellation left the assigned rider `on_delivery` for ever,
 *     which the availability route reads as "holding food" and so refused to
 *     let them go offline;
 *   - an ops reassignment returned every order to `ready`, telling the next
 *     rider and the customer the food was waiting when it was still cooking.
 *
 * So the pieces live here, take a transaction handle, and do no network I/O.
 * Callers flush the outbox after their transaction commits.
 */

import type { DbClient } from '@dash/db';
import { resolveOfferRound } from '@dash/domain/dispatch';
import {
  assertTransition,
  RIDER_ON_ORDER_STATUSES,
  RIDER_RELEASABLE_STATUSES,
  statusAfterRiderRelease,
  type OrderStatus,
  type TransitionActor,
} from '@dash/domain/orders';
import { enqueueViaOutbox } from '../events/outbox.js';
import { ApiError } from '../http/errors.js';
import { recordOrderChange } from '../realtime/notify.js';

/**
 * Withdraw every offer for this order that a rider could still accept.
 *
 * Withdrawn, not declined or expired: the rider did nothing. Without this, a
 * stopped order stays on a rider's offer list until its deadline.
 */
export async function withdrawOpenOffers(db: DbClient, orderId: string): Promise<number> {
  const withdrawn = await db.dispatchOffer.updateMany({
    where: { orderId, status: 'pending' },
    data: { status: 'withdrawn', respondedAt: new Date() },
  });
  return withdrawn.count;
}

/**
 * Put a rider back to `idle` once they are carrying nothing.
 *
 * Accepting sets `on_delivery`, and only completing a delivery used to clear
 * it. Called after the order has already been taken off the rider (or ended),
 * so the count is of the work they still really have. A rider on another
 * delivery stays `on_delivery`; one who is offline or on a break is left as
 * they chose.
 */
export async function settleRiderAvailability(db: DbClient, riderId: string): Promise<void> {
  const stillCarrying = await db.order.count({
    where: { riderId, status: { in: [...RIDER_ON_ORDER_STATUSES] } },
  });
  if (stillCarrying > 0) return;
  await db.rider.updateMany({
    where: { id: riderId, availability: 'on_delivery' },
    data: { availability: 'idle' },
  });
}

/**
 * The idempotency key for the round that follows a given offer.
 *
 * Keyed on the offer, not the round number. Round numbers restart at 1 after
 * a release or a reassignment, so a `round_2` key could already have been used
 * by the same order, and the queue would silently drop the new round. An offer
 * id is never reused. A rider's decline and the round's own expiry sweep name
 * the same offer, so whichever comes second is the same job, not another round.
 */
export function nextRoundKey(orderId: string, afterOfferId: string): string {
  return `dispatch_${orderId}_after_${afterOfferId}`;
}

/**
 * Ask dispatch for the next round after `afterOffer`, unless the round limit
 * has been reached — in which case the order is left for a dispatcher, as the
 * expiry sweep already does.
 */
export async function enqueueNextRound(
  db: DbClient,
  orderId: string,
  afterOffer: { id: string; round: number },
): Promise<boolean> {
  const next = resolveOfferRound({ round: afterOffer.round, remainingCandidates: 1 });
  if (next.action !== 'reoffer') return false;
  await enqueueViaOutbox(db, {
    name: 'dispatch.find_rider',
    payload: { orderId, round: next.nextRound ?? afterOffer.round + 1 },
    idempotencyKey: nextRoundKey(orderId, afterOffer.id),
  });
  return true;
}

export interface ReleaseInput {
  orderId: string;
  /** The status and rider read before the transaction; the release is a compare-and-set on both. */
  expectedStatus: OrderStatus;
  riderId: string;
  readyAt: Date | null;
  /** Recorded on the status event. */
  actorType: TransitionActor;
  /** The actor the state machine judges the move for: `ops` for staff, `system` for a rider's own release. */
  transitionActor: 'ops' | 'system';
  actorId: string;
  reasonCode: string;
  reason: string | null;
}

/**
 * Take the rider off an order they have not picked up yet, and send it back
 * to dispatch.
 *
 * Atomic on the order row: the update names the status and rider that were
 * read, so a rider marking pickup, a second release, or an acceptance racing
 * this one makes it match nothing and roll back. There is never a moment with
 * two riders on the order, and never one where the order has no rider and no
 * search running.
 */
export async function releaseRiderBeforePickup(db: DbClient, input: ReleaseInput): Promise<{ status: 'ready' | 'preparing' }> {
  if (!RIDER_RELEASABLE_STATUSES.has(input.expectedStatus)) {
    throw ApiError.conflict('The rider already has this order. It has to be handled as an incident, not reassigned.');
  }
  const to = statusAfterRiderRelease(input.readyAt);
  assertTransition(input.expectedStatus, to, input.transitionActor);

  const moved = await db.order.updateMany({
    where: { id: input.orderId, status: input.expectedStatus, riderId: input.riderId },
    data: { status: to, riderId: null },
  });
  if (moved.count === 0) {
    throw ApiError.conflict('That order has just changed. Reload and try again.');
  }

  // The assignment itself. The offer that made it is closed so an old offer id
  // can never be replayed into a claim.
  await db.dispatchOffer.updateMany({
    where: { orderId: input.orderId, riderId: input.riderId, status: 'accepted' },
    data: { status: 'withdrawn', respondedAt: new Date() },
  });
  await withdrawOpenOffers(db, input.orderId);

  const event = await db.orderStatusEvent.create({
    data: {
      orderId: input.orderId,
      fromStatus: input.expectedStatus,
      toStatus: to,
      actorType: input.actorType,
      actorId: input.actorId,
      reasonCode: input.reasonCode,
      reason: input.reason,
    },
    select: { id: true },
  });

  await settleRiderAvailability(db, input.riderId);

  // Straight back to dispatch. Riders already offered this order — including
  // the one just released — are not offered it again (see the worker).
  await enqueueViaOutbox(db, {
    name: 'dispatch.find_rider',
    payload: { orderId: input.orderId, round: 1 },
    idempotencyKey: `dispatch_${input.orderId}_release_${event.id}`,
  });

  // After the rider is cleared, so the order's own fan-out reaches the customer
  // and vendor and no longer treats the released rider as on it. Their own
  // topic is added once, so a rider taken off by ops re-reads their work and
  // finds the job gone; it carries an identifier, not the order.
  await recordOrderChange(db, input.orderId, { extraTopics: [`rider:${input.riderId}`] });
  return { status: to };
}

/**
 * Everything a cancellation owes riders, inside the cancelling transaction:
 * no offer left that could be accepted, and the assigned rider, if any, no
 * longer marked as carrying it. The order keeps its `riderId`, and the rider's
 * offer stays `accepted`, as the record of who had it; only a `pending` offer
 * can ever be claimed, so neither can be replayed.
 */
export async function releaseRidersFromStoppedOrder(db: DbClient, order: { id: string; riderId: string | null }): Promise<void> {
  await withdrawOpenOffers(db, order.id);
  if (order.riderId) await settleRiderAvailability(db, order.riderId);
}
