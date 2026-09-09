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
  Field,
  Input,
  LoadingBlock,
  formatNaira,
} from '@/components/ui';
import { Modal } from '@/components/Modal';
import { ApiRequestError } from '@/lib/api';
import { authedFetch, useHasSession, usePermissions } from '@/lib/session';

/**
 * Declutters operations console.
 *
 * The minimum a person needs to run seller verification and the submission
 * queue safely: see who is waiting, read the evidence, decide, and have every
 * decision carry a reason. It is deliberately plain — this is a working
 * surface, not a marketing one, and the marketplace's own visual language
 * comes later.
 *
 * Two things about it are not cosmetic.
 *
 * **It never renders a document inline.** Bytes are fetched as a short-lived
 * signed link at the moment a reviewer asks, and opened in a new tab. Nothing
 * about a KYC document is cached in this page's state, so a screenshot of the
 * console is not a screenshot of somebody's passport.
 *
 * **It expects to be told no.** Reading the private record and deciding on it
 * both need a live step-up, and the API says so in words a person can act on.
 * Rather than hiding buttons the server would refuse, the page shows the
 * refusal — a greyed-out control teaches nobody why.
 */

type Tab = 'sellers' | 'submissions';

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
  isIdentityDocument: boolean;
  status: string;
  note: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

