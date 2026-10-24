'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

import { AppHeader } from '@/components/AppHeader';
import { useStepUp } from '@/components/StepUpPrompt';
import { Badge, Button, Card, EmptyState, ErrorState, Input, LoadingBlock } from '@/components/ui';
import { ApiRequestError } from '@/lib/api';
import { authedFetch, useHasSession, usePermissions } from '@/lib/session';

/**
 * Vendor and rider applications.
 *
 * The founder approves every early vendor and rider personally. Approval is
 * the only thing that grants the vendor or rider role; suspension withdraws
 * it on the next request. Every decision needs a recent step-up and is
 * audited on the server. Phone numbers are shown with the server's own
 * words, which never call a phone verified.
 */

type Status = 'pending' | 'approved' | 'rejected' | 'suspended' | 'all';
type Decision = 'approve' | 'reject' | 'suspend' | 'reinstate';

interface PhoneStatus {
  number: string | null;
  verification: 'unverified';
  notice: string | null;
}

interface VendorApplication {
  vendorId: string;
  businessName: string;
  category: string;
  description: string | null;
  city: { slug: string; name: string };
  status: { code: string; label: string };
  reason: string | null;
  submittedAt: string;
  branch: { address: string; latitude: number; longitude: number; insideServiceArea: boolean; phone: string | null } | null;
  owner: { identityId: string; name: string | null; email: string | null; phone: PhoneStatus } | null;
}

interface RiderApplication {
  riderId: string;
  vehicleType: string;
  vehiclePlate: string | null;
  status: { code: string; label: string };
  submittedAt: string;
  applicant: { identityId: string; name: string | null; email: string | null; phone: PhoneStatus };
}

/** What a decision may follow from, mirroring the server's rules. */
const DECISIONS_FROM: Record<string, Decision[]> = {
  pending_admin_approval: ['approve', 'reject'],
  approved: ['suspend'],
  suspended: ['reinstate'],
  rejected: [],
};

const NEEDS_REASON: ReadonlySet<Decision> = new Set(['reject', 'suspend']);

function messageFor(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  return 'Something went wrong. Try again.';
}

