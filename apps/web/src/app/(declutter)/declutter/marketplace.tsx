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
 * Category discovery is the row of pills, not a separate page. A directory that
 * only re-lists the same categories is a click between a visitor and what they
 * came for.
 *
 * **Every category here comes from the taxonomy.** There is no list of category
 * names in this file, no per-category label map and no screen that knows one
 * category from another. A category carries its own attribute schema, its own
 * public/admin visibility rules and its own handover rule; a component that
 * knew about "Cars" by name would eventually get one of those wrong, and the
 * dangerous one is visibility — that is what keeps a VIN off a public page.
 *
 * Everything below the search box is decided by the server. Prices, badges,
 * availability and which listings exist at all come from the API; nothing here
 * computes a price, hides a listing or awards a badge.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { ListingTile } from '@/components/declutter/ListingTile';
import { apiFetch, ApiRequestError } from '@/lib/api';
import { track } from '@/lib/analytics';
import {
  CONDITION_LABELS,
  SORT_OPTIONS,
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

const EMPTY: Filters = { q: '', category: '', location: '', condition: '', sort: 'newest' };

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

export function Marketplace({
  initialListings,
  initialCategories,
}: {
  initialListings: ListingCard[];
  initialCategories: Taxonomy['categories'];
}) {
  const [typed, setTyped] = useState<Filters>(EMPTY);
  const [applied, setApplied] = useState<Filters>(EMPTY);

  // Seeded from the server render, so the first screen has real items in it
  // before any JavaScript has fetched anything.
  const [listings, setListings] = useState<ListingCard[] | null>(initialListings);
  const [categories, setCategories] = useState(initialCategories);
  const [areas, setAreas] = useState<Taxonomy['locations']>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  // The server already delivered page one of the unfiltered feed. Refetching it
  // on mount would blank a rendered grid to re-request what is already on it.
  const skipFirstLoad = useRef(initialListings.length > 0);

  useEffect(() => {
    void apiFetch<Taxonomy>('/v1/declutter/taxonomy')
      .then((taxonomy) => {
        setAreas(taxonomy.locations);
        if (taxonomy.categories.length > 0) setCategories(taxonomy.categories);
      })
      // A filter bar that cannot load is a missing convenience, not a broken
      // page. The grid below it still works.
      .catch(() => undefined);
  }, []);

  const load = useCallback(async (active: Filters) => {
    setError(null);
    setBusy(true);
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
          : 'We could not reach the marketplace. Check your connection and try again.',
      );
      setListings([]);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (skipFirstLoad.current) {
      skipFirstLoad.current = false;
      return;
    }
    void load(applied);
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
    } catch {
      setError('We could not load more items.');
    } finally {
      setLoadingMore(false);
    }
  }

  function apply(patch: Partial<Filters>) {
    const next = { ...typed, ...patch };
    setTyped(next);
    setApplied(next);
    track('declutter_filter_applied', {
      ...(next.category ? { category: next.category } : {}),
      ...(next.location ? { location: next.location } : {}),
      ...(next.condition ? { condition: next.condition } : {}),
      sort: next.sort,
    });
  }

  const filtered =
    applied.q.trim() !== '' ||
    applied.category !== '' ||
    applied.location !== '' ||
    applied.condition !== '';

  return (
    <section
      id="browse"
      className="mx-auto w-full max-w-[1240px] scroll-mt-24 px-5 py-16 sm:px-8 sm:py-20"
    >
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="dcl-eyebrow">The marketplace</p>
          <h2 className="dcl-display mt-3 text-3xl sm:text-4xl">
            {filtered ? 'Matching items' : 'Available now'}
          </h2>
        </div>

        <label className="relative text-xs font-medium text-[var(--ink-muted)]">
          <span className="sr-only">Sort by</span>
          <select
            className="dcl-glass min-h-11 rounded-full px-4 text-sm font-semibold text-[var(--ink)]"
            value={typed.sort}
            onChange={(event) => apply({ sort: event.target.value })}
          >
            {SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value} className="bg-[var(--surface-raised)]">
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* --- Category discovery, straight from the taxonomy ----------------- */}
      <nav aria-label="Categories" className="mt-8">
        <ul className="flex snap-x gap-2 overflow-x-auto pb-2">
          <li className="snap-start">
            <CategoryPill
              label="Everything"
              active={typed.category === ''}
              onClick={() => apply({ category: '' })}
            />
          </li>
          {categories.map((category) => (
            <li key={category.key} className="snap-start">
              <CategoryPill
                label={category.name}
                active={typed.category === category.key}
                onClick={() => apply({ category: category.key })}
              />
            </li>
          ))}
        </ul>
      </nav>

      {/* --- Search and filters --------------------------------------------- */}
      <form
        role="search"
        className="mt-5 grid gap-3 lg:grid-cols-[1fr_auto]"
        onSubmit={(event) => {
          event.preventDefault();
          setApplied(typed);
          if (typed.q.trim()) track('declutter_search_used', { hasQuery: true });
        }}
      >
        <div className="dcl-glass flex min-w-0 items-center gap-3 rounded-full px-5">
          <span aria-hidden className="text-lg leading-none text-[var(--ink-muted)]">
            ⌕
          </span>
          <label className="sr-only" htmlFor="declutter-search">
            Search items
          </label>
          <input
            id="declutter-search"
            type="search"
            placeholder="Search a phone, a sofa, a car…"
            value={typed.q}
            onChange={(event) => setTyped({ ...typed, q: event.target.value })}
            className="min-h-12 w-full min-w-0 bg-transparent text-sm text-[var(--ink)] outline-none placeholder:text-[var(--ink-muted)]"
          />
        </div>

        <div className="flex min-w-0 gap-2">
          <FilterSelect
            label="Area"
            value={typed.location}
            onChange={(value) => apply({ location: value })}
            options={[
              { value: '', label: 'All areas' },
              ...areas.map((area) => ({ value: area.slug, label: area.label })),
            ]}
          />
          <FilterSelect
            label="Condition"
            value={typed.condition}
            onChange={(value) => apply({ condition: value })}
            options={[
              { value: '', label: 'Any condition' },
              ...Object.entries(CONDITION_LABELS).map(([value, label]) => ({ value, label })),
            ]}
          />
          <button
            type="submit"
            className="min-h-12 shrink-0 rounded-full bg-[var(--primary)] px-6 text-sm font-bold text-[var(--on-primary)] transition-colors hover:bg-[var(--primary-hover)]"
          >
            Search
          </button>
        </div>
      </form>

      {/* --- Results --------------------------------------------------------- */}
      <div className="mt-12">
        {error ? (
          <ErrorPanel message={error} onRetry={() => void load(applied)} />
        ) : listings === null || (busy && listings.length === 0) ? (
          <GridSkeleton />
        ) : listings.length === 0 ? (
          <EmptyPanel
            filtered={filtered}
            onClear={() => {
              setTyped(EMPTY);
              setApplied(EMPTY);
            }}
          />
        ) : (
          <>
            <p className="sr-only" aria-live="polite">
              {listings.length} items shown
            </p>
            <div className="grid grid-cols-2 gap-x-4 gap-y-9 md:grid-cols-3 lg:grid-cols-4">
              {listings.map((listing, index) => (
                <ListingTile key={listing.slug} listing={listing} priority={index < 4} />
              ))}
            </div>
          </>
        )}
      </div>

      {cursor && !error ? (
        <div className="mt-14 flex justify-center">
          <button
            type="button"
            onClick={() => void loadMore()}
            disabled={loadingMore}
            className="dcl-glass min-h-12 rounded-full px-8 text-sm font-bold transition-colors hover:bg-[var(--dcl-glass-strong)] disabled:opacity-60"
          >
            {loadingMore ? 'Loading…' : 'Show more items'}
          </button>
        </div>
      ) : null}
    </section>
  );
}

