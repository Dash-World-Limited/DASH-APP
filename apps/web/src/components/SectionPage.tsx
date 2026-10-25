'use client';

/**
 * One section of the marketplace: its sellers, and nothing else.
 *
 * Every section renders through this. Shops, Restaurants, Local Market,
 * Pharmacy and Declutter differ by a label and a category filter, so five
 * hand-written screens would be five places for the same bug — and five
 * chances for Declutter to drift into looking like a different application
 * rather than one door among equals.
 *
 * It deliberately stops at the seller. Tapping through goes to the existing
 * vendor page, which already renders that seller's own categories and items
 * and feeds the one basket. Declutter does not get an item-first shortcut for
 * the same reason a restaurant does not: the hierarchy is section → seller →
 * that seller's categories → item, everywhere.
 */

import Link from 'next/link';
import { useStudioContent } from '@/lib/useStudioContent';
import { orderStudioVendors } from '@dash/domain/content/presentation';
import { StudioCategoryArtwork, StudioVendorArtwork } from '@/components/content/StudioPresentation';
import { useEffect, useState } from 'react';

import { Badge, Card, EmptyState, ErrorState, LoadingBlock, formatDistance, formatNaira } from '@/components/ui';
import { apiFetch, ApiRequestError } from '@/lib/api';
import type { Section } from '@/lib/sections';

interface SellerCard {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  category: string;
  rating: { average: number; count: number } | null;
  distanceMetres: number | null;
  branch: {
    state: string;
    minimumOrder: number;
    estimatedMinutes: number | null;
  } | null;
}

/** Browsed from here until the customer's own address is known. */
const DEFAULT_POSITION = { latitude: 6.4281, longitude: 3.4219 };

export function SectionPage({ section }: { section: Section }) {
  const studio = useStudioContent();
  const [sellers, setSellers] = useState<SellerCard[] | null>(null);
  const [error, setError] = useState<ApiRequestError | null>(null);

  useEffect(() => {
    let cancelled = false;

    // One request per business type the section gathers — Shops asks for both
    // `retail` and `grocery`. Merged by slug so a seller listed under two
    // categories appears once.
    void Promise.all(
      section.categories.map((category) =>
        apiFetch<{ vendors: SellerCard[] }>(
          `/v1/vendors?latitude=${DEFAULT_POSITION.latitude}&longitude=${DEFAULT_POSITION.longitude}&category=${category}`,
        ).catch(() => ({ vendors: [] as SellerCard[] })),
      ),
    )
      .then((responses) => {
        if (cancelled) return;
        const bySlug = new Map<string, SellerCard>();
        for (const response of responses) {
          for (const seller of response.vendors ?? []) bySlug.set(seller.slug, seller);
        }
        setSellers(
          [...bySlug.values()].sort(
            (a, b) => (a.distanceMetres ?? Infinity) - (b.distanceMetres ?? Infinity),
          ),
        );
        setError(null);
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setError(
          caught instanceof ApiRequestError
            ? caught
            : new ApiRequestError(0, 'unknown', `Could not load ${section.label}.`),
        );
      });

    return () => {
      cancelled = true;
    };
  }, [section]);

  return (
    <main id="main" className="mx-auto max-w-2xl px-4 py-6">
      <StudioCategoryArtwork items={studio} categoryId={section.slug} /><h1 className="text-2xl font-bold tracking-tight">{section.label}</h1>
      <p className="mt-1 text-sm text-[var(--ink-muted)]">{section.blurb}</p>

      <div className="mt-5">
        {error ? (
          <ErrorState message={error.message} requestId={error.requestId} />
        ) : sellers === null ? (
          <LoadingBlock label={`Loading ${section.label.toLowerCase()}`} />
        ) : sellers.length === 0 ? (
          <EmptyState
            title={`No ${section.label.toLowerCase()} near you yet`}
            description="We are still adding sellers to this section."
          />
        ) : (
          <ul className="space-y-3">
            {orderStudioVendors(sellers, studio, (seller) => seller.id).map((seller) => (
              <Card as="li" key={seller.slug} className="p-0">
                <Link href={`/browse/${seller.slug}`} className="block p-4">
                  <StudioVendorArtwork items={studio} vendorId={seller.id} /><div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h2 className="truncate font-bold">{seller.name}</h2>
                      {seller.description ? (
                        <p className="mt-0.5 line-clamp-2 text-sm text-[var(--ink-muted)]">
                          {seller.description}
                        </p>
                      ) : null}
                    </div>
                    {seller.branch?.state === 'open' ? null : (
                      <Badge tone="neutral">Closed</Badge>
                    )}
                  </div>

                  <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--ink-muted)]">
                    {seller.rating ? (
                      <span className="font-semibold text-[var(--ink)]">
                        ★ {seller.rating.average.toFixed(1)}
                      </span>
                    ) : null}
                    {seller.branch?.estimatedMinutes ? (
                      <span>{seller.branch.estimatedMinutes} min</span>
                    ) : null}
                    {seller.distanceMetres !== null ? (
                      <span>{formatDistance(seller.distanceMetres)}</span>
                    ) : null}
                    {seller.branch?.minimumOrder ? (
                      <span>Min {formatNaira(seller.branch.minimumOrder)}</span>
                    ) : null}
                  </div>
                </Link>
              </Card>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
