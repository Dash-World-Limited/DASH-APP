/**
 * Shared types and vocabulary for the Declutters marketplace.
 *
 * Deliberately not a `'use client'` module: the listing detail page fetches on
 * the server so it can put a real title, description and image into the page's
 * metadata, and both halves need these types.
 */

import { API_BASE } from './api';

export interface PublicLocation {
  slug: string;
  label: string;
}

export interface ListingPhoto {
  url: string;
  alt: string;
  role: string;
}

/**
 * Where a photograph is actually fetched from.
 *
 * The API returns whatever its storage provider issued. Object storage issues
 * an absolute signed URL and this is a no-op; the local development adapter
 * issues a path on the *API*, and a bare path in an <img src> would resolve
 * against the web origin instead — which is a broken image on every card, and
 * would still be broken in production the moment the API is on its own host.
 */
export function photoSrc(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `${API_BASE}${url}`;
}

export interface ListingCard {
  slug: string;
  title: string;
  priceKobo: number;
  condition: string;
  categoryKey: string;
  categoryName: string;
  location: PublicLocation;
  availability: string;
  badges: string[];
  photo: ListingPhoto | null;
  publishedAt: string | null;
}

export interface ListingDetail extends Omit<ListingCard, 'photo'> {
  description: string;
  attributes: Record<string, unknown>;
  photos: ListingPhoto[];
  seller: {
    id: string;
    displayName: string;
    sellerType: string;
    isTrustedPartner: boolean;
    memberSince: string | null;
  };
  contactable: boolean;
}

export interface Taxonomy {
  categories: { key: string; name: string; slug: string }[];
  locations: PublicLocation[];
}

/**
 * The words a badge is allowed to appear as, mirrored from
 * `TRUST_BADGE_LABELS` in `@dash/domain/declutter`.
 *
 * Mirrored rather than imported because this is a plain string map and pulling
 * the domain package into a server component's render path for five words is
 * not worth the build coupling. The domain owns *whether* a badge is earned;
 * this owns how it is spelled, and a test in the domain pins the wording.
 */
export const BADGE_LABELS: Record<string, string> = {
  dash_reviewed: 'DASH Reviewed',
  verified_listing: 'Verified Listing',
  fixed_price: 'Fixed Price',
  trusted_partner: 'Trusted Partner',
  value_checked: 'DASH ValueChecked',
};

/** One line explaining what each badge actually means, for a tooltip or aside. */
export const BADGE_MEANINGS: Record<string, string> = {
  dash_reviewed: 'A DASH team member reviewed this listing and approved its price.',
  verified_listing: 'This seller’s identity was verified against government ID.',
  fixed_price: 'The price is set by DASH. There is no haggling.',
  trusted_partner: 'This seller has a standing agreement with DASH.',
  value_checked: 'Priced with DASH ValueCheck and authorised by a person.',
};

export const CONDITION_LABELS: Record<string, string> = {
  new: 'New',
  like_new: 'Like new',
  good: 'Good',
  fair: 'Fair',
};

export const AVAILABILITY_LABELS: Record<string, string> = {
  available: 'Available',
  reserved: 'Reserved',
  unavailable: 'Unavailable',
  sold: 'Sold',
};

/**
 * The four things this marketplace promises, in the words it is allowed to use.
 *
 * `No Negotiation` is deliberately messaging rather than a badge. A badge is
 * derived from a recorded fact about one listing; this is true of the whole
 * product, and dressing a universal truth up as a per-item award would cheapen
 * the badges that are actually earned.
 *
 * `DASH ValueChecked` is absent, and will stay absent until a live valuation
 * provider has genuinely run and a human has authorised the price. The domain
 * refuses to emit it; this file does not offer the words either.
 */