function CategoryPill({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`min-h-10 shrink-0 whitespace-nowrap rounded-full border px-4 text-sm font-semibold transition-colors ${
        active
          ? 'border-transparent bg-[var(--ink)] text-[var(--ink-inverted)]'
          : 'border-[var(--line)] bg-[var(--dcl-glass)] text-[var(--ink-muted)] hover:text-[var(--ink)]'
      }`}
    >
      {label}
    </button>
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
    // `relative` matters. The visually-hidden span below is `position:
    // absolute`, and with no positioned ancestor its containing block is the
    // page rather than this row — so it lays itself out at the far end of the
    // row's content, escapes whatever was meant to clip it, and drags a
    // horizontal scrollbar across the whole site.
    <label className="relative min-w-0 flex-1 text-xs font-medium text-[var(--ink-muted)] lg:flex-none">
      <span className="sr-only">{label}</span>
      <select
        className="dcl-glass min-h-12 w-full min-w-0 rounded-full px-4 text-sm font-semibold text-[var(--ink)]"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value} className="bg-[var(--surface-raised)]">
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function GridSkeleton() {
  return (
    <>
      <p className="sr-only" aria-live="polite">
        Loading items
      </p>
      <div aria-hidden className="grid grid-cols-2 gap-x-4 gap-y-9 md:grid-cols-3 lg:grid-cols-4">
        {Array.from({ length: 8 }, (_, index) => (
          <div key={index}>
            <div className="dash-pulse aspect-[4/5] rounded-[var(--radius-card)] bg-[var(--dcl-glass)]" />
            <div className="dash-pulse mt-3 h-3.5 w-4/5 rounded bg-[var(--dcl-glass)]" />
            <div className="dash-pulse mt-2 h-3 w-1/2 rounded bg-[var(--dcl-glass)]" />
          </div>
        ))}
      </div>
    </>
  );
}

function EmptyPanel({ filtered, onClear }: { filtered: boolean; onClear: () => void }) {
  return (
    <div className="rounded-[var(--radius-card)] border border-dashed border-[var(--line-strong)] px-6 py-20 text-center">
      <p className="dcl-display text-2xl">
        {filtered ? 'Nothing matches that yet' : 'Nothing listed yet'}
      </p>
      <p className="mx-auto mt-3 max-w-sm text-sm text-[var(--ink-muted)]">
        {filtered
          ? 'Try a wider search, or clear the filters to see everything available.'
          : 'Items appear here as the DASH team finishes checking them. It is worth coming back.'}
      </p>
      {filtered ? (
        <button
          type="button"
          onClick={onClear}
          className="dcl-glass mt-7 min-h-11 rounded-full px-6 text-sm font-bold"
        >
          Clear filters
        </button>
      ) : null}
    </div>
  );
}

function ErrorPanel({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="rounded-[var(--radius-card)] border border-[var(--danger)] bg-[var(--danger-soft)] px-6 py-12 text-center"
    >
      <p className="text-base font-bold text-[var(--danger)]">We could not load the marketplace</p>
      <p className="mx-auto mt-2 max-w-sm text-sm text-[var(--ink-muted)]">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="dcl-glass mt-7 min-h-11 rounded-full px-6 text-sm font-bold"
      >
        Try again
      </button>
    </div>
  );
}
