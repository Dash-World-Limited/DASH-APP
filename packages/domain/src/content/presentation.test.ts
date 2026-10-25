import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  categoryArtwork,
  loadStudioFeed,
  orderStudioVendors,
  parseStudioFeed,
  studioSlot,
  vendorPresentation,
} from './presentation.js';
const base = 'https://api.dash.test';
const image = {
  url: '/v1/files/content-studio%2Ftest?signature=test',
  alt: 'DASH artwork',
};
const hero = {
  id: 'hero',
  type: 'banner',
  placement: 'home.hero',
  title: 'Published hero',
  body: 'DASH selected',
  image,
  href: '/shops',
};
const feed = (items: unknown[]) => ({ schemaVersion: 1, items });
afterEach(() => vi.useRealTimers());
describe('published presentation transport', () => {
  it.each([
    null,
    {},
    { schemaVersion: 2, items: [hero] },
    { schemaVersion: 1, items: {} },
  ])('rejects unsupported or malformed envelopes %j', (value) =>
    expect(parseStudioFeed(value, base)).toEqual([]),
  );
  it('skips malformed/future items without losing a valid published hero', () => {
    const parsed = parseStudioFeed(
      feed([
        null,
        { ...hero, type: 'future_component' },
        { ...hero, href: 'javascript:evil()' },
        hero,
      ]),
      base,
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.image?.url).toBe(`${base}${image.url}`);
  });
  it('refuses script, malformed and authenticated image URLs', () => {
    for (const url of [
      'javascript:alert(1)',
      'https://',
      '//evil.test/x',
      'https://user:password@example.test/x',
    ])
      expect(
        parseStudioFeed(feed([{ ...hero, image: { ...image, url } }]), base)[0]
          ?.image,
      ).toBeNull();
  });
  it('does not use mismatched component types in hero slots', () => {
    const items = parseStudioFeed(
      feed([{ ...hero, type: 'featured_vendor' }]),
      base,
    );
    expect(studioSlot(items, 'home.hero')).toEqual([]);
  });
  it('returns defaults on HTTP, network and malformed JSON failure', async () => {
    const fetcher = vi.fn();
    for (const implementation of [
      async () => ({ ok: false }),
      async () => {
        throw new Error('offline');
      },
      async () => ({
        ok: true,
        json: async () => {
          throw new Error('bad JSON');
        },
      }),
    ]) {
      fetcher.mockImplementation(implementation);
      expect(await loadStudioFeed(base, fetcher)).toEqual([]);
    }
  });
  it('loads the same public V1 feed without credentials or session interaction', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => feed([hero]) });
    expect(await loadStudioFeed(base, fetcher)).toHaveLength(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe(`${base}/v1/content`);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      credentials: 'omit',
      headers: { Accept: 'application/json' },
    });
  });
  it.each(['request', 'body'])(
    'enforces 2500ms even if the %s ignores AbortSignal',
    async (stage) => {
      vi.useFakeTimers();
      const never = new Promise(() => undefined);
      const fetcher = vi
        .fn()
        .mockImplementation(() =>
          stage === 'request'
            ? never
            : Promise.resolve({ ok: true, json: () => never }),
        );
      const result = loadStudioFeed(base, fetcher);
      await vi.advanceTimersByTimeAsync(2500);
      expect(await result).toEqual([]);
      expect(fetcher.mock.calls[0]?.[1].signal.aborted).toBe(true);
    },
  );
  it('cancels on unmount and does not call an unconfigured API', async () => {
    const fetcher = vi
      .fn()
      .mockImplementation(() => new Promise(() => undefined));
    expect(await loadStudioFeed(null, fetcher)).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
    const controller = new AbortController();
    const result = loadStudioFeed(base, fetcher, controller.signal);
    controller.abort();
    expect(await result).toEqual([]);
  });
});
describe('presentation projections preserve catalogue authority', () => {
  const vendors = [
    { id: 'a', name: 'Original A', state: 'closed', price: 200 },
    { id: 'b', name: 'Original B', state: 'open', price: 900 },
    { id: 'c', name: 'Original C', state: 'busy', price: 100 },
  ];
  const feature = (id: string, vendorId: string, position: number) => ({
    id,
    type: 'featured_vendor',
    placement: 'home.featured',
    vendorId,
    position,
    title: 'Not the operational name',
  });
  it('can only permute eligible input vendors, keeping every original object and operational field', () => {
    const items = parseStudioFeed(
      feed([feature('f1', 'ineligible', 0), feature('f2', 'b', 1)]),
      base,
    );
    const result = orderStudioVendors(vendors, items, (v) => v.id);
    expect(result).toEqual([vendors[1], vendors[0], vendors[2]]);
    expect(result[0]).toBe(vendors[1]);
    expect(result).toHaveLength(3);
    expect(orderStudioVendors([], items, (v: { id: string }) => v.id)).toEqual(
      [],
    );
    expect(vendors.map((v) => v.id)).toEqual(['a', 'b', 'c']);
  });
  it('preserves fallback order and stable ties', () => {
    expect(orderStudioVendors(vendors, [], (v) => v.id)).toEqual(vendors);
    const items = parseStudioFeed(
      feed([feature('f1', 'b', 1), feature('f2', 'a', 1)]),
      base,
    );
    expect(orderStudioVendors(vendors, items, (v) => v.id)).toEqual(vendors);
  });
  it('maps existing native and web surface names to authoritative service category IDs', () => {
    const items = parseStudioFeed(
      feed([
        {
          ...hero,
          id: 'food',
          type: 'category_artwork',
          placement: 'category.artwork',
          categoryId: 'food',
        },
        {
          ...hero,
          id: 'market',
          type: 'category_artwork',
          placement: 'category.artwork',
          categoryId: 'local_market',
        },
      ]),
      base,
    );
    expect(categoryArtwork(items, 'restaurants')?.alt).toBe(image.alt);
    expect(categoryArtwork(items, 'local-market')).toEqual(
      categoryArtwork(items, 'market'),
    );
    expect(categoryArtwork(items, 'pharmacy')).toBeNull();
  });
  it('targets vendor overrides by API identity, never slug/title or another vendor', () => {
    const items = parseStudioFeed(
      feed([
        {
          ...hero,
          type: 'vendor_presentation',
          placement: 'vendor.presentation',
          vendorId: 'b',
          featured: true,
          label: 'DASH pick',
          logo: image,
        },
      ]),
      base,
    );
    expect(vendorPresentation(items, 'b')?.label).toBe('DASH pick');
    expect(vendorPresentation(items, 'a')).toBeUndefined();
    expect(orderStudioVendors(vendors, items, (v) => v.id)[0]).toBe(vendors[1]);
  });
});
