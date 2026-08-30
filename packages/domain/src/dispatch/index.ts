/**
 * Dispatch.
 *
 * Scores candidate riders for an order and decides who gets offered it. Like
 * pricing, this is deterministic and explainable (ADR-0007): every score comes
 * back with the contribution of each factor, so a dispatcher can answer "why did
 * that rider get it and not this one?" from the record alone.
 *
 * This is a rules engine, not a model. There is no training data yet. The
 * `DispatchDecision` records everything a future model would need as features.
 */

import { haversineMetres, type LatLng } from '../geo/index.js';

export const DISPATCH_RULE_VERSION = '2026.08.1';

export type VehicleType = 'bicycle' | 'motorcycle' | 'car' | 'van' | 'on_foot';

export type RiderAvailability = 'offline' | 'idle' | 'on_delivery' | 'on_break';

export interface RiderCandidate {
  readonly riderId: string;
  readonly location: LatLng;
  /** When that location was reported. Stale positions are penalised. */
  readonly locationReportedAt: Date;
  readonly availability: RiderAvailability;
  readonly vehicleType: VehicleType;
  /** Deliveries currently held. Compared against the vehicle's capacity. */
  readonly activeDeliveryCount: number;
  /** Rolling completion/quality score, 0–100. */
  readonly qualityScore: number;
  /** When this rider last completed or declined an offer — drives fairness. */
  readonly lastAssignedAt?: Date | undefined;
  /** Zones the rider is permitted to work. Empty = unrestricted. */
  readonly allowedZoneIds?: readonly string[] | undefined;
  /** True if the rider has accepted cash orders and is under their cash float cap. */
  readonly canCarryCash: boolean;
}

export interface DispatchRequest {
  readonly orderId: string;
  readonly pickup: LatLng;
  readonly dropoff: LatLng;
  readonly zoneId: string;
  /** Minimum vehicle needed — a 40kg grocery order is not a bicycle job. */
  readonly minimumVehicle: VehicleType;
  readonly requiresCashHandling: boolean;
  /** When the food is expected ready. Riders who arrive far too early idle. */
  readonly readyAt: Date;
  readonly now: Date;
}

export interface DispatchWeights {
  /** Weight on rider→pickup proximity. The dominant factor. */
  readonly proximity: number;
  /** Weight on rider quality score. */
  readonly quality: number;
  /** Weight on fairness — how long the rider has waited for work. */
  readonly fairness: number;
  /** Weight on arriving near the ready time rather than far too early/late. */
  readonly readinessAlignment: number;
  /** Penalty applied per active delivery already held. */
  readonly loadPenalty: number;
  /** Penalty for a stale location report. */
  readonly stalenessPenalty: number;
}

export const DEFAULT_WEIGHTS: DispatchWeights = {
  proximity: 45,
  quality: 20,
  fairness: 15,
  readinessAlignment: 20,
  loadPenalty: 25,
  stalenessPenalty: 20,
};

export interface DispatchConfig {
  readonly weights: DispatchWeights;
  /** Riders further than this from pickup are not considered at all. */
  readonly maximumPickupMetres: number;
  /** A location older than this is treated as unusable. */
  readonly maximumLocationAgeSeconds: number;
  /** Beyond this, a rider is considered fully "rested" for fairness scoring. */
  readonly fairnessSaturationSeconds: number;
  /** Speed assumption per vehicle, metres per second, for pickup ETA. */
  readonly vehicleSpeedMetresPerSecond: Readonly<Record<VehicleType, number>>;
  /** Straight-line to road-distance factor for this city. */
  readonly detourFactor: number;
  /** How many riders to offer to at once. 1 = strictly sequential. */
  readonly offerBatchSize: number;
}

export const DEFAULT_CONFIG: DispatchConfig = {
  weights: DEFAULT_WEIGHTS,
  maximumPickupMetres: 8_000,
  maximumLocationAgeSeconds: 120,
  fairnessSaturationSeconds: 1_800,
  // Lagos traffic-adjusted averages, not free-flow speeds.
  vehicleSpeedMetresPerSecond: {
    on_foot: 1.3,
    bicycle: 3.5,
    motorcycle: 6.5,
    car: 5.5,
    van: 4.5,
  },
  detourFactor: 1.4,
  offerBatchSize: 1,
};

