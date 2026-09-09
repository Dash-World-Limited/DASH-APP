'use client';

/**
 * The Declutters feed.
 *
 * Item-first, not seller-first, and that is the one deliberate departure from
 * the shared `SectionPage` every other front door uses. Shops, Restaurants,
 * Local Market and Pharmacy are all "pick a seller, then browse their
 * catalogue", because that is how those businesses work. Second-hand is not:
 * each seller has one sofa, and a hierarchy that made a buyer choose a stranger
 * before seeing what they were selling would be a worse product wearing a
 * consistent shape.
 *
 * Everything below the search box is driven by the server. Prices, badges,
 * availability and which listings exist at all are decided by the API; nothing
 * here computes a price, hides a listing or awards a badge.
 */

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Input,
  Skeleton,
  formatNaira,
} from '@/components/ui';
import { apiFetch, ApiRequestError } from '@/lib/api';
import { track } from '@/lib/analytics';
import {
  AVAILABILITY_LABELS,
  BADGE_LABELS,
  CONDITION_LABELS,
  SORT_OPTIONS,
  photoSrc,
  type ListingCard,
  type Taxonomy,
} from '@/lib/declutter';

interface Filters {
  q: string;
  category: string;
  location: string;
  condition: string;
  sort: string;
}

const EMPTY_FILTERS: Filters = { q: '', category: '', location: '', condition: '', sort: 'newest' };

/** Badges worth the space on a card. The rest belong on the detail page. */
const CARD_BADGES = new Set(['dash_reviewed', 'verified_listing', 'trusted_partner']);

function buildQuery(filters: Filters, cursor: string | null): string {
  const params = new URLSearchParams();
  if (filters.q.trim()) params.set('q', filters.q.trim());
  if (filters.category) params.set('category', filters.category);
  if (filters.location) params.set('location', filters.location);
  if (filters.condition) params.set('condition', filters.condition);
  if (filters.sort) params.set('sort', filters.sort);
  if (cursor) params.set('cursor', cursor);
  return params.toString();
}

