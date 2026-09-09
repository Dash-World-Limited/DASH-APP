import type { Metadata } from 'next';
import Link from 'next/link';

import { DeclutterHero } from '@/components/declutter/DeclutterHero';
import { TrustBand } from '@/components/declutter/TrustBand';
import { INDEXING_ENABLED, SITE_ORIGIN, fetchLandingOnServer } from '@/lib/declutter';
import { Marketplace } from './marketplace';

/**
 * The Declutters front door.
 *
 * This page used to render `SectionPage`, the shared "pick a seller, browse
 * their catalogue" screen that Shops, Restaurants, Local Market and Pharmacy
 * all use. That shape was right while Declutter was proven rider infrastructure
 * sitting on the vendor tables, and it is wrong for the real marketplace: each
 * seller here has one sofa, and making a buyer choose a stranger before seeing
 * what they were selling would be a worse product wearing a consistent shape.
 * The vendor path is untouched and still serves `/browse/[slug]`; only this
 * front door now points at listings.
 *
 * A server component, and the first page of listings is fetched here rather
 * than in the browser. The hero is built from photographs of items genuinely
 * for sale, and an image-led page whose images arrive after a round trip is a
 * grey page — which is the difference between a marketplace and a loading
 * spinner on the connection a Lagos handset actually has.
 */

const DESCRIPTION =
  'Checked second-hand phones, laptops, furniture, appliances, tools and cars in Lagos and Asaba. Every item reviewed by the DASH team, every price fixed, every seller identity-verified.';

export const metadata: Metadata = {
  title: 'DASH World Declutters — checked second-hand at a fixed price',
  description: DESCRIPTION,
  alternates: { canonical: `${SITE_ORIGIN}/declutter` },
  robots: INDEXING_ENABLED ? { index: true, follow: true } : { index: false, follow: false },
  openGraph: {
    type: 'website',
    title: 'DASH World Declutters',
    description: DESCRIPTION,
    url: `${SITE_ORIGIN}/declutter`,
    siteName: 'DASH World Declutters',
    locale: 'en_NG',
  },
  twitter: { card: 'summary_large_image', title: 'DASH World Declutters', description: DESCRIPTION },
};

export default async function DeclutterPage() {
  const { listings, categories } = await fetchLandingOnServer();

  return (
    <main id="main">
      <DeclutterHero featured={listings} />

      <Marketplace initialListings={listings} initialCategories={categories} />

      <TrustBand />

      {/* The way in for the other half of the marketplace. Below the trust band
          rather than in the header: most people arrive wanting to buy, and by
          the time somebody has read why DASH checks every item, they are in a
          position to believe the same will happen to theirs. */}
      <section className="mx-auto w-full max-w-[1240px] px-5 py-20 sm:px-8">
        <div className="dcl-glass relative overflow-hidden rounded-[var(--radius-card)] px-6 py-14 text-center sm:px-14">
          <div
            aria-hidden
            className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full opacity-30 blur-[100px]"
            style={{ background: 'radial-gradient(circle, rgba(212,175,55,0.55), transparent 65%)' }}
          />
          <div className="relative">
            <p className="dcl-eyebrow">Selling</p>
            <h2 className="dcl-display mx-auto mt-4 max-w-2xl text-3xl sm:text-4xl">
              Find out what your things are actually worth.
            </h2>
            <p className="mx-auto mt-5 max-w-xl text-base leading-relaxed text-[var(--ink-muted)]">
              DASH values the item, verifies you once, and handles every buyer. You agree the price
              before anything is published, and your phone number never is.
            </p>
            <Link
              href="/declutter/sell"
              className="mt-9 inline-flex min-h-12 items-center rounded-full bg-[var(--primary)] px-8 text-sm font-bold text-[var(--on-primary)] transition-colors hover:bg-[var(--primary-hover)]"
            >
              Sell an item
            </Link>
          </div>
        </div>
      </section>
    </main>
  );
}
