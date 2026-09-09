'use client';

/**
 * The interactive half of a listing page.
 *
 * The server already rendered the facts. This adds the gallery, the enquiry
 * form, and the one piece of state that matters: whether the person looking at
 * this page has an account, because asking to be put in touch requires one.
 *
 * The enquiry is deliberately modest. It creates a request for a human to
 * decide and says so; it does not promise a reply time, does not show the
 * seller's name as a contact, and never implies a message has been delivered to
 * anybody. Overstating what happens next is how a marketplace loses a buyer's
 * trust on their first interaction with it.
 */

import Link from 'next/link';
import { useState } from 'react';

import { Badge, Button, Card, Field, formatNaira } from '@/components/ui';
import { ApiRequestError } from '@/lib/api';
import { authedFetch, useHasSession } from '@/lib/session';
import { track } from '@/lib/analytics';
import {
  AVAILABILITY_LABELS,
  BADGE_LABELS,
  BADGE_MEANINGS,
  CONDITION_LABELS,
  photoSrc,
  type ListingDetail,
} from '@/lib/declutter';

const BADGE_TONE: Record<string, 'gold' | 'success' | 'neutral'> = {
  fixed_price: 'gold',
  dash_reviewed: 'success',
  verified_listing: 'success',
  trusted_partner: 'gold',
  value_checked: 'gold',
};

function readableKey(key: string): string {
  return key
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .replace(/^./, (character) => character.toUpperCase());
}

