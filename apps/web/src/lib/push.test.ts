// @vitest-environment jsdom

/**
 * A notification is a prompt, not an instruction.
 *
 * The payload arrives from outside our infrastructure, having passed through
 * Google's servers, so nothing in it may decide where the app goes beyond
 * choosing between routes we already know. These assertions are about what the
 * app refuses to do with a message it did not write.
 */

import { describe, expect, it } from 'vitest';

import { deepLinkTarget, pushAvailable } from './push';

describe('deepLinkTarget', () => {
  it('sends a rider-offer notification to the rider screen', () => {
    expect(deepLinkTarget({ type: 'rider_offer', offerId: 'o1' })).toBe('/rider');
  });

  it('ignores a notification it does not recognise', () => {
    // Not navigating is the correct response to a message we do not understand.
    expect(deepLinkTarget({ type: 'something_else' })).toBeNull();
    expect(deepLinkTarget({})).toBeNull();
    expect(deepLinkTarget(null)).toBeNull();
    expect(deepLinkTarget(undefined)).toBeNull();
  });

  it('never builds a route out of the payload', () => {
    // The attack this closes: a notification naming its own destination. The
    // offer id is used to decide *whether* to navigate, never *where* — so a
    // crafted payload cannot point the app at a route of its choosing.
    for (const hostile of [
      { type: 'rider_offer', offerId: '../admin' },
      { type: 'rider_offer', offerId: 'https://example.com/phish' },
      { type: 'rider_offer', offerId: '/ops' },
    ]) {
      expect(deepLinkTarget(hostile)).toBe('/rider');
    }
  });

  it('does not follow a type it was not given', () => {
    expect(deepLinkTarget({ offerId: 'o1' })).toBeNull();
  });
});

describe('pushAvailable', () => {
  it('is false without the native shell, so the web client is unaffected', () => {
    // Push needs a Firebase configuration compiled into the shell. Everywhere
    // else the app runs identically and relies on the socket.
    expect(pushAvailable()).toBe(false);
  });
});
