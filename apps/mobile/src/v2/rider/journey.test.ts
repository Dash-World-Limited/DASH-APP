/**
 * The rider journey's rules: one next action per state, in the order the
 * server accepts them; the pickup code exactly while the shop needs it; and
 * distances and times worded as what they are.
 */

import { describe, expect, it } from 'vitest';

import {
  JOURNEY_STEPS,
  externalNavigationUrl,
  formatAgo,
  formatDistance,
  formatEta,
  gpsFreshness,
  journeyStage,
  offerWindowSeconds,
  pickupCodeVisible,
  RELEASE_REASONS,
  riderCanRelease,
  riderCancelMode,
  straightLineMetres,
} from './journey';
import type { DeliveryStatus } from './RiderFlowProvider';

const ORDER: DeliveryStatus[] = ['rider_assigned', 'rider_arrived', 'picked_up', 'en_route', 'arrived', 'delivered'];

describe('journeyStage', () => {
  it('moves through the states in the order the server accepts from a rider', () => {
    for (let index = 0; index < ORDER.length - 2; index += 1) {
      const action = journeyStage(ORDER[index]!).action;
      expect(action, ORDER[index]).toMatchObject({ kind: 'progress', to: ORDER[index + 1] });
    }
  });

  it('asks for the delivery PIN only at the drop-off', () => {
    expect(journeyStage('arrived').action).toEqual({ kind: 'pin', label: 'Complete delivery' });
    for (const status of ORDER.filter((value) => value !== 'arrived')) {
      expect(journeyStage(status).action?.kind).not.toBe('pin');
    }
  });

  it('heads to the shop before collection and to the customer after', () => {
    expect(journeyStage('rider_assigned').target).toBe('pickup');
    expect(journeyStage('rider_arrived').target).toBe('pickup');
    expect(journeyStage('picked_up').target).toBe('dropoff');
    expect(journeyStage('en_route').target).toBe('dropoff');
    expect(journeyStage('arrived').target).toBe('dropoff');
  });

  it('ends with no action and no destination once delivered', () => {
    expect(journeyStage('delivered')).toMatchObject({ step: JOURNEY_STEPS.length, target: null, action: null });
  });

  it('numbers each step within the visible step list', () => {
    ORDER.slice(0, 5).forEach((status, index) => expect(journeyStage(status).step).toBe(index));
  });
});

describe('pickupCodeVisible', () => {
  it('shows the code only while the shop is waiting for the rider', () => {
    expect(ORDER.filter(pickupCodeVisible)).toEqual(['rider_assigned', 'rider_arrived']);
  });
});

describe('distances and times', () => {
  it('measures the straight line between two real coordinates', () => {
    // Two points in Lagos 0.0193° of latitude and 0.0503° of longitude apart:
    // 5.96 km on the great circle (checked independently with the haversine
    // formula). A road between them would be longer; this is not a road.
    const metres = straightLineMetres({ latitude: 6.4474, longitude: 3.4722 }, { latitude: 6.4281, longitude: 3.4219 });
    expect(metres).toBeGreaterThan(5_700);
    expect(metres).toBeLessThan(6_100);
  });

  it('is zero for the same point', () => {
    expect(straightLineMetres({ latitude: 6.5, longitude: 3.3 }, { latitude: 6.5, longitude: 3.3 })).toBe(0);
  });

  it.each([
    [4, '10 m'],
    [432, '430 m'],
    [1_240, '1.2 km'],
    [12_600, '13 km'],
    [Number.NaN, '—'],
  ])('formats %s metres as %s', (metres, text) => {
    expect(formatDistance(metres)).toBe(text);
  });

  it('words an ETA as an estimate and drops a missing one', () => {
    expect(formatEta(380)).toBe('about 6 min');
    expect(formatEta(20)).toBe('about 1 min');
    expect(formatEta(null)).toBeNull();
    expect(formatEta(undefined)).toBeNull();
  });

  it('says how long ago something happened', () => {
    expect(formatAgo(null, 10_000)).toBeNull();
    expect(formatAgo(9_000, 10_000)).toBe('just now');
    expect(formatAgo(0, 42_000)).toBe('42s ago');
    expect(formatAgo(0, 125_000)).toBe('2 min ago');
  });
});

describe('gpsFreshness', () => {
  it('is live for a recent fix, stale for an old one, none without one', () => {
    expect(gpsFreshness(null, 100_000)).toBe('none');
    expect(gpsFreshness(90_000, 100_000)).toBe('live');
    expect(gpsFreshness(60_000, 100_000)).toBe('stale');
  });
});

describe('offerWindowSeconds', () => {
  it('starts the ring full from when this phone first saw the offer', () => {
    const seenAt = Date.parse('2026-10-12T10:00:05Z');
    expect(offerWindowSeconds('2026-10-12T10:00:30Z', seenAt)).toBe(25);
  });

  it('never returns zero, so the ring cannot divide by it', () => {
    expect(offerWindowSeconds('2026-10-12T10:00:00Z', Date.parse('2026-10-12T10:01:00Z'))).toBe(1);
    expect(offerWindowSeconds('not a date', 0)).toBe(1);
  });
});

describe('externalNavigationUrl', () => {
  const shop = { latitude: 6.4474, longitude: 3.4722 };

  it('hands Android a geo: intent so the rider chooses their navigation app', () => {
    expect(externalNavigationUrl(shop, 'Shop & Co', 'android')).toBe('geo:6.4474,3.4722?q=6.4474,3.4722(Shop%20%26%20Co)');
  });

  it('hands iOS to Apple Maps with the destination', () => {
    expect(externalNavigationUrl(shop, 'Shop', 'ios')).toContain('daddr=6.4474,3.4722');
  });
});

describe('riderCanRelease', () => {
  it('offers giving a job back only before the rider has the order', () => {
    const allowed = (['rider_assigned', 'rider_arrived', 'picked_up', 'en_route', 'arrived', 'delivered'] as DeliveryStatus[]).filter(riderCanRelease);
    expect(allowed).toEqual(['rider_assigned', 'rider_arrived']);
  });

  it('offers exactly the reasons the API accepts', () => {
    // Mirrors RELEASE_REASONS in apps/api/src/routes/rider.ts.
    expect(RELEASE_REASONS.map((reason) => reason.code)).toEqual([
      'vehicle_problem',
      'emergency',
      'vendor_closed_or_unreachable',
      'order_not_ready_too_long',
      'unsafe_location',
      'other',
    ]);
  });
});

describe('riderCancelMode', () => {
  it('hands the job back before pickup, escalates after, and offers nothing once delivered', () => {
    const modes = (['rider_assigned', 'rider_arrived', 'picked_up', 'en_route', 'arrived', 'delivered'] as DeliveryStatus[]).map(riderCancelMode);
    expect(modes).toEqual(['release', 'release', 'escalate', 'escalate', 'escalate', null]);
  });
});