/** Capacity by vehicle — how many deliveries may be stacked. */
const VEHICLE_CAPACITY: Readonly<Record<VehicleType, number>> = {
  on_foot: 1,
  bicycle: 2,
  motorcycle: 3,
  car: 4,
  van: 6,
};

/** Ordering for "is this vehicle at least as capable as required?". */
const VEHICLE_RANK: Readonly<Record<VehicleType, number>> = {
  on_foot: 0,
  bicycle: 1,
  motorcycle: 2,
  car: 3,
  van: 4,
};

export type ExclusionReason =
  | 'not_idle'
  | 'location_stale'
  | 'too_far'
  | 'vehicle_insufficient'
  | 'at_capacity'
  | 'zone_not_permitted'
  | 'cannot_carry_cash';

export interface ScoreFactor {
  readonly name: keyof DispatchWeights;
  /** Normalised 0–1 before weighting. */
  readonly raw: number;
  /** Signed contribution to the final score. */
  readonly contribution: number;
  readonly explanation: string;
}

export interface ScoredRider {
  readonly riderId: string;
  readonly score: number;
  readonly factors: readonly ScoreFactor[];
  readonly pickupEtaSeconds: number;
  readonly pickupDistanceMetres: number;
}

export interface ExcludedRider {
  readonly riderId: string;
  readonly reason: ExclusionReason;
  readonly detail: string;
}

export interface DispatchDecision {
  readonly ruleVersion: string;
  readonly orderId: string;
  readonly decidedAt: Date;
  /** Best candidates, highest score first. */
  readonly ranked: readonly ScoredRider[];
  /** Who to offer to now, given `offerBatchSize`. */
  readonly offerTo: readonly string[];
  /** Everyone filtered out, and why. This is what makes disputes answerable. */
  readonly excluded: readonly ExcludedRider[];
  /** True when nobody qualified — the caller must escalate to manual dispatch. */
  readonly needsManualDispatch: boolean;
}

/**
 * Hard eligibility filters. These are absolute: no score can rescue a rider who
 * fails one. Separating them from scoring means a rider is never assigned a job
 * their vehicle cannot carry just because they were very close by.
 */
function excludeIfIneligible(
  rider: RiderCandidate,
  request: DispatchRequest,
  config: DispatchConfig,
  pickupDistanceMetres: number,
): ExcludedRider | null {
  if (rider.availability !== 'idle' && rider.availability !== 'on_delivery') {
    return {
      riderId: rider.riderId,
      reason: 'not_idle',
      detail: `availability=${rider.availability}`,
    };
  }

  const ageSeconds = (request.now.getTime() - rider.locationReportedAt.getTime()) / 1000;
  if (ageSeconds > config.maximumLocationAgeSeconds || ageSeconds < 0) {
    return {
      riderId: rider.riderId,
      reason: 'location_stale',
      detail: `location ${Math.round(ageSeconds)}s old`,
    };
  }

  if (pickupDistanceMetres > config.maximumPickupMetres) {
    return {
      riderId: rider.riderId,
      reason: 'too_far',
      detail: `${Math.round(pickupDistanceMetres)}m > ${config.maximumPickupMetres}m`,
    };
  }

  const required = VEHICLE_RANK[request.minimumVehicle];
  if (VEHICLE_RANK[rider.vehicleType] < required) {
    return {
      riderId: rider.riderId,
      reason: 'vehicle_insufficient',
      detail: `${rider.vehicleType} < ${request.minimumVehicle}`,
    };
  }

  const capacity = VEHICLE_CAPACITY[rider.vehicleType];
  if (rider.activeDeliveryCount >= capacity) {
    return {
      riderId: rider.riderId,
      reason: 'at_capacity',
      detail: `${rider.activeDeliveryCount}/${capacity} deliveries`,
    };
  }

  const zones = rider.allowedZoneIds;
  if (zones && zones.length > 0 && !zones.includes(request.zoneId)) {
    return {
      riderId: rider.riderId,
      reason: 'zone_not_permitted',
      detail: `zone ${request.zoneId} not in rider's zones`,
    };
  }

  if (request.requiresCashHandling && !rider.canCarryCash) {
    return {
      riderId: rider.riderId,
      reason: 'cannot_carry_cash',
      detail: 'rider is not cash-enabled or is over their float cap',
    };
  }

  return null;
}

