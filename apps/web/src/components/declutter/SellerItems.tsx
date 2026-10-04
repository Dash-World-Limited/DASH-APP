'use client';

import { useCallback, useEffect, useState } from 'react';

import { ApiRequestError } from '@/lib/api';
import { authedFetch } from '@/lib/session';

interface SubmissionSummary {
  id: string;
  code: string;
  status: string;
  title: string | null;
  condition: string | null;
  expectedPriceKobo: number | null;
  createdAt: string;
}

interface PriceState {
  status: string;
  priceKobo: number | null;
  acceptedPriceKobo: number | null;
  acceptanceValid: boolean;
}

interface Row {
  submission: SubmissionSummary;
  price: PriceState | null;
}

function money(kobo: number): string {
  return new Intl.NumberFormat('en-NG', {
    style: 'currency',
    currency: 'NGN',
    maximumFractionDigits: 0,
  }).format(kobo / 100);
}

function readable(value: string): string {
  return value.replaceAll('_', ' ');
}

function messageOf(caught: unknown): string {
  return caught instanceof ApiRequestError ? caught.message : 'Could not update that item.';
}

export function SellerItems({ refreshKey = 0 }: { refreshKey?: number }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const result = await authedFetch<{ submissions: SubmissionSummary[] }>('/v1/declutter/submissions');
      const withPrices = await Promise.all(
        result.submissions.map(async (submission) => {
          try {
            const price = await authedFetch<PriceState>(`/v1/declutter/submissions/${submission.id}/price`);
            return { submission, price };
          } catch {
            return { submission, price: null };
          }
        }),
      );
      setRows(withPrices);
    } catch (caught) {
      setError(messageOf(caught));
      setRows([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  async function answer(row: Row, response: 'accept' | 'decline') {
    const priceKobo = row.price?.priceKobo;
    if (!priceKobo) return;
    setBusyId(row.submission.id);
    setError(null);
    try {
      await authedFetch(`/v1/declutter/submissions/${row.submission.id}/price-response`, {
        method: 'POST',
        body: { response, priceKobo },
      });
      await load();
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusyId(null);
    }
  }

  if (rows === null && !error) {
    return (
      <div className="dcl-glass rounded-[var(--radius-card)] p-6">
        <p className="text-sm text-[var(--ink-muted)]">Loading your items…</p>
      </div>
    );
  }

  if (!rows || rows.length === 0) return null;

  return (
    <section className="dcl-glass rounded-[var(--radius-card)] p-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="dcl-eyebrow">Your items</p>
          <h2 className="mt-2 text-xl font-bold">Submissions and price offers</h2>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="min-h-10 rounded-full border border-[var(--line)] px-4 text-xs font-bold"
        >
          Refresh
        </button>
      </div>

      {error ? <p role="alert" className="mt-4 text-sm font-semibold text-[var(--danger)]">{error}</p> : null}

      <div className="mt-5 space-y-3">
        {rows.map((row) => {
          const waitingForSeller = row.price?.status === 'seller_acceptance_pending' && row.price.priceKobo;
          return (
            <article key={row.submission.id} className="rounded-2xl border border-[var(--line)] bg-[var(--surface-sunken)] p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-bold">{row.submission.title ?? row.submission.code}</p>
                  <p className="mt-1 text-xs text-[var(--ink-muted)]">
                    {row.submission.code} · {readable(row.submission.status)}
                  </p>
                </div>
                {row.price?.acceptanceValid ? (
                  <span className="rounded-full bg-[var(--success-soft)] px-3 py-1 text-xs font-bold text-[var(--success)]">
                    Price accepted
                  </span>
                ) : null}
              </div>

              {waitingForSeller ? (
                <div className="mt-4 rounded-xl border border-[var(--line)] bg-[var(--surface)] p-4">
                  <p className="text-xs font-semibold uppercase tracking-wide text-[var(--ink-muted)]">DASH fixed price</p>
                  <p className="mt-1 text-2xl font-bold">{money(row.price!.priceKobo!)}</p>
                  <p className="mt-2 text-xs leading-relaxed text-[var(--ink-muted)]">
                    Accept this price to make the item eligible for publication after the remaining DASH checks.
                  </p>
                  <div className="mt-4 flex gap-2">
                    <button
                      type="button"
                      disabled={busyId === row.submission.id}
                      onClick={() => void answer(row, 'accept')}
                      className="min-h-11 flex-1 rounded-full bg-[var(--primary)] px-4 text-xs font-bold text-[var(--on-primary)] disabled:opacity-50"
                    >
                      Accept price
                    </button>
                    <button
                      type="button"
                      disabled={busyId === row.submission.id}
                      onClick={() => void answer(row, 'decline')}
                      className="min-h-11 flex-1 rounded-full border border-[var(--line)] px-4 text-xs font-bold disabled:opacity-50"
                    >
                      Decline
                    </button>
                  </div>
                </div>
              ) : row.price?.acceptedPriceKobo ? (
                <p className="mt-3 text-sm text-[var(--ink-muted)]">
                  Accepted price: <strong className="text-[var(--ink)]">{money(row.price.acceptedPriceKobo)}</strong>
                </p>
              ) : (
                <p className="mt-3 text-sm text-[var(--ink-muted)]">
                  DASH review/pricing is still in progress.
                </p>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
