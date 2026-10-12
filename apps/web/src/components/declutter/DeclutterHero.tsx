import Link from 'next/link';

import { DeclutterPromoCarousel } from '@/components/declutter/DeclutterPromoCarousel';

/**
 * The first screen.
 *
 * The marketplace inventory already has its own dedicated browsing section
 * immediately below this hero. Repeating live listings here made the hero do
 * the catalogue's job twice, so the desktop companion area is now reserved for
 * intentional DASH World promotions instead.
 *
 * Mobile deliberately stays clean for now: no compressed desktop advert block.
 * A mobile-native promotional treatment can be introduced separately after the
 * desktop carousel and its final campaign artwork are approved.
 */
export function DeclutterHero() {
  return (
    <section className="relative overflow-hidden border-b border-[var(--line)]">
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

          <ul className="mt-10 flex flex-wrap gap-x-6 gap-y-2 text-xs font-semibold text-[var(--ink-muted)]">
            {['DASH Reviewed', 'Verified Listing', 'Fixed Price', 'No Negotiation'].map((promise) => (
              <li key={promise} className="flex items-center gap-2">
                <span aria-hidden className="h-1 w-1 rounded-full bg-[var(--accent)]" />
                {promise}
              </li>
            ))}
          </ul>
        </div>

        <div className="dcl-rise hidden lg:block" style={{ animationDelay: '90ms' }}>
          <DeclutterPromoCarousel />
        </div>
      </div>
    </section>
  );
}