export function ListingDetailView({ listing }: { listing: ListingDetail }) {
  const [active, setActive] = useState(0);
  const photo = listing.photos[active];

  return (
    <main id="main" className="mx-auto w-full max-w-5xl px-4 py-5">
      <nav aria-label="Breadcrumb" className="mb-4 text-sm">
        <Link href="/declutter" className="font-semibold underline">
          Declutters
        </Link>
        <span className="mx-2 text-[var(--ink-muted)]">/</span>
        <span className="text-[var(--ink-muted)]">{listing.categoryName}</span>
      </nav>

      <div className="grid gap-6 lg:grid-cols-2">
        <section aria-label="Photographs" className="space-y-2">
          <Card className="overflow-hidden">
            <div className="aspect-square bg-graphite-100">
              {photo ? (
                // A plain <img>: the bytes come from our own private bucket
                // through a short-lived signed URL, and routing that through
                // the Next optimiser would mean the server re-fetching a link
                // that is about to expire. See lib/images.ts.
                <img
                  src={photoSrc(photo.url)}
                  alt={photo.alt}
                  className="h-full w-full object-cover"
                  // The first photograph is the largest thing on the page and
                  // the thing a buyer is waiting for.
                  fetchPriority="high"
                />
              ) : (
                <div className="flex h-full items-center justify-center text-sm text-[var(--ink-muted)]">
                  No photograph
                </div>
              )}
            </div>
          </Card>

          {listing.photos.length > 1 ? (
            <ul className="flex gap-2 overflow-x-auto pb-1">
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
                    className={`h-16 w-16 shrink-0 overflow-hidden rounded-lg border-2 ${
                      index === active ? 'border-[var(--primary)]' : 'border-transparent'
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
        </section>

        <section className="space-y-4">
          <div>
            <h1 className="text-2xl font-bold">{listing.title}</h1>
            <p className="mt-1 text-3xl font-bold">{formatNaira(listing.priceKobo)}</p>
            <p className="mt-1 text-sm text-[var(--ink-muted)]">
              {CONDITION_LABELS[listing.condition] ?? listing.condition} · {listing.location.label}
              {listing.availability !== 'available'
                ? ` · ${AVAILABILITY_LABELS[listing.availability] ?? listing.availability}`
                : ''}
            </p>
          </div>

          <ul className="flex flex-wrap gap-2">
            {listing.badges.map((badge) => (
              <li key={badge} title={BADGE_MEANINGS[badge]}>
                <Badge tone={BADGE_TONE[badge] ?? 'neutral'}>{BADGE_LABELS[badge] ?? badge}</Badge>
              </li>
            ))}
          </ul>

          {/* Spelled out rather than left to the badges. "Fixed Price" means
              nothing to somebody who has never used this marketplace, and the
              absence of haggling is the product. */}
          <Card className="p-4 text-sm">
            <p className="font-semibold">How this works</p>
            <ul className="mt-2 space-y-1 text-[var(--ink-muted)]">
              <li>DASH checked this item and set the price. It is not negotiable.</li>
              <li>The seller’s identity was verified before this went live.</li>
              <li>
                Ask to be put in touch and a DASH team member arranges it. Your details are not
                published, and neither are the seller’s.
              </li>
            </ul>
          </Card>

          <ContactRequest listing={listing} />

          <section aria-label="Description">
            <h2 className="text-sm font-semibold">Description</h2>
            <p className="mt-1 whitespace-pre-line text-sm">{listing.description}</p>
          </section>

          {Object.keys(listing.attributes).length > 0 ? (
            <section aria-label="Specifications">
              <h2 className="text-sm font-semibold">Specifications</h2>
              <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                {Object.entries(listing.attributes).map(([key, value]) => (
                  <div key={key} className="contents">
                    <dt className="text-[var(--ink-muted)]">{readableKey(key)}</dt>
                    <dd className="font-medium">{String(value)}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ) : null}

          <section aria-label="Seller" className="text-sm">
            <h2 className="text-sm font-semibold">Seller</h2>
            <p className="mt-1">
              {listing.seller.displayName}
              {listing.seller.isTrustedPartner ? ' · Trusted Partner' : ''}
            </p>
            <p className="text-xs text-[var(--ink-muted)]">
              Verified by DASH. Contact details are never published.
            </p>
          </section>
        </section>
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

  if (!listing.contactable) {
    return (
      <Card className="p-4 text-sm">
        <p className="font-semibold">Not available to enquire about</p>
        <p className="mt-1 text-[var(--ink-muted)]">
          This item is {AVAILABILITY_LABELS[listing.availability]?.toLowerCase() ?? 'unavailable'}.
          Browse the rest of the marketplace for something similar.
        </p>
      </Card>
    );
  }

  if (!hasSession) {
    return (
      <Card className="p-4 text-sm">
        <p className="font-semibold">Sign in to ask about this item</p>
        <p className="mt-1 text-[var(--ink-muted)]">
          An introduction is arranged between two real people, so we need to know who is asking.
        </p>
        <Link href="/signin" className="mt-3 inline-block">
          <Button size="sm">Sign in</Button>
        </Link>
      </Card>
    );
  }

  if (sent) {
    return (
      <Card className="p-4 text-sm" >
        <p className="font-semibold">Your question is with the DASH team</p>
        {/* No promised reply time. A deadline this product cannot yet keep
            would be a worse first impression than no deadline. */}
        <p className="mt-1 text-[var(--ink-muted)]">
          Someone will review it and arrange the introduction. You can see it under your enquiries.
        </p>
      </Card>
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
      const messageText =
        caught instanceof ApiRequestError
          ? caught.message
          : 'We could not send that. Try again in a moment.';
      setError(messageText);
      track('declutter_contact_request_failed', {
        slug: listing.slug,
        ...(caught instanceof ApiRequestError ? { reason: caught.code } : {}),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-3 p-4">
      <Field
        label="Ask about this item"
        htmlFor="declutter-enquiry"
        hint="Questions about condition, collection or inspection. The price is fixed, so there is nothing to offer."
      >
        <textarea
          id="declutter-enquiry"
          rows={3}
          maxLength={600}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          placeholder="Is the original charger included?"
          className="w-full rounded-xl border bg-[var(--surface-raised)] px-3.5 py-2.5 text-[var(--ink)] placeholder:text-[var(--ink-muted)]"
        />
      </Field>

      {error ? (
        <p role="alert" className="text-sm font-medium text-[var(--danger)]">
          {error}
        </p>
      ) : null}

      <Button onClick={() => void send()} disabled={busy}>
        {busy ? 'Sending…' : 'Ask to be put in touch'}
      </Button>
    </Card>
  );
}
