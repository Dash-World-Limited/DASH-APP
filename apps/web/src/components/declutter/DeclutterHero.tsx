import Link from 'next/link';

import { formatPrice, photoSrc, type ListingCard } from '@/lib/declutter';

/**
 * The first screen.
 *
 * Built around real photographs of real items that are genuinely for sale right
 * now, not stock imagery and not an illustration. That is a deliberate
 * constraint rather than a shortcut: a second-hand marketplace whose hero shows
 * a studio photograph of a phone nobody is selling has told its first lie
 * before the visitor has scrolled.
 *
 * When there is nothing listed yet the collage simply does not render and the
 * headline stands on its own. An empty marketplace should look like a new one,
 * not like a broken one.
 *
 * A server component — no state, no effects, and its images are in the first
 * HTML the browser receives.
 */
export function DeclutterHero({ featured }: { featured: ListingCard[] }) {
  // Three is enough to suggest a marketplace and few enough to stay sharp on a
  // handset. Only items with a photograph, because the whole point is the
  // photograph.
  const collage = featured.filter((listing) => listing.photo).slice(0, 3);

  return (
    <section className="relative overflow-hidden border-b border-[var(--line)]">
      {/* Two very soft washes of brand colour. Restrained: they read as depth
          on a dark ground rather than as a gradient anybody notices. */}
      <div
        aria-hidden
        className="pointer-events-none absolute -left-40 -top-52 h-[36rem] w-[36rem] rounded-full opacity-40 blur-[120px]"
        style={{ background: 'radial-gradient(circle, rgba(77,124,255,0.5), transparent 65%)' }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -right-52 top-20 h-[32rem] w-[32rem] rounded-full opacity-25 blur-[130px]"
        style={{ background: 'radial-gradient(circle, rgba(23,179,166,0.5), transparent 65%)' }}
      />

      <div className="relative mx-auto grid w-full max-w-[1240px] gap-12 px-5 py-16 sm:px-8 sm:py-20 lg:grid-cols-[1.05fr_1fr] lg:items-center lg:gap-16 lg:py-28">
        <div className="dcl-rise">
          <p className="dcl-eyebrow">
            <span className="text-[var(--dcl-gold)]">Dash World</span> · Lagos &amp; Asaba
          </p>

          <h1 className="dcl-display mt-5 text-[2.6rem] leading-[0.95] sm:text-6xl lg:text-[4.25rem]">
            Second-hand,
            <br />
            <span className="text-[var(--primary)]">without the guesswork.</span>
          </h1>

          <p className="mt-6 max-w-lg text-base leading-relaxed text-[var(--ink-muted)] sm:text-lg">
            Every listing is reviewed by the DASH team — its photos, description and price — before it goes live,
            and priced once, from real market evidence. Sellers are identity-verified. Nobody haggles, and nobody
            gets your phone number.
          </p>

          <div className="mt-9 flex flex-wrap gap-3">
            <Link
              href="#browse"
              className="inline-flex min-h-12 items-center rounded-full bg-[var(--primary)] px-7 text-sm font-bold text-[var(--on-primary)] transition-colors hover:bg-[var(--primary-hover)]"
            >
              Browse the marketplace
            </Link>
            <Link
              href="/declutter/sell"
              className="dcl-glass inline-flex min-h-12 items-center rounded-full px-7 text-sm font-bold transition-colors hover:bg-[var(--dcl-glass-strong)]"
            >
              Sell an item
            </Link>
          </div>

          {/* The four promises, compressed to their names. The trust band
              further down the page explains each one; here they are a
              reassurance, not an argument. */}
          <ul className="mt-10 flex flex-wrap gap-x-6 gap-y-2 text-xs font-semibold text-[var(--ink-muted)]">
            {['DASH Reviewed', 'Verified Listing', 'Fixed Price', 'No Negotiation'].map((promise) => (
              <li key={promise} className="flex items-center gap-2">
                <span aria-hidden className="h-1 w-1 rounded-full bg-[var(--accent)]" />
                {promise}
              </li>
            ))}
          </ul>
        </div>

        {collage.length > 0 ? (
          <div className="dcl-rise grid grid-cols-2 gap-3 sm:gap-4" style={{ animationDelay: '90ms' }}>
            {collage.map((listing, index) => (
              <Link
                key={listing.slug}
                href={`/declutter/${listing.slug}`}
                className={`dcl-card group relative block overflow-hidden rounded-[var(--radius-card)] border border-[var(--line)] ${
                  index === 0 ? 'col-span-2 aspect-[16/10]' : 'aspect-square'
                }`}
              >
                <div className="dcl-media dcl-scrim h-full w-full">
                  <img
                    src={photoSrc(listing.photo!.url)}
                    alt={listing.photo!.alt}
                    // The hero images are the largest thing on the first screen.
                    fetchPriority={index === 0 ? 'high' : 'auto'}
                    className="h-full w-full object-cover"
                  />
                </div>
                <div className="absolute inset-x-0 bottom-0 z-10 p-4">
                  <p className="dcl-display text-base text-white sm:text-lg">
                    {formatPrice(listing.priceKobo)}
                  </p>
                  <p className="mt-0.5 line-clamp-1 text-xs text-white/80">{listing.title}</p>
                </div>
              </Link>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}
