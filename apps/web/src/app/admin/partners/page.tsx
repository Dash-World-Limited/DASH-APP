'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';

import { useStepUp } from '@/components/StepUpPrompt';
import { ApiRequestError } from '@/lib/api';
import { authedFetch, useHasSession, usePermissions } from '@/lib/session';

interface PhoneStatus {
  number: string | null;
  verification: 'unverified';
  notice: string | null;
}
interface RiderApplication {
  riderId: string;
  vehicleType: string;
  vehiclePlate: string | null;
  status: { code: string; label: string };
  submittedAt: string;
  applicant: {
    identityId: string;
    name: string | null;
    email: string | null;
    phone: PhoneStatus;
  };
}
interface VendorApplication {
  vendorId: string;
  businessName: string;
  category: string;
  status: { code: string; label: string };
  submittedAt: string;
  city: { slug: string; name: string };
  owner: { name: string | null; email: string | null } | null;
}

function PartnerQueue() {
  const params = useSearchParams();
  const requested = params.get('tab');
  const [tab, setTab] = useState<'riders' | 'vendors'>(requested === 'vendors' ? 'vendors' : 'riders');
  const signedIn = useHasSession();
  const { permissions, loaded } = usePermissions();
  const canRiders = permissions.has('admin:rider:approve');
  const canVendors = permissions.has('admin:vendor:approve');
  const [riders, setRiders] = useState<RiderApplication[] | null>(null);
  const [vendors, setVendors] = useState<VendorApplication[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { run: runStepUp, prompt: stepUpPrompt } = useStepUp();

  const load = useCallback(async () => {
    if (!signedIn || !loaded) return;
    setError(null);
    try {
      if (canRiders) {
        const result = await runStepUp(() =>
          authedFetch<{ applications: RiderApplication[] }>('/v1/admin/rider-applications?status=pending&limit=100'),
        );
        if (result) setRiders(result.applications);
      } else setRiders([]);
      if (canVendors) {
        const result = await runStepUp(() =>
          authedFetch<{ applications: VendorApplication[] }>('/v1/admin/vendor-applications?status=pending&limit=100'),
        );
        if (result) setVendors(result.applications);
      } else setVendors([]);
    } catch (caught) {
      setError(caught instanceof ApiRequestError ? caught.message : 'Could not load partner applications.');
    }
  }, [canRiders, canVendors, loaded, runStepUp, signedIn]);

  useEffect(() => {
    void load();
  }, [load]);

  const approve = async (kind: 'rider' | 'vendor', id: string, label: string) => {
    setBusyId(id);
    setError(null);
    setNotice(null);
    try {
      const path = kind === 'rider'
        ? `/v1/admin/riders/${id}/decision`
        : `/v1/admin/vendors/${id}/decision`;
      const result = await runStepUp(() =>
        authedFetch(path, { method: 'POST', body: { decision: 'approve' } }),
      );
      if (result !== undefined) {
        setNotice(`${label} approved. Their DASH access will update from the server.`);
        await load();
      }
    } catch (caught) {
      setError(caught instanceof ApiRequestError ? caught.message : 'The approval did not go through.');
    } finally {
      setBusyId(null);
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

  const rows = tab === 'riders' ? riders : vendors;

  return (
    <div className="min-h-[calc(100vh-4.5rem)] px-4 py-6 sm:px-6 sm:py-8 xl:px-8">
      <div className="mx-auto max-w-7xl">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="admin-kicker">Partner control</p>
            <h1 className="mt-1 text-3xl font-extrabold tracking-[-0.03em]">Applications</h1>
            <p className="mt-2 text-sm text-[var(--ink-muted)]">Approve only after the applicant has passed the checks you require.</p>
          </div>
          <Link href="/ops/partners" className="rounded-xl border border-[var(--line)] bg-[var(--surface-raised)] px-4 py-2.5 text-xs font-bold text-[var(--ink-muted)] hover:text-[var(--ink)]">
            Open full review tools
          </Link>
        </div>

        <div className="mt-6 inline-flex rounded-xl bg-[var(--surface-sunken)] p-1">
          {(['riders', 'vendors'] as const).map((value) => {
            const allowed = value === 'riders' ? canRiders : canVendors;
            return (
              <button
                key={value}
                type="button"
                disabled={!allowed}
                onClick={() => setTab(value)}
                className={
                  'min-w-28 rounded-lg px-4 py-2.5 text-sm font-bold capitalize transition ' +
                  (tab === value ? 'bg-[var(--ink)] text-[var(--ink-inverted)]' : 'text-[var(--ink-muted)]') +
                  (!allowed ? ' opacity-40' : '')
                }
              >
                {value}
              </button>
            );
          })}
        </div>

        {notice ? <div className="mt-5 rounded-2xl bg-[var(--success-soft)] px-5 py-4 text-sm font-semibold text-[var(--success)]">{notice}</div> : null}
        {error ? <div className="mt-5 rounded-2xl bg-[var(--danger-soft)] px-5 py-4 text-sm font-semibold text-[var(--danger)]">{error}</div> : null}

        <div className="mt-6">
          {rows === null ? (
            <div className="admin-card rounded-3xl p-8 text-center text-sm text-[var(--ink-muted)]">Loading applications…</div>
          ) : rows.length === 0 ? (
            <div className="admin-card rounded-3xl p-10 text-center">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--primary-soft)] text-xl text-[var(--primary)]">✓</div>
              <h2 className="mt-4 text-xl font-extrabold">Queue clear</h2>
              <p className="mt-2 text-sm text-[var(--ink-muted)]">There are no pending {tab} applications right now.</p>
            </div>
          ) : tab === 'riders' ? (
            <div className="grid gap-4 lg:grid-cols-2">
              {(riders ?? []).map((rider) => (
                <article key={rider.riderId} className="admin-card rounded-3xl p-5 sm:p-6">
                  <div className="flex items-start gap-4">
                    <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-[var(--primary-soft)] text-lg font-extrabold text-[var(--primary)]">
                      {(rider.applicant.name ?? 'R').slice(0, 1).toUpperCase()}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="truncate text-lg font-extrabold">{rider.applicant.name ?? 'Unnamed applicant'}</h2>
                        <span className="rounded-full bg-[var(--primary-soft)] px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-wide text-[var(--primary)]">Pending</span>
                      </div>
                      <p className="mt-1 truncate text-sm text-[var(--ink-muted)]">{rider.applicant.email ?? 'No email'}</p>
                    </div>
                  </div>

                  <dl className="mt-5 grid grid-cols-2 gap-3 rounded-2xl bg-[var(--surface-sunken)] p-4 text-sm">
                    <div><dt className="text-xs text-[var(--ink-muted)]">Vehicle</dt><dd className="mt-1 font-bold capitalize">{rider.vehicleType.replace(/_/g, ' ')}</dd></div>
                    <div><dt className="text-xs text-[var(--ink-muted)]">Plate</dt><dd className="mt-1 font-bold">{rider.vehiclePlate ?? 'Not supplied'}</dd></div>
                    <div><dt className="text-xs text-[var(--ink-muted)]">Phone</dt><dd className="mt-1 font-bold">{rider.applicant.phone.number ?? 'Not supplied'}</dd></div>
                    <div><dt className="text-xs text-[var(--ink-muted)]">Applied</dt><dd className="mt-1 font-bold">{new Date(rider.submittedAt).toLocaleDateString()}</dd></div>
                  </dl>

                  <button
                    type="button"
                    disabled={busyId === rider.riderId}
                    onClick={() => void approve('rider', rider.riderId, rider.applicant.name ?? 'Rider')}
                    className="mt-5 min-h-12 w-full rounded-xl bg-[var(--primary)] px-4 text-sm font-extrabold text-[var(--on-primary)] transition hover:bg-[var(--primary-hover)] disabled:opacity-50"
                  >
                    {busyId === rider.riderId ? 'Approving…' : 'Approve rider'}
                  </button>
                </article>
              ))}
            </div>
          ) : (
            <div className="grid gap-4 lg:grid-cols-2">
              {(vendors ?? []).map((vendor) => (
                <article key={vendor.vendorId} className="admin-card rounded-3xl p-5 sm:p-6">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <span className="rounded-full bg-[var(--primary-soft)] px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-wide text-[var(--primary)]">Pending</span>
                      <h2 className="mt-3 text-lg font-extrabold">{vendor.businessName}</h2>
                      <p className="mt-1 text-sm text-[var(--ink-muted)]">{vendor.owner?.name ?? vendor.owner?.email ?? 'Owner'}</p>
                    </div>
                    <div className="rounded-xl bg-[var(--surface-sunken)] px-3 py-2 text-xs font-bold capitalize">{vendor.category.replace(/_/g, ' ')}</div>
                  </div>
                  <div className="mt-5 rounded-2xl bg-[var(--surface-sunken)] p-4 text-sm">
                    <p className="text-xs text-[var(--ink-muted)]">City</p>
                    <p className="mt-1 font-bold">{vendor.city.name}</p>
                  </div>
                  <button
                    type="button"
                    disabled={busyId === vendor.vendorId}
                    onClick={() => void approve('vendor', vendor.vendorId, vendor.businessName)}
                    className="mt-5 min-h-12 w-full rounded-xl bg-[var(--primary)] px-4 text-sm font-extrabold text-[var(--on-primary)] transition hover:bg-[var(--primary-hover)] disabled:opacity-50"
                  >
                    {busyId === vendor.vendorId ? 'Approving…' : 'Approve vendor'}
                  </button>
                </article>
              ))}
            </div>
          )}
        </div>
      </div>
      {stepUpPrompt}
    </div>
  );
}

export default function AdminPartnersPage() {
  return (
    <Suspense fallback={<div className="p-8 text-sm text-[var(--ink-muted)]">Loading partner queue…</div>}>
      <PartnerQueue />
    </Suspense>
  );
}
