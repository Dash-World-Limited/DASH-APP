'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { AppHeader } from '@/components/AppHeader';
import {
  Badge,
  Button,
  Card,
  ErrorState,
  EstimateNote,
  LoadingBlock,
  formatNaira,
} from '@/components/ui';
import { Modal } from '@/components/Modal';
import { ApiRequestError, type QuoteLine } from '@/lib/api';
import { customerTimeline } from '@dash/domain/orders';
import { authedFetch } from '@/lib/session';
import { liveLabel, useLive } from '@/lib/useLive';

interface OrderDetail {
  id: string;
  code: string;
  status: string;
  statusLabel: string;
  phase: 'confirming' | 'preparing' | 'on_the_way' | 'complete' | 'stopped';
  mode: string;
  total: number;
  quoteBreakdown: { lines: QuoteLine[] };
  contactless: boolean;
  instructions: string | null;
  createdAt: string;
  estimatedReadyAt: string | null;
  deliveredAt: string | null;
  cancellationReason: string | null;
  vendor: { id: string; name: string; slug: string; category: string };
  branch: { name: string; address: string };
  address: { line1: string; landmark: string | null } | null;
  items: {
    nameSnapshot: string;
    priceSnapshot: number;
    quantity: number;
    modifiers: string | null;
    lineTotal: number;
  }[];
  statusEvents: { toStatus: string; createdAt: string; actorType: string }[];
  rider: {
    name: string | null;
    vehicleType: string;
    latitude: number | null;
    longitude: number | null;
    reportedAt: string | null;
    isStale: boolean;
  } | null;
  /** Optional: absent from servers older than refund confirmation. */
  refunds?: { amount: number; status: string; label: string; body: string; refundedAt: string | null; createdAt: string }[];
}

interface Cancellation {
  allowed: boolean;
  feeBasisPoints: number;
  refundBasisPoints: number;
  explanation: string;
}

// The timeline's words come from the shared vocabulary, not from here.
//
// This file used to keep its own copy — a second vocabulary for the same
// states, already saying "Preparing" while the server said "Being prepared",
// and both of them wrong for a pharmacy. See @dash/domain/orders.


