import type { MetadataRoute } from 'next';

import { INDEXING_ENABLED, SITE_ORIGIN } from '@/lib/declutter';

/**
 * robots.txt.
 *
 * The default is to allow nothing. Most of what this application serves is a
 * development build with fictional vendors, an operations console and a rider
 * app, none of which should ever appear in a search result — and a robots file
 * that opens by default would put them there the first time somebody pointed a
 * domain at it.
 *
 * `NEXT_PUBLIC_DECLUTTER_INDEXABLE=true` opens exactly the marketplace and
 * nothing else: the feed, the listing pages, the sell page. The console, the
 * rider surfaces, sign-in and the customer app stay disallowed even then,
 * because they are still not public and a crawler following a link from a
 * shared listing would otherwise wander into them.
 *
 * This is belt and braces with the per-page `robots` metadata. A page carries
 * its own `noindex` when indexing is off; this file stops a crawler asking for
 * it at all. Either alone would be enough, and a launch is the wrong time to
 * rely on one of them being right.
 */
export default function robots(): MetadataRoute.Robots {
  if (!INDEXING_ENABLED) {
    return {
      rules: [{ userAgent: '*', disallow: '/' }],
    };
  }

  return {
    rules: [
      {
        userAgent: '*',
        allow: ['/declutter'],
        disallow: [
          '/',
          '/ops',
          '/rider',
          '/vendor',
          '/account',
          '/orders',
          '/basket',
          '/wallet',
          '/signin',
          '/home',
          '/browse',
          '/search',
          '/shops',
          '/restaurants',
          '/market',
          '/pharmacy',
        ],
      },
    ],
    sitemap: `${SITE_ORIGIN}/sitemap.xml`,
  };
}
