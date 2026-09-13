/**
 * The rider's offer clock, the switch between faces, and the privacy rule the
 * incoming-offer screen stands on.
 */

import { describe, expect, it } from 'vitest';

import { stagingOffer } from '../data/staging';
import { hrefForMode, initialRouteForMode, riderModeOffered } from './mode';
import { offerPhase, remainingFraction, secondsLeft } from './offer';

const NOW = Date.parse('2026-09-13T12:00:00.000Z');
const at = (offsetSeconds: number): string => new Date(NOW + offsetSeconds * 1000).toISOString();

describe('the offer clock', () => {
  it("counts from the server's expiry, not from when the screen opened", () => {
    // A rider woken from a killed app opens the offer late. They must see the
    // time they actually have — the server expires offers, not this screen.
    const expiresAt = at(30);
    const openedTwentySecondsLate = NOW + 20_000;
    expect(secondsLeft(expiresAt, openedTwentySecondsLate)).toBe(10);
  });

  it('rounds up, so the last second is shown rather than a premature zero', () => {
    expect(secondsLeft(at(0.2), NOW)).toBe(1);
  });

  it('is expired at and after the deadline', () => {
    expect(secondsLeft(at(0), NOW)).toBe(0);
    expect(offerPhase(at(0), NOW)).toBe('expired');
    expect(offerPhase(at(-5), NOW)).toBe('expired');
    expect(offerPhase(at(5), NOW)).toBe('open');
  });

  it('treats a malformed expiry as expired, never as open for ever', () => {
    expect(secondsLeft('not a date', NOW)).toBe(0);
    expect(offerPhase('not a date', NOW)).toBe('expired');
  });

  it("draws the ring against the offer's own window — 30s live, 90s woken", () => {
    expect(remainingFraction(at(15), 30, NOW)).toBeCloseTo(0.5);
    expect(remainingFraction(at(45), 90, NOW)).toBeCloseTo(0.5);
    expect(remainingFraction(at(200), 30, NOW)).toBe(1);
    expect(remainingFraction(at(-1), 30, NOW)).toBe(0);
  });
});

describe('the incoming offer never carries the customer', () => {
  it('has no name, street or phone before acceptance', () => {
    // The server sends only a coarsened drop-off area until the rider accepts
    // (GET /v1/rider/offers). The approved board shows a name here; the rule
    // stands, and this guards the staging fixture as well as the type.
    const text = JSON.stringify(stagingOffer(new Date(NOW)));
    for (const field of ['customer', 'displayName', 'line1', 'contactPhone', 'phone', 'Emma']) {
      expect(text, field).not.toContain(field);
    }
  });
});

describe('Customer and Rider — one account', () => {
  it('maps the remembered mode to one startup route and one interactive destination', () => {
    expect(initialRouteForMode('customer')).toBe('(customer)');
    expect(hrefForMode('customer')).toBe('/');
    expect(initialRouteForMode('rider')).toBe('rider');
    expect(hrefForMode('rider')).toBe('/rider');
  });

  it('offers Rider mode in production only to an approved rider', () => {
    expect(riderModeOffered('production', { riderStatus: 'approved' })).toBe(true);
    for (const riderStatus of ['pending', 'rejected', 'suspended', null] as const) {
      expect(riderModeOffered('production', { riderStatus }), String(riderStatus)).toBe(false);
    }
    expect(riderModeOffered('production', null)).toBe(false);
  });

  it('shows the switch in development and staging so the Rider screens can be reviewed', () => {
    // A drawing decision only: every rider route authorises on the server.
    expect(riderModeOffered('staging', null)).toBe(true);
    expect(riderModeOffered('development', null)).toBe(true);
  });
});
