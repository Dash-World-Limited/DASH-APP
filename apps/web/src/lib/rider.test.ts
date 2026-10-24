/**
 * Location reporting must not stop when a rider starts a delivery.
 *
 * The rider screen's `availability` covers only the three states the rider can
 * select. The server has a fourth, `on_delivery`, which it sets on assignment,
 * and both the offer subscription and the GPS reporting loop are gated on the
 * screen's value. Reporting therefore survives a delivery only because
 * hydration folds `on_delivery` into `idle` — a one-line mapping with no test
 * behind it, guarding the moment a customer is actively watching the rider
 * approach.
 *
 * These assertions are over the server's own vocabulary, so the rule holds
 * whatever the screen later decides to display.
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  diagnosticsEnabled,
  isOfferNoLongerAvailable,
  shouldReportLocation,
  toScreenAvailability,
  type RiderAvailability,
} from './rider';

const ALL: RiderAvailability[] = ['offline', 'idle', 'on_break', 'on_delivery'];

describe('shouldReportLocation', () => {
  it('keeps reporting once the rider is on a delivery', () => {
    expect(shouldReportLocation('on_delivery')).toBe(true);
  });

  it('reports while idle and waiting for work', () => {
    expect(shouldReportLocation('idle')).toBe(true);
  });

  it('does not track a rider who is not working', () => {
    expect(shouldReportLocation('offline')).toBe(false);
    expect(shouldReportLocation('on_break')).toBe(false);
  });

  it('stops only for a rider who is not working', () => {
    const reporting = ALL.filter(shouldReportLocation);
    expect(reporting).toEqual(['idle', 'on_delivery']);
  });
});

describe('toScreenAvailability', () => {
  it('shows a rider on a delivery as working, not offline', () => {
    expect(toScreenAvailability('on_delivery')).toBe('idle');
  });

  it('passes the selectable states through untouched', () => {
    expect(toScreenAvailability('offline')).toBe('offline');
    expect(toScreenAvailability('idle')).toBe('idle');
    expect(toScreenAvailability('on_break')).toBe('on_break');
  });

  it('never maps a working state to offline', () => {
    for (const state of ALL) {
      if (state === 'offline') continue;
      expect(toScreenAvailability(state)).not.toBe('offline');
    }
  });
});

/**
 * A rider tapping Accept on an offer that has already gone.
 *
 * Regression suite for a defect found on a physical handset: the Accept and
 * Decline buttons called the API as a floating promise with no `catch`, so
 * when the rider tapped an offer that had expired seconds earlier the 409 went
 * unhandled and Next.js rendered a full-screen developer error over a working
 * app. The rider had done nothing wrong and the trip was never at risk.
 */
describe('isOfferNoLongerAvailable', () => {
  it('treats a 409 as an offer that has gone, not a fault', () => {
    // Expired, taken by another rider, or already answered — the server
    // refuses all three identically.
    expect(isOfferNoLongerAvailable({ status: 409 })).toBe(true);
  });

  it('treats a 404 the same way', () => {
    // The offer no longer exists, or was never this rider's to answer. Either
    // way there is nothing to act on and re-reading is the cure.
    expect(isOfferNoLongerAvailable({ status: 404 })).toBe(true);
  });

  it('does not swallow real failures', () => {
    // These must still surface. Quietly treating a dead server or an expired
    // session as "offer gone" would leave a rider tapping a button that
    // silently does nothing.
    for (const status of [0, 400, 401, 403, 422, 429, 500, 502, 503]) {
      expect(isOfferNoLongerAvailable({ status })).toBe(false);
    }
  });
});

/**
 * The reporting decision must be made from the server's state, not the
 * screen's.
 *
 * The rider screen can only display three states, so showing the server's
 * `on_delivery` means folding it into `idle`. Those two answers agree today —
 * which is exactly the hazard: reporting during a delivery survived only as a
 * side effect of a display choice, and a later decision to show `on_delivery`
 * as its own state would have switched off tracking mid-delivery without
 * touching a line of location code.
 */
describe('reporting is decided by server state', () => {
  it('covers every state the server can hold', () => {
    const decision: Record<RiderAvailability, boolean> = {
      offline: false,
      idle: true,
      on_break: false,
      on_delivery: true,
    };
    for (const [state, expected] of Object.entries(decision)) {
      expect(shouldReportLocation(state as RiderAvailability), state).toBe(expected);
    }
  });

  it('does not depend on the display fold to keep a delivery reporting', () => {
    // `on_delivery` must report on its own merits, before any mapping.
    expect(shouldReportLocation('on_delivery')).toBe(true);
    // And the fold is not what makes that true — it is merely consistent.
    expect(shouldReportLocation(toScreenAvailability('on_delivery'))).toBe(true);
  });
});

describe('diagnosticsEnabled', () => {
  const original = { node: process.env.NODE_ENV, flag: process.env.NEXT_PUBLIC_DASH_DIAGNOSTICS };
  const set = (node: string | undefined, flag: string | undefined): void => {
    (process.env as Record<string, string | undefined>)['NODE_ENV'] = node;
    (process.env as Record<string, string | undefined>)['NEXT_PUBLIC_DASH_DIAGNOSTICS'] = flag;
  };
  afterEach(() => set(original.node, original.flag));

  it('is on in development, where the panel earns its keep', () => {
    set('development', undefined);
    expect(diagnosticsEnabled()).toBe(true);
  });

  it('is off in a production build', () => {
    set('production', undefined);
    expect(diagnosticsEnabled()).toBe(false);
  });

  it('cannot be switched on in production by any flag', () => {
    // There is deliberately no escape hatch. A flag that could re-enable the
    // panel in production would be a route for it to reach a real rider — via
    // a mistaken deployment variable, or a copied build script — in exchange
    // for a capability nothing needs, since the test APK loads from the
    // development server rather than a production bundle.
    for (const value of ['true', 'TRUE', '1', 'yes', 'false', '']) {
      set('production', value);
      expect(diagnosticsEnabled(), `flag=${value}`).toBe(false);
    }
  });

  it('is on in test builds too, which is where the handset work happens', () => {
    set('test', 'anything');
    expect(diagnosticsEnabled()).toBe(true);
  });
});