export function Marketplace() {
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [listings, setListings] = useState<ListingCard[] | null>(null);
  const [taxonomy, setTaxonomy] = useState<Taxonomy | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [page, setPage] = useState(1);

  // The search box is typed into; the request is not made on every keystroke.
  // `applied` is what has actually been asked for.
  const [applied, setApplied] = useState<Filters>(EMPTY_FILTERS);

  const firstLoad = useRef(true);

  useEffect(() => {
    void apiFetch<Taxonomy>('/v1/declutter/taxonomy')
      .then(setTaxonomy)
      // A filter bar that cannot load is a missing convenience, not a broken
      // page. The feed below it still works.
      .catch(() => setTaxonomy({ categories: [], locations: [] }));
  }, []);

  const load = useCallback(async (active: Filters) => {
    setError(null);
    setListings(null);
    setPage(1);
    try {
      const data = await apiFetch<{ listings: ListingCard[]; nextCursor: string | null }>(
        `/v1/declutter/listings?${buildQuery(active, null)}`,
      );
      setListings(data.listings);
      setCursor(data.nextCursor);

      track('declutter_feed_viewed', {
        resultCount: data.listings.length,
        hasQuery: active.q.trim().length > 0,
        ...(active.category ? { category: active.category } : {}),
        ...(active.location ? { location: active.location } : {}),
        sort: active.sort,
      });
    } catch (caught) {
      setError(
        caught instanceof ApiRequestError
          ? caught.message
          : 'We could not load the marketplace. Check your connection and try again.',
      );
      setListings([]);
    }
  }, []);

  useEffect(() => {
    void load(applied);
    if (firstLoad.current) {
      firstLoad.current = false;
      return;
    }
    if (applied.q.trim()) track('declutter_search_used', { hasQuery: true });
  }, [applied, load]);

  async function loadMore() {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const data = await apiFetch<{ listings: ListingCard[]; nextCursor: string | null }>(
        `/v1/declutter/listings?${buildQuery(applied, cursor)}`,
      );
      setListings((current) => [...(current ?? []), ...data.listings]);
      setCursor(data.nextCursor);
      setPage((current) => current + 1);
      track('declutter_feed_viewed', { resultCount: data.listings.length, page: page + 1 });
    } catch {
      setError('We could not load more items.');
    } finally {
      setLoadingMore(false);
    }
  }

  function applyFilter(patch: Partial<Filters>) {
    const next = { ...filters, ...patch };
    setFilters(next);
    setApplied(next);
    track('declutter_filter_applied', {
      ...(next.category ? { category: next.category } : {}),
      ...(next.location ? { location: next.location } : {}),
      ...(next.condition ? { condition: next.condition } : {}),
      sort: next.sort,
    });
  }

  const hasFilters =
    applied.q.trim() !== '' || applied.category !== '' || applied.location !== '' || applied.condition !== '';

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6">
      <header className="mb-6 space-y-2">
        <h1 className="text-2xl font-bold sm:text-3xl">DASH World Declutters</h1>
        <p className="max-w-2xl text-sm text-[var(--ink-muted)]">
          Second-hand items in Lagos and Asaba, checked by the DASH team and sold at a fixed price.
          No haggling, no strangers with your phone number.
        </p>
        <div className="flex flex-wrap gap-2 pt-1">
          <Badge tone="gold">Fixed Price</Badge>
          <Badge tone="success">DASH Reviewed</Badge>
          <Badge tone="neutral">Verified sellers</Badge>
        </div>
      </header>

      <form
        className="mb-5 space-y-3"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          setApplied(filters);
        }}
      >
        <div className="flex gap-2">
          <label className="sr-only" htmlFor="declutter-search">
            Search items
          </label>
          <Input
            id="declutter-search"
            type="search"
            placeholder="Search for a phone, a sofa, a generator…"
            value={filters.q}
            onChange={(event) => setFilters({ ...filters, q: event.target.value })}
            className="flex-1"
          />
          <Button type="submit">Search</Button>
        </div>

        {/* Scrolls sideways on a handset rather than wrapping into four rows
            that push the first listing off the screen.

            `min-w-0` is load-bearing, not tidiness: a flex item defaults to
            `min-width: auto`, which is its content size, so without it this row
            refuses to shrink below the width of all four selects and drags a
            horizontal scrollbar onto the whole page. An earlier version also
            bled to the screen edge with negative margins; that made the same
            overflow harder to see and is not worth the 16px. */}
        <div id="filters" className="flex w-full min-w-0 gap-2 overflow-x-auto pb-1 sm:flex-wrap">
          <FilterSelect
            label="Category"
            value={filters.category}
            onChange={(value) => applyFilter({ category: value })}
            options={[
              { value: '', label: 'All categories' },
              ...(taxonomy?.categories.map((category) => ({
                value: category.key,
                label: category.name,
              })) ?? []),
            ]}
          />
          <FilterSelect
            label="Area"
            value={filters.location}
            onChange={(value) => applyFilter({ location: value })}
            options={[
              { value: '', label: 'Lagos & Asaba' },
              ...(taxonomy?.locations.map((location) => ({
                value: location.slug,
                label: location.label,
              })) ?? []),
            ]}
          />
          <FilterSelect
            label="Condition"
            value={filters.condition}
            onChange={(value) => applyFilter({ condition: value })}
            options={[
              { value: '', label: 'Any condition' },
              ...Object.entries(CONDITION_LABELS).map(([value, label]) => ({ value, label })),
            ]}
          />
          <FilterSelect
            label="Sort"
            value={filters.sort}
            onChange={(value) => applyFilter({ sort: value })}
            options={SORT_OPTIONS}
          />
        </div>
      </form>

      {error ? (
        <ErrorState title="Could not load items" message={error} onRetry={() => void load(applied)} />
      ) : null}

      {listings === null && !error ? <FeedSkeleton /> : null}

      {listings !== null && listings.length === 0 && !error ? (
        <EmptyState
          title={hasFilters ? 'Nothing matches that' : 'Nothing listed yet'}
          description={
            hasFilters
              ? 'Try a wider search, or clear the filters to see everything available.'
              : 'New items are added as the DASH team checks them. Check back shortly.'
          }
          action={
            hasFilters ? (
              <Button
                variant="secondary"
                onClick={() => {
                  setFilters(EMPTY_FILTERS);
                  setApplied(EMPTY_FILTERS);
                }}
              >
                Clear filters
              </Button>
            ) : undefined
          }
        />
      ) : null}

      {listings && listings.length > 0 ? (
        <>
          <p className="sr-only" aria-live="polite">
            {listings.length} items shown
          </p>
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {listings.map((listing) => (
              <ListingTile key={listing.slug} listing={listing} />
            ))}
          </ul>
        </>
      ) : null}

      {cursor ? (
        <div className="mt-6 flex justify-center">
          <Button variant="secondary" onClick={() => void loadMore()} disabled={loadingMore}>
            {loadingMore ? 'Loading…' : 'Show more'}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    // `relative` matters. The visually-hidden span below is
    // `position: absolute`, and with no positioned ancestor its containing
    // block is the page rather than this row — so it laid itself out at the
    // far end of the row's *scrolled* content, escaped the overflow container
    // that was supposed to clip it, and pulled a horizontal scrollbar across
    // the whole site. One word, and the page stopped scrolling sideways.
    <label className="relative shrink-0 text-xs font-medium text-[var(--ink-muted)]">
      <span className="sr-only">{label}</span>
      <select
        className="min-h-11 rounded-xl border bg-[var(--surface-raised)] px-3 text-sm font-semibold text-[var(--ink)]"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function ListingTile({ listing }: { listing: ListingCard }) {
  const badges = listing.badges.filter((badge) => CARD_BADGES.has(badge));

  return (
    <Card as="li" className="overflow-hidden">
      <Link
        href={`/declutter/${listing.slug}`}
        className="block focus-visible:outline focus-visible:outline-2"
        onClick={() =>
          track('declutter_listing_viewed', {
            slug: listing.slug,
            category: listing.categoryKey,
            priceKobo: listing.priceKobo,
          })
        }
      >
        <div className="relative aspect-square bg-graphite-100">
          {listing.photo ? (
            // A plain <img>: the bytes come from our own storage through a
            // signed URL, and routing those through the Next optimiser would
            // mean re-fetching a short-lived link on the server.
            <img
              src={photoSrc(listing.photo.url)}
              alt={listing.photo.alt}
              loading="lazy"
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="flex h-full items-center justify-center text-xs text-[var(--ink-muted)]">
              No photograph
            </div>
          )}

          {listing.availability !== 'available' ? (
            <span className="absolute left-2 top-2 rounded-full bg-[var(--ink)] px-2 py-1 text-xs font-semibold text-[var(--ink-inverted)]">
              {AVAILABILITY_LABELS[listing.availability] ?? listing.availability}
            </span>
          ) : null}
        </div>

        <div className="space-y-1 p-3">
          <p className="line-clamp-2 text-sm font-semibold">{listing.title}</p>
          <p className="text-base font-bold">{formatNaira(listing.priceKobo)}</p>
          <p className="text-xs text-[var(--ink-muted)]">
            {CONDITION_LABELS[listing.condition] ?? listing.condition} · {listing.location.label}
          </p>
          {badges.length > 0 ? (
            <div className="flex flex-wrap gap-1 pt-1">
              {badges.map((badge) => (
                <Badge key={badge} tone={badge === 'trusted_partner' ? 'gold' : 'success'}>
                  {BADGE_LABELS[badge] ?? badge}
                </Badge>
              ))}
            </div>
          ) : null}
        </div>
      </Link>
    </Card>
  );
}

function FeedSkeleton() {
  return (
    <>
      <p className="sr-only" aria-live="polite">
        Loading items
      </p>
      <ul aria-hidden className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {Array.from({ length: 8 }, (_, index) => (
          <li key={index}>
            <Card className="overflow-hidden">
              <Skeleton className="aspect-square rounded-none" />
              <div className="space-y-2 p-3">
                <Skeleton className="h-4 w-4/5" />
                <Skeleton className="h-4 w-1/2" />
              </div>
            </Card>
          </li>
        ))}
      </ul>
    </>
  );
}
