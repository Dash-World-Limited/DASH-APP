/**
 * The invariant, asserted directly.
 *
 *   **No order may reach `rider_assigned` while the accepting rider's
 *   authoritative `locationReportedAt` is older than 120 seconds.**
 *
 * Everything in the grace design is mechanism; this is the property being
 * bought. It is asserted here against the pure decision function rather than
 * inferred from the mechanism working, because a test that exercises the
 * mechanism only proves the paths it happens to walk — and the thing that must
 * be true is a statement about *every* path.
 *
 * The reason it matters: a grace offer is created from a position too old to
 * assign on, deliberately, so a rider whose app was killed can be woken by a
 * push. If acceptance did not re-check, that stale position would flow straight
 * through to an assignment and dispatch's freshness rule would be gone —
 * not moved, gone.
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG, offerTtlSecondsFor } from './index.js';
import {
  countsAsDecline,
  judgeAcceptance,
  shouldRedispatch,
  type AcceptanceCandidate,
  type AcceptanceContext,
  type AcceptanceRefusal,
} from './acceptance.js';

const NOW = new Date('2026-09-07T21:00:00.000Z');
const secondsAgo = (n: number): Date => new Date(NOW.getTime() - n * 1000);
const secondsAhead = (n: number): Date => new Date(NOW.getTime() + n * 1000);

/** A rider who should be allowed through, so each test changes exactly one thing. */
const eligible = (over: Partial<AcceptanceCandidate> = {}): AcceptanceCandidate => ({
  riderStatus: 'approved',
  availability: 'idle',
  onlineUntil: secondsAhead(600),
  locationReportedAt: secondsAgo(10),
  activeDeliveryCount: 0,
  capacity: 3,
  allowedZoneIds: ['zone-a'],
  ...over,
});

const context = (over: Partial<AcceptanceContext> = {}): AcceptanceContext => ({
  now: NOW,
  offerStatus: 'pending',
  offerExpiresAt: secondsAhead(20),
  pickupDistanceMetres: 600,
  pickupZoneId: 'zone-a',
  ...over,
});

describe('the freshness invariant', () => {
  it('allows an acceptance backed by a fresh position', () => {
    expect(judgeAcceptance(eligible(), context()).allowed).toBe(true);
  });

  it('refuses every position older than the limit, exhaustively', () => {
    // Walked one second at a time across the boundary rather than spot-checked,
    // because an off-by-one here is the whole invariant.
    const limit = DEFAULT_CONFIG.maximumLocationAgeSeconds;
    for (let age = 0; age <= limit + 60; age += 1) {
      const verdict = judgeAcceptance(eligible({ locationReportedAt: secondsAgo(age) }), context());
      if (age <= limit) {
        expect(verdict.allowed, `age ${age}s`).toBe(true);
      } else {
        expect(verdict.allowed, `age ${age}s`).toBe(false);
        expect(verdict.refusal, `age ${age}s`).toBe('location_stale');
      }
    }
  });

  it('refuses a position inside the grace window but outside the assignment window', () => {
    // The exact case the grace design creates: old enough to have been woken,
    // far too old to be given the delivery.
    for (const age of [121, 300, DEFAULT_CONFIG.offerGraceSeconds]) {
      const verdict = judgeAcceptance(eligible({ locationReportedAt: secondsAgo(age) }), context());
      expect(verdict.allowed, `${age}s`).toBe(false);
      expect(verdict.refusal, `${age}s`).toBe('location_stale');
    }
  });

  it('refuses a rider who has never reported a position', () => {
    const verdict = judgeAcceptance(eligible({ locationReportedAt: null }), context());
    expect(verdict.allowed).toBe(false);
    expect(verdict.refusal).toBe('location_missing');
  });

  it('refuses a position stamped in the future', () => {
    // A clock-skewed or forged timestamp must not read as "very fresh".
    const verdict = judgeAcceptance(
      eligible({ locationReportedAt: secondsAhead(30) }),
      context(),
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.refusal).toBe('location_stale');
  });

  it('cannot be satisfied by any other field being favourable', () => {
    // The adversarial shape: everything else is perfect, the position is not.
    // No combination of approval, lease, capacity or proximity may compensate.
    const stale = { locationReportedAt: secondsAgo(500) };
    for (const over of [
      { availability: 'idle' },
      { availability: 'on_delivery' },
      { activeDeliveryCount: 0 },
      { onlineUntil: secondsAhead(86_400) },
      { allowedZoneIds: [] },
    ]) {
      const verdict = judgeAcceptance(eligible({ ...stale, ...over }), context({ pickupDistanceMetres: 1 }));
      expect(verdict.allowed, JSON.stringify(over)).toBe(false);
    }
  });
});

