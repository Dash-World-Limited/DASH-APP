import { describe, expect, it } from 'vitest';
import {
  decideDispatch,
  DEFAULT_CONFIG,
  DISPATCH_RULE_VERSION,
  estimatePickupSeconds,
  MAX_OFFER_ROUNDS,
  resolveOfferRound,
  type DispatchRequest,
  type RiderCandidate,
} from './index.js';
import type { LatLng } from '../geo/index.js';

const NOW = new Date('2026-08-30T18:00:00Z');
const PICKUP: LatLng = { latitude: 6.4281, longitude: 3.4219 }; // Victoria Island
const DROPOFF: LatLng = { latitude: 6.4478, longitude: 3.4723 }; // Lekki Phase 1

/** A rider ~500m from the pickup, idle, fresh location, good quality. */
function rider(overrides: Partial<RiderCandidate> = {}): RiderCandidate {
  return {
    riderId: 'rid_base',
    location: { latitude: 6.4325, longitude: 3.4235 },
    locationReportedAt: new Date(NOW.getTime() - 10_000),
    availability: 'idle',
    vehicleType: 'motorcycle',
    activeDeliveryCount: 0,
    qualityScore: 85,
    lastAssignedAt: new Date(NOW.getTime() - 600_000),
    canCarryCash: true,
    ...overrides,
  };
}

const REQUEST: DispatchRequest = {
  orderId: 'ord_1',
  pickup: PICKUP,
  dropoff: DROPOFF,
  zoneId: 'zone_vi',
  minimumVehicle: 'bicycle',
  requiresCashHandling: false,
  readyAt: new Date(NOW.getTime() + 5 * 60_000),
  now: NOW,
};

describe('estimatePickupSeconds', () => {
  it('scales with the detour factor and vehicle speed', () => {
    const bike = estimatePickupSeconds(rider({ vehicleType: 'bicycle' }), PICKUP, DEFAULT_CONFIG);
    const moto = estimatePickupSeconds(rider({ vehicleType: 'motorcycle' }), PICKUP, DEFAULT_CONFIG);
    expect(moto.seconds).toBeLessThan(bike.seconds);
    expect(moto.metres).toBeCloseTo(bike.metres, 6);
  });
});