/** Estimated seconds for this rider to reach the pickup point. */
export function estimatePickupSeconds(
  rider: RiderCandidate,
  pickup: LatLng,
  config: DispatchConfig,
): { seconds: number; metres: number } {
  const straightLine = haversineMetres(rider.location, pickup);
  const metres = straightLine * config.detourFactor;
  const speed = config.vehicleSpeedMetresPerSecond[rider.vehicleType];
  return { seconds: metres / speed, metres: straightLine };
}

function scoreRider(
  rider: RiderCandidate,
  request: DispatchRequest,
  config: DispatchConfig,
  pickupEtaSeconds: number,
  pickupDistanceMetres: number,
): ScoredRider {
  const w = config.weights;
  const factors: ScoreFactor[] = [];

  // --- Proximity: closer is better, linear to the cutoff --------------------
  const proximityRaw = Math.max(0, 1 - pickupDistanceMetres / config.maximumPickupMetres);
  factors.push({
    name: 'proximity',
    raw: proximityRaw,
    contribution: proximityRaw * w.proximity,
    explanation: `${Math.round(pickupDistanceMetres)}m from pickup`,
  });

  // --- Quality --------------------------------------------------------------
  const qualityRaw = Math.min(1, Math.max(0, rider.qualityScore / 100));
  factors.push({
    name: 'quality',
    raw: qualityRaw,
    contribution: qualityRaw * w.quality,
    explanation: `quality score ${rider.qualityScore}/100`,
  });

  // --- Fairness: riders idle longest get a boost ----------------------------
  // Without this, the same few riders nearest the busiest vendors take every
  // job and everyone else earns nothing. Saturates so it never outweighs
  // getting the food there quickly.
  const idleSeconds = rider.lastAssignedAt
    ? (request.now.getTime() - rider.lastAssignedAt.getTime()) / 1000
    : config.fairnessSaturationSeconds;
  const fairnessRaw = Math.min(1, Math.max(0, idleSeconds / config.fairnessSaturationSeconds));
  factors.push({
    name: 'fairness',
    raw: fairnessRaw,
    contribution: fairnessRaw * w.fairness,
    explanation: `waiting ${Math.round(idleSeconds / 60)} min for work`,
  });

  // --- Readiness alignment --------------------------------------------------
  // Best when the rider arrives just as the food is ready. Arriving 15 minutes
  // early wastes the rider's time; arriving late means cold food.
  const secondsUntilReady = (request.readyAt.getTime() - request.now.getTime()) / 1000;
  const arrivalGapSeconds = pickupEtaSeconds - secondsUntilReady;
  // A 5-minute window either side scores near-perfect; degrades over 15 minutes.
  const gapPenalty = Math.max(0, Math.abs(arrivalGapSeconds) - 300) / 900;
  const readinessRaw = Math.min(1, Math.max(0, 1 - gapPenalty));
  factors.push({
    name: 'readinessAlignment',
    raw: readinessRaw,
    contribution: readinessRaw * w.readinessAlignment,
    explanation:
      arrivalGapSeconds > 0
        ? `arrives ~${Math.round(arrivalGapSeconds / 60)} min after food is ready`
        : `arrives ~${Math.round(-arrivalGapSeconds / 60)} min before food is ready`,
  });

  // --- Load penalty ---------------------------------------------------------
  const capacity = VEHICLE_CAPACITY[rider.vehicleType];
  const loadRaw = rider.activeDeliveryCount / capacity;
  factors.push({
    name: 'loadPenalty',
    raw: loadRaw,
    contribution: -loadRaw * w.loadPenalty,
    explanation: `holding ${rider.activeDeliveryCount} of ${capacity} deliveries`,
  });

  // --- Staleness penalty ----------------------------------------------------
  const ageSeconds = (request.now.getTime() - rider.locationReportedAt.getTime()) / 1000;
  const stalenessRaw = Math.min(1, ageSeconds / config.maximumLocationAgeSeconds);
  factors.push({
    name: 'stalenessPenalty',
    raw: stalenessRaw,
    contribution: -stalenessRaw * w.stalenessPenalty,
    explanation: `location ${Math.round(ageSeconds)}s old`,
  });

  const score = factors.reduce((sum, factor) => sum + factor.contribution, 0);

  return {
    riderId: rider.riderId,
    score: Math.round(score * 100) / 100,
    factors,
    pickupEtaSeconds: Math.round(pickupEtaSeconds),
    pickupDistanceMetres: Math.round(pickupDistanceMetres),
  };
}

