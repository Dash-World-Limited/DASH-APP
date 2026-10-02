'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

import { Button } from '@/components/ui';
import { ApiRequestError } from '@/lib/api';
import { authedFetch, useHasSession, useMe, usePermissions } from '@/lib/session';

interface RiderApplication {
  riderId: string;
  vehicleType: string;
  status: { code: string; label: string };
}
interface VendorApplication {
  vendorId: string;
  businessName: string;
  status: { code: string; label: string };
}
interface LiveOrder {
  id: string;
  alerts: string[];
  rider: { id: string } | null;
}

function Metric({
  label,
  value,
  detail,
  tone = 'default',
}: {
  label: string;
  value: number | string;
  detail: string;
  tone?: 'default' | 'gold' | 'danger' | 'success';
}) {
  const toneClass =
    tone === 'gold'
      ? 'text-[var(--primary)]'
      : tone === 'danger'
        ? 'text-[var(--danger)]'
        : tone === 'success'
          ? 'text-[var(--success)]'
          : 'text-[var(--ink)]';
  return (
    <div className="admin-card rounded-2xl p-5">
      <p className="text-xs font-bold uppercase tracking-[0.12em] text-[var(--ink-muted)]">{label}</p>
      <p className={'mt-2 text-3xl font-extrabold tracking-tight ' + toneClass}>{value}</p>
      <p className="mt-1 text-xs leading-5 text-[var(--ink-muted)]">{detail}</p>
    </div>
  );
}

