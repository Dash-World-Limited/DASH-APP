'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { AppHeader } from '@/components/AppHeader';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  LoadingBlock,
  formatNaira,
} from '@/components/ui';
import { ApiRequestError } from '@/lib/api';
import { authedFetch, useHasSession, usePermissions } from '@/lib/session';

/**
 * Operations console.
 *
 * Dark surface, dense layout, alerts first. A dispatcher scans this for
 * problems, not for browsing — so anything wrong is loud and everything normal
 * is quiet.
 */

interface LiveOrder {
  id: string;
  code: string;
  status: string;
  vendor: string;
  zone: string | null;
  ageMinutes: number;
  alerts: ('unassigned_too_long' | 'preparation_overdue' | 'rider_location_stale')[];
  rider: {
    id: string;
    name: string | null;
    latitude: number | null;
    longitude: number | null;
    locationAgeSeconds: number | null;
  } | null;
}

interface LedgerIntegrity {
  transactionsChecked: number;
  balanced: boolean;
  totalDriftKobo: number;
  offending: string[];
}

const ALERT_LABELS: Record<LiveOrder['alerts'][number], string> = {
  unassigned_too_long: 'No rider yet',
  preparation_overdue: 'Kitchen overdue',
  rider_location_stale: 'Rider signal lost',
};

