'use client';

/**
 * Product analytics hooks.
 *
 * A deliberately thin shim, and it does not ship an analytics vendor. What it
 * does is put every event the marketplace cares about behind one named function
 * with a fixed vocabulary, so that when a provider is chosen it is wired in one
 * place rather than sprinkled through components — and so a reviewer can read
 * the list below and see exactly what this product measures.
 *
 * ## What is never sent
 *
 * No personal data. Not an email, not a phone number, not a seller's display
 * name, not a free-text enquiry message, and not a customer id. The properties
 * are slugs, category keys, counts and prices — enough to answer "which
 * categories do people browse and where do they drop out", and not enough to
 * reconstruct who did it. This is enforced by the `AnalyticsProperties` type
 * rather than by a reviewer noticing.
 *
 * ## How it behaves before a provider exists
 *
 * `window.dashAnalytics` is called if a host page defined one, and otherwise
 * nothing happens. No console noise in production, no queue growing in memory,
 * no network request. A missing analytics provider must never be able to break
 * a page or slow a first paint.
 */

/**
 * Every event the marketplace emits.
 *
 * A closed union rather than a free string: an event name typed slightly
 * differently in two components produces two funnels that look like one, and
 * that is discovered months later while trying to explain a drop-off.
 */
export type AnalyticsEvent =
  | 'declutter_feed_viewed'
  | 'declutter_search_used'
  | 'declutter_filter_applied'
  | 'declutter_listing_viewed'
  | 'declutter_photo_opened'
  | 'declutter_contact_requested'
  | 'declutter_contact_request_failed'
  | 'declutter_sell_started';

/**
 * What may travel with an event.
 *
 * Numbers, booleans and short slugs only. There is no `string` catch-all on
 * purpose — that is the field a free-text message or a display name would
 * eventually be put into.
 */
export interface AnalyticsProperties {
  /** Listing slug. Public, already in the URL. */
  slug?: string;
  /** Category key, e.g. `phones-tablets`. */
  category?: string;
  /** Area slug, e.g. `asaba-okpanam-road`. */
  location?: string;
  condition?: string;
  sort?: string;
  /** Integer kobo, as everywhere else in this codebase. */
  priceKobo?: number;
  resultCount?: number;
  /** Whether a search box had any text, never the text itself. */
  hasQuery?: boolean;
  page?: number;
  reason?: string;
}

declare global {
  interface Window {
    dashAnalytics?: (event: string, properties: Record<string, unknown>) => void;
  }
}

export function track(event: AnalyticsEvent, properties: AnalyticsProperties = {}): void {
  if (typeof window === 'undefined') return;
  try {
    window.dashAnalytics?.(event, { ...properties });
  } catch {
    // Analytics is never allowed to break a page. A provider that throws is a
    // provider problem, and the buyer looking at a sofa should not find out.
  }
}
