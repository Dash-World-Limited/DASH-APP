/**
 * The real catalogue, mapped onto the screens' models, against a fake server
 * shaped like `GET /v1/vendors`, `/v1/vendors/:slug` and `/v1/search`.
 *
 * Asserted: nothing is invented (no photo, rating or range the API did not
 * send), the category structure is the real one and never collapses to "All",
 * money is passed through in kobo untouched, and every call is a public,
 * unauthenticated read of the existing endpoints.
 */

import { describe, expect, it, vi } from 'vitest';

import { createApiClient } from '../api/client';
import { ApiError } from '../api/errors';
import { createSession } from '../api/session';
import {
  type ApiVendorDetail,
  type ApiVendorSummary,
  fetchMerchants,
  fetchStorefront,
  imageSource,
  merchantFromSummary,
  optionGroupsFromModifiers,
  productFromItem,
  searchCatalogue,
  shopCategories,
  storefrontFromDetail,
} from './catalog';

const BASE = 'https://api.staging.dash.test';
const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function harness(respond: (url: string) => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return respond(url);
  });
  const session = createSession({ get: async () => null, set: async () => undefined });
  return { api: createApiClient({ baseUrl: BASE, fetch, session }), calls };
}

const summary = (over: Partial<ApiVendorSummary> = {}): ApiVendorSummary => ({
  id: 'v1',
  name: 'FreshCart Grocers',
  slug: 'freshcart-grocers',
  description: null,
  category: 'grocery',
  serviceCategory: 'shops',
  rating: { average: 4.4, count: 128 },
  branch: { id: 'b1', state: 'Lagos', minimumOrder: 0, estimatedMinutes: 35 },
  distanceMetres: null,
  ...over,
});

const detail: ApiVendorDetail = {
  id: 'v2',
  name: 'Lagos Home & Electronics',
  slug: 'lagos-home-electronics',
  description: 'Home and electronics in Yaba.',
  category: 'retail',
  ratingAverage: 4.4,
  ratingCount: 128,
  branches: [{ id: 'b2', defaultPrepMinutes: 15, busyExtraMinutes: 5 }],
  categories: [
    { id: 'c-el', name: 'Electronics', description: null, items: [
      { id: 'i-fan', name: 'Standing fan, 18 inch', description: null, price: 4_200_000, imageKey: null, isAvailable: true },
      { id: 'i-bulb', name: 'LED bulb, 4-pack', description: null, price: 650_000, imageKey: 'https://cdn.example.com/bulb.jpg', isAvailable: false },
    ] },
    { id: 'c-empty', name: 'Coming soon', description: null, items: [] },
    { id: 'c-home', name: 'Home', description: null, items: [
      { id: 'i-pan', name: 'Stainless cookware set', description: 'Five pieces.', price: 5_800_000, imageKey: 'uploads/pan.jpg', isAvailable: true },
    ] },
  ],
};

describe('photographs', () => {
  it('uses an https URL as it is, and treats anything else as no photo', () => {
    expect(imageSource('https://cdn.example.com/a.jpg')).toEqual({ uri: 'https://cdn.example.com/a.jpg' });
    expect(imageSource('uploads/a.jpg')).toBeNull(); // a storage key the API cannot resolve yet
    expect(imageSource('http://insecure.example.com/a.jpg')).toBeNull();
    expect(imageSource(null)).toBeNull();
  });
});

describe('a shop in a list', () => {
  it('keeps the real rating and the one estimate, and invents no photo', () => {
    const merchant = merchantFromSummary(summary());
    expect(merchant).toMatchObject({ slug: 'freshcart-grocers', descriptor: 'Groceries', category: 'grocery', cover: null, logo: null });
    expect(merchant.rating).toEqual({ average: 4.4, count: 128 });
    expect(merchant.eta).toEqual({ min: 35, max: 35 });
  });

  it('shows no rating for a shop nobody has rated yet', () => {
    expect(merchantFromSummary(summary({ rating: { average: null, count: 0 } })).rating).toBeNull();
    expect(merchantFromSummary(summary({ branch: null })).eta).toBeNull();
  });
});

describe('the category doors above Shops', () => {
  it('are "All" and then each real category that has a shop, never "All" alone', () => {
    const merchants = [summary(), summary({ slug: 'home', category: 'retail' }), summary({ slug: 'more', category: 'grocery' })].map(merchantFromSummary);
    expect(shopCategories(merchants).map((c) => c.id)).toEqual(['all', 'grocery', 'retail']);
    expect(shopCategories(merchants).map((c) => c.label)).toEqual(['All', 'Groceries', 'Retail']);
  });

  it('are only "All" when there is no shop at all', () => {
    expect(shopCategories([]).map((c) => c.id)).toEqual(['all']);
  });
});

