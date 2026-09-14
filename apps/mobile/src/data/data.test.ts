/**
 * The six services come from the shared contract; the fixtures stand in for
 * the server without pretending to be it.
 */

import { SERVICE_CATEGORY_IDS } from '@dash/domain/services';
import { describe, expect, it } from 'vitest';

import { formatCount, formatDistance, formatEta, formatRating, greetingFor } from '../lib/format';
import { BUNDLED_SERVICE_TILES, SERVICE_PRESENTATION, tilesFromServer, toServiceTiles } from './services';
import { stagingQuote } from './staging';

describe('the Home grid', () => {
  it('shows the six contract services in the contract order', () => {
    expect(BUNDLED_SERVICE_TILES.map((t) => t.id)).toEqual([...SERVICE_CATEGORY_IDS]);
  });

  it('draws every service equally — no door is special', () => {
    // DASH must never read as a Declutter app, or as any one service with extras.
    expect(new Set(BUNDLED_SERVICE_TILES.map((t) => typeof t.art)).size).toBe(1);
  });

  it('follows the server\'s order and drops what this build cannot draw', () => {
    const tiles = toServiceTiles([
      { id: 'logistics', position: 6 },
      { id: 'food', position: 1 },
      { id: 'teleportation', position: 7 },
      null,
      { id: 'shops' },
    ]);
    expect(tiles.map((t) => t.id)).toEqual(['food', 'logistics']);
  });

  it('never lets a server answer collapse Home to one door', () => {
    // The old DASH APP failure: every category gone but "Everything".
    expect(tilesFromServer({ categories: [{ id: 'everything', position: 1 }] })).toBeNull();
    expect(tilesFromServer({ categories: [{ id: 'everything', position: 1 }, { id: 'shops', position: 2 }] })).toBeNull();
    expect(tilesFromServer({ categories: [] })).toBeNull();
    expect(tilesFromServer({ nope: true })).toBeNull();
    expect(tilesFromServer(null)).toBeNull();
  });

  it('takes the server’s answer when it is a real set of services, including one hidden by operations', () => {
    const all = SERVICE_CATEGORY_IDS.map((id, index) => ({ id, position: index + 1 }));
    expect(tilesFromServer({ categories: all })?.map((t) => t.id)).toEqual([...SERVICE_CATEGORY_IDS]);
    const withoutLogistics = all.filter((c) => c.id !== 'logistics');
    expect(tilesFromServer({ categories: withoutLogistics })).toHaveLength(SERVICE_CATEGORY_IDS.length - 1);
  });

  it('opens only the flows this checkpoint built, and says so for the rest', () => {
    const available = Object.entries(SERVICE_PRESENTATION).filter(([, p]) => p.available).map(([id]) => id);
    expect(available).toEqual(['shops']);
  });
});

describe('the staging quote', () => {
  it('stays in integer kobo and adds up', () => {
    const quote = stagingQuote([
      { productId: 'iphone-15-pro', quantity: 1 },
      { productId: 'airpods-pro-2', quantity: 1 },
    ]);
    for (const value of [quote.itemsTotal, quote.deliveryFee, quote.serviceFee, quote.total]) {
      expect(Number.isInteger(value)).toBe(true);
    }
    expect(quote.total).toBe(quote.itemsTotal + quote.deliveryFee + quote.serviceFee);
    // The board's figures: ₦1,670,000 + ₦2,500 + ₦1,500 = ₦1,674,000.
    expect(quote.total).toBe(1_674_000_00);
  });

  it('charges no fees on an empty cart', () => {
    expect(stagingQuote([]).total).toBe(0);
  });
});

describe('formatting the boards\' figures', () => {
  it('prints distance, counts, ratings and estimates as drawn', () => {
    expect(formatDistance(850)).toBe('850 m');
    expect(formatDistance(1200)).toBe('1.2 km');
    expect(formatCount(1200)).toBe('1.2k');
    expect(formatCount(320)).toBe('320');
    expect(formatCount(12_400)).toBe('12k');
    expect(formatRating(4)).toBe('4.0');
    expect(formatEta({ min: 20, max: 35 })).toBe('20–35 mins');
    expect(formatEta({ min: 30, max: 30 })).toBe('30 mins');
  });

  it('greets by the time of day', () => {
    expect(greetingFor(7)).toBe('Good morning');
    expect(greetingFor(13)).toBe('Good afternoon');
    expect(greetingFor(20)).toBe('Good evening');
  });
});
