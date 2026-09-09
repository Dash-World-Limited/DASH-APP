import type { Metadata } from 'next';
import Link from 'next/link';

import { Button } from '@/components/ui';
import { INDEXING_ENABLED, SITE_ORIGIN } from '@/lib/declutter';
import { Marketplace } from './marketplace';

/**
 * The Declutters front door.
 *
 * This page used to render `SectionPage`, the shared "pick a seller, browse
 * their catalogue" screen that Shops, Restaurants, Local Market and Pharmacy
 * all use. That shape was right while Declutter was proven rider
 * infrastructure sitting on the vendor tables, and it is wrong for the real
 * marketplace: each seller here has one sofa, and making a buyer choose a
 * stranger before seeing what they were selling would be a worse product
 * wearing a consistent shape. The vendor path is untouched and still serves
 * `/browse/[slug]`; only this front door now points at listings.
 *
 * A server component purely so it can carry metadata. The feed itself is a
 * client component, because searching and filtering are interactive and a
 * crawler has no need for a list of listings in the HTML — the individual
 * listing pages are the ones worth indexing, and those render server-side.
 */

const DESCRIPTION =
  'Second-hand phones, laptops, furniture, appliances and tools in Lagos and Asaba. Every item checked by DASH, every price fixed, every seller identity-verified.';

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
  twitter: { card: 'summary', title: 'DASH World Declutters', description: DESCRIPTION },
};

export default function DeclutterPage() {
  // No shell of its own: the `(declutter)` layout supplies the website's own
  // header and footer.
  return (
    <>
      <main id="main">
        <Marketplace />

        {/* The way in for the other half of the marketplace. At the foot of the
            feed rather than in the header: most people arrive wanting to buy,
            and the ones who want to sell are looking for it. */}
        <aside className="mx-auto w-full max-w-6xl px-4 pb-10">
          <div className="rounded-[var(--radius-card)] border border-dashed px-6 py-8 text-center">
            <p className="text-base font-semibold">Have something to sell?</p>
            <p className="mx-auto mt-2 max-w-md text-sm text-[var(--ink-muted)]">
              DASH values it, checks it and handles the buyer. You agree the price before anything
              is published.
            </p>
            <Link href="/declutter/sell" className="mt-5 inline-block">
              <Button>Sell an item</Button>
            </Link>
          </div>
        </aside>
      </main>
    </>
  );
}
