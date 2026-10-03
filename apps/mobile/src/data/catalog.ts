/**
 * The customer catalogue, from the real API.
 *
 * Three existing public endpoints, nothing new: `GET /v1/vendors` (a service's
 * merchants), `GET /v1/vendors/:slug` (one storefront: its shelves and
 * products) and `GET /v1/search`. This file maps their answers onto the view
 * models the screens already draw (data/models.ts), so wiring a screen is a
 * change of source, not a redesign.
 *
 * What the API does not serve is left empty rather than invented:
 * - photographs: vendors have no cover or logo yet, and a product's
 *   `imageKey` is a storage key the API cannot resolve yet. An `https` value
 *   is used as-is, anything else is "no photo" — the same rule as the web
 *   (apps/web/src/lib/images.ts). Screens draw a designed placeholder.
 * - product ratings and galleries do not exist; vendor ratings do.
 * - "featured" and "popular" signals do not exist, so the screens rank by the
 *   real rating instead and say so.
 *
 * Money stays integer kobo from the server. Nothing here adds prices up.
 *
 * Pure mapping plus thin fetchers: tested directly with a fake server.
 */

import type { Kobo } from '@dash/domain/money';
import type { ImageSourcePropType } from 'react-native';

import type { ApiClient } from '../api/client';
import { COMPILED_API_URL } from '../api/buildConfig';
import { normaliseBaseUrl } from '../api/client';
import type { MerchantModel, ProductModel, ProductOptionGroup, ShopCategoryModel } from './models';

// ---------------------------------------------------------------- API shapes (only what is used)

export interface ApiVendorSummary {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  category: string;
  serviceCategory: string | null;
  rating: { average: number | null; count: number } | null;
  branch: { id: string; state: string | null; minimumOrder: number | null; estimatedMinutes: number | null } | null;
  distanceMetres: number | null;
}

export interface ApiModifierGroup {
  id: string;
  name: string;
  minSelect: number;
  maxSelect: number;
  options: { id: string; name: string; priceDelta: number }[];
}

export interface ApiItem {
  id: string;
  name: string;
  description: string | null;
  price: number;
  imageKey: string | null;
  isAvailable: boolean;
  modifierGroups?: ApiModifierGroup[];
}

export interface ApiVendorDetail {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  category: string;
  ratingAverage: number | null;
  ratingCount: number;
  branches: { id: string; defaultPrepMinutes: number; busyExtraMinutes: number }[];
  categories: { id: string; name: string; description: string | null; items: ApiItem[] }[];
}

export interface ApiSearchResult {
  vendors: { id: string; name: string; slug: string; category: string; ratingAverage: number | null }[];
  items: { id: string; name: string; price: number; vendor: { id: string; name: string; slug: string } }[];
}

// ---------------------------------------------------------------- mapping

