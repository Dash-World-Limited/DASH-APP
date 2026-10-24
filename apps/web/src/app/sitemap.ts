import type { MetadataRoute } from 'next';

import { API_BASE } from '@/lib/api';
import { INDEXING_ENABLED, SITE_ORIGIN, type ListingCard } from '@/lib/declutter';

/**
 * The sitemap.
 *
 * Only Declutters is in it. The rest of this application is not public, and a
 * sitemap is a positive statement that a URL is worth indexing — listing the
 * operations console in one would be an invitation.
 *
 * Listings are read from the same public endpoint a visitor uses, so the
 * sitemap can only ever contain pages a stranger can actually open: the feed
 * excludes anything draft, rejected, suspended or sold, and a sitemap entry for
 * a page that answers 404 is a crawl error that costs the site ranking.
 *
 * Empty when indexing is off. A sitemap served by a site whose robots.txt
 * disallows everything is a contradiction, and the first thing anyone
 * debugging indexing has to untangle.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  if (!INDEXING_ENABLED) return [];

  const now = new Date();

  const roots: MetadataRoute.Sitemap = [
    { url: `${SITE_ORIGIN}/declutter`, lastModified: now, changeFrequency: 'hourly', priority: 1 },
    {
      url: `${SITE_ORIGIN}/declutter/sell`,
      lastModified: now,
      changeFrequency: 'monthly',
      priority: 0.6,
    },
  ];

  let listings: ListingCard[] = [];
  try {
    // The public cap is 48 a page; this walks a few pages rather than asking
    // for everything at once, and stops at a bound so a marketplace that grows
    // faster than expected cannot turn sitemap generation into a long request.
    let cursor: string | null = null;
    for (let page = 0; page < 20; page += 1) {
      const query = new URLSearchParams({ limit: '48', sort: 'newest' });
      if (cursor) query.set('cursor', cursor);

      const response = await fetch(`${API_BASE}/v1/declutter/listings?${query.toString()}`, {
        cache: 'no-store',
      });
      if (!response.ok) break;

      const body = (await response.json()) as { listings: ListingCard[]; nextCursor: string | null };
      listings = listings.concat(body.listings);
      cursor = body.nextCursor;
      if (!cursor) break;
    }
  } catch {
    // A sitemap missing its listings is a smaller problem than a build or a
    // request that fails because the API was briefly unreachable.
    return roots;
  }

  return roots.concat(
    listings.map((listing) => ({
      url: `${SITE_ORIGIN}/declutter/${listing.slug}`,
      lastModified: listing.publishedAt ? new Date(listing.publishedAt) : now,
      changeFrequency: 'daily' as const,
      priority: 0.8,
    })),
  );
}