describe('hard eligibility filters', () => {
  it('excludes an offline rider', () => {
    const decision = decideDispatch(REQUEST, [rider({ availability: 'offline' })]);
    expect(decision.ranked).toHaveLength(0);
    expect(decision.excluded[0]?.reason).toBe('not_idle');
    expect(decision.needsManualDispatch).toBe(true);
  });

  it('excludes a rider on a break', () => {
    const decision = decideDispatch(REQUEST, [rider({ availability: 'on_break' })]);
    expect(decision.excluded[0]?.reason).toBe('not_idle');
  });

  it('excludes a rider whose location is stale beyond the grace window', () => {
    // Past the grace window there is nothing left to justify even waking them:
    // a position this old says little about where the rider is now.
    const decision = decideDispatch(REQUEST, [
      rider({
        locationReportedAt: new Date(NOW.getTime() - (DEFAULT_CONFIG.offerGraceSeconds + 60) * 1000),
      }),
    ]);
    expect(decision.excluded[0]?.reason).toBe('location_stale');
    expect(decision.ranked).toHaveLength(0);
  });

  it('admits a rider inside the grace window, marked as grace', () => {
    // Too stale to be given the delivery, fresh enough to be worth waking. The
    // acceptance path demands a current fix before any assignment, so this can
    // only ever produce a notification — see acceptance.ts.
    const decision = decideDispatch(REQUEST, [
      rider({ locationReportedAt: new Date(NOW.getTime() - 300_000) }),
    ]);
    expect(decision.excluded).toHaveLength(0);
    expect(decision.ranked[0]?.eligibilityMode).toBe('grace');
  });

  it('marks a rider inside the normal window as fresh', () => {
    const decision = decideDispatch(REQUEST, [
      rider({ locationReportedAt: new Date(NOW.getTime() - 30_000) }),
    ]);
    expect(decision.ranked[0]?.eligibilityMode).toBe('fresh');
  });

  it('offers to a live rider ahead of a closer sleeping one', () => {
    // Mode is the primary sort key. A grace rider may score higher — they can
    // be nearer, or better rested — and must still lose to anyone awake, because
    // reaching them costs a push, a cold start and a GPS fix, and they may turn
    // out to be ineligible once they wake.
    const decision = decideDispatch(REQUEST, [
      rider({
        riderId: 'sleeping-and-nearer',
        location: PICKUP,
        locationReportedAt: new Date(NOW.getTime() - 300_000),
      }),
      rider({ riderId: 'awake', locationReportedAt: new Date(NOW.getTime() - 30_000) }),
    ]);

    expect(decision.ranked[0]?.riderId).toBe('awake');
    expect(decision.ranked[0]?.eligibilityMode).toBe('fresh');
    expect(decision.offerTo).toEqual(['awake']);
  });

  it('excludes a rider whose location is timestamped in the future', () => {
    const decision = decideDispatch(REQUEST, [
      rider({ locationReportedAt: new Date(NOW.getTime() + 60_000) }),
    ]);
    expect(decision.excluded[0]?.reason).toBe('location_stale');
  });

  it('excludes a rider beyond the maximum pickup radius', () => {
    const decision = decideDispatch(REQUEST, [
      rider({ location: { latitude: 6.9, longitude: 3.9 } }),
    ]);
    expect(decision.excluded[0]?.reason).toBe('too_far');
  });

  it('never assigns a job the vehicle cannot carry, however close the rider', () => {
    // A bicycle rider standing on the vendor's doorstep still cannot take a
    // van-sized order. No score can rescue this.
    const decision = decideDispatch(
      { ...REQUEST, minimumVehicle: 'van' },
      [rider({ vehicleType: 'bicycle', location: PICKUP })],
    );
    expect(decision.ranked).toHaveLength(0);
    expect(decision.excluded[0]?.reason).toBe('vehicle_insufficient');
  });

  it('excludes a rider at vehicle capacity', () => {
    const decision = decideDispatch(REQUEST, [
      rider({ vehicleType: 'motorcycle', activeDeliveryCount: 3 }),
    ]);
    expect(decision.excluded[0]?.reason).toBe('at_capacity');
  });

  it('excludes a rider not permitted in the zone', () => {
    const decision = decideDispatch(REQUEST, [rider({ allowedZoneIds: ['zone_ikeja'] })]);
    expect(decision.excluded[0]?.reason).toBe('zone_not_permitted');
  });

  it('treats an empty zone list as unrestricted', () => {
    const decision = decideDispatch(REQUEST, [rider({ allowedZoneIds: [] })]);
    expect(decision.ranked).toHaveLength(1);
  });

  it('excludes a non-cash rider from a cash order', () => {
    const decision = decideDispatch(
      { ...REQUEST, requiresCashHandling: true },
      [rider({ canCarryCash: false })],
    );
    expect(decision.excluded[0]?.reason).toBe('cannot_carry_cash');
  });

  it('explains every exclusion', () => {
    const decision = decideDispatch(REQUEST, [
      rider({ riderId: 'a', availability: 'offline' }),
      rider({ riderId: 'b', location: { latitude: 6.9, longitude: 3.9 } }),
      rider({ riderId: 'c', vehicleType: 'on_foot' }),
    ]);
    expect(decision.excluded).toHaveLength(3);
    for (const exclusion of decision.excluded) {
      expect(exclusion.detail.length).toBeGreaterThan(0);
      expect(exclusion.riderId).toBeTruthy();
    }
  });
});