/** An image the app can load, or null. `https` URLs only: keys are not resolvable yet. */
export function imageSource(key: string | null | undefined): ImageSourcePropType | null {
  if (typeof key !== 'string') return null;
  const value = key.trim();
  if (/^https:\/\//i.test(value)) return { uri: value };

  // Local staging storage signs through the API itself and therefore returns
  // a relative /v1/files/... URL. The connected staging APK has its API origin
  // compiled into the bundle, so resolve only that known internal path against
  // that trusted origin. Raw storage keys are never rendered.
  if (/^\/v1\/files\//i.test(value)) {
    const base = normaliseBaseUrl(COMPILED_API_URL);
    return base ? { uri: `${base}${value}` } : null;
  }

  return null;
}

/** The vendor categories the Shops service holds, in words. */
const VENDOR_CATEGORY_LABELS: Record<string, string> = {
  grocery: 'Groceries',
  retail: 'Retail',
  restaurant: 'Restaurant',
  pharmacy: 'Pharmacy',
  market: 'Local Market',
  declutter: 'Declutter',
};

export function vendorCategoryLabel(category: string): string {
  return VENDOR_CATEGORY_LABELS[category] ?? category.charAt(0).toUpperCase() + category.slice(1);
}

function rating(average: number | null | undefined, count: number | null | undefined): MerchantModel['rating'] {
  return typeof average === 'number' && typeof count === 'number' && count > 0 ? { average, count } : null;
}

/** One estimate, shown as one (the API does not serve a range). */
function eta(minutes: number | null | undefined): MerchantModel['eta'] {
  return typeof minutes === 'number' && minutes > 0 ? { min: minutes, max: minutes } : null;
}

export function merchantFromSummary(vendor: ApiVendorSummary): MerchantModel {
  return {
    slug: vendor.slug,
    name: vendor.name,
    descriptor: vendorCategoryLabel(vendor.category),
    category: vendor.category,
    cover: null,
    logo: null,
    rating: rating(vendor.rating?.average, vendor.rating?.count),
    eta: eta(vendor.branch?.estimatedMinutes),
  };
}

/**
 * The real category structure above a service's shops: "All", then one door
 * per vendor category that actually has a shop, in a fixed order. Never only
 * "All" while there are shops to show (see MIN_SERVER_SERVICES for Home's
 * version of the same rule).
 */
export function shopCategories(merchants: readonly MerchantModel[]): ShopCategoryModel[] {
  const present = [...new Set(merchants.map((m) => m.category).filter((c): c is string => Boolean(c)))];
  present.sort((a, b) => vendorCategoryLabel(a).localeCompare(vendorCategoryLabel(b)));
  return [{ id: 'all', label: 'All', image: null }, ...present.map((id) => ({ id, label: vendorCategoryLabel(id), image: null }))];
}

/**
 * Modifier groups as the option groups the product screen draws. Each group is
 * one choice; an optional group (minSelect 0) starts on "None" so nothing is
 * chosen for the customer. A price delta is shown on the option, formatted by
 * the screen, never added to the price here.
 */
export function optionGroupsFromModifiers(groups: readonly ApiModifierGroup[] | undefined): ProductOptionGroup[] {
  return (groups ?? [])
    .filter((group) => group.options.length > 0)
    .map((group) => {
      const options = group.options.map((option) => ({ id: option.id, label: option.name, priceDelta: option.priceDelta }));
      const optional = group.minSelect === 0;
      return {
        id: group.id,
        label: group.name,
        kind: 'chip' as const,
        options: optional ? [{ id: '', label: 'None', priceDelta: 0 }, ...options] : options,
        defaultOption: optional ? '' : undefined,
      };
    });
}

export function productFromItem(item: ApiItem, merchantSlug: string, shelf: string, shelfLabel?: string): ProductModel {
  const image = imageSource(item.imageKey);
  return {
    id: item.id,
    merchantSlug,
    name: item.name,
    price: item.price as Kobo,
    image,
    gallery: image ? [image] : [],
    description: item.description ?? '',
    rating: null,
    optionGroups: optionGroupsFromModifiers(item.modifierGroups),
    shelf,
    shelfLabel,
    available: item.isAvailable,
  };
}

export interface StorefrontModel {
  merchant: MerchantModel;
  /** "All", then the shop's own shelves in its order. */
  shelves: { id: string; label: string }[];
  products: ProductModel[];
  /** The branch an order is placed with. Null for staging fixtures, which cannot be ordered from. */
  branchId?: string | null;
}

export function storefrontFromDetail(vendor: ApiVendorDetail): StorefrontModel {
  const branch = vendor.branches[0];
  const merchant: MerchantModel = {
    slug: vendor.slug,
    name: vendor.name,
    descriptor: vendorCategoryLabel(vendor.category),
    category: vendor.category,
    cover: null,
    logo: null,
    rating: rating(vendor.ratingAverage, vendor.ratingCount),
    eta: eta(branch ? branch.defaultPrepMinutes + branch.busyExtraMinutes : null),
    description: vendor.description ?? undefined,
  };
  const shelves = vendor.categories.filter((c) => c.items.length > 0);
  return {
    merchant,
    shelves: [{ id: 'all', label: 'All' }, ...shelves.map((c) => ({ id: c.id, label: c.name }))],
    products: shelves.flatMap((c) => c.items.map((item) => productFromItem(item, vendor.slug, c.id, c.name))),
    branchId: branch?.id ?? null,
  };
}

export interface SearchResultsModel {
  shops: { slug: string; name: string; descriptor: string; rating: MerchantModel['rating'] }[];
  products: { id: string; name: string; price: Kobo; merchantSlug: string; merchantName: string; image?: ImageSourcePropType | null }[];
}

export function searchFromApi(result: ApiSearchResult): SearchResultsModel {
  return {
    shops: result.vendors.map((v) => ({
      slug: v.slug,
      name: v.name,
      descriptor: vendorCategoryLabel(v.category),
      rating: typeof v.ratingAverage === 'number' ? { average: v.ratingAverage, count: 0 } : null,
    })),
    products: result.items.map((i) => ({
      id: i.id,
      name: i.name,
      price: i.price as Kobo,
      merchantSlug: i.vendor.slug,
      merchantName: i.vendor.name,
    })),
  };
}

// ---------------------------------------------------------------- fetchers

export const SEARCH_MIN_LENGTH = 2;

export async function fetchMerchants(api: ApiClient, service: 'shops'): Promise<MerchantModel[]> {
  // One page is the whole service at launch volume; the API caps a page at 50.
  const body = await api.request<{ vendors: ApiVendorSummary[] }>(`/v1/vendors?service=${service}&sort=rating&limit=50`, { auth: false });
  return (body.vendors ?? []).map(merchantFromSummary);
}

export async function fetchStorefront(api: ApiClient, slug: string): Promise<StorefrontModel> {
  const body = await api.request<{ vendor: ApiVendorDetail }>(`/v1/vendors/${encodeURIComponent(slug)}`, { auth: false });
  return storefrontFromDetail(body.vendor);
}

export async function searchCatalogue(api: ApiClient, query: string): Promise<SearchResultsModel> {
  const q = query.trim();
  if (q.length < SEARCH_MIN_LENGTH) return { shops: [], products: [] };
  const body = await api.request<ApiSearchResult>(`/v1/search?q=${encodeURIComponent(q)}&limit=15`, { auth: false });
  return searchFromApi(body);
}
