/**
 * The catalogue for the screens: live from the API when the build has one,
 * staging fixtures when it does not (and the screens say which).
 *
 * Every hook returns the same shape: `status` (loading, ready or error), the
 * data, a person-readable `error`, and `retry`. Storefronts are cached for the
 * session, so opening a product or the cart reuses the shop the customer just
 * browsed instead of fetching it again; `retry` always goes back to the server.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '../api';
import { ApiError } from '../api/errors';
import { fetchMerchants, fetchStorefront, SEARCH_MIN_LENGTH, searchCatalogue, shopCategories, type SearchResultsModel, type StorefrontModel } from './catalog';
import type { MerchantModel, ProductModel, ShopCategoryModel } from './models';
import { FEATURED_SHOPS, merchantBySlug, POPULAR_NEAR_YOU, PRODUCTS, productById, SHOP_CATEGORIES, STOREFRONT_HERO, STOREFRONT_SHELVES } from './staging';

export type LoadStatus = 'loading' | 'ready' | 'error';

export interface Loaded<T> {
  status: LoadStatus;
  data: T | null;
  /** What to tell the person, when status is `error`. */
  error: string | null;
  /** 404: the thing does not exist (or is not public), which is not an outage. */
  notFound: boolean;
  retry: () => void;
  /** True when the data came from the API rather than staging fixtures. */
  live: boolean;
}

/** Whether this build reads the real catalogue. */
export const catalogueIsLive = (): boolean => api.configured;

function describe(error: unknown): { message: string; notFound: boolean } {
  if (error instanceof ApiError) {
    if (error.status === 404) return { message: 'This is not available right now.', notFound: true };
    return { message: error.message, notFound: false };
  }
  return { message: 'Something went wrong. Please try again.', notFound: false };
}

/** Load `fn` when `key` changes; `retry` runs it again against the server. */
function useLoad<T>(key: string | null, fn: (fresh: boolean) => Promise<T>, live: boolean): Loaded<T> {
  const [state, setState] = useState<Omit<Loaded<T>, 'retry' | 'live'>>({ status: 'loading', data: null, error: null, notFound: false });
  const [attempt, setAttempt] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    if (key === null) return;
    let current = true;
    setState((s) => ({ ...s, status: 'loading', error: null, notFound: false }));
    fnRef
      .current(attempt > 0)
      .then((data) => current && setState({ status: 'ready', data, error: null, notFound: false }))
      .catch((error: unknown) => {
        if (!current) return;
        const { message, notFound } = describe(error);
        setState({ status: 'error', data: null, error: message, notFound });
      });
    return () => {
      current = false;
    };
  }, [key, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { ...state, retry, live };
}

// ---------------------------------------------------------------- storefront cache

const STOREFRONT_TTL_MS = 5 * 60_000;
const storefronts = new Map<string, { at: number; value: Promise<StorefrontModel> }>();
const settled = new Map<string, StorefrontModel>();

export function loadStorefront(slug: string, fresh = false): Promise<StorefrontModel> {
  const hit = storefronts.get(slug);
  if (hit && !fresh && Date.now() - hit.at < STOREFRONT_TTL_MS) return hit.value;
  const value = fetchStorefront(api, slug).then((store) => {
    settled.set(slug, store);
    return store;
  });
  value.catch(() => storefronts.delete(slug)); // a failure is never cached
  storefronts.set(slug, { at: Date.now(), value });
  return value;
}

/** A shop's name without waiting: from the fixtures, or a storefront already loaded. */
export function knownMerchantName(slug: string | null | undefined): string | null {
  if (!slug) return null;
  return settled.get(slug)?.merchant.name ?? merchantBySlug(slug)?.name ?? null;
}

// ---------------------------------------------------------------- Shops landing

export interface ShopsLandingModel {
  categories: ShopCategoryModel[];
  /** Live: every Shops merchant, best rated first. Staging: the board's featured rail. */
  rail: MerchantModel[];
  /** Live: the same merchants as a list. Staging: the board's "popular near you". */
  list: MerchantModel[];
}

