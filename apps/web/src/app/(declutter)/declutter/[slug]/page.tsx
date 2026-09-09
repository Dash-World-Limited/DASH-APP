import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import {
  BADGE_LABELS,
  CONDITION_LABELS,
  INDEXING_ENABLED,
  SITE_ORIGIN,
  fetchListingOnServer,
  photoSrc,
} from '@/lib/declutter';
import { ListingDetailView } from './detail';

/**
 * One item, rendered on the server.
 *
 * This is the only page in the application that is fetched server-side, and the
 * reason is share previews. A Declutters listing's natural life is being pasted
 * into a WhatsApp group — that is how second-hand selling actually spreads in
 * Lagos and Asaba — and a link that unfurls as "DASH APP" with no picture is a
 * link nobody taps. Metadata cannot be produced by a client component, so the
 * page fetches once on the server, renders the real content into the HTML, and
 * hands the same data to a client component for the interactive parts.
 *
 * A listing that is missing, suspended, rejected or sold-and-archived comes back
 * as `null` and becomes a 404 here. That mirrors the API, which answers 404
 * rather than 403 for anything hidden, so a guessed slug cannot be used to learn
 * that a listing exists.
 */

interface PageProps {
  params: Promise<{ slug: string }>;
}

/** Trimmed to roughly what a preview card shows before it truncates anyway. */
function shareDescription(description: string, priceNaira: string, area: string): string {
  const summary = description.replace(/\s+/g, ' ').trim();
  const opener = `${priceNaira} · ${area} · Fixed price, DASH Reviewed.`;
  const room = 160 - opener.length - 1;
  return room > 20 && summary.length > 0
    ? `${opener} ${summary.slice(0, room).trimEnd()}${summary.length > room ? '…' : ''}`
    : opener;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const listing = await fetchListingOnServer(slug);

  if (!listing) {
    return { title: 'Item not found — DASH World Declutters', robots: { index: false } };
  }

  const priceNaira = `₦${(listing.priceKobo / 100).toLocaleString('en-NG')}`;
  const title = `${listing.title} — ${priceNaira} — DASH World Declutters`;
  const description = shareDescription(listing.description, priceNaira, listing.location.label);
  const url = `${SITE_ORIGIN}/declutter/${listing.slug}`;
  // Absolute, because a share preview is fetched by WhatsApp or a crawler
  // from outside this application entirely.
  const first = listing.photos[0];
  const image = first ? photoSrc(first.url) : undefined;

  return {
    title,
    description,
    alternates: { canonical: url },
    // Indexing is off unless explicitly enabled. The rest of this application
    // is a development build serving fictional vendors, and switching the
    // marketplace on should be a deliberate act at launch.
    robots: INDEXING_ENABLED ? { index: true, follow: true } : { index: false, follow: false },
    openGraph: {
      type: 'website',
      title,
      description,
      url,
      siteName: 'DASH World Declutters',
      locale: 'en_NG',
      ...(image ? { images: [{ url: image, alt: listing.photos[0]?.alt ?? listing.title }] } : {}),
    },
    twitter: {
      card: image ? 'summary_large_image' : 'summary',
      title,
      description,
      ...(image ? { images: [image] } : {}),
    },
  };
}

export default async function ListingPage({ params }: PageProps) {
  const { slug } = await params;
  const listing = await fetchListingOnServer(slug);
  if (!listing) notFound();

  /**
   * Structured data.
   *
   * `availability` and `price` are copied from the same response the page
   * renders, so a search result can never advertise a price the page does not
   * show. `itemCondition` uses schema.org's own vocabulary rather than ours.
   *
   * The seller is named by display name only — the same string already on the
   * page — and there is no address, no telephone and no email, because a
   * structured-data block is exactly the kind of place a contact detail gets
   * added without anyone thinking of it as publishing one.
   */
  const conditionUrl: Record<string, string> = {
    new: 'https://schema.org/NewCondition',
    like_new: 'https://schema.org/UsedCondition',
    good: 'https://schema.org/UsedCondition',
    fair: 'https://schema.org/UsedCondition',
  };

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: listing.title,
    description: listing.description,
    ...(listing.photos.length > 0 ? { image: listing.photos.map((photo) => photoSrc(photo.url)) } : {}),
    category: listing.categoryName,
    itemCondition: conditionUrl[listing.condition] ?? 'https://schema.org/UsedCondition',
    offers: {
      '@type': 'Offer',
      price: (listing.priceKobo / 100).toFixed(2),
      priceCurrency: 'NGN',
      availability:
        listing.availability === 'available'
          ? 'https://schema.org/InStock'
          : listing.availability === 'reserved'
            ? 'https://schema.org/PreOrder'
            : 'https://schema.org/OutOfStock',
      url: `${SITE_ORIGIN}/declutter/${listing.slug}`,
      seller: { '@type': 'Organization', name: 'DASH World Declutters' },
      areaServed: listing.location.label,
    },
  };

  return (
    <>
      <script
        type="application/ld+json"
        // The object is built above from the API's own response; there is no
        // user-controlled key in it, and the values are JSON-encoded.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, '\\u003c') }}
      />

      {/* Rendered server-side so the page has real content before any
          JavaScript runs — for a crawler, and for a handset on a bad
          connection. The client component below takes over for the gallery
          and the enquiry form. */}
      <noscript>
        <div className="mx-auto max-w-3xl px-4 py-6">
          <h1 className="text-2xl font-bold">{listing.title}</h1>
          <p className="mt-1 text-lg font-semibold">
            ₦{(listing.priceKobo / 100).toLocaleString('en-NG')}
          </p>
          <p className="mt-1 text-sm">
            {CONDITION_LABELS[listing.condition] ?? listing.condition} · {listing.location.label}
          </p>
          <p className="mt-3 whitespace-pre-line">{listing.description}</p>
          <p className="mt-3 text-sm">
            {listing.badges.map((badge) => BADGE_LABELS[badge] ?? badge).join(' · ')}
          </p>
        </div>
      </noscript>

      <ListingDetailView listing={listing} />
    </>
  );
}