export const TRUST_PROMISES: { title: string; body: string }[] = [
  {
    title: 'DASH Reviewed',
    // Not "inspects the item": DASH reviews the submission — its photos,
    // description and price. Physical inspection happens between buyer and
    // seller (docs/DESIGN-DECLUTTER-DOMAIN.md), and the condition is the
    // seller's own description.
    body: 'A DASH team member reviews the photos, description and price, and approves the listing. The condition is as described by the seller.',
  },
  {
    title: 'Verified Listing',
    body: 'The seller’s identity is checked against government ID before anything goes live.',
  },
  {
    title: 'Fixed Price',
    body: 'DASH sets one price from real market evidence. It is the price you pay.',
  },
  {
    title: 'No Negotiation',
    body: 'Nobody haggles, nobody is talked up, and nobody misses out for answering slowly.',
  },
];

/**
 * Where the parent brand lives.
 *
 * Declutters is a Dash World product, and a visitor who landed on a shared
 * listing has no other way to learn that.
 */
export const DASH_WORLD_URL = 'https://dashworldng.com';

export const SORT_OPTIONS: { value: string; label: string }[] = [
  { value: 'newest', label: 'Newest first' },
  { value: 'price_low', label: 'Price: low to high' },
  { value: 'price_high', label: 'Price: high to low' },
];

/**
 * Fetch a listing on the server, for metadata and first paint.
 *
 * Returns null rather than throwing on anything that is not a listing we can
 * show. A hidden or missing listing has to become a 404 page, and an API that
 * is briefly down must not turn a product page into a stack trace.
 *
 * `no-store` because a listing can be suspended at any moment, and a cached
 * page for a suspended item is exactly the thing moderation exists to prevent.
 */
export async function fetchListingOnServer(slug: string): Promise<ListingDetail | null> {
  try {
    const response = await fetch(`${API_BASE}/v1/declutter/listings/${encodeURIComponent(slug)}`, {
      cache: 'no-store',
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { listing: ListingDetail };
    return body.listing;
  } catch {
    return null;
  }
}

/**
 * The first page of listings and the taxonomy, fetched on the server.
 *
 * The landing page is image-led, and an image-led page whose images arrive
 * after a round trip is a grey page. Fetching here puts real photographs into
 * the first HTML the browser receives, which matters most on the connection a
 * Lagos handset actually has.
 *
 * Failures degrade rather than throw. If the API is briefly unreachable the
 * hero renders without its collage and the feed below it — which fetches
 * client-side anyway — shows its own error state with a retry. A marketplace
 * that 500s because a decorative image could not be found is worse than one
 * that opens slightly plainer.
 */
export async function fetchLandingOnServer(): Promise<{
  listings: ListingCard[];
  categories: Taxonomy['categories'];
}> {
  const [listings, taxonomy] = await Promise.all([
    fetch(`${API_BASE}/v1/declutter/listings?limit=12`, { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : { listings: [] }))
      .then((body: { listings?: ListingCard[] }) => body.listings ?? [])
      .catch(() => [] as ListingCard[]),
    fetch(`${API_BASE}/v1/declutter/taxonomy`, { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : { categories: [] }))
      .then((body: { categories?: Taxonomy['categories'] }) => body.categories ?? [])
      .catch(() => [] as Taxonomy['categories']),
  ]);

  return { listings, categories: taxonomy };
}

/** Naira, without the trailing kobo nobody reads on a price tag. */
export function formatPrice(kobo: number): string {
  return `₦${Math.round(kobo / 100).toLocaleString('en-NG')}`;
}


/**
 * The canonical public origin, used for share links and structured data.
 *
 * Falls back to the production host rather than to localhost: a metadata URL
 * that says `http://localhost:3000` in a shared WhatsApp preview is worse than
 * one that is merely stale.
 */
export const SITE_ORIGIN =
  process.env['NEXT_PUBLIC_SITE_ORIGIN'] ?? 'https://dashworldng.com';

/**
 * Whether search engines may index the marketplace.
 *
 * Off unless explicitly switched on. The rest of this application is a
 * development build serving fictional vendors and must never be indexed; the
 * Declutters pages are the first genuinely public surface, and turning them on
 * should be a deliberate act at launch rather than something that happens
 * because a page was written.
 */
export const INDEXING_ENABLED = process.env['NEXT_PUBLIC_DECLUTTER_INDEXABLE'] === 'true';