export function useShops(): Loaded<ShopsLandingModel> {
  const live = catalogueIsLive();
  return useLoad(
    'shops',
    async () => {
      if (!live) return { categories: [...SHOP_CATEGORIES], rail: [...FEATURED_SHOPS], list: [...POPULAR_NEAR_YOU] };
      const merchants = await fetchMerchants(api, 'shops');
      return { categories: shopCategories(merchants), rail: merchants, list: merchants };
    },
    live,
  );
}

// ---------------------------------------------------------------- Storefront

export interface StorefrontView extends StorefrontModel {
  /** A hero photograph for the storefront, where one exists. */
  hero: MerchantModel['cover'];
}

export function useStorefront(slug: string | undefined): Loaded<StorefrontView> {
  const live = catalogueIsLive();
  return useLoad(
    slug ?? null,
    async (fresh) => {
      if (!slug) throw new ApiError(404, 'not_found', 'Not found.');
      if (!live) {
        const merchant = merchantBySlug(slug);
        if (!merchant) throw new ApiError(404, 'not_found', 'Not found.');
        return {
          merchant,
          hero: slug === 'techworld' ? STOREFRONT_HERO.techworld : merchant.cover,
          shelves: [...STOREFRONT_SHELVES],
          products: PRODUCTS.filter((p) => p.merchantSlug === slug),
        };
      }
      const store = await loadStorefront(slug, fresh);
      return { ...store, hero: store.merchant.cover };
    },
    live,
  );
}

// ---------------------------------------------------------------- Product

export function useProduct(id: string | undefined, store: string | undefined): Loaded<{ product: ProductModel; merchant: MerchantModel | null }> {
  const live = catalogueIsLive();
  return useLoad(
    id ? `${store ?? ''}/${id}` : null,
    async (fresh) => {
      const notFound = new ApiError(404, 'not_found', 'Not found.');
      if (!id) throw notFound;
      if (!live || !store) {
        const product = productById(id);
        if (!product) throw notFound;
        return { product, merchant: merchantBySlug(product.merchantSlug) ?? null };
      }
      const storefront = await loadStorefront(store, fresh);
      const product = storefront.products.find((p) => p.id === id);
      if (!product) throw notFound;
      return { product, merchant: storefront.merchant };
    },
    live,
  );
}

// ---------------------------------------------------------------- Cart lines

/** The products behind the cart's lines: the storefront the cart belongs to, or the fixtures. */
export function useCartProducts(merchantSlug: string | null): Loaded<Map<string, ProductModel>> {
  const live = catalogueIsLive() && merchantSlug !== null && !merchantBySlug(merchantSlug);
  return useLoad(
    merchantSlug ?? 'none',
    async (fresh) => {
      if (!live || !merchantSlug) return new Map(PRODUCTS.map((p) => [p.id, p]));
      const store = await loadStorefront(merchantSlug, fresh);
      return new Map(store.products.map((p) => [p.id, p]));
    },
    live,
  );
}

// ---------------------------------------------------------------- Search

export function useCatalogueSearch(query: string, delayMs = 300): Loaded<SearchResultsModel> & { tooShort: boolean } {
  const live = catalogueIsLive();
  const q = query.trim();
  const [debounced, setDebounced] = useState(q);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(q), delayMs);
    return () => clearTimeout(timer);
  }, [q, delayMs]);

  const tooShort = debounced.length < SEARCH_MIN_LENGTH;
  const loaded = useLoad(
    tooShort ? null : debounced,
    async () => {
      if (!live) {
        const lower = debounced.toLowerCase();
        return {
          shops: FEATURED_SHOPS.filter((s) => `${s.name} ${s.descriptor}`.toLowerCase().includes(lower)).map((s) => ({
            slug: s.slug,
            name: s.name,
            descriptor: s.descriptor,
            rating: s.rating,
          })),
          products: PRODUCTS.filter((p) => p.name.toLowerCase().includes(lower)).map((p) => ({
            id: p.id,
            name: p.name,
            price: p.price,
            merchantSlug: p.merchantSlug,
            merchantName: merchantBySlug(p.merchantSlug)?.name ?? '',
            image: p.image,
          })),
        };
      }
      return searchCatalogue(api, debounced);
    },
    live,
  );
  return { ...loaded, tooShort };
}
