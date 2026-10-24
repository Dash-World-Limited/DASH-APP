'use client';

/**
 * One item in the grid.
 *
 * The photograph is the card. Everything else is small, quiet, and arranged so
 * the eye reaches the picture first and the price second — which is the order
 * people actually shop in. A card that leads with a title and a row of
 * coloured badges is a database row with a picture attached, and that is what
 * every classifieds board in Nigeria already looks like.
 *
 * Badges are severely rationed here. Two, at most, and only the ones that mean
 * something about *this* item: reviewed, and verified. `Fixed Price` is true of
 * every listing on the site and is said once, in the hero and the trust band,
 * rather than stamped on all forty cards.
 */

import Link from 'next/link';

import { track } from '@/lib/analytics';
import {
  AVAILABILITY_LABELS,
  BADGE_LABELS,
  CONDITION_LABELS,
  formatPrice,
  photoSrc,
  type ListingCard,
} from '@/lib/declutter';

/** The two worth the space on a card. The rest belong on the detail page. */
const CARD_BADGES = ['dash_reviewed', 'verified_listing'] as const;

export function ListingTile({ listing, priority = false }: { listing: ListingCard; priority?: boolean }) {
  const badges = CARD_BADGES.filter((badge) => listing.badges.includes(badge));
  const unavailable = listing.availability !== 'available';

  return (
    <article className="dcl-card group">
      <Link
        href={`/declutter/${listing.slug}`}
        className="block rounded-[var(--radius-card)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--primary)]"
        onClick={() =>
          track('declutter_listing_viewed', {
            slug: listing.slug,
            category: listing.categoryKey,
            priceKobo: listing.priceKobo,
          })
        }
      >
        <div className="dcl-media dcl-scrim aspect-[4/5] rounded-[var(--radius-card)] border border-[var(--line)]">
          {listing.photo ? (
            <img
              src={photoSrc(listing.photo.url)}
              alt={listing.photo.alt}
              // The first row is what a visitor waits for; everything below the
              // fold can arrive when it arrives.
              loading={priority ? 'eager' : 'lazy'}
              fetchPriority={priority ? 'high' : 'auto'}
              className={`h-full w-full object-cover ${unavailable ? 'opacity-55 saturate-50' : ''}`}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-xs text-[var(--ink-muted)]">
              No photograph yet
            </div>
          )}

          {unavailable ? (
            // Stated plainly over the picture rather than hidden in the meta
            // line. Somebody scrolling a grid should never tap through to
            // discover an item is gone.
            <span className="dcl-glass-strong absolute left-3 top-3 rounded-full px-3 py-1 text-[0.6875rem] font-bold uppercase tracking-wider text-[var(--ink)]">
              {AVAILABILITY_LABELS[listing.availability] ?? listing.availability}
            </span>
          ) : null}

          <div className="absolute inset-x-0 bottom-0 z-10 p-3.5">
            <p className="dcl-display text-lg text-white drop-shadow-sm sm:text-xl">
              {formatPrice(listing.priceKobo)}
            </p>
          </div>
        </div>

        <div className="px-1 pt-3">
          <h3 className="line-clamp-2 text-sm font-semibold leading-snug text-[var(--ink)]">
            {listing.title}
          </h3>
          <p className="mt-1 text-xs text-[var(--ink-muted)]">
            {CONDITION_LABELS[listing.condition] ?? listing.condition}
            <span aria-hidden> · </span>
            {/* Area and state. Never a distance, never an ETA, never an
                address — Declutters browsing does not do proximity. */}
            {listing.location.label}
          </p>

          {badges.length > 0 ? (
            <ul className="mt-2.5 flex flex-wrap gap-1.5">
              {badges.map((badge) => (
                <li
                  key={badge}
                  className="rounded-full border border-[var(--line)] bg-[var(--dcl-glass)] px-2 py-0.5 text-[0.6875rem] font-semibold text-[var(--ink-muted)]"
                >
                  {BADGE_LABELS[badge]}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </Link>
    </article>
  );
}
