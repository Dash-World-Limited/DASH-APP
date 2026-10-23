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

/** The reasons the API accepts for restarting the search on an order with no rider. */
const REDISPATCH_REASONS = [
  { value: 'no_rider_found', label: 'No rider was found' },
  { value: 'riders_back_online', label: 'Riders are available again' },
  { value: 'customer_request', label: 'Customer asked us to try again' },
  { value: 'other', label: 'Another reason' },
] as const;

/** The reasons the API accepts for a staff cancellation. */
const CANCEL_REASONS = [
  { value: 'customer_request', label: 'Customer asked to cancel' },
  { value: 'vendor_request', label: 'Vendor asked to cancel' },
  { value: 'vendor_unavailable', label: 'Vendor is closed or unreachable' },
  { value: 'no_rider_available', label: 'No rider available' },
  { value: 'duplicate_order', label: 'Duplicate order' },
  { value: 'suspected_fraud', label: 'Suspected fraud' },
  { value: 'rider_incident', label: 'Rider incident (rider has the order)' },
  { value: 'delivery_incident', label: 'Delivery incident (rider has the order)' },
  { value: 'other', label: 'Another reason' },
] as const;

/** Rider statuses in which the rider physically has the order. */
const RIDER_HAS_ORDER = new Set(['picked_up', 'en_route', 'arrived']);
/** States in which dispatch is running or can be restarted for an order with no rider. */
const SEARCHABLE = new Set(['preparing', 'ready']);

type OpsAction = 'reassign' | 'redispatch' | 'cancel';

const ACTION_COPY: Record<
  OpsAction,
  {
    title: (code: string) => string;
    description: string;
    reasons: readonly { value: string; label: string }[];
    noteRequired: boolean;
    confirm: string;
    busy: string;
    failure: string;
  }
> = {
  reassign: {
    title: (code) => `Reassign ${code}`,
    description:
      'The current rider is taken off and the order goes straight back to dispatch, without them. Only before pickup.',
    reasons: REASSIGN_REASONS,
    noteRequired: false,
    confirm: 'Reassign',
    busy: 'Reassigning…',
    failure: 'The reassignment did not go through.',
  },
  redispatch: {
    title: (code) => `Find a rider for ${code}`,
    description: 'Restarts the search. Riders offered this order before may be offered it again.',
    reasons: REDISPATCH_REASONS,
    noteRequired: false,
    confirm: 'Restart search',
    busy: 'Restarting…',
    failure: 'The search did not restart.',
  },
  cancel: {
    title: (code) => `Cancel ${code}`,
    description:
      'Stops the order for everyone: rider offers are withdrawn and any rider is stood down. No refund is made here — if a payment was taken, decide the refund in Refunds.',
    reasons: CANCEL_REASONS,
    noteRequired: true,
    confirm: 'Cancel order',
    busy: 'Cancelling…',
    failure: 'The cancellation did not go through.',
  },
};

/**
 * One staff action on a live order.
 *
 * The reason is mandatory and audited, so it is picked rather than typed, and
 * the note is free text because the enum never quite covers what happened. A
 * cancellation also requires the note: it stops an order for a customer, a
 * vendor and possibly a rider at once.
 */
