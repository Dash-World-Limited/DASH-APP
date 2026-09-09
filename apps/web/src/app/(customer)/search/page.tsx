'use client';

/**
 * Search across the marketplace.
 *
 * Backed by the existing `/v1/search` endpoint, which already searches vendors
 * and items server-side — so this is a surface over something real rather than
 * a filter over a page of results the client happens to hold.
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { Card, EmptyState, Input, LoadingBlock } from '@/components/ui';
import { apiFetch } from '@/lib/api';

interface SearchHit {
  slug: string;
  name: string;
  category?: string;
}

interface SearchResponse {
  vendors?: SearchHit[];
}

export default function SearchPage() {
  const [term, setTerm] = useState('');
  const [results, setResults] = useState<SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    const query = term.trim();
    if (query.length < 2) {
      setResults(null);
      return;
    }

    // Debounced: a request per keystroke would put the API under load that
    // tells it nothing, and results that arrive out of order would flicker.
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(() => {
      void apiFetch<SearchResponse>(`/v1/search?q=${encodeURIComponent(query)}`)
        .then((response) => {
          if (!cancelled) setResults(response.vendors ?? []);
        })
        .catch(() => {
          if (!cancelled) setResults([]);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 300);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [term]);

  return (
    <div className="min-h-dvh">
      <main id="main" className="mx-auto max-w-lg px-4 py-6">
        <h1 className="text-2xl font-bold tracking-tight">Search</h1>
        <Input
          value={term}
          onChange={(event) => setTerm(event.target.value)}
          placeholder="Restaurants, groceries, pharmacies…"
          className="mt-4"
          aria-label="Search DASH"
          autoComplete="off"
        />

        <div className="mt-5">
          {searching ? (
            <LoadingBlock label="Searching" />
          ) : results === null ? (
            <EmptyState
              title="What are you looking for?"
              description="Search across restaurants, supermarkets, pharmacies and shops."
            />
          ) : results.length === 0 ? (
            <EmptyState
              title="Nothing matched"
              description="Try a shorter word, or a different spelling."
            />
          ) : (
            <ul className="space-y-3">
              {results.map((hit) => (
                <Card as="li" key={hit.slug} className="p-4">
                  <Link href={`/browse/${hit.slug}`} className="font-bold">
                    {hit.name}
                  </Link>
                  {hit.category ? (
                    <p className="mt-0.5 text-sm capitalize text-[var(--ink-muted)]">
                      {hit.category}
                    </p>
                  ) : null}
                </Card>
              ))}
            </ul>
          )}
        </div>
      </main>
    </div>
  );
}
