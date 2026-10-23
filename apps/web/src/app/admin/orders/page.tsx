'use client';

/**
 * Order lookup: the full historical record of one order, by its code.
 *
 * Everything shown is what the order froze when it was placed — item names
 * and prices, the delivery address, the seller's name — so a renamed product
 * or an edited address never rewrites history. Where the live product has
 * changed since, it is shown beside the snapshot, never instead of it.
 */

import Link from 'next/link';
import { type FormEvent, useState } from 'react';

import { formatNaira } from '@/components/ui';
import { ApiRequestError } from '@/lib/api';
import { authedFetch, useHasSession, usePermissions } from '@/lib/session';

interface HistoricalOrder {
  id: string;
  code: string;
  status: string;
  statusLabel: string;
  mode: string;
  vendor: { id: string; name: string; currentName: string };
  branch: { name: string; address: string };
  customer: { id: string; name: string | null; email: string | null; phone: string | null };
  rider: { id: string; name: string | null; phone: string | null; vehicleType: string } | null;
  deliveryAddress: { label: string | null; line1: string; landmark: string | null; instructions: string | null; contactPhone: string } | null;
  deliveryAddressFrozen: boolean;
  items: Array<{
    name: string;
    unitPrice: number;
    quantity: number;
    modifiers: Array<{ name: string; priceDelta: number }>;
    lineTotal: number;
    instructions: string | null;
    stillListed: boolean;
    currentName: string | null;
  }>;
  totals: Record<'itemsSubtotal' | 'discountTotal' | 'deliveryFee' | 'serviceFee' | 'smallOrderFee' | 'surgeAmount' | 'tax' | 'tip' | 'walletApplied' | 'total', number>;
  timestamps: Record<'createdAt' | 'placedAt' | 'acceptedAt' | 'readyAt' | 'pickedUpAt' | 'deliveredAt' | 'cancelledAt', string | null>;
  cancellation: { reason: string | null; by: string | null; byName: string | null; byRoles: string[]; at: string } | null;
  payments: Array<{ provider: string; method: string; status: string; amount: number; createdAt: string; capturedAt: string | null; refunds: Array<{ amount: number; status: string }> }>;
  statusEvents: Array<{ fromStatus: string | null; toStatus: string; actorType: string; reasonCode: string | null; reason: string | null; createdAt: string }>;
  riderSearch: 'finding' | 'finding_another' | null;
  refundReview: { state: 'required' | 'refund_recorded'; flaggedAt: string | null; capturedAmount: number } | null;
  dispatchOffers: Array<{
    id: string;
    round: number;
    status: string;
    createdAt: string;
    expiresAt: string;
    respondedAt: string | null;
    declineReason: string | null;
    rider: { id: string; name: string | null };
  }>;
  riderRating: { rating: number; comment: string | null } | null;
}

const FEE_LABELS: Array<[keyof HistoricalOrder['totals'], string]> = [
  ['itemsSubtotal', 'Items'],
  ['discountTotal', 'Discount'],
  ['deliveryFee', 'Delivery fee'],
  ['serviceFee', 'Service fee'],
  ['smallOrderFee', 'Small order fee'],
  ['surgeAmount', 'Busy-period fee'],
  ['tax', 'Tax'],
  ['tip', 'Rider tip'],
  ['walletApplied', 'Wallet applied'],
];

const when = (value: string | null) => (value ? new Date(value).toLocaleString() : '—');