describe('state that changed between the offer and the acceptance', () => {
  const cases: [string, Partial<AcceptanceCandidate>, AcceptanceRefusal][] = [
    ['suspended after the offer', { riderStatus: 'suspended' }, 'not_approved'],
    ['rejected after the offer', { riderStatus: 'rejected' }, 'not_approved'],
    ['went offline deliberately', { onlineUntil: null }, 'not_online'],
    ['lease expired', { onlineUntil: secondsAgo(1) }, 'lease_expired'],
    ['went on break', { availability: 'on_break' }, 'not_available'],
    ['set offline', { availability: 'offline' }, 'not_available'],
    ['filled up', { activeDeliveryCount: 3, capacity: 3 }, 'at_capacity'],
  ];

  for (const [name, over, expected] of cases) {
    it(`refuses a rider who ${name}`, () => {
      const verdict = judgeAcceptance(eligible(over), context());
      expect(verdict.allowed).toBe(false);
      expect(verdict.refusal).toBe(expected);
    });
  }

  it('refuses a rider who moved outside the pickup radius', () => {
    const verdict = judgeAcceptance(
      eligible(),
      context({ pickupDistanceMetres: DEFAULT_CONFIG.maximumPickupMetres + 1 }),
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.refusal).toBe('too_far');
  });

  it('refuses a rider whose fresh position is outside a permitted zone', () => {
    const verdict = judgeAcceptance(
      eligible({ allowedZoneIds: ['zone-b'] }),
      context({ pickupZoneId: 'zone-a' }),
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.refusal).toBe('zone_not_permitted');
  });

  it('allows an unrestricted rider into any zone', () => {
    // An empty permission list means "not zone-restricted", not "permitted
    // nowhere" — the same reading dispatch uses.
    expect(
      judgeAcceptance(eligible({ allowedZoneIds: [] }), context({ pickupZoneId: 'zone-z' })).allowed,
    ).toBe(true);
  });

  it('lets a working rider stack a second delivery up to capacity', () => {
    expect(
      judgeAcceptance(eligible({ availability: 'on_delivery', activeDeliveryCount: 1 }), context())
        .allowed,
    ).toBe(true);
  });
});

describe('the offer itself', () => {
  it('refuses an offer that is no longer pending', () => {
    for (const status of ['accepted', 'declined', 'expired', 'withdrawn']) {
      const verdict = judgeAcceptance(eligible(), context({ offerStatus: status }));
      expect(verdict.allowed, status).toBe(false);
      expect(verdict.refusal, status).toBe('offer_not_pending');
    }
  });

  it('refuses an offer at the instant it expires', () => {
    // Expiry is not a grace of its own: at exactly the expiry moment the offer
    // is gone, so a fix arriving on the boundary loses.
    expect(judgeAcceptance(eligible(), context({ offerExpiresAt: NOW })).refusal).toBe(
      'offer_expired',
    );
    expect(judgeAcceptance(eligible(), context({ offerExpiresAt: secondsAgo(1) })).refusal).toBe(
      'offer_expired',
    );
  });

  it('allows a fix that arrives one second before expiry', () => {
    expect(judgeAcceptance(eligible(), context({ offerExpiresAt: secondsAhead(1) })).allowed).toBe(
      true,
    );
  });
});

describe('how a refusal is treated', () => {
  it('never counts as a decline', () => {
    // Every refusal is the rider being unable, not unwilling. Recording these
    // against an acceptance rate would punish riders for a slow GPS and create
    // an incentive to leave the app burning battery.
    expect(countsAsDecline()).toBe(false);
  });

  it('sends the order back to dispatch when this rider cannot take it', () => {
    for (const refusal of [
      'not_approved', 'not_online', 'lease_expired', 'not_available',
      'at_capacity', 'location_missing', 'location_stale',
      'zone_not_permitted', 'too_far',
    ] as AcceptanceRefusal[]) {
      expect(shouldRedispatch(refusal), refusal).toBe(true);
    }
  });

  it('does not re-dispatch when the order is not waiting on this rider', () => {
    // Someone else already resolved it, or the worker is about to re-round.
    expect(shouldRedispatch('offer_not_pending')).toBe(false);
    expect(shouldRedispatch('offer_expired')).toBe(false);
  });
});

describe('how long a rider has to answer', () => {
  /**
   * Proven on a handset: a rider swiped DASH away and dispatch ran seconds
   * later. Their position was 82s old — well inside the freshness window — so
   * the offer was treated as one an open app would answer and given thirty
   * seconds. The process was already dead. The push arrived, the rider tapped
   * it, the app cold-started, and the offer had expired while they were still
   * signing in.
   *
   * Location freshness is a fact about where a phone was. It says nothing
   * about whether anything is still running on it.
   */
  it('gives a live client the short deadline', () => {
    expect(offerTtlSecondsFor('live')).toBe(DEFAULT_CONFIG.offerTtlSeconds);
  });

  it('gives a killed or swiped client the wake deadline', () => {
    expect(offerTtlSecondsFor('unknown')).toBe(DEFAULT_CONFIG.graceOfferTtlSeconds);
  });

  it('does not shorten the deadline just because the position is fresh', () => {
    // The exact regression. Freshness is not an input here at all — there is
    // no argument for it — which is what makes the mistake unrepresentable
    // rather than merely avoided.
    expect(offerTtlSecondsFor('unknown')).toBeGreaterThan(offerTtlSecondsFor('live'));
  });

  it('resolves uncertainty towards the longer deadline', () => {
    // Being wrong this way costs an order sixty seconds before it re-rounds.
    // Being wrong the other way wakes a rider and takes the work away before
    // they can reach it. A deployment that cannot determine liveness at all
    // therefore degrades safely instead of reintroducing the bug.
    expect(offerTtlSecondsFor('unknown')).toBe(DEFAULT_CONFIG.graceOfferTtlSeconds);
  });

  it('leaves the wake deadline long enough for the measured cold-start path', () => {
    // FCM delivery, the rider noticing, a cold start, and a GPS acquisition
    // measured at 8-48s on real hardware. Thirty seconds loses that race.
    expect(DEFAULT_CONFIG.graceOfferTtlSeconds).toBeGreaterThanOrEqual(60);
  });
});
