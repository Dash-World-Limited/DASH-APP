import { describe, expect, it } from 'vitest';

import { prepTimeChoices, vendorActions } from './vendor-orders';

describe('what the vendor console offers', () => {
  it('offers accept and reject only for a new order', () => {
    for (const status of ['placed', 'vendor_reviewing']) {
      expect(vendorActions({ status }), status).toMatchObject({ accept: true, reject: true, markReady: false });
    }
    expect(vendorActions({ status: 'accepted' })).toMatchObject({ accept: false, startPreparing: true });
  });

  it('keeps "food ready" available after a rider takes the order, until it is recorded', () => {
    for (const status of ['rider_assigned', 'rider_arrived']) {
      expect(vendorActions({ status, readyAt: null }), status).toMatchObject({ markReady: true, foodReadyRecorded: false });
      expect(vendorActions({ status, readyAt: '2026-09-28T12:00:00Z' }), status).toMatchObject({
        markReady: false,
        foodReadyRecorded: true,
      });
    }
    expect(vendorActions({ status: 'preparing' }).markReady).toBe(true);
  });

  it('offers pickup verification when the rider is at the counter', () => {
    // The regression: the button disappeared the moment the rider marked arrived.
    expect(vendorActions({ status: 'rider_arrived' }).verifyPickup).toBe(true);
    expect(vendorActions({ status: 'rider_assigned' }).verifyPickup).toBe(true);
    expect(vendorActions({ status: 'ready' }).verifyPickup).toBe(true);
    for (const status of ['placed', 'accepted', 'preparing', 'picked_up', 'delivered', 'cancelled']) {
      expect(vendorActions({ status }).verifyPickup, status).toBe(false);
    }
  });

  it('offers cancel from accepting until a rider collects the food', () => {
    for (const status of ['accepted', 'preparing', 'ready', 'rider_assigned', 'rider_arrived']) {
      expect(vendorActions({ status }).cancel, status).toBe(true);
    }
    for (const status of ['placed', 'vendor_reviewing', 'picked_up', 'en_route', 'arrived', 'delivered', 'cancelled', 'rejected']) {
      expect(vendorActions({ status }).cancel, status).toBe(false);
    }
  });

  it('says a rider is being found rather than implying one is coming', () => {
    expect(vendorActions({ status: 'ready', riderSearch: 'finding' }).riderSearchNote).toMatch(/Nobody is on the way yet/);
    expect(vendorActions({ status: 'ready', riderSearch: 'finding_another' }).riderSearchNote).toMatch(/finding another rider/);
    expect(vendorActions({ status: 'rider_assigned', riderSearch: null }).riderSearchNote).toBeNull();
  });

  it('offers nothing on a stopped order, and says so', () => {
    for (const status of ['cancelled', 'rejected']) {
      const actions = vendorActions({ status });
      expect(actions.stopped, status).toBe(true);
      expect([actions.accept, actions.startPreparing, actions.markReady, actions.verifyPickup]).toEqual([false, false, false, false]);
    }
  });
});

describe('prep time', () => {
  it('pre-selects the branch default and always offers it', () => {
    expect(prepTimeChoices(25)).toEqual({ choices: [10, 15, 20, 25, 30, 45, 60], initial: 25 });
    expect(prepTimeChoices(20)).toEqual({ choices: [10, 15, 20, 30, 45, 60], initial: 20 });
  });

  it('falls back to 20 minutes for a missing or impossible default', () => {
    for (const value of [null, undefined, 0, -5, 181, 12.5]) {
      expect(prepTimeChoices(value as number | null | undefined).initial, String(value)).toBe(20);
    }
  });
});