export default function AdminOverviewPage() {
  const signedIn = useHasSession();
  const { me, loaded: meLoaded } = useMe();
  const { permissions, loaded: permissionsLoaded } = usePermissions();
  const [pendingRiders, setPendingRiders] = useState<number | null>(null);
  const [pendingVendors, setPendingVendors] = useState<number | null>(null);
  const [orders, setOrders] = useState<LiveOrder[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!signedIn || !permissionsLoaded) return;
    setError(null);
    try {
      const jobs: Promise<void>[] = [];
      if (permissions.has('admin:rider:approve')) {
        jobs.push(
          authedFetch<{ applications: RiderApplication[] }>('/v1/admin/rider-applications?status=pending&limit=100')
            .then((result) => setPendingRiders(result.applications.length)),
        );
      } else setPendingRiders(0);

      if (permissions.has('admin:vendor:approve')) {
        jobs.push(
          authedFetch<{ applications: VendorApplication[] }>('/v1/admin/vendor-applications?status=pending&limit=100')
            .then((result) => setPendingVendors(result.applications.length)),
        );
      } else setPendingVendors(0);

      jobs.push(
        authedFetch<{ orders: LiveOrder[] }>('/v1/ops/live')
          .then((result) => setOrders(result.orders))
          .catch(() => setOrders([])),
      );

      await Promise.all(jobs);
    } catch (caught) {
      setError(caught instanceof ApiRequestError ? caught.message : 'Could not load the Super Admin overview.');
    }
  }, [permissions, permissionsLoaded, signedIn]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!signedIn && meLoaded) {
    return (
      <section className="mx-auto max-w-3xl px-5 py-16">
        <div className="admin-card rounded-3xl p-8 text-center">
          <p className="admin-kicker">Restricted</p>
          <h1 className="mt-3 text-3xl font-extrabold tracking-tight">Super Admin sign-in required</h1>
          <p className="mx-auto mt-3 max-w-lg text-sm leading-6 text-[var(--ink-muted)]">
            This surface can approve partners, inspect live operations and perform audited actions.
          </p>
          <Link href="/signin?next=/admin" className="mt-6 inline-block">
            <Button size="lg">Sign in securely</Button>
          </Link>
        </div>
      </section>
    );
  }

  const flagged = orders?.filter((order) => order.alerts.length > 0).length ?? 0;
  const unassigned = orders?.filter((order) => !order.rider).length ?? 0;
  const firstName = me?.identity.displayName?.split(/\s+/)[0] ?? 'Director';

  return (
    <div className="admin-grid-glow min-h-[calc(100vh-4.5rem)] px-4 py-6 sm:px-6 sm:py-8 xl:px-8">
      <div className="mx-auto max-w-7xl">
        <section className="overflow-hidden rounded-3xl bg-[var(--ink)] text-[var(--ink-inverted)] shadow-2xl">
          <div className="relative px-6 py-8 sm:px-8 sm:py-10">
            <div className="absolute -right-24 -top-24 h-64 w-64 rounded-full bg-[var(--primary)]/20 blur-3xl" />
            <div className="relative max-w-3xl">
              <p className="text-xs font-extrabold uppercase tracking-[0.18em] text-[var(--primary)]">DASH Control Centre</p>
              <h1 className="mt-3 text-3xl font-extrabold tracking-[-0.035em] sm:text-4xl">
                Welcome back, {firstName}.
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-6 opacity-70 sm:text-base">
                One place to approve partners, watch live operations and keep the platform healthy.
              </p>
              <div className="mt-6 flex flex-wrap gap-3">
                <Link href="/admin/partners" className="rounded-xl bg-[var(--primary)] px-4 py-2.5 text-sm font-extrabold text-[var(--on-primary)] transition hover:opacity-90">
                  Review applications
                </Link>
                <Link href="/ops" className="rounded-xl border border-white/15 bg-white/[0.06] px-4 py-2.5 text-sm font-bold text-white transition hover:bg-white/10">
                  Open live operations
                </Link>
              </div>
            </div>
          </div>
        </section>

        <section className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Platform snapshot">
          <Metric label="Pending riders" value={pendingRiders ?? '—'} detail="Waiting for administrator review" tone="gold" />
          <Metric label="Pending vendors" value={pendingVendors ?? '—'} detail="Businesses waiting to go live" />
          <Metric label="Active orders" value={orders?.length ?? '—'} detail={unassigned ? `${unassigned} currently unassigned` : 'Dispatch queue is covered'} tone={unassigned ? 'danger' : 'success'} />
          <Metric label="Operational alerts" value={orders === null ? '—' : flagged} detail={flagged ? 'Needs attention on the live board' : 'No live-order alerts'} tone={flagged ? 'danger' : 'success'} />
        </section>

        {error ? (
          <div role="alert" className="mt-5 rounded-2xl border border-[var(--danger)]/25 bg-[var(--danger-soft)] px-5 py-4 text-sm font-semibold text-[var(--danger)]">
            {error}
          </div>
        ) : null}

        <section className="mt-7 grid gap-5 xl:grid-cols-[1.35fr_0.65fr]">
          <div className="admin-card rounded-3xl p-5 sm:p-6">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="admin-kicker">Action queue</p>
                <h2 className="mt-1 text-xl font-extrabold tracking-tight">What needs you</h2>
              </div>
              <button type="button" onClick={() => void load()} className="rounded-xl border border-[var(--line)] px-3 py-2 text-xs font-bold text-[var(--ink-muted)] hover:text-[var(--ink)]">
                Refresh
              </button>
            </div>

            <div className="mt-5 divide-y divide-[var(--line)]">
              <Link href="/admin/partners?tab=riders" className="flex items-center gap-4 py-4 first:pt-0">
                <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-[var(--primary-soft)] text-[var(--primary)]">
                  <span className="text-lg font-extrabold">{pendingRiders ?? '·'}</span>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="font-bold">Rider applications</p>
                  <p className="mt-0.5 text-sm text-[var(--ink-muted)]">Identity, vehicle and approval queue</p>
                </div>
                <span className="text-xl text-[var(--ink-muted)]">→</span>
              </Link>

              <Link href="/admin/partners?tab=vendors" className="flex items-center gap-4 py-4">
                <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-[var(--surface-sunken)] text-[var(--ink)]">
                  <span className="text-lg font-extrabold">{pendingVendors ?? '·'}</span>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="font-bold">Vendor applications</p>
                  <p className="mt-0.5 text-sm text-[var(--ink-muted)]">Approve stores before they enter the marketplace</p>
                </div>
                <span className="text-xl text-[var(--ink-muted)]">→</span>
              </Link>

              <Link href="/ops/refunds" className="flex items-center gap-4 py-4 last:pb-0">
                <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-[var(--surface-sunken)] text-[var(--ink)]">₦</div>
                <div className="min-w-0 flex-1">
                  <p className="font-bold">Finance & refunds</p>
                  <p className="mt-0.5 text-sm text-[var(--ink-muted)]">Review payment cases with audit protection</p>
                </div>
                <span className="text-xl text-[var(--ink-muted)]">→</span>
              </Link>
            </div>
          </div>

          <aside className="admin-card rounded-3xl p-5 sm:p-6">
            <p className="admin-kicker">Security</p>
            <h2 className="mt-1 text-xl font-extrabold tracking-tight">Protected by design</h2>
            <div className="mt-5 space-y-4">
              {[
                ['MFA step-up', 'Sensitive approvals require a recent second factor.'],
                ['Permission scoped', 'The API decides what every admin can actually do.'],
                ['Audit trail', 'Partner decisions and operational actions are recorded.'],
              ].map(([title, body]) => (
                <div key={title} className="flex gap-3">
                  <div className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full bg-[var(--primary)]" />
                  <div>
                    <p className="text-sm font-bold">{title}</p>
                    <p className="mt-0.5 text-xs leading-5 text-[var(--ink-muted)]">{body}</p>
                  </div>
                </div>
              ))}
            </div>
          </aside>
        </section>
      </div>
    </div>
  );
}