describe('scoring', () => {
  it('prefers the closer rider, all else equal', () => {
    const near = rider({ riderId: 'near', location: { latitude: 6.4290, longitude: 3.4225 } });
    const far = rider({ riderId: 'far', location: { latitude: 6.4600, longitude: 3.4600 } });
    const decision = decideDispatch(REQUEST, [far, near]);
    expect(decision.ranked[0]?.riderId).toBe('near');
    expect(decision.offerTo).toEqual(['near']);
  });

  it('prefers the higher-quality rider at equal distance', () => {
    const good = rider({ riderId: 'good', qualityScore: 95 });
    const poor = rider({ riderId: 'poor', qualityScore: 40 });
    const decision = decideDispatch(REQUEST, [poor, good]);
    expect(decision.ranked[0]?.riderId).toBe('good');
  });

  it('gives idle riders a fairness boost so work is spread', () => {
    const justFinished = rider({
      riderId: 'busy',
      lastAssignedAt: new Date(NOW.getTime() - 10_000),
    });
    const waitingAges = rider({
      riderId: 'waiting',
      lastAssignedAt: new Date(NOW.getTime() - 3_600_000),
    });
    const decision = decideDispatch(REQUEST, [justFinished, waitingAges]);
    expect(decision.ranked[0]?.riderId).toBe('waiting');
  });

  it('does not let fairness override a much closer rider', () => {
    // Fairness spreads work; it must never send food on a long detour.
    const closeButBusy = rider({
      riderId: 'close',
      location: PICKUP,
      lastAssignedAt: new Date(NOW.getTime() - 10_000),
    });
    const idleButFar = rider({
      riderId: 'far',
      location: { latitude: 6.49, longitude: 3.49 },
      lastAssignedAt: new Date(NOW.getTime() - 7_200_000),
    });
    const decision = decideDispatch(REQUEST, [idleButFar, closeButBusy]);
    expect(decision.ranked[0]?.riderId).toBe('close');
  });

  it('penalises a rider already carrying deliveries', () => {
    const empty = rider({ riderId: 'empty', activeDeliveryCount: 0 });
    const loaded = rider({ riderId: 'loaded', activeDeliveryCount: 2 });
    const decision = decideDispatch(REQUEST, [loaded, empty]);
    expect(decision.ranked[0]?.riderId).toBe('empty');
  });

  it('prefers a rider who arrives near the ready time over one who idles', () => {
    // Food is ready in 20 minutes. A rider 1 minute away would wait 19 minutes.
    const request = { ...REQUEST, readyAt: new Date(NOW.getTime() + 20 * 60_000) };
    const onDoorstep = rider({ riderId: 'doorstep', location: PICKUP });
    const tenMinutesOut = rider({
      riderId: 'ten',
      location: { latitude: 6.462, longitude: 3.445 },
    });
    const decision = decideDispatch(request, [onDoorstep, tenMinutesOut]);

    const doorstepScore = decision.ranked.find((r) => r.riderId === 'doorstep');
    const tenScore = decision.ranked.find((r) => r.riderId === 'ten');
    const doorstepReadiness = doorstepScore?.factors.find((f) => f.name === 'readinessAlignment');
    const tenReadiness = tenScore?.factors.find((f) => f.name === 'readinessAlignment');

    expect(tenReadiness?.contribution).toBeGreaterThan(doorstepReadiness?.contribution ?? 0);
  });

  it('explains every factor that contributed to a score', () => {
    const decision = decideDispatch(REQUEST, [rider()]);
    const scored = decision.ranked[0];
    expect(scored).toBeDefined();
    expect(scored?.factors.length).toBe(6);
    for (const factor of scored?.factors ?? []) {
      expect(factor.explanation.length).toBeGreaterThan(0);
      expect(Number.isFinite(factor.contribution)).toBe(true);
      expect(factor.raw).toBeGreaterThanOrEqual(0);
      expect(factor.raw).toBeLessThanOrEqual(1);
    }
    // The score is the sum of its parts — no hidden term.
    const summed = (scored?.factors ?? []).reduce((total, f) => total + f.contribution, 0);
    expect(scored?.score).toBeCloseTo(summed, 1);
  });
});

