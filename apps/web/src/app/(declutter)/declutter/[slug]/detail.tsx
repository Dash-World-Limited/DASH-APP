'use client';

/**
 * The interactive half of a listing page.
 *
 * The server already rendered the facts. This adds the gallery, the enquiry,
 * and the one piece of state that matters: whether the person looking at this
 * page has an account, because asking to be put in touch requires one.
 *
 * The enquiry is deliberately modest. It creates a request for a human to
 * decide and says so; it does not promise a reply time, does not show the
 * seller as a contact, and never implies a message has been delivered to
 * anybody. Overstating what happens next is how a marketplace loses a buyer's
 * trust on their first interaction with it.
 *
 * Specifications arrive from the API already filtered to the category's public
 * fields. This component renders whatever it is given and knows nothing about
 * any particular category — which is what keeps a VIN, an IMEI or a serial
 * number off the page as categories are added.
 */

import Link from 'next/link';
import { useState } from 'react';

import { ApiRequestError } from '@/lib/api';
import { authedFetch, useHasSession } from '@/lib/session';
import { track } from '@/lib/analytics';
import {
  AVAILABILITY_LABELS,
  BADGE_LABELS,
  BADGE_MEANINGS,
  CONDITION_LABELS,
  formatPrice,
  photoSrc,
  type ListingDetail,
} from '@/lib/declutter';

function readableKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .replace(/^./, (character) => character.toUpperCase());
}

