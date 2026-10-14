import { describe, expect, it } from 'vitest';

import { describePlace, homeLocationLines, ratingWord, riderCallUrl, RATING_STARS } from './delivery';

describe('calling the rider', () => {
  const rider = { phone: '+2348031234567' };

  it('dials the assigned rider while they work the order', () => {
    for (const status of ['rider_assigned', 'rider_arrived', 'picked_up', 'en_route', 'arrived']) {
      expect(riderCallUrl({ status, rider })).toBe('tel:+2348031234567');
    }
  });

  it('offers no call before assignment, after the job, or without a real number', () => {
    for (const status of ['placed', 'preparing', 'ready', 'delivered', 'cancelled', 'refunded', 'not-a-status']) {
      expect(riderCallUrl({ status, rider })).toBeNull();
    }
    expect(riderCallUrl({ status: 'en_route', rider: null })).toBeNull();
    expect(riderCallUrl({ status: 'en_route', rider: { phone: null } })).toBeNull();
    expect(riderCallUrl({ status: 'en_route', rider: {} })).toBeNull();
    expect(riderCallUrl({ status: 'en_route', rider: { phone: '08031234567' } })).toBeNull();
    expect(riderCallUrl({ status: 'en_route', rider: { phone: '+234 803 123 4567;rm' } })).toBeNull();
  });

  it('tidies spacing in a stored number', () => {
    expect(riderCallUrl({ status: 'en_route', rider: { phone: '+234 803 123-4567' } })).toBe('tel:+2348031234567');
  });
});

describe('rating words', () => {
  it('names every star value', () => {
    expect(RATING_STARS.map(ratingWord)).toEqual(['Poor', 'Fair', 'Good', 'Very good', 'Excellent']);
    expect(ratingWord(0)).toBe('');
  });
});

describe('reading a place as an address', () => {
  it('uses the platform’s formatted line without the country or a Plus Code', () => {
    expect(
      describePlace({
        formattedAddress: '8FVC9G8F+6X, 12 Admiralty Way, Lekki Phase 1, Lagos, Nigeria',
        country: 'Nigeria',
      }),
    ).toBe('12 Admiralty Way, Lekki Phase 1, Lagos');
  });

  it('builds the line from parts when there is no formatted line', () => {
    expect(
      describePlace({ streetNumber: '4', street: 'Nnebisi Road', district: 'Cable Point', city: 'Asaba', region: 'Delta', country: 'Nigeria' }),
    ).toBe('4 Nnebisi Road, Cable Point, Asaba, Delta');
    expect(describePlace({ name: 'Shoprite Asaba', subregion: 'Oshimili South', region: 'Delta' })).toBe('Shoprite Asaba, Oshimili South, Delta');
  });

  it('drops repeated parts', () => {
    expect(describePlace({ street: 'Okpanam Road', city: 'Asaba', region: 'asaba' })).toBe('Okpanam Road, Asaba');
  });

  it('says nothing when the geocoder gave nothing readable', () => {
    expect(describePlace(null)).toBeNull();
    expect(describePlace({})).toBeNull();
    expect(describePlace({ name: '8FVC9G8F+6X', country: 'Nigeria' })).toBeNull();
  });

  it('fits the address field', () => {
    expect(describePlace({ formattedAddress: `${'a'.repeat(150)}, ${'b'.repeat(150)}` })?.length).toBeLessThanOrEqual(200);
  });
});

describe('the home screen location line', () => {
  it('shows the confirmed address first', () => {
    expect(homeLocationLines({ kind: 'confirmed', label: 'Home', line1: '4 Nnebisi Road' })).toMatchObject({
      caption: 'Delivering to',
      title: 'Home · 4 Nnebisi Road',
    });
    expect(homeLocationLines({ kind: 'confirmed', label: null, line1: '4 Nnebisi Road' }).title).toBe('4 Nnebisi Road');
  });

  it('shows the detected place, asking for confirmation', () => {
    const lines = homeLocationLines({ kind: 'detected', description: 'Cable Point, Asaba' });
    expect(lines.title).toBe('Cable Point, Asaba');
    expect(lines.caption).toMatch(/confirm/);
    expect(homeLocationLines({ kind: 'detected', description: null }).title).toBe('Your current location');
  });

  it('never shows a made-up place when location is off or unavailable', () => {
    for (const location of [{ kind: 'denied', canAskAgain: false }, { kind: 'unavailable' }] as const) {
      const lines = homeLocationLines(location);
      expect(lines.title).toBe('Set your delivery location');
      expect(`${lines.caption} ${lines.title}`).not.toMatch(/Lekki|Asaba|Lagos/);
    }
    expect(homeLocationLines({ kind: 'loading' }).title).toMatch(/Finding/);
  });
});