export default function OrderTrackingPage() {
  const params = useParams<{ id: string }>();
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [cancellation, setCancellation] = useState<Cancellation | null>(null);
  const [error, setError] = useState<ApiRequestError | null>(null);
  const [pin, setPin] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const result = await authedFetch<{ order: OrderDetail; cancellation: Cancellation }>(
        `/v1/orders/${params.id}`,
      );
      setOrder(result.order);
      setCancellation(result.cancellation);
      setError(null);
    } catch (caught) {
      setError(
        caught instanceof ApiRequestError
          ? caught
          : new ApiRequestError(0, 'unknown', 'Could not load this order.'),
      );
    }
  }, [params.id]);

  useEffect(() => {
    try {
      setPin(sessionStorage.getItem(`dash.pin.${params.id}`));
    } catch {
      setPin(null);
    }
  }, [params.id]);

  // A finished order has nothing left to announce, so both the socket and the
  // timer stop. `order === null` counts as live so the very first read happens.
  const stillMoving =
    order === null || (order.phase !== 'complete' && order.phase !== 'stopped');

  // Realtime, with the ten-second poll kept underneath it.
  //
  // The notification carries `{subject, version}` and nothing else; the refresh
  // it triggers is this screen's own `load()`, which is the same authorized
  // read it has always made. That is what stops the socket showing a customer
  // anything `GET /v1/orders/:id` would not have — the rider's position only
  // while the order is active, no delivery PIN, no other customer's order.
  const { status } = useLive({
    topics: [`order:${params.id}`],
    load,
    pollMs: 10_000,
    enabled: stillMoving,
  });

  if (error) {
    return (
      <>
        <AppHeader />
        <main id="main" className="mx-auto max-w-2xl px-5 py-12">
          <ErrorState
            title={error.status === 404 ? 'Order not found' : 'Could not load this order'}
            message={
              error.status === 404
                ? 'This order does not exist, or it is not yours.'
                : error.message
            }
            requestId={error.requestId}
            onRetry={() => void load()}
          />
          <Link href="/orders">
            <Button variant="ghost" className="mt-4">
              Back to your orders
            </Button>
          </Link>
        </main>
      </>
    );
  }

  if (!order) {
    return (
      <>
        <AppHeader />
        <main id="main" className="mx-auto max-w-2xl px-5 py-12">
          <LoadingBlock label="Loading your order" />
        </main>
      </>
    );
  }

  const phases = customerTimeline(order.vendor.category);
  const activePhaseIndex = phases.findIndex((phase) => phase.key === order.phase);
  const stopped = order.phase === 'stopped';

  return (
    <>
      <AppHeader />
      <main id="main" className="mx-auto max-w-2xl px-5 py-10">
        <Link href="/orders" className="text-sm text-graphite-600 underline">
          ← Your orders
        </Link>

        <header className="mt-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="text-3xl font-extrabold tracking-tight">{order.vendor.name}</h1>
              <p className="mt-1 font-mono text-sm text-graphite-400">{order.code}</p>
            </div>
            <Badge tone={stopped ? 'danger' : order.phase === 'complete' ? 'success' : 'gold'}>
              {order.statusLabel}
            </Badge>
          </div>
          {stillMoving ? (
            // Says what is actually happening rather than a decorative "live"
            // dot. When the socket is not connected this screen is still
            // correct — it is re-reading on a timer, which is what it always
            // did — and saying so is more use than implying otherwise.
            <p className="mt-2 text-xs text-graphite-400" aria-live="polite">
              {liveLabel(status, 10_000)}
            </p>
          ) : null}
        </header>

        {/* --- Progress ------------------------------------------------------ */}
        {!stopped ? (
          <ol className="mt-8 flex gap-2" aria-label="Order progress">
            {phases.map((phase, index) => {
              const done = index <= activePhaseIndex;
              const current = index === activePhaseIndex;
              return (
                <li key={phase.key} className="flex-1">
                  <div
                    className={`h-1.5 rounded-full ${done ? 'bg-gold-400' : 'bg-graphite-100'} ${
                      current && order.phase !== 'complete' ? 'dash-pulse' : ''
                    }`}
                  />
                  <p
                    className={`mt-2 text-xs ${done ? 'font-semibold' : 'text-graphite-400'}`}
                    aria-current={current ? 'step' : undefined}
                  >
                    {phase.label}
                  </p>
                </li>
              );
            })}
          </ol>
        ) : (
          <Card className="mt-6 border-coral-400/40 bg-coral-50 p-5">
            <p className="font-semibold text-coral-600">{order.statusLabel}</p>
            {order.cancellationReason ? (
              <p className="mt-1 text-sm text-graphite-600">{order.cancellationReason}</p>
            ) : null}
          </Card>
        )}

        {/* --- Refunds ------------------------------------------------------- */}
        {/* Worded by the server: "Refunded" only once Paystack has confirmed it. */}
        {(order.refunds ?? []).map((refund, index) => (
          <Card key={`${refund.createdAt}-${index}`} className="mt-6 p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-bold">Refund of {formatNaira(refund.amount)}</p>
              <Badge>{refund.label}</Badge>
            </div>
            <p className="mt-1 text-sm text-graphite-600" aria-live="polite">
              {refund.body}
            </p>
          </Card>
        ))}

        {/* --- Delivery PIN -------------------------------------------------- */}
        {pin && !stopped && order.phase !== 'complete' ? (
          <Card className="mt-6 border-gold-400 bg-gold-50 p-5 text-center">
            <p className="text-sm font-semibold text-gold-600">Your delivery code</p>
            <p className="mt-2 font-mono text-4xl font-extrabold tracking-[0.3em]">{pin}</p>
            <p className="mt-2 text-sm text-graphite-600">
              Read this to your rider when they arrive. They cannot complete the delivery without
              it.
            </p>
          </Card>
        ) : null}

        {/* --- Rider --------------------------------------------------------- */}
        {order.rider ? (
          <Card className="mt-6 p-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-sm text-graphite-400">Your rider</p>
                <p className="mt-0.5 font-bold">{order.rider.name}</p>
                <p className="text-sm capitalize text-graphite-600">
                  {order.rider.vehicleType.replace('_', ' ')}
                </p>
              </div>
              {order.rider.isStale ? (
                <Badge tone="warning">Signal lost</Badge>
              ) : (
                <Badge tone="success">Live</Badge>
              )}
            </div>
            {order.rider.isStale ? (
              <p className="mt-3 text-sm text-graphite-600">
                We have not had a location update recently. Your rider is still on the way — this
                usually means poor signal.
              </p>
            ) : order.rider.latitude !== null ? (
              <p className="mt-3 text-sm text-graphite-600">
                Last seen{' '}
                {order.rider.reportedAt
                  ? new Date(order.rider.reportedAt).toLocaleTimeString('en-NG', {
                      timeStyle: 'short',
                    })
                  : 'just now'}
                .
              </p>
            ) : null}
          </Card>
        ) : null}

        {/* --- Items --------------------------------------------------------- */}
        <section className="mt-8">
          <h2 className="text-lg font-bold">What you ordered</h2>
          <ul className="mt-3 space-y-2">
            {order.items.map((item, index) => (
              <li key={index} className="flex items-baseline justify-between gap-4 text-sm">
                <span>
                  {item.quantity}× {item.nameSnapshot}
                </span>
                <span className="shrink-0 font-semibold tabular-nums">
                  {formatNaira(item.lineTotal)}
                </span>
              </li>
            ))}
          </ul>
        </section>

        {/* --- Receipt ------------------------------------------------------- */}
        <section className="mt-8">
          <h2 className="text-lg font-bold">Receipt</h2>
          <Card className="mt-3 p-5">
            <dl className="space-y-2">
              {order.quoteBreakdown.lines.map((line, index) => (
                <div key={index} className="flex items-baseline justify-between gap-4 text-sm">
                  <dt>{line.label}</dt>
                  <dd
                    className={`shrink-0 font-semibold tabular-nums ${
                      line.amount < 0 ? 'text-emerald-600' : ''
                    }`}
                  >
                    {formatNaira(line.amount)}
                  </dd>
                </div>
              ))}
            </dl>
            <div className="mt-4 flex items-baseline justify-between border-t pt-4">
              <span className="font-bold">Total paid</span>
              <span className="text-lg font-extrabold tabular-nums">
                {formatNaira(order.total)}
              </span>
            </div>
          </Card>
        </section>

        {/* --- Timeline ------------------------------------------------------ */}
        <section className="mt-8">
          <h2 className="text-lg font-bold">Timeline</h2>
          <ol className="mt-3 space-y-2">
            {order.statusEvents.map((event, index) => (
              <li key={index} className="flex items-baseline justify-between gap-4 text-sm">
                <span className="capitalize">{event.toStatus.replace(/_/g, ' ')}</span>
                <span className="shrink-0 text-graphite-400">
                  {new Date(event.createdAt).toLocaleTimeString('en-NG', { timeStyle: 'short' })}
                </span>
              </li>
            ))}
          </ol>
        </section>

        {/* --- Cancellation --------------------------------------------------- */}
        {cancellation ? (
          <section className="mt-10 border-t pt-6">
            {cancellation.allowed ? (
              <>
                <p className="text-sm text-graphite-600">{cancellation.explanation}</p>
                <Button
                  variant="danger"
                  className="mt-3"
                  disabled={cancelling}
                  onClick={() => setConfirmingCancel(true)}
                >
                  {cancelling ? 'Cancelling…' : 'Cancel this order'}
                </Button>
              </>
            ) : (
              <EstimateNote>{cancellation.explanation}</EstimateNote>
            )}
          </section>
        ) : null}
      </main>

      {confirmingCancel && cancellation ? (
        <Modal
          title="Cancel this order?"
          onClose={() => setConfirmingCancel(false)}
          labelledBy="cancel-title"
        >
          <p className="text-sm text-[var(--ink-muted)]">{cancellation.explanation}</p>

          {cancelError ? (
            <p role="alert" className="mt-3 text-sm font-medium text-coral-600">
              {cancelError}
            </p>
          ) : null}

          <div className="mt-5 flex gap-2">
            <Button
              variant="ghost"
              className="flex-1"
              disabled={cancelling}
              onClick={() => setConfirmingCancel(false)}
            >
              Keep my order
            </Button>
            <Button
              variant="danger"
              className="flex-1"
              disabled={cancelling}
              onClick={() => {
                setCancelling(true);
                setCancelError(null);
                void authedFetch(`/v1/orders/${params.id}/cancel`, { method: 'POST', body: {} })
                  .then(async () => {
                    await load();
                    setConfirmingCancel(false);
                  })
                  .catch((caught: unknown) => {
                    // Kept open on failure. A cancellation that silently did
                    // not happen is the one error a customer must not miss.
                    setCancelError(
                      caught instanceof ApiRequestError
                        ? caught.message
                        : 'We could not cancel that. Please try again.',
                    );
                  })
                  .finally(() => setCancelling(false));
              }}
            >
              {cancelling ? 'Cancelling…' : 'Yes, cancel'}
            </Button>
          </div>
        </Modal>
      ) : null}
    </>
  );
}