describe('a storefront', () => {
  const store = storefrontFromDetail(detail);

  it('keeps the shop’s own shelves, in its order, after "All", and drops empty ones', () => {
    expect(store.shelves).toEqual([
      { id: 'all', label: 'All' },
      { id: 'c-el', label: 'Electronics' },
      { id: 'c-home', label: 'Home' },
    ]);
  });

  it('passes prices through in kobo and marks what the shop has made unavailable', () => {
    expect(store.products.map((p) => [p.id, p.price, p.available, p.shelf, p.shelfLabel])).toEqual([
      ['i-fan', 4_200_000, true, 'c-el', 'Electronics'],
      ['i-bulb', 650_000, false, 'c-el', 'Electronics'],
      ['i-pan', 5_800_000, true, 'c-home', 'Home'],
    ]);
    expect(store.products.every((p) => Number.isInteger(p.price))).toBe(true);
  });

  it('draws only the photographs it can load, and invents no product rating', () => {
    expect(store.products.map((p) => p.image)).toEqual([null, { uri: 'https://cdn.example.com/bulb.jpg' }, null]);
    expect(store.products.every((p) => p.rating === null)).toBe(true);
    expect(store.merchant.eta).toEqual({ min: 20, max: 20 });
    expect(store.merchant.description).toBe('Home and electronics in Yaba.');
  });
});

describe('options', () => {
  it('start an optional group on "None", keep a required group’s first choice, and show a price difference without adding it', () => {
    const groups = optionGroupsFromModifiers([
      { id: 'g-size', name: 'Size', minSelect: 1, maxSelect: 1, options: [{ id: 's', name: 'Small', priceDelta: 0 }, { id: 'l', name: 'Large', priceDelta: 50_000 }] },
      { id: 'g-extra', name: 'Extras', minSelect: 0, maxSelect: 1, options: [{ id: 'e', name: 'Gift wrap', priceDelta: 20_000 }] },
      { id: 'g-empty', name: 'Nothing', minSelect: 0, maxSelect: 1, options: [] },
    ]);
    expect(groups.map((g) => g.id)).toEqual(['g-size', 'g-extra']);
    expect(groups[0]?.defaultOption).toBeUndefined();
    expect(groups[0]?.options.map((o) => o.priceDelta)).toEqual([0, 50_000]);
    expect(groups[1]?.defaultOption).toBe('');
    expect(groups[1]?.options[0]).toEqual({ id: '', label: 'None', priceDelta: 0 });
    const product = productFromItem({ id: 'x', name: 'Tote', description: null, price: 900_000, imageKey: null, isAvailable: true }, 'shop', 'c');
    expect(product.price).toBe(900_000);
  });
});

describe('fetching', () => {
  it('reads the Shops merchants from the existing public endpoint, best rated first, without a token', async () => {
    const { api, calls } = harness(() => json(200, { vendors: [summary()], nextCursor: null }));
    const merchants = await fetchMerchants(api, 'shops');
    expect(merchants.map((m) => m.slug)).toEqual(['freshcart-grocers']);
    expect(calls[0]?.url).toBe(`${BASE}/v1/vendors?service=shops&sort=rating&limit=50`);
    expect((calls[0]?.init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('reads one storefront by its slug, and a missing shop is a 404, not an outage', async () => {
    const { api, calls } = harness((url) => (url.endsWith('/v1/vendors/lagos-home-electronics') ? json(200, { vendor: detail }) : json(404, { error: { code: 'not_found', message: 'Not found.' } })));
    expect((await fetchStorefront(api, 'lagos-home-electronics')).merchant.name).toBe('Lagos Home & Electronics');
    await expect(fetchStorefront(api, 'gone')).rejects.toMatchObject({ status: 404 });
    await expect(fetchStorefront(api, 'gone')).rejects.toBeInstanceOf(ApiError);
    expect(calls[0]?.url).toBe(`${BASE}/v1/vendors/lagos-home-electronics`);
  });

  it('searches only once there are two characters, and encodes what was typed', async () => {
    const { api, calls } = harness(() =>
      json(200, { vendors: [{ id: 'v1', name: 'FreshCart Grocers', slug: 'freshcart-grocers', category: 'grocery', ratingAverage: 4.4 }], items: [{ id: 'i1', name: 'Long Grain Rice (5kg)', price: 950_000, vendor: { id: 'v1', name: 'FreshCart Grocers', slug: 'freshcart-grocers' } }] }),
    );
    expect(await searchCatalogue(api, ' r ')).toEqual({ shops: [], products: [] });
    expect(calls).toHaveLength(0);
    const results = await searchCatalogue(api, 'rice & oil');
    expect(calls[0]?.url).toBe(`${BASE}/v1/search?q=rice%20%26%20oil&limit=15`);
    expect(results.shops[0]).toMatchObject({ slug: 'freshcart-grocers', descriptor: 'Groceries' });
    expect(results.products[0]).toMatchObject({ id: 'i1', price: 950_000, merchantSlug: 'freshcart-grocers', merchantName: 'FreshCart Grocers' });
  });
});
