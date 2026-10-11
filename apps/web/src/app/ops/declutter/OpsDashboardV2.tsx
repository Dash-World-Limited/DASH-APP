'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { AppHeader } from '@/components/AppHeader';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Input,
  LoadingBlock,
  formatNaira,
} from '@/components/ui';
import { ApiRequestError } from '@/lib/api';
import { authedFetch, usePermissions, useSessionState } from '@/lib/session';

import { ItemReviewWorkspace } from './ItemReviewWorkspace';
import { PricingQueue } from './pricing';
import { PublishQueue } from './publish';

type Tab = 'overview' | 'sellers' | 'submissions' | 'pricing' | 'publish';

type BadgeTone = 'neutral' | 'success' | 'warning' | 'danger' | 'gold';

interface SellerRow {
  id: string;
  displayName: string;
  sellerType: string;
  kycStatus: string;
  nameMatchVerdict: string | null;
  nameMatchScore: number | null;
  createdAt: string;
}

interface SellerDocument {
  id: string;
  kind: string;
  status: string;
  note?: string | null;
  reviewedAt?: string | null;
  createdAt?: string;
}

interface SellerDetail extends SellerRow {
  legalName: string | null;
  phoneE164: string | null;
  addressLine: string | null;
  socialHandle: string | null;
  nationalIdLast4: string | null;
  bankName: string | null;
  bankAccountLast4: string | null;
  bankAccountName: string | null;
  adminNotes: string | null;
  rejectionReason: string | null;
  verifiedAt: string | null;
  documents: SellerDocument[];
}

interface SubmissionRow {
  id: string;
  code: string;
  status: string;
  title: string | null;
  condition: string | null;
  expectedPriceKobo: number | null;
  createdAt: string;
  seller?: { id: string; displayName: string; kycStatus: string };
}

interface QueueSnapshot {
  sellers: SellerRow[];
  submissions: SubmissionRow[];
}

const KYC_FILTERS = ['pending', 'unverified', 'verified', 'rejected', 'suspended'] as const;
const SUBMISSION_FILTERS = [
  'intake',
  'kyc_pending',
  'details_pending',
  'fraud_review',
  'valuation_pending',
  'pricing_review',
] as const;

const IDENTITY_DOCUMENT_KINDS = new Set([
  'national_id',
  'drivers_licence',
  'passport',
  'voters_card',
]);

const NAV: { id: Tab; label: string; eyebrow: string }[] = [
  { id: 'overview', label: 'Overview', eyebrow: 'Command centre' },
  { id: 'sellers', label: 'Seller verification', eyebrow: 'KYC & identity' },
  { id: 'submissions', label: 'Item review', eyebrow: 'Intake & checks' },
  { id: 'pricing', label: 'ValueCheck', eyebrow: 'Pricing decisions' },
  { id: 'publish', label: 'Publish', eyebrow: 'Go live' },
];

function readable(value: string): string {
  return value.replace(/_/g, ' ');
}

function messageFor(error: unknown): string {
  return error instanceof ApiRequestError ? error.message : 'Something went wrong. Try again.';
}

function needsStepUp(error: unknown): boolean {
  return (
    error instanceof ApiRequestError &&
    (error.code === 'step_up_required' || error.code === 'step_up_expired')
  );
}

function kycTone(status: string): BadgeTone {
  if (status === 'verified') return 'success';
  if (status === 'pending') return 'warning';
  if (status === 'rejected' || status === 'suspended') return 'danger';
  return 'neutral';
}

