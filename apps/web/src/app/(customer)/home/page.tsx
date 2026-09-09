'use client';

/**
 * Customer Home.
 *
 * The job of this screen is to answer two questions in the first second:
 * *what is DASH* and *what can I get where I am standing*. Everything on it
 * serves one of those. The five front doors answer the first; the sellers below
 * answer the second, and they are computed from the same delivery location the
 * header shows, so the page cannot say one thing at the top and another
 * underneath.
 *
 * ## What was removed
 *
 * A row of chips reading Everything · Food · Groceries · Essentials. That was
 * the app's previous top-level structure, left sitting directly beneath its
 * replacement — two competing answers to "how is DASH organised", one of which
 * put Groceries and Essentials at the same level as the five sections that now
 * contain them. The doors are the structure; a filter that quietly restates an
 * older one is worse than no filter.
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { SectionDoors } from '@/components/SectionDoors';
import {
  Badge,
  EmptyState,
  ErrorState,
  EstimateNote,
  LoadingBlock,
  formatDistance,
  formatNairaCompact,
} from '@/components/ui';
import { apiFetch, ApiRequestError, type VendorSummary } from '@/lib/api';
import { locateWithDevice, locationLabel, useDeliveryLocation } from '@/lib/delivery-location';

/**
 * A seller's mark, until sellers have photographs.
 *
 * `Vendor` carries no image field yet — merchant photography arrives with
 * vendor catalogue management, where a real merchant uploads it — so this is
 * the honest stand-in: the seller's own initials, tinted from their own name so
 * the same shop is the same colour every time. It occupies exactly the space a
 * photograph will, which is the point: the layout does not have to change when
 * the images land, and nothing here pretends to be a picture of anything.
 */
function SellerMark({ name }: { name: string }) {
  const initials = name
    .split(/\s+/)
    .filter((word) => /[a-z0-9]/i.test(word))
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? '')
    .join('');

  // A stable hue per seller. Deterministic, so it never flickers between
  // renders or differs between the list and the seller's own page.
  let hash = 0;
  for (const character of name) hash = (hash * 31 + character.charCodeAt(0)) % 360;

  return (
    <span
      aria-hidden="true"
      className="flex h-14 w-14 shrink-0 items-center justify-center rounded-[var(--radius-control)] text-base font-extrabold tracking-tight"
      style={{
        backgroundColor: `oklch(0.94 0.045 ${hash})`,
        color: `oklch(0.42 0.12 ${hash})`,
      }}
    >
      {initials || '·'}
    </span>
  );
}

