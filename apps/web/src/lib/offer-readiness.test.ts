/**
 * What a rider is allowed to tap, and when.
 *
 * The server refuses to assign a delivery on a position over two minutes old.
 * A rider woken from a killed app has no position at all, so without a
 * confirmation step the first thing they would do is tap Accept, be refused,
 * and wait out a twenty-second reporting tick before they could try again.
 *
 * These assert the whole state space rather than the happy path, because the
 * states that matter are the awkward ones: a denied permission, a GPS that
 * never fixes, a server that rejects the position that was found. Each has a
 * different right answer and only one of them is an error.
 */

import { describe, expect, it } from 'vitest';

import {
  canAccept,
  needsFreshFix,
  readiness,
  FRESHNESS_MARGIN_SECONDS,
  type ConfirmationFailure,
} from './offer-readiness';

const MAX = 120;

describe('needsFreshFix', () => {
  it('demands a fix when nothing has ever been accepted', () => {
    // The woken-from-a-killed-app case: no position at all.
    expect(needsFreshFix(null, MAX)).toBe(true);
  });

  it('does not delay a rider whose app never stopped reporting', () => {
    // The ordinary path must stay instant. A rider with a twenty-second-old
    // position taps Accept and it works.
    expect(needsFreshFix(0, MAX)).toBe(false);
    expect(needsFreshFix(20, MAX)).toBe(false);
    expect(needsFreshFix(60, MAX)).toBe(false);
  });

  it('refreshes before the server would refuse, not at the moment it would', () => {
    // A position 118s old is 121s old by the time the rider has read the
    // address and tapped. Using the server's exact limit here would produce
    // refusals that look arbitrary to the rider.
    const threshold = MAX - FRESHNESS_MARGIN_SECONDS;
    expect(needsFreshFix(threshold - 1, MAX)).toBe(false);
    expect(needsFreshFix(threshold + 1, MAX)).toBe(true);
    expect(needsFreshFix(MAX - 1, MAX)).toBe(true);
  });

  it('tracks the server limit rather than hardcoding one', () => {
    // If the server's freshness rule is ever tightened, this follows it.
    expect(needsFreshFix(100, 300)).toBe(false);
    expect(needsFreshFix(100, 60)).toBe(true);
  });
});

describe('readiness', () => {
  it('enables Accept when the position is current', () => {
    const result = readiness({ locationAgeSeconds: 20, maxAgeSeconds: MAX, confirming: false });
    expect(result.state).toBe('ready');
    expect(canAccept(result.state)).toBe(true);
    // Silence is the success case — nothing to explain.
    expect(result.message).toBe('');
  });

  it('confirms rather than complains when a woken rider has no position', () => {
    // This is the ordinary state of a rider who has just been woken by a push.
    // Showing an error here would be wrong: nothing has failed.
    const result = readiness({ locationAgeSeconds: null, maxAgeSeconds: MAX, confirming: false });
    expect(result.state).toBe('confirming');
    expect(result.message).toBe('Confirming your location…');
    expect(canAccept(result.state)).toBe(false);
  });

  it('keeps Accept disabled while a fix is being acquired', () => {
    const result = readiness({ locationAgeSeconds: 20, maxAgeSeconds: MAX, confirming: true });
    expect(result.state).toBe('confirming');
    expect(canAccept(result.state)).toBe(false);
  });

  it('explains a denied permission instead of spinning for ever', () => {
    const result = readiness({
      locationAgeSeconds: null,
      maxAgeSeconds: MAX,
      confirming: false,
      failure: 'permission_denied',
    });
    expect(result.state).toBe('blocked');
    expect(result.message).toContain('Settings');
    expect(canAccept(result.state)).toBe(false);
  });

  it('gives a different, actionable message for every failure', () => {
    // A rider in a basement and a rider who denied permission need different
    // advice, and neither is served by a generic error.
    const failures: ConfirmationFailure[] = [
      'permission_denied',
      'no_fix',
      'rejected_by_server',
      'offline',
    ];
    const messages = failures.map(
      (failure) =>
        readiness({ locationAgeSeconds: null, maxAgeSeconds: MAX, confirming: false, failure })
          .message,
    );

    expect(new Set(messages).size).toBe(failures.length);
    for (const message of messages) expect(message.length).toBeGreaterThan(10);
  });

  it('reports failure ahead of confirmation, so a stuck attempt is visible', () => {
    // Both flags set: the rider must see why it failed rather than a spinner
    // that never resolves.
    const result = readiness({
      locationAgeSeconds: null,
      maxAgeSeconds: MAX,
      confirming: true,
      failure: 'no_fix',
    });
    expect(result.state).toBe('blocked');
  });

  it('never enables Accept in any state but ready', () => {
    // The property the whole module exists for: the button is enabled only
    // when a current position has been confirmed.
    const states = [
      readiness({ locationAgeSeconds: null, maxAgeSeconds: MAX, confirming: false }),
      readiness({ locationAgeSeconds: 500, maxAgeSeconds: MAX, confirming: false }),
      readiness({ locationAgeSeconds: 20, maxAgeSeconds: MAX, confirming: true }),
      readiness({
        locationAgeSeconds: 20,
        maxAgeSeconds: MAX,
        confirming: false,
        failure: 'no_fix',
      }),
    ];
    for (const result of states) {
      expect(canAccept(result.state), result.message).toBe(false);
    }
  });
});
