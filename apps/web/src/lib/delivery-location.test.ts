/**
 * What the shell is allowed to say about where the customer is.
 *
 * The delivery location decides which sellers appear, what they cost to reach
 * and whether DASH covers the address at all. A customer reads the place name
 * in the header and trusts the list underneath it, so the one thing this must
 * never do is present a guess as an answer — and the guess is the *starting*
 * state, which makes it the easy mistake rather than the unlikely one.
 *
 * The name shown is therefore always the server's own, for the position
 * actually in use. These assert that it cannot be anything else.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('./api', () => ({ apiFetch: vi.fn(async () => ({})) }));
vi.mock('./session', () => ({
  authedFetch: vi.fn(async () => ({ addresses: [] })),
  hasSession: () => false,
  subscribeToSession: () => () => {},
}));

import {
  DEFAULT_POSITION,
  locationLabel,
  type DeliveryLocation,
  type Serviceability,
} from './delivery-location';

const location = (serviceability: Serviceability | null): DeliveryLocation => ({
  position: DEFAULT_POSITION,
  source: 'default',
  serviceability,
  locating: false,
});

const zone = (name: string): Serviceability => ({
  serviceable: true,
  city: { id: 'c', name: 'Lagos', slug: 'lagos' },
  zone: { id: 'z', name },
});

describe('the place name', () => {
  it('says nothing until the server has answered', () => {
    // Null, not "Lagos" and not "Locating…". A caller renders a prompt; a
    // placeholder here would be a guess wearing the shape of an answer.
    expect(locationLabel(location(null))).toBeNull();
  });

  it('uses the zone the server named', () => {
    expect(locationLabel(location(zone('Victoria Island')))).toBe('Victoria Island');
  });

  it('falls back to the city, never to an invented neighbourhood', () => {
    expect(
      locationLabel(
        location({ serviceable: true, city: { id: 'c', name: 'Lagos', slug: 'lagos' } }),
      ),
    ).toBe('Lagos');
  });

  it('returns null rather than guessing when the server named neither', () => {
    expect(locationLabel(location({ serviceable: true, city: null }))).toBeNull();
  });

  it('says so plainly when the address is outside coverage', () => {
    // A customer here must not be shown a cheerful zone name above an empty
    // list — the list is empty for a reason they are entitled to know.
    const label = locationLabel(
      location({ serviceable: false, city: null, message: 'We do not deliver to Ikorodu yet.' }),
    );
    expect(label).toBe('Outside our delivery area');
  });
});

describe('the starting position', () => {
  it('is an admitted guess', () => {
    // `source` exists so the shell can offer to fix it. A default presented as
    // the customer's own address is how someone in Ikorodu is told DASH does
    // not serve them while looking at Victoria Island.
    expect(location(null).source).toBe('default');
  });

  it('is somewhere DASH actually operates, so the app is never empty on open', () => {
    expect(DEFAULT_POSITION.latitude).toBeGreaterThan(6);
    expect(DEFAULT_POSITION.latitude).toBeLessThan(7);
    expect(DEFAULT_POSITION.longitude).toBeGreaterThan(3);
    expect(DEFAULT_POSITION.longitude).toBeLessThan(4);
  });
});