export function ListingDetailView({ listing }: { listing: ListingDetail }) {
  const [active, setActive] = useState(0);
  const photo = listing.photos[active];
  const unavailable = listing.availability !== 'available';

  return (
    <main id="main" className="mx-auto w-full max-w-[1240px] px-5 py-8 sm:px-8 sm:py-12">
      <nav aria-label="Breadcrumb" className="mb-7 text-sm text-[var(--ink-muted)]">
        <Link href="/declutter" className="font-semibold hover:text-[var(--ink)]">
          Marketplace
        </Link>
        <span aria-hidden className="mx-2">
          /
        </span>
        <span>{listing.categoryName}</span>
      </nav>

      <div className="grid gap-10 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] lg:gap-14">
        {/* --- Gallery ------------------------------------------------------ */}
        <section aria-label="Photographs" className="min-w-0">
          <div className="dcl-media relative aspect-[4/3] overflow-hidden rounded-[var(--radius-card)] border border-[var(--line)]">
            {photo ? (
              <img
                src={photoSrc(photo.url)}
                alt={photo.alt}
                fetchPriority="high"
                className={`h-full w-full object-cover ${unavailable ? 'opacity-60 saturate-50' : ''}`}
              />
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-[var(--ink-muted)]">
                No photograph
              </div>
            )}

            {unavailable ? (
              <span className="dcl-glass-strong absolute left-4 top-4 rounded-full px-4 py-1.5 text-xs font-bold uppercase tracking-wider">
                {AVAILABILITY_LABELS[listing.availability] ?? listing.availability}
              </span>
            ) : null}
          </div>

          {listing.photos.length > 1 ? (
            <ul className="mt-3 flex gap-3 overflow-x-auto pb-1">
              {listing.photos.map((candidate, index) => (
                <li key={candidate.url}>
                  <button
                    type="button"
                    aria-label={candidate.alt}
                    aria-current={index === active}
                    onClick={() => {
                      setActive(index);
                      track('declutter_photo_opened', { slug: listing.slug });
                    }}
                    className={`h-20 w-20 shrink-0 overflow-hidden rounded-xl border-2 transition-colors ${
                      index === active
                        ? 'border-[var(--primary)]'
                        : 'border-[var(--line)] hover:border-[var(--line-strong)]'
                    }`}
                  >
                    <img
                      src={photoSrc(candidate.url)}
                      alt=""
                      loading="lazy"
                      className="h-full w-full object-cover"
                    />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}

          <section aria-label="Description" className="mt-10">
            <h2 className="dcl-eyebrow">About this item</h2>
            <p className="mt-4 whitespace-pre-line text-base leading-relaxed text-[var(--ink-muted)]">
              {listing.description}
            </p>
          </section>

          {Object.keys(listing.attributes).length > 0 ? (
            <section aria-label="Specifications" className="mt-10">
              <h2 className="dcl-eyebrow">Specifications</h2>
              <dl className="mt-4 grid gap-px overflow-hidden rounded-[var(--radius-card)] border border-[var(--line)] bg-[var(--line)] sm:grid-cols-2">
                {Object.entries(listing.attributes).map(([key, value]) => (
                  <div key={key} className="flex items-baseline gap-3 bg-[var(--surface)] px-4 py-3">
                    <dt className="min-w-[8rem] shrink-0 text-xs text-[var(--ink-muted)]">
                      {readableKey(key)}
                    </dt>
                    <dd className="text-sm font-semibold">{String(value)}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ) : null}
        </section>

        {/* --- The panel ---------------------------------------------------- */}
        <div className="min-w-0 lg:sticky lg:top-24 lg:self-start">
          <h1 className="dcl-display text-3xl sm:text-4xl">{listing.title}</h1>

          <p className="dcl-display mt-4 text-4xl sm:text-5xl">{formatPrice(listing.priceKobo)}</p>
          <p className="mt-2 text-sm text-[var(--ink-muted)]">
            {CONDITION_LABELS[listing.condition] ?? listing.condition}
            <span aria-hidden> · </span>
            {/* Area and state. Never a distance, never an ETA, never an
                address — Declutters browsing does not do proximity. */}
            {listing.location.label}
          </p>

          <ul className="mt-6 flex flex-wrap gap-2">
            {listing.badges.map((badge) => (
              <li
                key={badge}
                title={BADGE_MEANINGS[badge]}
                className="rounded-full border border-[var(--line)] bg-[var(--dcl-glass)] px-3 py-1.5 text-xs font-semibold text-[var(--ink)]"
              >
                {BADGE_LABELS[badge] ?? badge}
              </li>
            ))}
          </ul>

          <div className="mt-7">
            <ContactRequest listing={listing} />
          </div>

          {/* Spelled out rather than left to the badges. "Fixed Price" means
              nothing to somebody who has never used this marketplace, and the
              absence of haggling is the product. */}
          <section
            aria-label="How this works"
            className="dcl-glass mt-6 rounded-[var(--radius-card)] p-5"
          >
            <p className="text-sm font-bold">How this works</p>
            <ul className="mt-3 space-y-2.5 text-sm leading-relaxed text-[var(--ink-muted)]">
              <li>DASH inspected this item and set the price. It is not negotiable.</li>
              <li>The seller passed identity verification before this went live.</li>
              <li>
                Ask to be put in touch and a DASH team member arranges it. Your details are not
                published, and neither are the seller&rsquo;s.
              </li>
            </ul>
          </section>

          <section aria-label="Seller" className="mt-6 border-t border-[var(--line)] pt-6">
            <p className="dcl-eyebrow">Seller</p>
            <p className="mt-3 flex flex-wrap items-center gap-2 text-base font-semibold">
              {listing.seller.displayName}
              {listing.seller.isTrustedPartner ? (
                <span className="rounded-full bg-[var(--dcl-gold-soft)] px-2.5 py-1 text-xs font-bold text-[var(--dcl-gold)]">
                  Trusted Partner
                </span>
              ) : null}
            </p>
            <p className="mt-1.5 text-xs text-[var(--ink-muted)]">
              Identity verified by DASH. Contact details are never published.
            </p>
          </section>
        </div>
      </div>
    </main>
  );
}

function ContactRequest({ listing }: { listing: ListingDetail }) {
  const hasSession = useHasSession();
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  if (!listing.contactable) {
    return (
      <div className="rounded-[var(--radius-card)] border border-[var(--line-strong)] p-5">
        <p className="text-sm font-bold">
          {listing.availability === 'sold' ? 'This item has sold' : 'Not available to enquire about'}
        </p>
        <p className="mt-2 text-sm text-[var(--ink-muted)]">
          {listing.availability === 'reserved'
            ? 'It is being held for another buyer. If that falls through it comes back to the marketplace.'
            : 'Browse the rest of the marketplace for something similar.'}
        </p>
        <Link
          href="/declutter"
          className="dcl-glass mt-5 inline-flex min-h-11 items-center rounded-full px-5 text-sm font-bold"
        >
          Back to the marketplace
        </Link>
      </div>
    );
  }

  if (!hasSession) {
    return (
      <div className="rounded-[var(--radius-card)] border border-[var(--line-strong)] p-5">
        <p className="text-sm font-bold">Sign in to ask about this item</p>
        <p className="mt-2 text-sm text-[var(--ink-muted)]">
          An introduction is arranged between two real people, so DASH needs to know who is asking.
        </p>
        <Link
          href="/signin"
          className="mt-5 inline-flex min-h-12 items-center rounded-full bg-[var(--primary)] px-7 text-sm font-bold text-[var(--on-primary)]"
        >
          Sign in to continue
        </Link>
      </div>
    );
  }

  if (sent) {
    return (
      <div className="rounded-[var(--radius-card)] border border-[var(--accent)] bg-[var(--accent-soft)] p-5">
        <p className="text-sm font-bold">Your question is with the DASH team</p>
        {/* No promised reply time. A deadline this product cannot yet keep
            would be a worse first impression than no deadline at all. */}
        <p className="mt-2 text-sm text-[var(--ink-muted)]">
          Someone will review it and arrange the introduction. Nothing about you has been sent to
          the seller.
        </p>
      </div>
    );
  }

  async function send() {
    setBusy(true);
    setError(null);
    try {
      await authedFetch(`/v1/declutter/listings/${listing.slug}/contact-requests`, {
        method: 'POST',
        body: JSON.stringify(message.trim() ? { message: message.trim() } : {}),
      });
      setSent(true);
      // The slug and category, never the message. See lib/analytics.ts.
      track('declutter_contact_requested', {
        slug: listing.slug,
        category: listing.categoryKey,
        priceKobo: listing.priceKobo,
      });
    } catch (caught) {
      setError(
        caught instanceof ApiRequestError
          ? caught.message
          : 'We could not send that. Try again in a moment.',
      );
      track('declutter_contact_request_failed', {
        slug: listing.slug,
        ...(caught instanceof ApiRequestError ? { reason: caught.code } : {}),
      });
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="min-h-14 w-full rounded-full bg-[var(--primary)] px-7 text-base font-bold text-[var(--on-primary)] transition-colors hover:bg-[var(--primary-hover)]"
      >
        Request seller contact
      </button>
    );
  }

  return (
    <div className="rounded-[var(--radius-card)] border border-[var(--line-strong)] p-5">
      <label htmlFor="declutter-enquiry" className="text-sm font-bold">
        What would you like to ask?
      </label>
      <p className="mt-1.5 text-xs text-[var(--ink-muted)]">
        Condition, collection or inspection. The price is fixed, so there is nothing to offer.
      </p>
      <textarea
        id="declutter-enquiry"
        rows={3}
        maxLength={600}
        value={message}
        onChange={(event) => setMessage(event.target.value)}
        placeholder="Is the original charger included?"
        className="mt-3 w-full rounded-xl border border-[var(--line)] bg-[var(--surface-sunken)] px-4 py-3 text-sm text-[var(--ink)] outline-none placeholder:text-[var(--ink-muted)] focus:border-[var(--primary)]"
      />

      {error ? (
        <p role="alert" className="mt-3 text-sm font-semibold text-[var(--danger)]">
          {error}
        </p>
      ) : null}

      <button
        type="button"
        onClick={() => void send()}
        disabled={busy}
        className="mt-4 min-h-12 w-full rounded-full bg-[var(--primary)] px-7 text-sm font-bold text-[var(--on-primary)] transition-colors hover:bg-[var(--primary-hover)] disabled:opacity-60"
      >
        {busy ? 'Sending…' : 'Send to DASH'}
      </button>
    </div>
  );
}