/**
 * Rank candidates and decide who to offer the order to.
 *
 * Ties break on rider id, not on array order, so the decision is reproducible
 * regardless of how the candidate list was queried.
 */
export function decideDispatch(
  request: DispatchRequest,
  candidates: readonly RiderCandidate[],
  config: DispatchConfig = DEFAULT_CONFIG,
): DispatchDecision {
  const ranked: ScoredRider[] = [];
  const excluded: ExcludedRider[] = [];

  for (const rider of candidates) {
    const { seconds, metres } = estimatePickupSeconds(rider, request.pickup, config);

    const exclusion = excludeIfIneligible(rider, request, config, metres);
    if (exclusion) {
      excluded.push(exclusion);
      continue;
    }

    ranked.push(scoreRider(rider, request, config, seconds, metres));
  }

  ranked.sort((a, b) => b.score - a.score || a.riderId.localeCompare(b.riderId));

  return {
    ruleVersion: DISPATCH_RULE_VERSION,
    orderId: request.orderId,
    decidedAt: request.now,
    ranked,
    offerTo: ranked.slice(0, config.offerBatchSize).map((r) => r.riderId),
    excluded,
    needsManualDispatch: ranked.length === 0,
  };
}

// ---------------------------------------------------------------------------
// Offer lifecycle
// ---------------------------------------------------------------------------

export type OfferStatus = 'pending' | 'accepted' | 'declined' | 'expired' | 'withdrawn';

/** How long a rider has to respond before the offer moves on. */
export const OFFER_TIMEOUT_SECONDS = 30;

/** How many rounds of offers before escalating to a human dispatcher. */
export const MAX_OFFER_ROUNDS = 4;

export interface OfferOutcome {
  readonly action: 'assign' | 'reoffer' | 'escalate';
  readonly riderId?: string;
  readonly nextRound?: number;
  readonly reason: string;
}

/**
 * Decide what happens after an offer round resolves.
 *
 * Escalation to a human is a first-class outcome, not a failure. An order that
 * nobody accepted after four rounds needs a dispatcher, and hiding that behind
 * infinite retries is how orders silently rot in a queue.
 */
export function resolveOfferRound(input: {
  acceptedBy?: string | undefined;
  round: number;
  remainingCandidates: number;
}): OfferOutcome {
  if (input.acceptedBy) {
    return { action: 'assign', riderId: input.acceptedBy, reason: 'Rider accepted the offer.' };
  }
  if (input.round >= MAX_OFFER_ROUNDS) {
    return {
      action: 'escalate',
      reason: `No rider accepted after ${MAX_OFFER_ROUNDS} rounds.`,
    };
  }
  if (input.remainingCandidates === 0) {
    return { action: 'escalate', reason: 'No eligible riders remain.' };
  }
  return {
    action: 'reoffer',
    nextRound: input.round + 1,
    reason: 'Offering to the next rider.',
  };
}