export default function AdminOrdersPage() {
  const signedIn = useHasSession();
  const { permissions, loaded } = usePermissions();
  const allowed = permissions.has('ops:order:read:all');
  const [ref, setRef] = useState('');
  const [order, setOrder] = useState<HistoricalOrder | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const search = async (event: FormEvent) => {
    event.preventDefault();
    const wanted = ref.trim();
    if (!wanted || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await authedFetch<{ order: HistoricalOrder }>(`/v1/admin/orders/${encodeURIComponent(wanted)}`);
      setOrder(result.order);
    } catch (caught) {
      setOrder(null);
      setError(
        caught instanceof ApiRequestError && caught.status === 404
          ? `No order matches “${wanted}”.`
          : caught instanceof ApiRequestError
            ? caught.message
            : 'Could not load that order.',
      );
    } finally {
      setBusy(false);
    }
  };

  if (!signedIn && loaded) {
    return (
      <div className="mx-auto max-w-3xl px-5 py-16">
        <div className="admin-card rounded-3xl p-8 text-center">
          <h1 className="text-2xl font-extrabold">Staff sign-in required</h1>
          <Link href="/admin/signin" className="mt-5 inline-flex rounded-xl bg-[var(--primary)] px-4 py-2.5 text-sm font-extrabold text-[var(--on-primary)]">
            Sign in
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[calc(100vh-4.5rem)] px-4 py-6 sm:px-6 sm:py-8 xl:px-8">
      <div className="mx-auto max-w-5xl">
        <p className="admin-kicker">Order history</p>
        <h1 className="mt-1 text-3xl font-extrabold tracking-[-0.03em]">Find an order</h1>
        <p className="mt-2 text-sm text-[var(--ink-muted)]">Shows the order exactly as it was placed: items, prices, address and seller.</p>

        {loaded && !allowed ? (
          <div className="admin-card mt-6 rounded-3xl p-8 text-sm text-[var(--ink-muted)]">This account cannot read orders.</div>
        ) : (
          <form onSubmit={(event) => void search(event)} className="mt-6 flex flex-wrap gap-3">
            <input
              value={ref}
              onChange={(event) => setRef(event.target.value)}
              placeholder="DASH-AB12CD"
              aria-label="Order code or id"
              className="min-h-12 flex-1 rounded-xl border border-[var(--line)] bg-[var(--surface-raised)] px-4 text-sm font-semibold"
            />
            <button type="submit" disabled={busy || !ref.trim()} className="min-h-12 rounded-xl bg-[var(--primary)] px-5 text-sm font-extrabold text-[var(--on-primary)] disabled:opacity-50">
              {busy ? 'Searching…' : 'Find order'}
            </button>
          </form>
        )}

        {error ? <div className="mt-5 rounded-2xl bg-[var(--danger-soft)] px-5 py-4 text-sm font-semibold text-[var(--danger)]">{error}</div> : null}

        {order ? (
          <div className="mt-6 grid gap-4 lg:grid-cols-2">
            <section className="admin-card rounded-3xl p-5 sm:p-6 lg:col-span-2">
              <div className="flex flex-wrap items-center gap-3">
                <h2 className="text-2xl font-extrabold">{order.code}</h2>
                <span className="rounded-full bg-[var(--primary-soft)] px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-wide text-[var(--primary)]">{order.statusLabel}</span>
                <span className="text-xs text-[var(--ink-muted)]">{order.mode}</span>
              </div>
              <p className="mt-2 text-sm">
                <strong>{order.vendor.name}</strong> · {order.branch.name}
                {order.vendor.currentName !== order.vendor.name ? <span className="text-[var(--ink-muted)]"> (now trading as {order.vendor.currentName})</span> : null}
              </p>
            </section>

            <section className="admin-card rounded-3xl p-5 sm:p-6">
              <h3 className="text-sm font-extrabold uppercase tracking-wide text-[var(--ink-muted)]">Items as purchased</h3>
              <ul className="mt-3 divide-y divide-[var(--line)] text-sm">
                {order.items.map((item, index) => (
                  <li key={`${item.name}-${index}`} className="py-2">
                    <div className="flex justify-between gap-3">
                      <span><strong>{item.quantity}×</strong> {item.name} <span className="text-[var(--ink-muted)]">@ {formatNaira(item.unitPrice)}</span></span>
                      <strong>{formatNaira(item.lineTotal)}</strong>
                    </div>
                    {item.modifiers.length ? <p className="text-xs text-[var(--ink-muted)]">{item.modifiers.map((modifier) => modifier.name).join(', ')}</p> : null}
                    {item.instructions ? <p className="text-xs text-[var(--ink-muted)]">“{item.instructions}”</p> : null}
                    {!item.stillListed ? <p className="text-xs text-[var(--ink-muted)]">No longer on the menu</p> : item.currentName && item.currentName !== item.name ? <p className="text-xs text-[var(--ink-muted)]">Now listed as {item.currentName}</p> : null}
                  </li>
                ))}
              </ul>
              <dl className="mt-3 space-y-1 border-t border-[var(--line)] pt-3 text-sm">
                {FEE_LABELS.filter(([key]) => key === 'itemsSubtotal' || key === 'deliveryFee' || order.totals[key] > 0).map(([key, label]) => (
                  <div key={key} className="flex justify-between"><dt className="text-[var(--ink-muted)]">{label}</dt><dd>{key === 'discountTotal' || key === 'walletApplied' ? '−' : ''}{formatNaira(order.totals[key])}</dd></div>
                ))}
                <div className="flex justify-between font-extrabold"><dt>Total</dt><dd>{formatNaira(order.totals.total)}</dd></div>
              </dl>
            </section>

            <section className="admin-card rounded-3xl p-5 sm:p-6 text-sm">
              <h3 className="text-sm font-extrabold uppercase tracking-wide text-[var(--ink-muted)]">People and place</h3>
              <dl className="mt-3 space-y-3">
                <div><dt className="text-xs text-[var(--ink-muted)]">Customer</dt><dd className="font-bold">{order.customer.name ?? 'Unnamed'}</dd><dd className="text-xs">{[order.customer.email, order.customer.phone].filter(Boolean).join(' · ')}</dd></div>
                <div><dt className="text-xs text-[var(--ink-muted)]">Rider</dt><dd className="font-bold">{order.rider ? order.rider.name ?? 'Unnamed rider' : order.riderSearch === 'finding_another' ? 'No rider — finding another' : order.riderSearch === 'finding' ? 'No rider — finding one' : 'No rider'}</dd>{order.rider ? <dd className="text-xs">{[order.rider.phone, order.rider.vehicleType].filter(Boolean).join(' · ')}</dd> : null}</div>
                <div>
                  <dt className="text-xs text-[var(--ink-muted)]">Delivered to {order.deliveryAddressFrozen ? '(as placed)' : '(saved address — order predates snapshots)'}</dt>
                  {order.deliveryAddress ? (
                    <>
                      <dd className="font-bold">{order.deliveryAddress.line1}</dd>
                      <dd className="text-xs">{[order.deliveryAddress.landmark, order.deliveryAddress.instructions, order.deliveryAddress.contactPhone].filter(Boolean).join(' · ')}</dd>
                    </>
                  ) : <dd>Pickup / none</dd>}
                </div>
                {order.riderRating ? <div><dt className="text-xs text-[var(--ink-muted)]">Rider rating</dt><dd className="font-bold">{'★'.repeat(order.riderRating.rating)}{order.riderRating.comment ? ` · “${order.riderRating.comment}”` : ''}</dd></div> : null}
              </dl>
            </section>

            <section className="admin-card rounded-3xl p-5 sm:p-6 text-sm">
              <h3 className="text-sm font-extrabold uppercase tracking-wide text-[var(--ink-muted)]">Timeline</h3>
              <dl className="mt-3 grid grid-cols-2 gap-2">
                {(Object.keys(order.timestamps) as Array<keyof HistoricalOrder['timestamps']>).filter((key) => order.timestamps[key]).map((key) => (
                  <div key={key}><dt className="text-xs text-[var(--ink-muted)]">{key.replace(/At$/, '')}</dt><dd className="font-bold">{when(order.timestamps[key])}</dd></div>
                ))}
              </dl>
              {order.cancellation ? (
                <p className="mt-3 text-xs">
                  Cancelled {when(order.cancellation.at)} by <strong>{order.cancellation.byName ?? order.cancellation.by ?? 'unknown'}</strong>
                  {order.cancellation.byRoles.length ? ` (${order.cancellation.byRoles.join(', ').replace(/_/g, ' ')})` : ''}: {order.cancellation.reason ?? 'no reason recorded'}
                </p>
              ) : null}
              <ol className="mt-3 space-y-1 border-t border-[var(--line)] pt-3 text-xs">
                {order.statusEvents.map((event, index) => (
                  <li key={index}>
                    {when(event.createdAt)} — {event.fromStatus ?? 'start'} → <strong>{event.toStatus}</strong> ({event.actorType})
                    {event.reasonCode ? <span className="text-[var(--ink-muted)]"> · {event.reasonCode}{event.reason ? `: ${event.reason}` : ''}</span> : null}
                  </li>
                ))}
              </ol>
            </section>

            {order.refundReview ? (
              <section
                role={order.refundReview.state === 'required' ? 'alert' : 'status'}
                className={`admin-card rounded-3xl p-5 sm:p-6 text-sm ${order.refundReview.state === 'required' ? 'border-2 border-coral-400' : ''}`}
              >
                <h3 className="text-sm font-extrabold uppercase tracking-wide text-[var(--ink-muted)]">
                  {order.refundReview.state === 'required' ? 'Refund review required' : 'Refund recorded'}
                </h3>
                <p className="mt-2">
                  {order.refundReview.state === 'required'
                    ? `Staff cancelled this order after ${formatNaira(order.refundReview.capturedAmount)} was captured. No refund has been decided. Record the refund (or its amount) in the finance refund flow.`
                    : 'A refund has been recorded for this staff-cancelled order. Follow it in Refunds.'}
                </p>
                {order.refundReview.flaggedAt ? <p className="mt-1 text-xs text-[var(--ink-muted)]">Flagged {when(order.refundReview.flaggedAt)}</p> : null}
              </section>
            ) : null}

            <section className="admin-card rounded-3xl p-5 sm:p-6 text-sm">
              <h3 className="text-sm font-extrabold uppercase tracking-wide text-[var(--ink-muted)]">Rider offers</h3>
              {order.dispatchOffers.length === 0 ? <p className="mt-3 text-[var(--ink-muted)]">No rider has been offered this order.</p> : null}
              <ol className="mt-3 space-y-1 text-xs">
                {order.dispatchOffers.map((offer) => (
                  <li key={offer.id}>
                    Round {offer.round} · <strong>{offer.rider.name ?? 'Unnamed rider'}</strong> · {offer.status}
                    <span className="text-[var(--ink-muted)]"> · offered {when(offer.createdAt)}{offer.respondedAt ? ` · answered ${when(offer.respondedAt)}` : ''}{offer.declineReason ? ` · “${offer.declineReason}”` : ''}</span>
                  </li>
                ))}
              </ol>
            </section>

            <section className="admin-card rounded-3xl p-5 sm:p-6 text-sm">
              <h3 className="text-sm font-extrabold uppercase tracking-wide text-[var(--ink-muted)]">Payments</h3>
              {order.payments.length === 0 ? <p className="mt-3 text-[var(--ink-muted)]">No payments recorded.</p> : null}
              <ul className="mt-3 space-y-2">
                {order.payments.map((payment, index) => (
                  <li key={index}>
                    <strong>{formatNaira(payment.amount)}</strong> · {payment.method} via {payment.provider} · {payment.status}
                    {payment.refunds.length ? <span className="text-xs text-[var(--ink-muted)]"> · refunds: {payment.refunds.map((refund) => `${formatNaira(refund.amount)} ${refund.status}`).join(', ')}</span> : null}
                  </li>
                ))}
              </ul>
            </section>
          </div>
        ) : null}
      </div>
    </div>
  );
}
