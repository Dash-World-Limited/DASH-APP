'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { SERVICE_CATEGORIES } from '@dash/domain/services';
import { AppHeader } from '@/components/AppHeader';
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  EstimateNote,
  LoadingBlock,
  formatDistance,
  formatNairaCompact,
} from '@/components/ui';
import { apiFetch, ApiRequestError, type VendorSummary } from '@/lib/api';

/** Where the customer is browsing from. Victoria Island is the seeded default. */
const DEFAULT_POSITION = { latitude: 6.4281, longitude: 3.4219 };

const CATEGORIES = [
  { id: '', label: 'ALL' },
  ...SERVICE_CATEGORIES.filter(({ kind }) => kind === 'merchant'),
];

interface Serviceability {
  serviceable: boolean;
  reason?: string;
  message?: string;
  city: { id: string; name: string; slug: string } | null;
  zone?: { id: string; name: string } | null;
  busy?: boolean;
}

export default function BrowsePage() {
  const [position, setPosition] = useState(DEFAULT_POSITION);
  const [service, setService] = useState<Serviceability | null>(null);
  const [vendors, setVendors] = useState<VendorSummary[] | null>(null);
  const [category, setCategory] = useState('');
  const [search, setSearch] = useState('');
  const [error, setError] = useState<ApiRequestError | null>(null);
  const [locating, setLocating] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const load = async (): Promise<void> => {
      setError(null);
      setVendors(null);
      try {
        const query = new URLSearchParams({
          latitude: String(position.latitude),
          longitude: String(position.longitude),
        });

        const serviceability = await apiFetch<Serviceability>(
          `/v1/serviceability?${query.toString()}`,
        );
        if (cancelled) return;
        setService(serviceability);

        if (category) query.set('service', category);
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
              : new ApiRequestError(0, 'unknown', 'Could not load vendors.'),
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
  }, [position, category, search]);

  const useMyLocation = (): void => {
    if (!navigator.geolocation) return;
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (result) => {
        setPosition({
          latitude: result.coords.latitude,
          longitude: result.coords.longitude,
        });
        setLocating(false);
      },
      () => {
        // Permission refused or unavailable — keep the default and say nothing
        // alarming. The customer can still browse.
        setLocating(false);
      },
      { timeout: 8000 },
    );
  };

  return (
    <>
      <AppHeader />
      <main id="main" className="mx-auto max-w-6xl px-5 py-8">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-extrabold tracking-tight">Order in Lagos</h1>
            {service?.serviceable ? (
              <p className="mt-1.5 text-sm text-graphite-600">
                Delivering to <strong>{service.zone?.name ?? service.city?.name}</strong>
                {service.busy ? (
                  <span className="ml-2">
                    <Badge tone="warning">Busy right now</Badge>
                  </span>
                ) : null}
              </p>
            ) : null}
          </div>
          <button
            onClick={useMyLocation}
            disabled={locating}
            className="rounded-xl border px-4 py-2 text-sm font-semibold hover:bg-[var(--surface-raised)]"
          >
            {locating ? 'Finding you…' : 'Use my location'}
          </button>
        </div>

        {service && !service.serviceable ? (
          <div className="mt-6 rounded-[var(--radius-card)] border border-coral-400/40 bg-coral-50 px-5 py-4">
            <p className="font-semibold text-coral-600">Not delivering here yet</p>
            <p className="mt-1 text-sm text-graphite-600">{service.message}</p>
          </div>
        ) : null}

        <div className="mt-6 space-y-4">
          <label className="sr-only" htmlFor="vendor-search">
            Search vendors
          </label>
          <input
            id="vendor-search"
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search food, shops, pharmacies or local markets…"
            className="w-full rounded-xl border bg-[var(--surface-raised)] px-4 py-3 text-base placeholder:text-graphite-400"
          />

          <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by service">
            {CATEGORIES.map((option) => (
              <button
                key={option.id}
                onClick={() => setCategory(option.id)}
                aria-pressed={category === option.id}
                className={`rounded-full px-4 py-2 text-sm font-semibold transition-colors ${
                  category === option.id
                    ? 'bg-graphite-900 text-white'
                    : 'border hover:bg-[var(--surface-raised)]'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-8">
          {error ? (
            <ErrorState
              message={error.message}
              requestId={error.requestId}
              onRetry={() => setPosition({ ...position })}
            />
          ) : vendors === null ? (
            <LoadingBlock label="Loading vendors" />
          ) : vendors.length === 0 ? (
            <EmptyState
              title="Nothing matches that"
              description={
                search
                  ? `No vendors matched “${search}”. Try a different search or clear the filters.`
                  : 'There are no vendors in this category yet.'
              }
            />
          ) : (
            <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {vendors.map((vendor) => {
                const closed = vendor.branch?.state === 'closed';
                return (
                  <Card
                    as="li"
                    key={vendor.id}
                    className="overflow-hidden transition-shadow hover:shadow-lg"
                  >
                    <Link
                      href={`/browse/${vendor.slug}`}
                      className={`block p-5 ${closed ? 'opacity-60' : ''}`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <h2 className="text-lg font-bold leading-tight">{vendor.name}</h2>
                        {closed ? (
                          <Badge tone="danger">Closed</Badge>
                        ) : vendor.branch?.state === 'busy' ? (
                          <Badge tone="warning">Busy</Badge>
                        ) : (
                          <Badge tone="success">Open</Badge>
                        )}
                      </div>

                      <p className="mt-1.5 line-clamp-2 text-sm text-graphite-600">
                        {vendor.description}
                      </p>

                      <dl className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                        <div className="flex items-center gap-1">
                          <dt className="sr-only">Rating</dt>
                          <dd className="font-semibold">
                            {vendor.rating.average.toFixed(1)}
                            <span className="ml-1 font-normal text-graphite-400">
                              ({vendor.rating.count})
                            </span>
                          </dd>
                        </div>
                        {vendor.distanceMetres !== null ? (
                          <div>
                            <dt className="sr-only">Distance</dt>
                            <dd className="text-graphite-600">
                              {formatDistance(vendor.distanceMetres)}
                            </dd>
                          </div>
                        ) : null}
                        {vendor.branch ? (
                          <div>
                            <dt className="sr-only">Estimated time</dt>
                            <dd className="text-graphite-600">
                              ~{vendor.branch.estimatedMinutes} min
                            </dd>
                          </div>
                        ) : null}
                      </dl>

                      {vendor.branch && vendor.branch.minimumOrder > 0 ? (
                        <EstimateNote>
                          {formatNairaCompact(vendor.branch.minimumOrder)} minimum
                        </EstimateNote>
                      ) : null}
                    </Link>
                  </Card>
                );
              })}
            </ul>
          )}
        </div>
      </main>
    </>
  );
}
