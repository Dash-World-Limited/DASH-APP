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
import { Modal } from '@/components/Modal';
import { ApiRequestError } from '@/lib/api';
import { authedFetch, useHasSession, useMe, usePermissions } from '@/lib/session';
import { useLive } from '@/lib/useLive';

/**
 * Operations console.
 *
 * Dark surface, dense layout, alerts first. A dispatcher scans this for
 * problems, not for browsing — so anything wrong is loud and everything normal
 * is quiet.
 */

/**
 * The reasons the API accepts for a reassignment.
 *
 * Mirrors the enum in `POST /v1/ops/orders/:id/reassign`. This used to be a
 * `window.prompt()` asking the dispatcher to type one of these strings from
 * memory: a typo produced a 400, and in a sandboxed browser the prompt threw
 * and the reassignment silently never happened. A reassignment is the most
 * audited action in the console — it must be the easiest one to record
 * correctly.
 */
const REASSIGN_REASONS = [
  { value: 'rider_unresponsive', label: 'Rider is unresponsive' },
  { value: 'rider_incident', label: 'Rider had an incident' },
  { value: 'wrong_vehicle', label: 'Wrong vehicle for this order' },
  { value: 'customer_request', label: 'Customer asked for a change' },
  { value: 'other', label: 'Another reason' },
] as const;

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

/**
 * Take an order off its rider and return it to the dispatch pool.
 *
 * The reason is mandatory and audited, so it is picked rather than typed, and
 * the note is free text because the enum never quite covers what happened.
 */
function ReassignDialog({
  order,
  onClose,
  onDone,
}: {
  order: { id: string; code: string };
  onClose: () => void;
  onDone: () => Promise<void> | void;
}) {
  const [reason, setReason] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    if (!reason) return;
    setBusy(true);
    setFailure(null);
    try {
      await authedFetch(`/v1/ops/orders/${order.id}/reassign`, {
        method: 'POST',
        body: { reasonCode: reason, ...(note.trim() ? { note: note.trim() } : {}) },
      });
      await onDone();
      onClose();
    } catch (caught) {
      setFailure(
        caught instanceof ApiRequestError
          ? caught.message
          : 'The reassignment did not go through.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Reassign ${order.code}`}
      description="The current rider is released and the order returns to dispatch."
      onClose={onClose}
      labelledBy="reassign-title"
    >
      <fieldset disabled={busy}>
        <legend className="sr-only">Reason for reassigning {order.code}</legend>
        <div className="space-y-2">
          {REASSIGN_REASONS.map((option) => (
            <label
              key={option.value}
              className={`flex cursor-pointer items-center gap-3 rounded-xl border px-4 py-3 text-sm transition-colors ${
                reason === option.value ? 'border-gold-400 bg-white/5' : 'hover:bg-white/5'
              }`}
            >
              <input
                type="radio"
                name="reassign-reason"
                value={option.value}
                checked={reason === option.value}
                onChange={() => setReason(option.value)}
                className="h-4 w-4"
              />
              <span className="font-medium">{option.label}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <label htmlFor="reassign-note" className="mt-4 block text-sm font-medium">
        Note <span className="font-normal text-[var(--ink-muted)]">(optional)</span>
      </label>
      <textarea
        id="reassign-note"
        value={note}
        onChange={(event) => setNote(event.target.value.slice(0, 280))}
        disabled={busy}
        rows={2}
        placeholder="Anything the next dispatcher should know."
        className="mt-1.5 w-full rounded-xl border bg-[var(--surface-raised)] px-3.5 py-2.5 text-sm text-[var(--ink)] placeholder:text-graphite-400"
      />

      {failure ? (
        <p role="alert" className="mt-3 text-sm font-medium text-coral-600">
          {failure}
        </p>
      ) : null}

      <div className="mt-5 flex gap-2">
        <Button variant="ghost" onClick={onClose} disabled={busy} className="flex-1">
          Cancel
        </Button>
        <Button onClick={() => void submit()} disabled={!reason || busy} className="flex-1">
          {busy ? 'Reassigning…' : 'Reassign'}
        </Button>
      </div>
    </Modal>
  );
}

export default function OpsPage() {
  const [orders, setOrders] = useState<LiveOrder[] | null>(null);
  const [reassigning, setReassigning] = useState<LiveOrder | null>(null);
  const [ledger, setLedger] = useState<LedgerIntegrity | null>(null);
  const [error, setError] = useState<ApiRequestError | null>(null);
  const signedIn = useHasSession();
  const { me } = useMe();
  const { permissions } = usePermissions();
  const canReadLedger = permissions.has('finance:ledger:read');
  const [cityIds, setCityIds] = useState<string[]>([]);

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

  /**
   * Which city boards to follow.
   *
   * A city-scoped dispatcher gets their own cities from `/v1/auth/me`. An
   * unscoped ops role — platform or super admin — reaches every city and has no
   * list of its own, so it takes the live cities from the public catalogue.
   * Neither is a grant: the server refuses any city topic the actor is not
   * entitled to, and the board's own query is filtered by `actor.cityIds`
   * regardless of what is subscribed here.
   */
  useEffect(() => {
    if (!signedIn || !me) return;
    if (me.cityIds.length > 0) {
      setCityIds(me.cityIds);
      return;
    }
    let cancelled = false;
    void authedFetch<{ cities: { id: string }[] }>('/v1/cities')
      .then((result) => {
        if (!cancelled) setCityIds(result.cities.map((city) => city.id));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [signedIn, me]);

  // Realtime over the seven-second poll. An escalation is the case this
  // matters for: it happens when dispatch has given up, often minutes after the
  // customer ordered, and nobody is watching the screen at that moment.
  const { status } = useLive({
    topics: cityIds.map((cityId) => `city:${cityId}`),
    load,
    pollMs: 7_000,
    enabled: signedIn,
  });

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
                            onClick={() => setReassigning(order)}
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
          {status === 'live'
            ? 'Live. Changes appear as they happen, and the board still re-reads every 30 seconds in case one is missed.'
            : 'Not connected for live updates — re-reading every 7 seconds instead.'}
        </p>
      </main>

      {reassigning ? (
        <ReassignDialog
          order={reassigning}
          onClose={() => setReassigning(null)}
          onDone={load}
        />
      ) : null}
    </div>
  );
}