export default function HomePage() {
  const location = useDeliveryLocation();
  const [vendors, setVendors] = useState<VendorSummary[] | null>(null);
  const [search, setSearch] = useState('');
  const [error, setError] = useState<ApiRequestError | null>(null);
  const [attempt, setAttempt] = useState(0);

  const service = location.serviceability;
  const place = locationLabel(location);

  useEffect(() => {
    let cancelled = false;

    const load = async (): Promise<void> => {
      setError(null);
      setVendors(null);
      try {
        const query = new URLSearchParams({
          latitude: String(location.position.latitude),
          longitude: String(location.position.longitude),
        });
        if (search.trim().length > 1) query.set('search', search.trim());

        const result = await apiFetch<{ vendors: VendorSummary[] }>(
          `/v1/vendors?${query.toString()}`,
        );
        if (!cancelled) setVendors(result.vendors);
      } catch (caught) {
        if (!cancelled) {
          setError(
            caught instanceof ApiRequestError
              ? caught
              : new ApiRequestError(0, 'unknown', 'Could not load sellers.'),
          );
          setVendors([]);
        }
      }
    };

    // Debounce the search so a keystroke does not fire a request each time.
    const timer = setTimeout(() => void load(), search ? 300 : 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [location.position, search, attempt]);

  return (
    <main id="main" className="mx-auto max-w-3xl px-5 pt-6">
      {/*
        Text-led and left-aligned rather than a centred banner. The heading is
        the only display-sized thing on the page, which is what makes it read as
        the top of a hierarchy instead of one more card.
      */}
      <header>
        <h1 className="type-display">
          Order anything
          <br />
          in Lagos
        </h1>
        <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-[var(--ink-muted)]">
          {/*
            Deliberately silent when the address is outside coverage. `place` is
            "Outside our delivery area" in that case, and dropping it into this
            sentence produced "Showing sellers near Outside our delivery area" —
            with the panel immediately below saying the same thing properly.
          */}
          {service && !service.serviceable ? null : place ? (
            <>
              <span>
                Showing sellers near <strong className="text-[var(--ink)]">{place}</strong>
              </span>
              {service?.busy ? <Badge tone="warning">Busy right now</Badge> : null}
            </>
          ) : (
            <span>Finding sellers near you…</span>
          )}
          {location.source !== 'device' ? (
            <button
              type="button"
              onClick={locateWithDevice}
              disabled={location.locating}
              className="font-semibold text-[var(--primary)] underline-offset-4 hover:underline disabled:opacity-60"
            >
              {location.locating ? 'Finding you…' : 'Use my location'}
            </button>
          ) : null}
        </p>
      </header>

      {service && !service.serviceable ? (
        <div className="mt-5 rounded-[var(--radius-card)] border border-[var(--danger)]/40 bg-[var(--danger-soft)] px-5 py-4">
          <p className="font-semibold text-[var(--danger)]">Not delivering here yet</p>
          <p className="mt-1 text-sm text-[var(--ink-muted)]">{service.message}</p>
        </div>
      ) : null}

      <div className="mt-6">
        <label className="sr-only" htmlFor="vendor-search">
          Search sellers
        </label>
        <input
          id="vendor-search"
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search for jollof, groceries, a pharmacy…"
          className="w-full rounded-[var(--radius-control)] border border-[var(--line)] bg-[var(--surface-raised)] px-4 py-3 text-base shadow-[var(--shadow-card)] placeholder:text-[var(--ink-muted)]"
        />
      </div>

      <section className="mt-7">
        <h2 className="type-eyebrow">Shop by section</h2>
        <div className="mt-3">
          <SectionDoors />
        </div>
      </section>

      <section className="mt-8">
        <h2 className="type-eyebrow">
          {search.trim().length > 1 ? 'Matching sellers' : 'Sellers near you'}
        </h2>

        <div className="mt-3">
          {error ? (
            <ErrorState
              message={error.message}
              requestId={error.requestId}
              onRetry={() => setAttempt((n) => n + 1)}
            />
          ) : vendors === null ? (
            <LoadingBlock label="Loading sellers" />
          ) : vendors.length === 0 ? (
            <EmptyState
              title="Nothing matches that"
              description={
                search
                  ? `No sellers matched “${search}”. Try a different search, or pick a section above.`
                  : 'There are no sellers near this location yet. Try moving your delivery location.'
              }
            />
          ) : (
            <ul className="space-y-2.5">
              {vendors.map((vendor) => {
                const closed = vendor.branch?.state === 'closed';
                return (
                  <li key={vendor.id}>
                    <Link
                      href={`/browse/${vendor.slug}`}
                      className={`flex items-start gap-3.5 rounded-[var(--radius-card)] border border-[var(--line)] bg-[var(--surface-raised)] p-3.5 shadow-[var(--shadow-card)] transition-[transform,border-color] duration-[var(--duration-base)] ease-[var(--ease-spring)] hover:border-[var(--line-strong)] active:scale-[0.99] ${
                        closed ? 'opacity-65' : ''
                      }`}
                    >
                      <SellerMark name={vendor.name} />

                      <span className="min-w-0 flex-1">
                        <span className="flex items-start justify-between gap-3">
                          <span className="type-title truncate">{vendor.name}</span>
                          {closed ? (
                            <Badge tone="danger">Closed</Badge>
                          ) : vendor.branch?.state === 'busy' ? (
                            <Badge tone="warning">Busy</Badge>
                          ) : (
                            <Badge tone="success">Open</Badge>
                          )}
                        </span>

                        {vendor.description ? (
                          // No `block` alongside the clamp: `line-clamp-*` sets
                          // `display: -webkit-box` itself, and a `block` next to
                          // it wins in the generated order and silently disables
                          // the clamping. Observed in the browser — two-line
                          // descriptions in a row meant to hold one.
                          <span className="mt-0.5 line-clamp-2 text-sm text-[var(--ink-muted)]">
                            {vendor.description}
                          </span>
                        ) : null}

                        <span className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--ink-muted)]">
                          {vendor.rating.count > 0 ? (
                            <span className="font-semibold text-[var(--ink)]">
                              ★ {vendor.rating.average.toFixed(1)}
                              <span className="ml-1 font-normal text-[var(--ink-muted)]">
                                ({vendor.rating.count})
                              </span>
                            </span>
                          ) : null}
                          {vendor.distanceMetres !== null ? (
                            <span>{formatDistance(vendor.distanceMetres)}</span>
                          ) : null}
                          {vendor.branch ? (
                            <EstimateNote>~{vendor.branch.estimatedMinutes} min</EstimateNote>
                          ) : null}
                          {vendor.branch && vendor.branch.minimumOrder > 0 ? (
                            <span>{formatNairaCompact(vendor.branch.minimumOrder)} minimum</span>
                          ) : null}
                        </span>
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>
    </main>
  );
}