function submissionTone(status: string): BadgeTone {
  if (status === 'fraud_review' || status === 'rejected') return 'danger';
  if (status === 'valuation_pending' || status === 'pricing_review') return 'gold';
  if (status === 'intake') return 'success';
  return 'warning';
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('en-NG', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function OpsDashboardV2() {
  const sessionState = useSessionState();
  const { permissions, loaded: permissionsLoaded } = usePermissions();
  const [tab, setTab] = useState<Tab>('overview');

  const canReadSellers = permissions.has('declutter:seller:read');
  const canReviewKyc = permissions.has('declutter:kyc:review');
  const canReadSubmissions = permissions.has('declutter:submission:read');
  const canWriteSubmissions = permissions.has('declutter:submission:write');
  const canAuthorize = permissions.has('declutter:pricing:authorize');
  const canPublish = permissions.has('declutter:listing:publish');

  if (sessionState === 'restoring') {
    return (
      <div className="min-h-dvh bg-[#f6f4ee]">
        <AppHeader variant="staff" />
        <main className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8">
          <Card className="border-0 bg-white p-8 shadow-sm">
            <p className="text-sm font-semibold text-[#9a782f]">DASH DECLUTTERS OPS</p>
            <h1 className="mt-2 text-2xl font-bold text-[#0b1320]">Restoring your staff session…</h1>
            <div className="mt-6">
              <LoadingBlock label="Restoring staff session" />
            </div>
          </Card>
        </main>
      </div>
    );
  }

  if (sessionState === 'unauthenticated') {
    return (
      <div className="min-h-dvh bg-[#f6f4ee]">
        <AppHeader variant="staff" />
        <main className="mx-auto max-w-5xl px-4 py-12 sm:px-6">
          <Card className="overflow-hidden border-0 shadow-sm">
            <div className="bg-[#08111f] px-6 py-10 text-white sm:px-10">
              <p className="text-xs font-semibold tracking-[0.2em] text-[#d5b466]">DASH DECLUTTERS OPS</p>
              <h1 className="mt-3 text-3xl font-bold">Staff access required</h1>
              <p className="mt-3 max-w-xl text-sm text-white/70">
                Seller identity evidence, item review and publication controls are restricted to authorised DASH staff.
              </p>
              <Link href="/ops/declutter/signin" className="mt-6 inline-flex">
                <span className="rounded-xl bg-[#d5b466] px-5 py-3 text-sm font-bold text-[#08111f]">
                  Sign in to DASH Ops
                </span>
              </Link>
            </div>
          </Card>
        </main>
      </div>
    );
  }

  if (permissionsLoaded && !canReadSellers && !canReadSubmissions) {
    return (
      <div className="min-h-dvh bg-[#f6f4ee]">
        <AppHeader variant="staff" />
        <main className="mx-auto max-w-5xl px-4 py-12 sm:px-6">
          <EmptyState
            title="Declutters access is not assigned"
            description="This staff account is signed in, but it does not hold the permissions needed to review Declutters sellers or submissions."
          />
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-dvh bg-[#f6f4ee] text-[#0b1320]">
      <AppHeader variant="staff" />
      <main className="mx-auto max-w-[1500px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        <section className="overflow-hidden rounded-[28px] bg-[#08111f] text-white shadow-sm">
          <div className="grid gap-6 px-6 py-7 sm:px-8 lg:grid-cols-[1fr_auto] lg:items-end lg:px-10 lg:py-9">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full border border-white/15 bg-white/5 px-3 py-1 text-[11px] font-semibold tracking-[0.16em] text-[#d5b466]">
                  DASH DECLUTTERS OPS
                </span>
                <span className="rounded-full bg-[#16302f] px-3 py-1 text-[11px] font-semibold text-[#8ce0d8]">
                  Secure staff workspace
                </span>
              </div>
              <h1 className="mt-4 text-3xl font-bold tracking-tight sm:text-4xl">Operations command centre</h1>
              <p className="mt-3 max-w-3xl text-sm leading-6 text-white/65 sm:text-base">
                Verify sellers, inspect identity evidence, review item intake, run ValueCheck and control what reaches the live marketplace.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <SecurityChip label="KYC" value={canReviewKyc ? 'Review enabled' : 'Read only'} />
              <SecurityChip label="Publish" value={canPublish ? 'Authorised' : 'Restricted'} />
            </div>
          </div>
        </section>

        <div className="mt-6 grid gap-6 lg:grid-cols-[250px_minmax(0,1fr)]">
          <aside>
            <div className="sticky top-4 space-y-3 rounded-[24px] border border-black/5 bg-white p-3 shadow-sm">
              <div className="px-3 pb-2 pt-2">
                <p className="text-[11px] font-bold tracking-[0.18em] text-[#9a782f]">WORKSPACE</p>
              </div>
              <nav className="space-y-1" aria-label="Declutters operations sections">
                {NAV.map((item) => {
                  const active = tab === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setTab(item.id)}
                      className={`w-full rounded-2xl px-4 py-3 text-left transition ${
                        active
                          ? 'bg-[#08111f] text-white shadow-sm'
                          : 'text-[#273244] hover:bg-[#f5f2ea]'
                      }`}
                      aria-current={active ? 'page' : undefined}
                    >
                      <span className={`block text-[10px] font-semibold uppercase tracking-[0.14em] ${active ? 'text-[#d5b466]' : 'text-[#8a8174]'}`}>
                        {item.eyebrow}
                      </span>
                      <span className="mt-1 block text-sm font-semibold">{item.label}</span>
                    </button>
                  );
                })}
              </nav>
              <div className="rounded-2xl bg-[#f7f4eb] p-4">
                <p className="text-xs font-semibold text-[#6b5a32]">Sensitive evidence</p>
                <p className="mt-1 text-xs leading-5 text-[#6d6d6d]">
                  Government ID files stay private. Opening one uses a short-lived secure link and may require an MFA step-up.
                </p>
              </div>
            </div>
          </aside>

          <section className="min-w-0 space-y-5">
            <SectionHeading tab={tab} />

            {tab === 'overview' ? (
              <Overview onNavigate={setTab} />
            ) : tab === 'sellers' ? (
              <SellerQueue canReviewKyc={canReviewKyc} />
            ) : tab === 'submissions' ? (
              <SubmissionQueue canWrite={canWriteSubmissions} />
            ) : tab === 'pricing' ? (
              <OpsPanel title="ValueCheck workspace" description="Valuation evidence, human review and approval stay separate by design.">
                <PricingQueue canAuthorize={canAuthorize} />
              </OpsPanel>
            ) : (
              <OpsPanel title="Publication control" description="Only items that pass every required check are eligible to go live.">
                <PublishQueue canPublish={canPublish} />
              </OpsPanel>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}

function SecurityChip({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3">
      <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-white/45">{label}</p>
      <p className="mt-1 font-semibold text-white/90">{value}</p>
    </div>
  );
}

function SectionHeading({ tab }: { tab: Tab }) {
  const copy: Record<Tab, { title: string; description: string }> = {
    overview: {
      title: 'Overview',
      description: 'What needs attention across seller verification and item intake right now.',
    },
    sellers: {
      title: 'Seller verification',
      description: 'Inspect identity evidence before a seller is allowed to go live.',
    },
    submissions: {
      title: 'Item review',
      description: 'Triage incoming items and move them through the review workflow.',
    },
    pricing: {
      title: 'ValueCheck',
      description: 'Review valuation evidence and authorise the final DASH price.',
    },
    publish: {
      title: 'Publish',
      description: 'Final gate before approved listings become public.',
    },
  };

  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 className="text-2xl font-bold tracking-tight text-[#0b1320]">{copy[tab].title}</h2>
        <p className="mt-1 text-sm text-[#68707d]">{copy[tab].description}</p>
      </div>
      <span className="rounded-full border border-[#dfd9cb] bg-white px-3 py-1 text-xs font-semibold text-[#7a6a47]">
        DASH staff only
      </span>
    </div>
  );
}

function OpsPanel({
  title,
  description,
  children,
}: {
  title?: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <Card className="border-black/5 bg-white p-5 shadow-sm sm:p-6">
      {title ? (
        <div className="mb-5 border-b border-[#eee9de] pb-5">
          <h3 className="text-lg font-bold">{title}</h3>
          {description ? <p className="mt-1 text-sm text-[#747b86]">{description}</p> : null}
        </div>
      ) : null}
      {children}
    </Card>
  );
}

function Overview({ onNavigate }: { onNavigate: (tab: Tab) => void }) {
  const [snapshot, setSnapshot] = useState<QueueSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [sellerData, submissionData] = await Promise.all([
        authedFetch<{ sellers: SellerRow[] }>('/v1/admin/declutter/sellers?limit=100'),
        authedFetch<{ submissions: SubmissionRow[] }>('/v1/admin/declutter/submissions?limit=100'),
      ]);
      setSnapshot({ sellers: sellerData.sellers, submissions: submissionData.submissions });
    } catch (caught) {
      setError(messageFor(caught));
      setSnapshot(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const metrics = useMemo(() => {
    const sellers = snapshot?.sellers ?? [];
    const submissions = snapshot?.submissions ?? [];
    return {
      kycWaiting: sellers.filter((row) => row.kycStatus === 'pending').length,
      verified: sellers.filter((row) => row.kycStatus === 'verified').length,
      needsDetail: submissions.filter((row) => row.status === 'details_pending' || row.status === 'kyc_pending').length,
      fraud: submissions.filter((row) => row.status === 'fraud_review').length,
      valuation: submissions.filter((row) => row.status === 'valuation_pending' || row.status === 'pricing_review').length,
    };
  }, [snapshot]);

  if (error) {
    return <ErrorState title="Could not load the operations snapshot" message={error} onRetry={() => void load()} />;
  }
  if (!snapshot) return <LoadingBlock label="Loading operations overview" />;

  const recentSubmissions = [...snapshot.submissions]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 5);

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="KYC waiting" value={metrics.kycWaiting} note="Sellers awaiting identity review" tone="gold" onClick={() => onNavigate('sellers')} />
        <MetricCard label="Needs attention" value={metrics.needsDetail} note="KYC or item details blocking progress" tone="neutral" onClick={() => onNavigate('submissions')} />
        <MetricCard label="Fraud review" value={metrics.fraud} note="Items requiring closer scrutiny" tone={metrics.fraud > 0 ? 'danger' : 'neutral'} onClick={() => onNavigate('submissions')} />
        <MetricCard label="ValueCheck queue" value={metrics.valuation} note="Items at valuation or pricing review" tone="success" onClick={() => onNavigate('pricing')} />
      </div>

      <div className="grid gap-5 xl:grid-cols-[1.35fr_.65fr]">
        <OpsPanel title="Recent item activity" description="Newest submissions in the current review window.">
          {recentSubmissions.length === 0 ? (
            <EmptyState title="No submissions yet" description="New seller items will appear here as they arrive." />
          ) : (
            <div className="divide-y divide-[#eee9de]">
              {recentSubmissions.map((row) => (
                <button
                  key={row.id}
                  type="button"
                  onClick={() => onNavigate('submissions')}
                  className="flex w-full items-center gap-4 py-4 text-left first:pt-0 last:pb-0"
                >
                  <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#f4efe2] text-xs font-black text-[#9a782f]">
                    DCL
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold">{row.title ?? 'Untitled item'}</p>
                    <p className="mt-1 text-xs text-[#858b94]">{row.code} · {formatDate(row.createdAt)}</p>
                  </div>
                  <Badge tone={submissionTone(row.status)}>{readable(row.status)}</Badge>
                </button>
              ))}
            </div>
          )}
        </OpsPanel>

        <OpsPanel title="Verification health" description="A quick read on the seller base in this queue window.">
          <div className="space-y-3">
            <HealthRow label="Verified sellers" value={metrics.verified} />
            <HealthRow label="Waiting for KYC review" value={metrics.kycWaiting} />
            <HealthRow label="Fraud-review items" value={metrics.fraud} />
          </div>
          <div className="mt-5 rounded-2xl bg-[#08111f] p-4 text-white">
            <p className="text-xs font-semibold text-[#d5b466]">SECURITY RULE</p>
            <p className="mt-2 text-sm leading-6 text-white/70">
              A seller cannot be verified until an accepted government identity document is on file.
            </p>
          </div>
        </OpsPanel>
      </div>
    </div>
  );
}

function MetricCard({
  label,
  value,
  note,
  tone,
  onClick,
}: {
  label: string;
  value: number;
  note: string;
  tone: 'gold' | 'neutral' | 'danger' | 'success';
  onClick: () => void;
}) {
  const accent = {
    gold: 'bg-[#f4ead0] text-[#8a6415]',
    neutral: 'bg-[#eef1f4] text-[#55606e]',
    danger: 'bg-[#fde9e6] text-[#a94336]',
    success: 'bg-[#e1f3ef] text-[#1b7067]',
  }[tone];

  return (
    <button type="button" onClick={onClick} className="rounded-[22px] border border-black/5 bg-white p-5 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-md">
      <div className={`inline-flex rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.14em] ${accent}`}>{label}</div>
      <p className="mt-4 text-3xl font-black tracking-tight">{value}</p>
      <p className="mt-1 text-xs leading-5 text-[#7a818b]">{note}</p>
    </button>
  );
}

function HealthRow({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center justify-between rounded-xl border border-[#eee9de] px-4 py-3">
      <span className="text-sm text-[#5f6875]">{label}</span>
      <span className="text-sm font-bold">{value}</span>
    </div>
  );
}

function SellerQueue({ canReviewKyc }: { canReviewKyc: boolean }) {
  const [status, setStatus] = useState<string>('pending');
  const [rows, setRows] = useState<SellerRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await authedFetch<{ sellers: SellerRow[] }>(
        `/v1/admin/declutter/sellers?kycStatus=${status}&limit=100`,
      );
      setRows(data.sellers);
    } catch (caught) {
      setError(messageFor(caught));
      setRows([]);
    }
  }, [status]);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = (rows ?? []).filter((row) =>
    row.displayName.toLowerCase().includes(search.trim().toLowerCase()),
  );

  return (
    <OpsPanel>
      <div className="flex flex-col gap-4 border-b border-[#eee9de] pb-5 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.15em] text-[#9a782f]">KYC QUEUE</p>
          <h3 className="mt-1 text-lg font-bold">Seller identity review</h3>
          <p className="mt-1 text-sm text-[#747b86]">Open a seller to inspect the information and identity evidence they submitted.</p>
        </div>
        <div className="w-full xl:max-w-xs">
          <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search seller name" aria-label="Search sellers" />
        </div>
      </div>

      <div className="mt-5 flex flex-wrap gap-2">
        {KYC_FILTERS.map((filter) => (
          <button
            key={filter}
            type="button"
            onClick={() => setStatus(filter)}
            className={`rounded-full px-3.5 py-2 text-xs font-semibold transition ${status === filter ? 'bg-[#08111f] text-white' : 'bg-[#f2efe8] text-[#5f6670] hover:bg-[#e9e4d9]'}`}
          >
            {readable(filter)}
          </button>
        ))}
      </div>

      <div className="mt-5">
        {error ? <ErrorState title="Could not load seller queue" message={error} onRetry={() => void load()} /> : null}
        {rows === null && !error ? <LoadingBlock label="Loading sellers" /> : null}
        {rows !== null && visible.length === 0 && !error ? (
          <EmptyState title="Nothing here" description={search ? 'No seller matches that search.' : `No sellers are ${readable(status)}.`} />
        ) : null}

        {visible.length > 0 ? (
          <div className="overflow-hidden rounded-2xl border border-[#e9e4d9]">
            <div className="hidden grid-cols-[1.2fr_.8fr_.7fr_.7fr_auto] gap-4 bg-[#f7f4ed] px-5 py-3 text-[10px] font-bold uppercase tracking-[0.13em] text-[#8a8174] md:grid">
              <span>Seller</span>
              <span>Type</span>
              <span>Name check</span>
              <span>Joined</span>
              <span>Action</span>
            </div>
            <div className="divide-y divide-[#eee9de]">
              {visible.map((row) => (
                <div key={row.id} className="grid gap-3 bg-white px-5 py-4 md:grid-cols-[1.2fr_.8fr_.7fr_.7fr_auto] md:items-center md:gap-4">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-bold">{row.displayName}</p>
                    <div className="mt-1"><Badge tone={kycTone(row.kycStatus)}>{readable(row.kycStatus)}</Badge></div>
                  </div>
                  <span className="text-sm text-[#616a76]">{readable(row.sellerType)}</span>
                  <div>
                    {row.nameMatchVerdict ? (
                      <Badge tone={row.nameMatchVerdict === 'match' ? 'success' : row.nameMatchVerdict === 'mismatch' ? 'danger' : 'warning'}>
                        {readable(row.nameMatchVerdict)}{row.nameMatchScore === null ? '' : ` · ${row.nameMatchScore}`}
                      </Badge>
                    ) : (
                      <span className="text-xs text-[#9298a0]">Not assessed</span>
                    )}
                  </div>
                  <span className="text-xs text-[#7c838d]">{formatDate(row.createdAt)}</span>
                  <Button size="sm" variant="secondary" onClick={() => setOpenId(row.id)}>Review seller</Button>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      {openId ? (
        <SellerReviewDrawer
          sellerId={openId}
          canReviewKyc={canReviewKyc}
          onClose={() => setOpenId(null)}
          onChanged={() => {
            setOpenId(null);
            void load();
          }}
        />
      ) : null}
    </OpsPanel>
  );
}

function SellerReviewDrawer({
  sellerId,
  canReviewKyc,
  onClose,
  onChanged,
}: {
  sellerId: string;
  canReviewKyc: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<SellerDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [adminNote, setAdminNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [stepUpRequired, setStepUpRequired] = useState(false);
  const retryRef = useRef<(() => Promise<void>) | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await authedFetch<{ seller: SellerDetail }>(`/v1/admin/declutter/sellers/${sellerId}`);
      setDetail(data.seller);
      setAdminNote(data.seller.adminNotes ?? '');
      setStepUpRequired(false);
    } catch (caught) {
      if (needsStepUp(caught)) {
        retryRef.current = load;
        setStepUpRequired(true);
        setError(null);
        return;
      }
      setError(messageFor(caught));
    }
  }, [sellerId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function decide(to: 'verified' | 'rejected' | 'suspended') {
    if ((to === 'rejected' || to === 'suspended') && !reason.trim()) {
      setNotice('Add a reason before rejecting or suspending this seller.');
      return;
    }

    const action = async (): Promise<void> => {
      setBusy(true);
      setNotice(null);
      try {
        await authedFetch(`/v1/admin/declutter/sellers/${sellerId}/decision`, {
          method: 'POST',
          body: {
            to,
            reason: reason.trim() || undefined,
            note: adminNote.trim() || undefined,
          },
        });
        try {
          await authedFetch(`/v1/admin/declutter/sellers/${sellerId}/decision-notification`, {
            method: 'POST',
            body: { decision: to, reason: reason.trim() || undefined },
          });
        } catch {
          // The decision is already authoritative; notification can retry independently.
        }
        onChanged();
      } catch (caught) {
        if (needsStepUp(caught)) {
          retryRef.current = action;
          setStepUpRequired(true);
        } else {
          setNotice(messageFor(caught));
        }
      } finally {
        setBusy(false);
      }
    };

    await action();
  }

  async function reviewDocument(documentId: string, status: 'accepted' | 'rejected') {
    if (status === 'rejected' && !reason.trim()) {
      setNotice('Add a reason before rejecting an identity document.');
      return;
    }

    const action = async (): Promise<void> => {
      setBusy(true);
      setNotice(null);
      try {
        await authedFetch(`/v1/admin/declutter/sellers/${sellerId}/documents/${documentId}/review`, {
          method: 'POST',
          body: { status, note: status === 'rejected' ? reason.trim() : undefined },
        });
        await load();
      } catch (caught) {
        if (needsStepUp(caught)) {
          retryRef.current = action;
          setStepUpRequired(true);
        } else {
          setNotice(messageFor(caught));
        }
      } finally {
        setBusy(false);
      }
    };

    await action();
  }

  async function openDocument(documentId: string) {
    setNotice(null);
    try {
      const data = await authedFetch<{ url: string }>(`/v1/admin/declutter/sellers/${sellerId}/documents/${documentId}/link`);
      window.open(data.url, '_blank', 'noopener,noreferrer');
    } catch (caught) {
      if (needsStepUp(caught)) {
        retryRef.current = null;
        setStepUpRequired(true);
        setNotice('Confirm your identity, then click View document again.');
      } else {
        setNotice(messageFor(caught));
      }
    }
  }

  const acceptedIdentityDocument = detail?.documents.some(
    (document) => IDENTITY_DOCUMENT_KINDS.has(document.kind) && document.status === 'accepted',
  ) ?? false;
  const identityReady = Boolean(detail?.legalName && detail?.phoneE164 && detail?.nationalIdLast4);
  const canApprove = acceptedIdentityDocument && identityReady;

  return (
    <OpsDrawer title="Seller verification" subtitle="Private KYC workspace" onClose={onClose}>
      {stepUpRequired ? (
        <StepUpGate
          onConfirmed={async () => {
            setStepUpRequired(false);
            const retry = retryRef.current;
            retryRef.current = null;
            if (retry) await retry();
          }}
        />
      ) : null}

      {error ? <ErrorState title="Could not open seller review" message={error} onRetry={() => void load()} /> : null}
      {!detail && !error && !stepUpRequired ? <LoadingBlock label="Loading seller verification" /> : null}

      {detail ? (
        <div className="space-y-6">
          <div className="rounded-[24px] bg-[#08111f] p-5 text-white sm:p-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-xs font-semibold tracking-[0.15em] text-[#d5b466]">SELLER</p>
                <h3 className="mt-2 text-2xl font-bold">{detail.displayName}</h3>
                <p className="mt-1 text-sm text-white/55">Joined {formatDate(detail.createdAt)}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Badge tone={kycTone(detail.kycStatus)}>{readable(detail.kycStatus)}</Badge>
                {detail.sellerType === 'trusted_partner' ? <Badge tone="success">Trusted partner</Badge> : null}
              </div>
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-[1.2fr_.8fr]">
            <ReviewSection title="Identity & contact" description="The information the seller submitted for verification.">
              <div className="grid gap-3 sm:grid-cols-2">
                <DataTile label="Legal name" value={detail.legalName} />
                <DataTile label="Phone" value={detail.phoneE164} />
                <DataTile label="Address" value={detail.addressLine} wide />
                <DataTile label="Social handle" value={detail.socialHandle} />
                <DataTile label="Government ID number" value={detail.nationalIdLast4 ? `•••• ${detail.nationalIdLast4}` : null} />
                <DataTile label="Verified at" value={formatDate(detail.verifiedAt)} />
              </div>
            </ReviewSection>

            <ReviewSection title="Verification checklist" description="All required evidence should be satisfied before approval.">
              <div className="space-y-2">
                <ChecklistRow label="Legal name supplied" done={Boolean(detail.legalName)} />
                <ChecklistRow label="Reachable phone supplied" done={Boolean(detail.phoneE164)} />
                <ChecklistRow label="Identity number on file" done={Boolean(detail.nationalIdLast4)} />
                <ChecklistRow label="Government ID accepted" done={acceptedIdentityDocument} />
              </div>
              <div className="mt-4 rounded-xl bg-[#f8f3e7] px-4 py-3 text-xs leading-5 text-[#6f5a2c]">
                DASH does not expose the full identity number here. Inspect the uploaded government ID through the protected document link instead.
              </div>
            </ReviewSection>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <ReviewSection title="Name & risk signals" description="Use these signals as evidence, not as an automatic decision.">
              <div className="grid gap-3 sm:grid-cols-2">
                <DataTile label="Name match" value={detail.nameMatchVerdict ? readable(detail.nameMatchVerdict) : null} />
                <DataTile label="Match score" value={detail.nameMatchScore === null ? null : String(detail.nameMatchScore)} />
                <DataTile label="Current KYC state" value={readable(detail.kycStatus)} />
                <DataTile label="Seller type" value={readable(detail.sellerType)} />
              </div>
            </ReviewSection>

            <ReviewSection title="Settlement identity" description="Optional payout information when the seller supplied it.">
              <div className="grid gap-3 sm:grid-cols-2">
                <DataTile label="Bank" value={detail.bankName} />
                <DataTile label="Account ending" value={detail.bankAccountLast4 ? `•••• ${detail.bankAccountLast4}` : null} />
                <DataTile label="Account name" value={detail.bankAccountName} wide />
              </div>
            </ReviewSection>
          </div>

          <ReviewSection title="Identity documents" description="Open the evidence, inspect it, then accept or reject the document itself.">
            {detail.documents.length === 0 ? (
              <EmptyState title="No identity document uploaded" description="This seller cannot be approved until a government identity document is uploaded and accepted." />
            ) : (
              <div className="grid gap-3 lg:grid-cols-2">
                {detail.documents.map((document) => {
                  const isIdentity = IDENTITY_DOCUMENT_KINDS.has(document.kind);
                  return (
                    <div key={document.id} className="rounded-2xl border border-[#e6e0d5] bg-[#fbfaf7] p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-sm font-bold">{readable(document.kind)}</p>
                          <p className="mt-1 text-xs text-[#7f8690]">{isIdentity ? 'Government identity evidence' : 'Supporting evidence'}</p>
                        </div>
                        <Badge tone={document.status === 'accepted' ? 'success' : document.status === 'rejected' ? 'danger' : 'warning'}>
                          {readable(document.status)}
                        </Badge>
                      </div>
                      {document.note ? <p className="mt-3 rounded-xl bg-white px-3 py-2 text-xs text-[#66707c]">{document.note}</p> : null}
                      <div className="mt-4 flex flex-wrap gap-2">
                        <Button size="sm" variant="secondary" onClick={() => void openDocument(document.id)}>
                          {isIdentity ? 'View government ID' : 'View document'}
                        </Button>
                        {canReviewKyc && document.status !== 'accepted' ? (
                          <Button size="sm" disabled={busy} onClick={() => void reviewDocument(document.id, 'accepted')}>Accept</Button>
                        ) : null}
                        {canReviewKyc && document.status !== 'rejected' ? (
                          <Button size="sm" variant="danger" disabled={busy} onClick={() => void reviewDocument(document.id, 'rejected')}>Reject</Button>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </ReviewSection>

          <ReviewSection title="Decision" description="Record what DASH decided and why. Seller-facing reasons and internal notes are kept separate.">
            <div className="grid gap-4 lg:grid-cols-2">
              <Field label="Seller-facing reason" htmlFor="declutter-review-reason" hint="Required for rejection or suspension.">
                <Input id="declutter-review-reason" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="e.g. The identity document is unreadable" />
              </Field>
              <Field label="Internal DASH note" htmlFor="declutter-admin-note" hint="Operational context for staff; not the seller-facing reason.">
                <Input id="declutter-admin-note" value={adminNote} onChange={(event) => setAdminNote(event.target.value)} placeholder="e.g. Names match; passport photo clear" />
              </Field>
            </div>

            {notice ? <p role="alert" className="mt-4 rounded-xl bg-[#fff2ef] px-4 py-3 text-sm font-medium text-[#a94336]">{notice}</p> : null}

            <div className="mt-5 flex flex-wrap gap-2">
              <Button disabled={busy || !canReviewKyc || !canApprove} onClick={() => void decide('verified')}>Approve seller</Button>
              <Button variant="danger" disabled={busy || !canReviewKyc || !reason.trim()} onClick={() => void decide('rejected')}>Reject seller</Button>
              <Button variant="secondary" disabled={busy || !canReviewKyc || !reason.trim()} onClick={() => void decide('suspended')}>Suspend seller</Button>
            </div>
            {!canApprove ? <p className="mt-3 text-xs text-[#7b828c]">Approval unlocks only after required identity details are present and at least one government ID document is accepted.</p> : null}
          </ReviewSection>
        </div>
      ) : null}
    </OpsDrawer>
  );
}

function StepUpGate({ onConfirmed }: { onConfirmed: () => Promise<void> | void }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function confirm() {
    if (!/^\d{6}$/.test(code.trim())) {
      setError('Enter the 6-digit code from your authenticator app.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await authedFetch('/v1/auth/mfa/step-up', { method: 'POST', body: { code: code.trim() } });
      setCode('');
      await onConfirmed();
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-5 rounded-[22px] border border-[#d8c693] bg-[#fff8e8] p-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
        <div className="flex-1">
          <p className="text-xs font-bold uppercase tracking-[0.14em] text-[#8c681e]">Identity confirmation required</p>
          <p className="mt-2 text-sm leading-6 text-[#695d42]">KYC details are sensitive. Enter the current 6-digit code from your authenticator to unlock this review window.</p>
        </div>
        <div className="w-full sm:w-52">
          <Input
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="000000"
            aria-label="Authenticator code"
            className="bg-white text-center font-mono text-lg tracking-[0.25em]"
          />
          <Button className="mt-2 w-full" disabled={busy || code.length !== 6} onClick={() => void confirm()}>
            {busy ? 'Confirming…' : 'Confirm identity'}
          </Button>
        </div>
      </div>
      {error ? <p role="alert" className="mt-3 text-sm font-medium text-[#a94336]">{error}</p> : null}
    </div>
  );
}

function ReviewSection({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="rounded-[22px] border border-[#e9e4da] bg-white p-5">
      <div className="mb-4">
        <h4 className="text-base font-bold">{title}</h4>
        {description ? <p className="mt-1 text-xs leading-5 text-[#7a818c]">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}

function DataTile({ label, value, wide = false }: { label: string; value: string | null; wide?: boolean }) {
  return (
    <div className={`rounded-xl bg-[#f8f6f1] px-4 py-3 ${wide ? 'sm:col-span-2' : ''}`}>
      <p className="text-[10px] font-bold uppercase tracking-[0.13em] text-[#8d8578]">{label}</p>
      <p className="mt-1 break-words text-sm font-semibold text-[#222b37]">{value || '—'}</p>
    </div>
  );
}

function ChecklistRow({ label, done }: { label: string; done: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl bg-[#f8f6f1] px-4 py-3">
      <span className="text-sm text-[#525c68]">{label}</span>
      <span className={`rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.1em] ${done ? 'bg-[#e1f3ef] text-[#1b7067]' : 'bg-[#f5e9dd] text-[#986139]'}`}>
        {done ? 'Ready' : 'Missing'}
      </span>
    </div>
  );
}

function SubmissionQueue({ canWrite }: { canWrite: boolean }) {
  const [status, setStatus] = useState<string>('kyc_pending');
  const [rows, setRows] = useState<SubmissionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<SubmissionRow | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await authedFetch<{ submissions: SubmissionRow[] }>(`/v1/admin/declutter/submissions?status=${status}&limit=100`);
      setRows(data.submissions);
    } catch (caught) {
      setError(messageFor(caught));
      setRows([]);
    }
  }, [status]);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = (rows ?? []).filter((row) => {
    const needle = search.trim().toLowerCase();
    if (!needle) return true;
    return `${row.title ?? ''} ${row.code} ${row.seller?.displayName ?? ''}`.toLowerCase().includes(needle);
  });

  return (
    <OpsPanel>
      <div className="flex flex-col gap-4 border-b border-[#eee9de] pb-5 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.15em] text-[#9a782f]">ITEM INTAKE</p>
          <h3 className="mt-1 text-lg font-bold">Submission review queue</h3>
          <p className="mt-1 text-sm text-[#747b86]">Track where each item is blocked and move it to the correct next stage.</p>
        </div>
        <div className="w-full xl:max-w-xs">
          <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search title, ref or seller" aria-label="Search submissions" />
        </div>
      </div>

      <div className="mt-5 flex flex-wrap gap-2">
        {SUBMISSION_FILTERS.map((filter) => (
          <button key={filter} type="button" onClick={() => setStatus(filter)} className={`rounded-full px-3.5 py-2 text-xs font-semibold transition ${status === filter ? 'bg-[#08111f] text-white' : 'bg-[#f2efe8] text-[#5f6670] hover:bg-[#e9e4d9]'}`}>
            {readable(filter)}
          </button>
        ))}
      </div>

      <div className="mt-5">
        {error ? <ErrorState title="Could not load submissions" message={error} onRetry={() => void load()} /> : null}
        {rows === null && !error ? <LoadingBlock label="Loading submissions" /> : null}
        {rows !== null && visible.length === 0 && !error ? <EmptyState title="Nothing here" description={search ? 'No item matches that search.' : `No submissions are ${readable(status)}.`} /> : null}

        {visible.length > 0 ? (
          <div className="overflow-hidden rounded-2xl border border-[#e9e4d9]">
            <div className="hidden grid-cols-[1.25fr_.7fr_.7fr_.7fr_auto] gap-4 bg-[#f7f4ed] px-5 py-3 text-[10px] font-bold uppercase tracking-[0.13em] text-[#8a8174] md:grid">
              <span>Item</span><span>Seller</span><span>Seller KYC</span><span>Expected</span><span>Action</span>
            </div>
            <div className="divide-y divide-[#eee9de]">
              {visible.map((row) => (
                <div key={row.id} className="grid gap-3 bg-white px-5 py-4 md:grid-cols-[1.25fr_.7fr_.7fr_.7fr_auto] md:items-center md:gap-4">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-bold">{row.title ?? 'Untitled item'}</p>
                    <p className="mt-1 text-xs text-[#858b94]">{row.code} · {row.condition ? readable(row.condition) : 'condition not set'}</p>
                    <div className="mt-2"><Badge tone={submissionTone(row.status)}>{readable(row.status)}</Badge></div>
                  </div>
                  <span className="truncate text-sm text-[#616a76]">{row.seller?.displayName ?? '—'}</span>
                  <span><Badge tone={row.seller?.kycStatus === 'verified' ? 'success' : 'warning'}>{row.seller ? readable(row.seller.kycStatus) : 'unknown'}</Badge></span>
                  <span className="text-sm font-semibold">{row.expectedPriceKobo === null ? '—' : formatNaira(row.expectedPriceKobo)}</span>
                  <Button size="sm" variant="secondary" onClick={() => setOpen(row)}>Review item</Button>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      {open ? (
        <ItemReviewWorkspace
          submission={open}
          canWrite={canWrite}
          onClose={() => setOpen(null)}
          onChanged={() => {
            setOpen(null);
            void load();
          }}
        />
      ) : null}
    </OpsPanel>
  );
}

function OpsDrawer({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 bg-[#08111f]/55 backdrop-blur-[2px]" onMouseDown={onClose}>
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="ml-auto flex h-full w-full max-w-5xl flex-col bg-[#f6f4ee] shadow-2xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="flex items-center justify-between gap-4 border-b border-[#dfd9cd] bg-white px-5 py-4 sm:px-7">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-[#9a782f]">{subtitle ?? 'DASH DECLUTTERS OPS'}</p>
            <h2 className="mt-1 text-xl font-bold">{title}</h2>
          </div>
          <button type="button" onClick={onClose} className="grid h-10 w-10 place-items-center rounded-xl border border-[#e2ddd2] bg-[#faf9f6] text-xl hover:bg-[#f2efe8]" aria-label="Close review">×</button>
        </header>
        <div className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-7">{children}</div>
      </aside>
    </div>
  );
}
