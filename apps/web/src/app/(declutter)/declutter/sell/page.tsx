import type { Metadata } from 'next';

import { INDEXING_ENABLED, SITE_ORIGIN } from '@/lib/declutter';
import { SellEntry } from './sell';

/**
 * Sell an item.
 *
 * The entry point, and honest about what it is: this milestone shipped the
 * public marketplace, not the full seller portal. A person who arrives here
 * gets the real sequence explained, and lands in whichever step actually
 * applies to them — become a seller, get verified, or describe the item.
 *
 * What it deliberately does not do is collect an item and then discover the
 * person cannot sell yet. Verification is the long pole, it involves a document
 * review by a human, and finding that out after typing a description is the
 * kind of thing that makes somebody give up on a marketplace.
 */

const DESCRIPTION =
  'Sell your phone, laptop, furniture or appliance through DASH World Declutters. DASH values it, verifies you, sets a fixed price you agree to, and handles the buyer.';

export const metadata: Metadata = {
  title: 'Sell an item — DASH World Declutters',
  description: DESCRIPTION,
  alternates: { canonical: `${SITE_ORIGIN}/declutter/sell` },
  robots: INDEXING_ENABLED ? { index: true, follow: true } : { index: false, follow: false },
  openGraph: {
    type: 'website',
    title: 'Sell an item — DASH World Declutters',
    description: DESCRIPTION,
    url: `${SITE_ORIGIN}/declutter/sell`,
    siteName: 'DASH World Declutters',
    locale: 'en_NG',
  },
};

export default function SellPage() {
  return <SellEntry />;
}