interface SellerDetail extends SellerRow {
  legalName: string | null;
  phoneE164: string | null;
  addressLine: string | null;
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

/** Statuses a reviewer filters the seller queue by. */
const KYC_FILTERS = ['pending', 'unverified', 'verified', 'rejected', 'suspended'] as const;

/**
 * Submission states an admin may move a record to from the console.
 *
 * `published` is absent, and not by oversight: publication needs a listing, a
 * price the seller accepted, and a permission this console does not use. The
 * API refuses it too — this list simply does not offer what would be refused.
 */
const SUBMISSION_TRANSITIONS = [
  { value: 'kyc_pending', label: 'Waiting on verification' },
  { value: 'details_pending', label: 'Need more detail' },
  { value: 'fraud_review', label: 'Send to fraud review' },
  { value: 'valuation_pending', label: 'Ready to value' },
  { value: 'rejected', label: 'Reject' },
] as const;

const SUBMISSION_FILTERS = [
  'intake',
  'kyc_pending',
  'details_pending',
  'fraud_review',
  'valuation_pending',
  'pricing_review',
] as const;

function kycTone(status: string): 'neutral' | 'success' | 'warning' | 'danger' {
  if (status === 'verified') return 'success';
  if (status === 'pending') return 'warning';
  if (status === 'rejected' || status === 'suspended') return 'danger';
  return 'neutral';
}

function matchTone(verdict: string | null): 'neutral' | 'success' | 'warning' | 'danger' {
  if (verdict === 'match') return 'success';
  if (verdict === 'review') return 'warning';
  if (verdict === 'mismatch') return 'danger';
  return 'neutral';
}

function readable(value: string): string {
  return value.replace(/_/g, ' ');
}

function messageFor(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  return 'Something went wrong. Try again.';
}

export default function DeclutterOpsPage() {
  const hasSession = useHasSession();
  const { permissions, loaded: permissionsLoaded } = usePermissions();
  const [tab, setTab] = useState<Tab>('sellers');

  const canReadSellers = permissions.has('declutter:seller:read');
  const canReviewKyc = permissions.has('declutter:kyc:review');
  const canReadSubmissions = permissions.has('declutter:submission:read');

  if (!hasSession) {
    return (
      <div className="min-h-dvh">
        <AppHeader />
        <main className="mx-auto max-w-5xl px-4 py-10">
          <EmptyState
            title="Sign in to continue"
            description="The Declutters console is for DASH staff."
            action={<Link href="/signin"><Button>Sign in</Button></Link>}
          />
        </main>
      </div>
    );
  }

  if (permissionsLoaded && !canReadSellers && !canReadSubmissions) {
    return (
      <div className="min-h-dvh">
        <AppHeader />
        <main className="mx-auto max-w-5xl px-4 py-10">
          <EmptyState
            title="No access"
            description="Your account does not have Declutters permissions."
          />
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-dvh">
      <AppHeader />
      <main className="mx-auto max-w-5xl space-y-6 px-4 py-8">
        <header className="space-y-1">
          <h1 className="text-2xl font-bold">Declutters</h1>
          <p className="text-sm text-[var(--ink-muted)]">
            Seller verification and the submission queue.
          </p>
        </header>

        <nav className="flex gap-2" aria-label="Sections">
          <Button
            variant={tab === 'sellers' ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => setTab('sellers')}
            aria-current={tab === 'sellers' ? 'page' : undefined}
          >
            Sellers
          </Button>
          <Button
            variant={tab === 'submissions' ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => setTab('submissions')}
            aria-current={tab === 'submissions' ? 'page' : undefined}
          >
            Submissions
          </Button>
        </nav>

        {tab === 'sellers' ? (
          <SellerQueue canReviewKyc={canReviewKyc} />
        ) : (
          <SubmissionQueue />
        )}
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sellers
// ---------------------------------------------------------------------------

function SellerQueue({ canReviewKyc }: { canReviewKyc: boolean }) {
  const [status, setStatus] = useState<string>('pending');
  const [rows, setRows] = useState<SellerRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await authedFetch<{ sellers: SellerRow[] }>(
        `/v1/admin/declutter/sellers?kycStatus=${status}`,
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

  return (
    <section className="space-y-4" aria-label="Seller verification queue">
      <div className="flex flex-wrap gap-2">
        {KYC_FILTERS.map((filter) => (
          <Button
            key={filter}
            size="sm"
            variant={status === filter ? 'primary' : 'secondary'}
            onClick={() => setStatus(filter)}
          >
            {readable(filter)}
          </Button>
        ))}
      </div>

      {error ? <ErrorState title="Could not load the queue" message={error} onRetry={() => void load()} /> : null}

      {rows === null && !error ? <LoadingBlock label="Loading sellers" /> : null}

      {rows !== null && rows.length === 0 && !error ? (
        <EmptyState title="Nothing here" description={`No sellers are ${readable(status)}.`} />
      ) : null}

      <ul className="space-y-2">
        {(rows ?? []).map((row) => (
          <li key={row.id}>
            <Card className="flex flex-wrap items-center gap-3 p-4">
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold">{row.displayName}</p>
                <p className="text-xs text-[var(--ink-muted)]">
                  {readable(row.sellerType)} · joined{' '}
                  {new Date(row.createdAt).toLocaleDateString()}
                </p>
              </div>
              <Badge tone={kycTone(row.kycStatus)}>{readable(row.kycStatus)}</Badge>
              {row.nameMatchVerdict ? (
                <Badge tone={matchTone(row.nameMatchVerdict)}>
                  names {row.nameMatchVerdict}
                  {row.nameMatchScore === null ? '' : ` ${row.nameMatchScore}`}
                </Badge>
              ) : null}
              <Button size="sm" variant="secondary" onClick={() => setOpenId(row.id)}>
                Review
              </Button>
            </Card>
          </li>
        ))}
      </ul>

      {openId ? (
        <SellerDetailModal
          sellerId={openId}
          canReviewKyc={canReviewKyc}
          onClose={() => setOpenId(null)}
          onChanged={() => {
            setOpenId(null);
            void load();
          }}
        />
      ) : null}
    </section>
  );
}

function SellerDetailModal({
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
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await authedFetch<{ seller: SellerDetail }>(
        `/v1/admin/declutter/sellers/${sellerId}`,
      );
      setDetail(data.seller);
    } catch (caught) {
      setError(messageFor(caught));
    }
  }, [sellerId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function decide(to: 'verified' | 'rejected' | 'suspended') {
    setBusy(true);
    setNotice(null);
    try {
      await authedFetch(`/v1/admin/declutter/sellers/${sellerId}/decision`, {
        method: 'POST',
        body: JSON.stringify({ to, reason: reason.trim() || undefined }),
      });
      onChanged();
    } catch (caught) {
      setNotice(messageFor(caught));
    } finally {
      setBusy(false);
    }
  }

  async function reviewDocument(documentId: string, status: 'accepted' | 'rejected') {
    setBusy(true);
    setNotice(null);
    try {
      await authedFetch(
        `/v1/admin/declutter/sellers/${sellerId}/documents/${documentId}/review`,
        {
          method: 'POST',
          body: JSON.stringify({ status, note: status === 'rejected' ? reason.trim() : undefined }),
        },
      );
      await load();
    } catch (caught) {
      setNotice(messageFor(caught));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Open a document.
   *
   * The link is requested at the moment of the click and used immediately. It
   * is never stored in state, so the bytes are not reachable from this page
   * after the tab is opened.
   */
  async function openDocument(documentId: string) {
    setNotice(null);
    try {
      const data = await authedFetch<{ url: string }>(
        `/v1/admin/declutter/sellers/${sellerId}/documents/${documentId}/link`,
      );
      window.open(data.url, '_blank', 'noopener,noreferrer');
    } catch (caught) {
      setNotice(messageFor(caught));
    }
  }

  return (
    <Modal title="Seller review" onClose={onClose}>
      {error ? <ErrorState title="Could not open this seller" message={error} onRetry={() => void load()} /> : null}
      {!detail && !error ? <LoadingBlock label="Loading seller" /> : null}

      {detail ? (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">{detail.displayName}</span>
            <Badge tone={kycTone(detail.kycStatus)}>{readable(detail.kycStatus)}</Badge>
            {detail.sellerType === 'trusted_partner' ? (
              <Badge tone="success">Trusted partner</Badge>
            ) : null}
          </div>

          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <Detail label="Legal name" value={detail.legalName} />
            <Detail label="Phone" value={detail.phoneE164} />
            <Detail label="Address" value={detail.addressLine} />
            <Detail
              label="Identity number"
              value={detail.nationalIdLast4 ? `•••• ${detail.nationalIdLast4}` : null}
            />
            <Detail label="Bank" value={detail.bankName} />
            <Detail
              label="Account"
              value={detail.bankAccountLast4 ? `•••• ${detail.bankAccountLast4}` : null}
            />
            <Detail label="Account name" value={detail.bankAccountName} />
            <Detail
              label="Name match"
              value={
                detail.nameMatchVerdict
                  ? `${detail.nameMatchVerdict} (${detail.nameMatchScore ?? '—'})`
                  : null
              }
            />
          </dl>

          <section className="space-y-2">
            <h3 className="text-sm font-semibold">Documents</h3>
            {detail.documents.length === 0 ? (
              <p className="text-sm text-[var(--ink-muted)]">
                Nothing uploaded. A seller cannot be verified without an accepted
                government identity document.
              </p>
            ) : (
              <ul className="space-y-2">
                {detail.documents.map((document) => (
                  <li
                    key={document.id}
                    className="flex flex-wrap items-center gap-2 rounded-xl border p-3"
                  >
                    <span className="flex-1 text-sm">
                      {readable(document.kind)}
                      {document.isIdentityDocument ? '' : ' (supporting)'}
                    </span>
                    <Badge
                      tone={
                        document.status === 'accepted'
                          ? 'success'
                          : document.status === 'rejected'
                            ? 'danger'
                            : 'warning'
                      }
                    >
                      {document.status}
                    </Badge>
                    <Button size="sm" variant="secondary" onClick={() => void openDocument(document.id)}>
                      Open
                    </Button>
                    {canReviewKyc && document.status !== 'accepted' ? (
                      <Button
                        size="sm"
                        disabled={busy}
                        onClick={() => void reviewDocument(document.id, 'accepted')}
                      >
                        Accept
                      </Button>
                    ) : null}
                    {canReviewKyc && document.status !== 'rejected' ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busy}
                        onClick={() => void reviewDocument(document.id, 'rejected')}
                      >
                        Reject
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <Field
            label="Reason"
            htmlFor="declutter-reason"
            hint="Required to reject or suspend, and shown to the seller."
          >
            <Input
              id="declutter-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="e.g. The identity document was unreadable"
            />
          </Field>

          {notice ? (
            <p role="alert" className="text-sm font-medium text-[var(--danger)]">
              {notice}
            </p>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <Button disabled={busy || !canReviewKyc} onClick={() => void decide('verified')}>
              Verify
            </Button>
            <Button
              variant="secondary"
              disabled={busy || !canReviewKyc}
              onClick={() => void decide('rejected')}
            >
              Reject
            </Button>
            <Button
              variant="secondary"
              disabled={busy || !canReviewKyc}
              onClick={() => void decide('suspended')}
            >
              Suspend
            </Button>
          </div>
        </div>
      ) : null}
    </Modal>
  );
}

function Detail({ label, value }: { label: string; value: string | null }) {
  return (
    <>
      <dt className="text-[var(--ink-muted)]">{label}</dt>
      <dd className="font-medium">{value ?? '—'}</dd>
    </>
  );
}

// ---------------------------------------------------------------------------
// Submissions
// ---------------------------------------------------------------------------

function SubmissionQueue() {
  const [status, setStatus] = useState<string>('intake');
  const [rows, setRows] = useState<SubmissionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<SubmissionRow | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await authedFetch<{ submissions: SubmissionRow[] }>(
        `/v1/admin/declutter/submissions?status=${status}`,
      );
      setRows(data.submissions);
    } catch (caught) {
      setError(messageFor(caught));
      setRows([]);
    }
  }, [status]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="space-y-4" aria-label="Submission queue">
      <div className="flex flex-wrap gap-2">
        {SUBMISSION_FILTERS.map((filter) => (
          <Button
            key={filter}
            size="sm"
            variant={status === filter ? 'primary' : 'secondary'}
            onClick={() => setStatus(filter)}
          >
            {readable(filter)}
          </Button>
        ))}
      </div>

      {error ? <ErrorState title="Could not load submissions" message={error} onRetry={() => void load()} /> : null}
      {rows === null && !error ? <LoadingBlock label="Loading submissions" /> : null}
      {rows !== null && rows.length === 0 && !error ? (
        <EmptyState title="Nothing here" description={`No submissions are ${readable(status)}.`} />
      ) : null}

      <ul className="space-y-2">
        {(rows ?? []).map((row) => (
          <li key={row.id}>
            <Card className="flex flex-wrap items-center gap-3 p-4">
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold">{row.title ?? 'Untitled'}</p>
                <p className="text-xs text-[var(--ink-muted)]">
                  {row.code}
                  {row.seller ? ` · ${row.seller.displayName}` : ''}
                  {row.condition ? ` · ${readable(row.condition)}` : ''}
                </p>
              </div>
              {row.expectedPriceKobo === null ? null : (
                <span className="text-sm font-semibold">
                  {formatNaira(row.expectedPriceKobo)}
                  <span className="ml-1 text-xs font-normal text-[var(--ink-muted)]">asked</span>
                </span>
              )}
              <Badge tone="neutral">{readable(row.status)}</Badge>
              <Button size="sm" variant="secondary" onClick={() => setOpen(row)}>
                Open
              </Button>
            </Card>
          </li>
        ))}
      </ul>

      {open ? (
        <SubmissionModal
          submission={open}
          onClose={() => setOpen(null)}
          onChanged={() => {
            setOpen(null);
            void load();
          }}
        />
      ) : null}
    </section>
  );
}

function SubmissionModal({
  submission,
  onClose,
  onChanged,
}: {
  submission: SubmissionRow;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [to, setTo] = useState<string>(SUBMISSION_TRANSITIONS[0].value);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function move() {
    setBusy(true);
    setNotice(null);
    try {
      await authedFetch(`/v1/admin/declutter/submissions/${submission.id}/transition`, {
        method: 'POST',
        body: JSON.stringify({ to, note: note.trim() || undefined }),
      });
      onChanged();
    } catch (caught) {
      setNotice(messageFor(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={submission.title ?? submission.code} onClose={onClose}>
      <div className="space-y-4">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <Detail label="Reference" value={submission.code} />
          <Detail label="Status" value={readable(submission.status)} />
          <Detail label="Condition" value={submission.condition ? readable(submission.condition) : null} />
          <Detail
            label="Seller expects"
            value={submission.expectedPriceKobo === null ? null : formatNaira(submission.expectedPriceKobo)}
          />
          <Detail label="Seller" value={submission.seller?.displayName ?? null} />
          <Detail
            label="Seller verification"
            value={submission.seller ? readable(submission.seller.kycStatus) : null}
          />
        </dl>

        <Field label="Move to" htmlFor="declutter-transition">
          <select
            id="declutter-transition"
            value={to}
            onChange={(event) => setTo(event.target.value)}
            className="w-full rounded-xl border bg-[var(--surface-raised)] px-3.5 py-2.5"
          >
            {SUBMISSION_TRANSITIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Note" htmlFor="declutter-note" hint="Kept on the submission's history.">
          <Input
            id="declutter-note"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="e.g. Need a photo of the serial number"
          />
        </Field>

        {notice ? (
          <p role="alert" className="text-sm font-medium text-[var(--danger)]">
            {notice}
          </p>
        ) : null}

        <Button disabled={busy} onClick={() => void move()}>
          Apply
        </Button>
      </div>
    </Modal>
  );
}