describe('determinism and reproducibility', () => {
  it('stamps the rule version on every decision', () => {
    expect(decideDispatch(REQUEST, [rider()]).ruleVersion).toBe(DISPATCH_RULE_VERSION);
  });

  it('produces the same ranking regardless of candidate order', () => {
    const candidates = [
      rider({ riderId: 'a', qualityScore: 70 }),
      rider({ riderId: 'b', qualityScore: 90 }),
      rider({ riderId: 'c', qualityScore: 80 }),
    ];
    const forward = decideDispatch(REQUEST, candidates).ranked.map((r) => r.riderId);
    const reversed = decideDispatch(REQUEST, [...candidates].reverse()).ranked.map((r) => r.riderId);
    expect(forward).toEqual(reversed);
  });

  it('breaks exact ties on rider id, not on array position', () => {
    // Two riders identical in every respect.
    const zed = rider({ riderId: 'rid_z' });
    const alpha = rider({ riderId: 'rid_a' });
    expect(decideDispatch(REQUEST, [zed, alpha]).ranked[0]?.riderId).toBe('rid_a');
    expect(decideDispatch(REQUEST, [alpha, zed]).ranked[0]?.riderId).toBe('rid_a');
  });

  it('ranks every eligible rider and excludes every ineligible one, with no losses', () => {
    const candidates = [
      rider({ riderId: 'ok1' }),
      rider({ riderId: 'ok2', qualityScore: 60 }),
      rider({ riderId: 'off', availability: 'offline' }),
      rider({ riderId: 'far', location: { latitude: 7.5, longitude: 4.5 } }),
    ];
    const decision = decideDispatch(REQUEST, candidates);
    expect(decision.ranked.length + decision.excluded.length).toBe(candidates.length);
  });
});

describe('offer batching', () => {
  it('offers to one rider at a time by default', () => {
    const decision = decideDispatch(REQUEST, [
      rider({ riderId: 'a' }),
      rider({ riderId: 'b' }),
      rider({ riderId: 'c' }),
    ]);
    expect(decision.offerTo).toHaveLength(1);
  });

  it('offers to a batch when configured', () => {
    const decision = decideDispatch(
      REQUEST,
      [rider({ riderId: 'a' }), rider({ riderId: 'b' }), rider({ riderId: 'c' })],
      { ...DEFAULT_CONFIG, offerBatchSize: 2 },
    );
    expect(decision.offerTo).toHaveLength(2);
  });

  it('offers to nobody when nobody qualifies', () => {
    const decision = decideDispatch(REQUEST, [rider({ availability: 'offline' })]);
    expect(decision.offerTo).toHaveLength(0);
    expect(decision.needsManualDispatch).toBe(true);
  });

  it('flags manual dispatch on an empty candidate list', () => {
    const decision = decideDispatch(REQUEST, []);
    expect(decision.needsManualDispatch).toBe(true);
    expect(decision.excluded).toHaveLength(0);
  });
});

describe('resolveOfferRound', () => {
  it('assigns when a rider accepts', () => {
    const outcome = resolveOfferRound({ acceptedBy: 'rid_1', round: 1, remainingCandidates: 3 });
    expect(outcome.action).toBe('assign');
    expect(outcome.riderId).toBe('rid_1');
  });

  it('re-offers while candidates and rounds remain', () => {
    const outcome = resolveOfferRound({ round: 1, remainingCandidates: 2 });
    expect(outcome.action).toBe('reoffer');
    expect(outcome.nextRound).toBe(2);
  });

  it('escalates to a human rather than retrying forever', () => {
    const outcome = resolveOfferRound({ round: MAX_OFFER_ROUNDS, remainingCandidates: 5 });
    expect(outcome.action).toBe('escalate');
  });

  it('escalates immediately when candidates run out', () => {
    const outcome = resolveOfferRound({ round: 1, remainingCandidates: 0 });
    expect(outcome.action).toBe('escalate');
  });

  it('always gives a reason a dispatcher can read', () => {
    for (const input of [
      { acceptedBy: 'r', round: 1, remainingCandidates: 1 },
      { round: 1, remainingCandidates: 1 },
      { round: MAX_OFFER_ROUNDS, remainingCandidates: 1 },
      { round: 1, remainingCandidates: 0 },
    ]) {
      expect(resolveOfferRound(input).reason.length).toBeGreaterThan(5);
    }
  });
});
