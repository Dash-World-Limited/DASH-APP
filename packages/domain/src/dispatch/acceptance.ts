/**
 * What must still be true at the moment a rider accepts.
 *
 * Dispatch decides who *may be offered* an order. This decides who may
 * actually be given it, and the two are deliberately different questions.
 *
 * Until now they were the same question asked once. Dispatch filtered on
 * approval, availability, freshness, distance, zone and capacity, and the
 * acceptance path re-checked none of it — safe only because an offer lived
 * thirty seconds and state cannot drift far in thirty seconds. That was an
 * assumption, not a guarantee, and nothing recorded it.
 *
 * The grace path breaks the assumption outright: an offer may now be created
 * from a position too old to assign on, precisely so a sleeping rider can be
 * woken. If acceptance still checked nothing, the freshness rule would not have
 * moved here — it would have disappeared from the system altogether. So this
 * function is the load-bearing half of that change, and it must never be absent
 * while grace offers exist.
 *
 * The invariant it exists to guarantee:
 *
 *   **No order may reach `rider_assigned` while the accepting rider's
 *   authoritative `locationReportedAt` is older than `maximumLocationAgeSeconds`.**
 *
 * Pure, so the invariant can be tested exhaustively without a database, a
 * clock or a network.
 */

import type { DispatchConfig } from './index.js';
import { DEFAULT_CONFIG } from './index.js';

/** Why an acceptance was refused. Ordered by how it should be reported. */
export type AcceptanceRefusal =
  | 'offer_not_pending'
  | 'offer_expired'
  | 'not_approved'
  | 'not_online'
  | 'lease_expired'
  | 'not_available'
  | 'at_capacity'
  | 'location_missing'
  | 'location_stale'
  | 'zone_not_permitted'
  | 'too_far';

export interface AcceptanceCandidate {
  readonly riderStatus: string;
  readonly availability: string;
  /** When the Online claim lapses. Null means the rider never went online. */
  readonly onlineUntil: Date | null;
  /** The rider's authoritative last accepted position. */
  readonly locationReportedAt: Date | null;
  readonly activeDeliveryCount: number;
  readonly capacity: number;
  readonly allowedZoneIds: readonly string[];
}

export interface AcceptanceContext {
  readonly now: Date;
  readonly offerStatus: string;
  readonly offerExpiresAt: Date;
  /** Straight-line metres from the rider's *fresh* position to the pickup. */
  readonly pickupDistanceMetres: number | null;
  /** The zone the pickup branch sits in, if it has one. */
  readonly pickupZoneId: string | null;
}

export interface AcceptanceVerdict {
  readonly allowed: boolean;
  readonly refusal?: AcceptanceRefusal;
  readonly detail?: string;
}

const ALLOWED = { allowed: true } as const;

const refuse = (refusal: AcceptanceRefusal, detail?: string): AcceptanceVerdict =>
  detail === undefined ? { allowed: false, refusal } : { allowed: false, refusal, detail };

/**
 * Whether this rider may be assigned this order, right now.
 *
 * Every gate dispatch applied is applied again, against state read inside the
 * accepting transaction rather than state remembered from when the offer was
 * made. Order matters only for which reason is reported first; all of them are
 * refusals.
 */
export function judgeAcceptance(
  rider: AcceptanceCandidate,
  context: AcceptanceContext,
  config: DispatchConfig = DEFAULT_CONFIG,
): AcceptanceVerdict {
  if (context.offerStatus !== 'pending') {
    return refuse('offer_not_pending', `offer is ${context.offerStatus}`);
  }
  if (context.offerExpiresAt.getTime() <= context.now.getTime()) {
    return refuse('offer_expired');
  }

  if (rider.riderStatus !== 'approved') {
    return refuse('not_approved', `rider is ${rider.riderStatus}`);
  }

  // Going Offline deliberately clears the lease, so this catches both an
  // explicit sign-off and an app that simply stopped reporting.
  if (!rider.onlineUntil) {
    return refuse('not_online');
  }
  if (rider.onlineUntil.getTime() <= context.now.getTime()) {
    return refuse('lease_expired');
  }

  // `on_delivery` is a working state and may stack another job up to capacity;
  // `on_break` and `offline` may not take work at all.
  if (rider.availability !== 'idle' && rider.availability !== 'on_delivery') {
    return refuse('not_available', `availability=${rider.availability}`);
  }

  if (rider.activeDeliveryCount >= rider.capacity) {
    return refuse('at_capacity', `${rider.activeDeliveryCount} >= ${rider.capacity}`);
  }

  // --- The invariant ---------------------------------------------------------
  //
  // This is the gate the whole grace design is built around. A grace offer was
  // created from a position too old to assign on; by here the rider must have
  // woken and reported a genuinely fresh one, or the acceptance fails. There is
  // no branch on `eligibilityMode`, deliberately: a fresh offer must satisfy
  // this too, so no future change to how offers are made can route around it.
  if (!rider.locationReportedAt) {
    return refuse('location_missing');
  }
  const ageSeconds = (context.now.getTime() - rider.locationReportedAt.getTime()) / 1000;
  if (ageSeconds > config.maximumLocationAgeSeconds || ageSeconds < 0) {
    return refuse('location_stale', `location ${Math.round(ageSeconds)}s old`);
  }

  // --- Re-validated against that fresh position ------------------------------
  if (
    context.pickupZoneId &&
    rider.allowedZoneIds.length > 0 &&
    !rider.allowedZoneIds.includes(context.pickupZoneId)
  ) {
    return refuse('zone_not_permitted');
  }

  if (context.pickupDistanceMetres === null) {
    return refuse('location_missing');
  }
  if (context.pickupDistanceMetres > config.maximumPickupMetres) {
    return refuse(
      'too_far',
      `${Math.round(context.pickupDistanceMetres)}m > ${config.maximumPickupMetres}m`,
    );
  }

  return ALLOWED;
}

/**
 * Whether a refusal means the rider chose not to take the job.
 *
 * It never does. Every refusal here is the rider being *unable* — a lapsed
 * lease, a slow GPS, a step outside the radius — and recording those against
 * an acceptance rate would punish riders for device and network behaviour they
 * do not control. It would also create an incentive to leave the app open and
 * burning battery, which is the opposite of what this design is for.
 *
 * Exists as a named function rather than a comment at the call site so the
 * distinction survives someone later adding a refusal reason.
 */
export function countsAsDecline(): boolean {
  return false;
}

/**
 * Whether a refused acceptance should send the order straight back to dispatch.
 *
 * When the rider cannot take it, the order should not sit waiting out the rest
 * of the offer's life — especially a grace offer, whose ninety seconds were
 * budgeted for waking someone, not for holding an order hostage after they have
 * already been proven ineligible.
 *
 * The two exceptions are the cases where the order is not waiting on this rider
 * at all: an offer that is no longer pending has already been resolved by
 * someone, and an expired one is about to be re-rounded by the worker anyway.
 */
export function shouldRedispatch(refusal: AcceptanceRefusal): boolean {
  return refusal !== 'offer_not_pending' && refusal !== 'offer_expired';
}