export default function PartnersPage() {
  const hasSession = useHasSession();
  const { permissions, loaded } = usePermissions();
  const [tab, setTab] = useState<'vendors' | 'riders'>('vendors');
  const canVendors = permissions.has('admin:vendor:approve');
  const canRiders = permissions.has('admin:rider:approve');

  if (!hasSession) {
    return (
      <div className="min-h-dvh">
        <AppHeader />
        <main className="mx-auto max-w-5xl px-4 py-10">
          <EmptyState title="Sign in to continue" description="Partner approvals are for DASH staff." action={<Link href="/signin"><Button>Sign in</Button></Link>} />
        </main>
      </div>
    );
  }

  if (loaded && !canVendors && !canRiders) {
    return (
      <div className="min-h-dvh">
        <AppHeader />
        <main className="mx-auto max-w-5xl px-4 py-10">
          <EmptyState title="No access" description="Your account cannot approve vendors or riders." />
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-dvh">
      <AppHeader />
      <main className="mx-auto max-w-5xl space-y-6 px-4 py-8">
        <header className="space-y-1">
          <h1 className="text-2xl font-bold">Partner approvals</h1>
          <p className="text-sm text-[var(--ink-muted)]">
            Vendors and riders who applied. Approval grants access; suspension withdraws it immediately.
          </p>
        </header>
        <nav className="flex gap-2" aria-label="Sections">
          {canVendors ? (
            <Button variant={tab === 'vendors' ? 'primary' : 'secondary'} size="sm" onClick={() => setTab('vendors')} aria-current={tab === 'vendors' ? 'page' : undefined}>
              Vendors
            </Button>
          ) : null}
          {canRiders ? (
            <Button variant={tab === 'riders' ? 'primary' : 'secondary'} size="sm" onClick={() => setTab('riders')} aria-current={tab === 'riders' ? 'page' : undefined}>
              Riders
            </Button>
          ) : null}
        </nav>
        {tab === 'vendors' && canVendors ? <Queue kind="vendors" /> : null}
        {tab === 'riders' && canRiders ? <Queue kind="riders" /> : null}
      </main>
    </div>
  );
}

function Queue({ kind }: { kind: 'vendors' | 'riders' }) {
  const [status, setStatus] = useState<Status>('pending');
  const [vendors, setVendors] = useState<VendorApplication[] | null>(null);
  const [riders, setRiders] = useState<RiderApplication[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { run, prompt } = useStepUp();

  const load = useCallback(async () => {
    setError(null);
    try {
      // Listing is step-up gated too: it shows applicants' contact details.
      if (kind === 'vendors') {
        const data = await run(() => authedFetch<{ applications: VendorApplication[] }>(`/v1/admin/vendor-applications?status=${status}&limit=100`));
        if (data) setVendors(data.applications);
      } else {
        const data = await run(() => authedFetch<{ applications: RiderApplication[] }>(`/v1/admin/rider-applications?status=${status}&limit=100`));
        if (data) setRiders(data.applications);
      }
    } catch (caught) {
      setError(messageFor(caught));
    }
  }, [kind, status, run]);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = kind === 'vendors' ? vendors : riders;

  return (
    <section className="space-y-4">
      {prompt}
      <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by status">
        {(['pending', 'approved', 'suspended', 'rejected', 'all'] as Status[]).map((value) => (
          <Button key={value} size="sm" variant={status === value ? 'primary' : 'ghost'} onClick={() => setStatus(value)} aria-pressed={status === value}>
            {value === 'pending' ? 'Pending approval' : value[0]!.toUpperCase() + value.slice(1)}
          </Button>
        ))}
      </div>
      {error ? <ErrorState message={error} onRetry={() => void load()} /> : null}
      {!error && rows === null ? <LoadingBlock label="Loading applications" /> : null}
      {rows && rows.length === 0 ? <EmptyState title="Nothing here" description="No applications with this status." /> : null}
      {kind === 'vendors'
        ? vendors?.map((application) => (
            <DecisionCard
              key={application.vendorId}
              title={application.businessName}
              subtitle={`${application.category} · ${application.city.name}`}
              status={application.status}
              reason={application.reason}
              details={[
                ['Owner', application.owner?.name ?? '—'],
                ['Email', application.owner?.email ?? '—'],
                ['Phone', phoneText(application.owner?.phone ?? null)],
                ['Address', application.branch?.address ?? '—'],
                ['Service area', application.branch ? (application.branch.insideServiceArea ? 'Inside a delivery zone' : 'Outside every delivery zone') : '—'],
                ['Applied', new Date(application.submittedAt).toLocaleString()],
              ]}
              decide={(decision, reason) =>
                run(() => authedFetch(`/v1/admin/vendors/${application.vendorId}/decision`, { method: 'POST', body: { decision, reason } }))
              }
              onDecided={() => void load()}
            />
          ))
        : riders?.map((application) => (
            <DecisionCard
              key={application.riderId}
              title={application.applicant.name ?? 'Rider applicant'}
              subtitle={`${application.vehicleType.replace('_', ' ')}${application.vehiclePlate ? ` · ${application.vehiclePlate}` : ''}`}
              status={application.status}
              reason={null}
              details={[
                ['Email', application.applicant.email ?? '—'],
                ['Phone', phoneText(application.applicant.phone)],
                ['Applied', new Date(application.submittedAt).toLocaleString()],
              ]}
              decide={(decision, reason) =>
                run(() => authedFetch(`/v1/admin/riders/${application.riderId}/decision`, { method: 'POST', body: { decision, reason } }))
              }
              onDecided={() => void load()}
            />
          ))}
    </section>
  );
}

/** The number, and the server's sentence about it. Never "verified". */
function phoneText(phone: PhoneStatus | null): string {
  if (!phone?.number) return '—';
  return phone.notice ? `${phone.number} — ${phone.notice}` : phone.number;
}

function DecisionCard({
  title,
  subtitle,
  status,
  reason,
  details,
  decide,
  onDecided,
}: {
  title: string;
  subtitle: string;
  status: { code: string; label: string };
  reason: string | null;
  details: [string, string][];
  decide: (decision: Decision, reason: string | undefined) => Promise<unknown>;
  onDecided: () => void;
}) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const available = DECISIONS_FROM[status.code] ?? [];

  async function act(decision: Decision) {
    if (NEEDS_REASON.has(decision) && note.trim().length < 3) {
      setNotice('Write the reason the person will be told.');
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const done = await decide(decision, note.trim() || undefined);
      if (done !== undefined) {
        setNote('');
        onDecided();
      }
    } catch (caught) {
      setNotice(messageFor(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-3 p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-lg font-bold">{title}</h2>
          <p className="text-sm capitalize text-[var(--ink-muted)]">{subtitle}</p>
        </div>
        <Badge>{status.label}</Badge>
      </div>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        {details.map(([label, value]) => (
          <div key={label} className="flex gap-2">
            <dt className="min-w-24 text-[var(--ink-muted)]">{label}</dt>
            <dd className="break-words">{value}</dd>
          </div>
        ))}
      </dl>
      {reason ? <p className="text-sm text-[var(--ink-muted)]">Reason given: {reason}</p> : null}
      {available.length > 0 ? (
        <div className="space-y-2">
          <label className="block text-sm font-medium" htmlFor={`note-${title}`}>
            Reason (told to the person when rejecting or suspending)
          </label>
          <Input id={`note-${title}`} value={note} onChange={(event) => setNote(event.target.value)} maxLength={500} />
          <div className="flex flex-wrap gap-2">
            {available.map((decision) => (
              <Button
                key={decision}
                size="sm"
                variant={decision === 'approve' || decision === 'reinstate' ? 'primary' : 'danger'}
                disabled={busy}
                onClick={() => void act(decision)}
              >
                {decision[0]!.toUpperCase() + decision.slice(1)}
              </Button>
            ))}
          </div>
        </div>
      ) : null}
      {notice ? (
        <p role="alert" className="text-sm font-medium text-[var(--danger)]">
          {notice}
        </p>
      ) : null}
    </Card>
  );
}