export default function OpsPage() {
  const [orders, setOrders] = useState<LiveOrder[] | null>(null);
  const [ledger, setLedger] = useState<LedgerIntegrity | null>(null);
  const [error, setError] = useState<ApiRequestError | null>(null);
  const signedIn = useHasSession();
  const { permissions } = usePermissions();
  const canReadLedger = permissions.has('finance:ledger:read');

  const load = useCallback(async (): Promise<void> => {
    if (!signedIn) return;
    try {
      const result = await authedFetch<{ orders: LiveOrder[] }>('/v1/ops/live');
      setOrders(result.orders);
      setError(null);
    } catch (caught) {
      setError(
        caught instanceof ApiRequestError
          ? caught
          : new ApiRequestError(0, 'unknown', 'Could not load the live board.'),
      );
      setOrders([]);
    }

    // Finance-only. Checked against the actor's own permissions first rather
    // than firing the request and swallowing a 403 — the server would still
    // refuse it, but calling an endpoint you know you cannot use fills the
    // console with errors and hides the real ones.
    if (!canReadLedger) {
      setLedger(null);
      return;
    }
    try {
      setLedger(await authedFetch<LedgerIntegrity>('/v1/finance/ledger/integrity'));
    } catch {
      setLedger(null);
    }
  }, [signedIn, canReadLedger]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!signedIn) return;
    const timer = setInterval(() => void load(), 7000);
    return () => clearInterval(timer);
  }, [load, signedIn]);

  if (!signedIn) {
    return (
      <div data-surface="field" className="min-h-screen">
        <AppHeader variant="staff" />
        <main id="main" className="mx-auto max-w-5xl px-5 py-12">
          <EmptyState
            title="Staff sign-in required"
            description="The live board is restricted to dispatch, support, and finance staff."
            action={
              <Link href="/signin?next=/ops">
                <Button>Sign in</Button>
              </Link>
            }
          />
        </main>
      </div>
    );
  }

  const flagged = orders?.filter((order) => order.alerts.length > 0) ?? [];
  const unassigned = orders?.filter((order) => order.rider === null).length ?? 0;

  return (
    <div data-surface="field" className="min-h-screen">
      <AppHeader variant="staff" />
      <main id="main" className="mx-auto max-w-5xl px-5 py-8">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <h1 className="text-3xl font-extrabold tracking-tight">Live operations</h1>
          <Button variant="ghost" size="sm" onClick={() => void load()}>
            Refresh
          </Button>
        </div>

        {/* --- Summary -------------------------------------------------------- */}
        <dl className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Card className="p-4">
            <dt className="text-xs uppercase tracking-wide text-[var(--ink-muted)]">Active</dt>
            <dd className="mt-1 text-2xl font-extrabold">{orders?.length ?? '—'}</dd>
          </Card>
          <Card className="p-4">
            <dt className="text-xs uppercase tracking-wide text-[var(--ink-muted)]">
              Unassigned
            </dt>
            <dd className="mt-1 text-2xl font-extrabold">{unassigned}</dd>
          </Card>
          <Card className={`p-4 ${flagged.length > 0 ? 'border-coral-400' : ''}`}>
            <dt className="text-xs uppercase tracking-wide text-[var(--ink-muted)]">Alerts</dt>
            <dd
              className={`mt-1 text-2xl font-extrabold ${
                flagged.length > 0 ? 'text-coral-400' : ''
              }`}
            >
              {flagged.length}
            </dd>
          </Card>
          <Card className={`p-4 ${ledger && !ledger.balanced ? 'border-coral-400' : ''}`}>
            <dt className="text-xs uppercase tracking-wide text-[var(--ink-muted)]">Ledger</dt>
            <dd className="mt-1 text-2xl font-extrabold">
              {ledger === null ? (
                <span className="text-base font-medium text-[var(--ink-muted)]">n/a</span>
              ) : ledger.balanced ? (
                <span className="text-emerald-400">Balanced</span>
              ) : (
                <span className="text-coral-400">Drift</span>
              )}
            </dd>
          </Card>
        </dl>

        {ledger && !ledger.balanced ? (
          <div className="mt-4">
            <ErrorState
              title="The money ledger does not balance"
              message={`Drift of ${formatNaira(ledger.totalDriftKobo)} across ${
                ledger.offending.length
              } transaction(s). Stop processing and escalate to finance immediately.`}
            />
          </div>
        ) : null}

        {error ? (
          <div className="mt-4">
            <ErrorState
              message={error.message}
              requestId={error.requestId}
              onRetry={() => void load()}
            />
          </div>
        ) : null}

        {/* --- Board ---------------------------------------------------------- */}
        <section className="mt-8">
          <h2 className="text-lg font-bold">Active orders</h2>
          <div className="mt-3">
            {orders === null ? (
              <LoadingBlock label="Loading the live board" />
            ) : orders.length === 0 ? (
              <EmptyState
                title="Nothing in flight"
                description="Active orders appear here as soon as they are placed."
              />
            ) : (
              <ul className="space-y-2">
                {[...orders]
                  // Anything with an alert floats to the top; then oldest first.
                  .sort(
                    (a, b) =>
                      b.alerts.length - a.alerts.length || b.ageMinutes - a.ageMinutes,
                  )
                  .map((order) => (
                    <Card
                      as="li"
                      key={order.id}
                      className={`p-4 ${order.alerts.length > 0 ? 'border-coral-400' : ''}`}
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-mono font-bold">{order.code}</span>
                            <Badge>{order.status.replace(/_/g, ' ')}</Badge>
                            {order.alerts.map((alert) => (
                              <Badge key={alert} tone="danger">
                                {ALERT_LABELS[alert]}
                              </Badge>
                            ))}
                          </div>
                          <p className="mt-1.5 text-sm text-[var(--ink-muted)]">
                            {order.vendor}
                            {order.zone ? ` · ${order.zone}` : ''} · {order.ageMinutes} min old
                          </p>
                          <p className="mt-0.5 text-sm">
                            {order.rider ? (
                              <>
                                Rider: <strong>{order.rider.name}</strong>
                                {order.rider.locationAgeSeconds !== null ? (
                                  <span className="text-[var(--ink-muted)]">
                                    {' '}
                                    · {order.rider.locationAgeSeconds}s ago
                                  </span>
                                ) : null}
                              </>
                            ) : (
                              <span className="text-[var(--ink-muted)]">No rider assigned</span>
                            )}
                          </p>
                        </div>

                        {order.rider ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              const note = window.prompt(
                                `Reassign ${order.code}. Why? (rider_unresponsive, rider_incident, wrong_vehicle, customer_request, other)`,
                                'rider_unresponsive',
                              );
                              if (!note) return;
                              void authedFetch(`/v1/ops/orders/${order.id}/reassign`, {
                                method: 'POST',
                                body: { reasonCode: note },
                              })
                                .then(() => load())
                                .catch((caught: unknown) => {
                                  if (caught instanceof ApiRequestError) setError(caught);
                                });
                            }}
                          >
                            Reassign
                          </Button>
                        ) : null}
                      </div>
                    </Card>
                  ))}
              </ul>
            )}
          </div>
        </section>

        <p className="mt-8 text-xs text-[var(--ink-muted)]">
          This board polls every 7 seconds. Live websocket push is not built yet.
        </p>
      </main>
    </div>
  );
}