function OpsActionDialog({
  action,
  order,
  onClose,
  onDone,
}: {
  action: OpsAction;
  order: { id: string; code: string };
  onClose: () => void;
  onDone: (result: { refundDecisionNeeded?: boolean }) => Promise<void> | void;
}) {
  const copy = ACTION_COPY[action];
  const [reason, setReason] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const noteMissing = copy.noteRequired && note.trim().length < 3;

  const submit = async (): Promise<void> => {
    if (!reason || noteMissing) return;
    setBusy(true);
    setFailure(null);
    try {
      const result = await authedFetch<{ refundDecisionNeeded?: boolean }>(`/v1/ops/orders/${order.id}/${action}`, {
        method: 'POST',
        body: { reasonCode: reason, ...(note.trim() ? { note: note.trim() } : {}) },
      });
      await onDone(result);
      onClose();
    } catch (caught) {
      setFailure(caught instanceof ApiRequestError ? caught.message : copy.failure);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={copy.title(order.code)}
      description={copy.description}
      onClose={onClose}
      labelledBy={`${action}-title`}
    >
      <fieldset disabled={busy}>
        <legend className="sr-only">Reason</legend>
        <div className="space-y-2">
          {copy.reasons.map((option) => (
            <label
              key={option.value}
              className={`flex cursor-pointer items-center gap-3 rounded-xl border px-4 py-3 text-sm transition-colors ${
                reason === option.value ? 'border-gold-400 bg-white/5' : 'hover:bg-white/5'
              }`}
            >
              <input
                type="radio"
                name={`${action}-reason`}
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

      <label htmlFor={`${action}-note`} className="mt-4 block text-sm font-medium">
        Note{' '}
        <span className="font-normal text-[var(--ink-muted)]">{copy.noteRequired ? '(required)' : '(optional)'}</span>
      </label>
      <textarea
        id={`${action}-note`}
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
          Back
        </Button>
        <Button
          variant={action === 'cancel' ? 'danger' : undefined}
          onClick={() => void submit()}
          disabled={!reason || noteMissing || busy}
          className="flex-1"
        >
          {busy ? copy.busy : copy.confirm}
        </Button>
      </div>
    </Modal>
  );
}

export default function OpsPage() {
  const [orders, setOrders] = useState<LiveOrder[] | null>(null);
  const [acting, setActing] = useState<{ action: OpsAction; order: LiveOrder } | null>(null);
  const [refundNotice, setRefundNotice] = useState<string | null>(null);
  const [ledger, setLedger] = useState<LedgerIntegrity | null>(null);
  const [error, setError] = useState<ApiRequestError | null>(null);
  const signedIn = useHasSession();
  const { me } = useMe();
  const { permissions } = usePermissions();
  const canReadLedger = permissions.has('finance:ledger:read');
  // Super admin only (see `ops:order:override`); the server enforces it.
  const canReassign = permissions.has('ops:order:override');
  const canCancel = permissions.has('ops:order:override');
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
          <div className="flex items-center gap-2">
            <Link href="/ops/declutter">
              <Button variant="ghost" size="sm">
                Declutters
              </Button>
            </Link>
            {permissions.has('admin:vendor:approve') || permissions.has('admin:rider:approve') ? (
              <Link href="/ops/partners">
                <Button variant="ghost" size="sm">
                  Partners
                </Button>
              </Link>
            ) : null}
            {permissions.has('finance:payment:read') ? (
              <Link href="/ops/refunds">
                <Button variant="ghost" size="sm">
                  Refunds
                </Button>
              </Link>
            ) : null}
            <Button variant="ghost" size="sm" onClick={() => void load()}>
              Refresh
            </Button>
          </div>
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

        {refundNotice ? (
          <div className="mt-4">
            <ErrorState title="Refund review required" message={refundNotice} />
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
                            {order.rider && RIDER_HAS_ORDER.has(order.status) ? (
                              <span className="text-[var(--ink-muted)]"> · has the order</span>
                            ) : null}
                          </p>
                        </div>

                        <div className="flex flex-wrap gap-2">
                          {/* Server-enforced too: these only hide what would be refused. */}
                          {canReassign && order.rider && !RIDER_HAS_ORDER.has(order.status) ? (
                            <Button variant="ghost" size="sm" onClick={() => setActing({ action: 'reassign', order })}>
                              Reassign
                            </Button>
                          ) : null}
                          {canReassign && !order.rider && SEARCHABLE.has(order.status) ? (
                            <Button variant="ghost" size="sm" onClick={() => setActing({ action: 'redispatch', order })}>
                              Find a rider
                            </Button>
                          ) : null}
                          {canCancel ? (
                            <Button variant="ghost" size="sm" onClick={() => setActing({ action: 'cancel', order })}>
                              Cancel
                            </Button>
                          ) : null}
                        </div>
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

      {acting ? (
        <OpsActionDialog
          action={acting.action}
          order={acting.order}
          onClose={() => setActing(null)}
          onDone={async (result) => {
            // A cancelled order leaves this board, so say what it still owes
            // before it goes. The flag stays on the admin order record.
            if (acting.action === 'cancel' && result.refundDecisionNeeded) {
              setRefundNotice(
                `${acting.order.code} was cancelled after payment was taken. No refund was made. Open the order in Orders and decide the refund in Refunds.`,
              );
            }
            await load();
          }}
        />
      ) : null}
    </div>
  );
}
