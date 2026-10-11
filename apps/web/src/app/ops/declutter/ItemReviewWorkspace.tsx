'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';

import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Field,
  Input,
  LoadingBlock,
  formatNaira,
} from '@/components/ui';
import { ApiRequestError } from '@/lib/api';
import { authedFetch, usePermissions } from '@/lib/session';
import { useStepUp } from '@/components/StepUpPrompt';

interface SubmissionSummary {
  id: string;
  code: string;
  status: string;
  title: string | null;
  condition: string | null;
  expectedPriceKobo: number | null;
  createdAt: string;
  seller?: { id: string; displayName: string; kycStatus: string };
}

interface ReviewSubmission {
  id: string;
  code: string;
  title: string | null;
  description: string | null;
  condition: string | null;
  categoryKey: string | null;
  expectedPriceKobo: number | null;
  attributes: Record<string, unknown>;
  photoCount: number;
  valueCheckStatus: string;
  escalationReasons: string[];
  authorizedPriceKobo: number | null;
  authorizationVersion: number;
  sellerAcceptedPriceKobo: number | null;
  acceptanceValid: boolean;
  seller: {
    displayName: string;
    kycStatus: string;
    sellerType: string;
  };
  openFraudFlags: number;
}

interface ReviewDetailResponse {
  submission: ReviewSubmission;
}

interface ReviewPhoto {
  id: string;
  role: string;
  position: number;
  caption: string | null;
  width: number | null;
  height: number | null;
  bytes: number | null;
  alt: string;
  url: string;
  expiresInSeconds: number;
}

interface PhotoResponse {
  photos: ReviewPhoto[];
}

const SUBMISSION_TRANSITIONS = [
  { value: 'approve_publish', label: 'Approve & Publish — final Super Admin decision' },
  { value: 'kyc_pending', label: 'Waiting on verification' },
  { value: 'details_pending', label: 'Need more detail' },
  { value: 'fraud_review', label: 'Send to fraud review' },
  { value: 'valuation_pending', label: 'Ready to value' },
  { value: 'rejected', label: 'Reject' },
] as const;

function readable(value: string): string {
  return value.replace(/_/g, ' ');
}

function messageFor(error: unknown): string {
  return error instanceof ApiRequestError ? error.message : 'Something went wrong. Try again.';
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

function formatBytes(bytes: number | null): string {
  if (bytes === null) return 'Size unavailable';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatAttributeValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  try {
    const encoded = JSON.stringify(value);
    return encoded.length > 180 ? `${encoded.slice(0, 177)}…` : encoded;
  } catch {
    return 'Recorded';
  }
}

function riskTone(count: number): 'success' | 'danger' {
  return count > 0 ? 'danger' : 'success';
}

export function ItemReviewWorkspace({
  submission,
  canWrite,
  onClose,
  onChanged,
}: {
  submission: SubmissionSummary;
  canWrite: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const {permissions} = usePermissions();
  const {run: runWithStepUp, prompt: stepUpPrompt} = useStepUp();
  const [detail, setDetail] = useState<ReviewSubmission | null>(null);
  const [photos, setPhotos] = useState<ReviewPhoto[] | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [to, setTo] = useState<string>(SUBMISSION_TRANSITIONS[1].value);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const loadEvidence = useCallback(async () => {
    setDetailError(null);
    setPhotoError(null);

    const [detailResult, photoResult] = await Promise.allSettled([
      authedFetch<ReviewDetailResponse>(`/v1/admin/declutter/submissions/${submission.id}/valuecheck`),
      authedFetch<PhotoResponse>(`/v1/admin/declutter/submissions/${submission.id}/photos`),
    ]);

    if (detailResult.status === 'fulfilled') {
      setDetail(detailResult.value.submission);
    } else {
      setDetail(null);
      setDetailError(messageFor(detailResult.reason));
    }

    if (photoResult.status === 'fulfilled') {
      setPhotos(photoResult.value.photos);
    } else {
      setPhotos([]);
      setPhotoError(messageFor(photoResult.reason));
    }
  }, [submission.id]);

  useEffect(() => {
    void loadEvidence();
  }, [loadEvidence]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  async function move() {
    setBusy(true);
    setNotice(null);
    try {
      await runWithStepUp(() => authedFetch(`/v1/admin/declutter/submissions/${submission.id}/${to === 'approve_publish' ? 'approve-publish' : 'transition'}`, {
        method: 'POST',
        body: to === 'approve_publish' ? { reason: note.trim() || undefined } : { to, note: note.trim() || undefined },
      }));
      onChanged();
    } catch (caught) {
      setNotice(messageFor(caught));
    } finally {
      setBusy(false);
    }
  }

  const attributes = Object.entries(detail?.attributes ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const current = detail ?? {
    id: submission.id,
    code: submission.code,
    title: submission.title,
    description: null,
    condition: submission.condition,
    categoryKey: null,
    expectedPriceKobo: submission.expectedPriceKobo,
    attributes: {},
    photoCount: photos?.length ?? 0,
    valueCheckStatus: 'unknown',
    escalationReasons: [],
    authorizedPriceKobo: null,
    authorizationVersion: 0,
    sellerAcceptedPriceKobo: null,
    acceptanceValid: false,
    seller: {
      displayName: submission.seller?.displayName ?? 'Unknown seller',
      kycStatus: submission.seller?.kycStatus ?? 'unknown',
      sellerType: 'unknown',
    },
    openFraudFlags: 0,
  } satisfies ReviewSubmission;

  return (
    <div className="fixed inset-0 z-50 bg-[#08111f]/60 backdrop-blur-[2px]" onMouseDown={onClose}>
      <div onMouseDown={event => event.stopPropagation()}>{stepUpPrompt}</div>
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Item review"
        className="ml-auto flex h-full w-full max-w-6xl flex-col bg-[#f6f4ee] shadow-2xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="flex items-center justify-between gap-4 border-b border-[#dfd9cd] bg-white px-5 py-4 sm:px-7">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.15em] text-[#9a782f]">{submission.code}</p>
            <h2 className="mt-1 text-xl font-bold">Item evidence review</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="grid h-10 w-10 place-items-center rounded-xl border border-[#e2ddd2] bg-[#faf9f6] text-xl hover:bg-[#f2efe8]"
            aria-label="Close item review"
          >
            ×
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-7">
          <div className="space-y-5">
            <div className="rounded-[26px] bg-[#08111f] p-5 text-white shadow-sm sm:p-7">
              <div className="flex flex-wrap items-start justify-between gap-5">
                <div className="min-w-0">
                  <p className="text-xs font-bold tracking-[0.15em] text-[#d5b466]">PRIVATE SUBMISSION</p>
                  <h3 className="mt-2 break-words text-2xl font-bold sm:text-3xl">{current.title ?? 'Untitled item'}</h3>
                  <p className="mt-2 text-sm text-white/55">Received {formatDate(submission.createdAt)}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Badge tone={current.seller.kycStatus === 'verified' ? 'success' : 'warning'}>
                    seller {readable(current.seller.kycStatus)}
                  </Badge>
                  <Badge tone={riskTone(current.openFraudFlags)}>
                    {current.openFraudFlags === 0 ? 'no open fraud flags' : `${current.openFraudFlags} fraud flag${current.openFraudFlags === 1 ? '' : 's'}`}
                  </Badge>
                </div>
              </div>
            </div>

            {detailError ? (
              <ErrorState title="Some item details could not be loaded" message={detailError} onRetry={() => void loadEvidence()} />
            ) : null}

            <div className="grid gap-5 xl:grid-cols-[1.4fr_.6fr]">
              <ReviewCard
                title="Submitted photographs"
                description="These are the seller's private item photos. Open any image at full size to inspect labels, damage and possession evidence."
                action={<Button size="sm" variant="ghost" onClick={() => void loadEvidence()}>Refresh secure links</Button>}
              >
                {photoError ? <ErrorState title="Could not load item photographs" message={photoError} onRetry={() => void loadEvidence()} /> : null}
                {photos === null && !photoError ? <LoadingBlock label="Loading item photographs" /> : null}
                {photos !== null && photos.length === 0 && !photoError ? (
                  <EmptyState title="No photographs available" description="Do not approve an item as review-ready until the seller has supplied clear photographs." />
                ) : null}
                {photos && photos.length > 0 ? (
                  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                    {photos.map((photo) => (
                      <button
                        key={photo.id}
                        type="button"
                        onClick={() => window.open(photo.url, '_blank', 'noopener,noreferrer')}
                        className="group overflow-hidden rounded-2xl border border-[#e4ded2] bg-[#f4f1e9] text-left"
                        aria-label={`Open ${readable(photo.role)} photograph`}
                      >
                        <div
                          role="img"
                          aria-label={photo.alt}
                          className="aspect-[4/3] w-full bg-[#e9e4da] bg-cover bg-center transition duration-200 group-hover:scale-[1.01]"
                          style={{ backgroundImage: `url(${JSON.stringify(photo.url).slice(1, -1)})` }}
                        />
                        <div className="p-3">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-xs font-bold uppercase tracking-[0.1em] text-[#79622e]">{readable(photo.role)}</span>
                            <span className="text-[10px] text-[#8a9098]">{formatBytes(photo.bytes)}</span>
                          </div>
                          <p className="mt-1 line-clamp-2 text-xs leading-5 text-[#646d78]">{photo.caption || 'No seller caption'}</p>
                        </div>
                      </button>
                    ))}
                  </div>
                ) : null}
              </ReviewCard>

              <div className="space-y-5">
                <ReviewCard title="Trust & risk" description="Signals guide a human review; none of them silently approves the item.">
                  <div className="space-y-2">
                    <EvidenceRow label="Seller verification" value={readable(current.seller.kycStatus)} tone={current.seller.kycStatus === 'verified' ? 'good' : 'warn'} />
                    <EvidenceRow label="Photos on record" value={String(photos?.length ?? current.photoCount)} tone={(photos?.length ?? current.photoCount) > 0 ? 'good' : 'warn'} />
                    <EvidenceRow label="Open fraud flags" value={String(current.openFraudFlags)} tone={current.openFraudFlags === 0 ? 'good' : 'bad'} />
                    <EvidenceRow label="ValueCheck state" value={readable(current.valueCheckStatus)} tone="neutral" />
                  </div>
                  {current.escalationReasons.length > 0 ? (
                    <div className="mt-4 rounded-xl border border-[#ead9bc] bg-[#fff8e8] p-3">
                      <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#8c681e]">Escalation reasons</p>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {current.escalationReasons.map((reason) => <Badge key={reason} tone="warning">{readable(reason)}</Badge>)}
                      </div>
                    </div>
                  ) : null}
                </ReviewCard>

                <ReviewCard title="Seller" description="Who submitted this item.">
                  <div className="space-y-2">
                    <EvidenceRow label="Display name" value={current.seller.displayName} tone="neutral" />
                    <EvidenceRow label="Seller type" value={readable(current.seller.sellerType)} tone="neutral" />
                    <EvidenceRow label="KYC" value={readable(current.seller.kycStatus)} tone={current.seller.kycStatus === 'verified' ? 'good' : 'warn'} />
                  </div>
                  {submission.seller?.id ? <p className="mt-3 break-all font-mono text-[10px] text-[#92979e]">Seller ref: {submission.seller.id}</p> : null}
                </ReviewCard>
              </div>
            </div>

            <div className="grid gap-5 lg:grid-cols-2">
              <ReviewCard title="Item facts" description="What the seller declared about the item.">
                <div className="grid gap-3 sm:grid-cols-2">
                  <DataTile label="Reference" value={current.code} />
                  <DataTile label="Category" value={current.categoryKey ? readable(current.categoryKey) : null} />
                  <DataTile label="Condition" value={current.condition ? readable(current.condition) : null} />
                  <DataTile label="Workflow" value={readable(submission.status)} />
                </div>
                <div className="mt-4 rounded-xl bg-[#f8f6f1] p-4">
                  <p className="text-[10px] font-bold uppercase tracking-[0.13em] text-[#8d8578]">Seller description</p>
                  <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-[#414b58]">{current.description || 'No description supplied.'}</p>
                </div>
              </ReviewCard>

              <ReviewCard title="Pricing trail" description="Seller expectation, DASH authority and seller acceptance are deliberately separate.">
                <div className="grid gap-3 sm:grid-cols-2">
                  <DataTile label="Seller expects" value={current.expectedPriceKobo === null ? null : formatNaira(current.expectedPriceKobo)} />
                  <DataTile label="DASH authorised" value={current.authorizedPriceKobo === null ? null : formatNaira(current.authorizedPriceKobo)} />
                  <DataTile label="Seller accepted" value={current.sellerAcceptedPriceKobo === null ? null : formatNaira(current.sellerAcceptedPriceKobo)} />
                  <DataTile label="Acceptance current" value={current.sellerAcceptedPriceKobo === null ? null : current.acceptanceValid ? 'Yes' : 'No — price changed or expired'} />
                </div>
              </ReviewCard>
            </div>

            <ReviewCard
              title="Submitted identifiers & specifications"
              description="Category-specific answers such as model, storage, serial or IMEI stay inside the DASH staff review boundary."
            >
              {detail === null && !detailError ? <LoadingBlock label="Loading item specifications" /> : null}
              {detail && attributes.length === 0 ? (
                <EmptyState title="No structured specifications" description="This submission did not include category-specific answers." />
              ) : null}
              {attributes.length > 0 ? (
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {attributes.map(([key, value]) => (
                    <DataTile key={key} label={readable(key)} value={formatAttributeValue(value)} />
                  ))}
                </div>
              ) : null}
              <p className="mt-4 rounded-xl bg-[#f4efe2] px-4 py-3 text-xs leading-5 text-[#6d5a2f]">
                Sensitive item identifiers are for ownership and fraud review. The ValueCheck provider receives only attributes explicitly approved for valuation.
              </p>
            </ReviewCard>

            <ReviewCard title="Workflow decision" description="Move the item only when the evidence supports the next state. Notes remain on its history.">
              <div className="grid gap-4 lg:grid-cols-2">
                <Field label="Move to" htmlFor={`declutter-transition-${submission.id}`}>
                  <select
                    id={`declutter-transition-${submission.id}`}
                    value={to}
                    onChange={(event) => setTo(event.target.value)}
                    className="w-full rounded-xl border border-[#dcd6ca] bg-white px-3.5 py-2.5 text-sm"
                  >
                    {SUBMISSION_TRANSITIONS.filter(option => option.value !== 'approve_publish' || permissions.has('declutter:pricing:authorize')).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                </Field>
                <Field label="Review note" htmlFor={`declutter-transition-note-${submission.id}`} hint="Be specific enough that another reviewer can understand the decision later.">
                  <Input
                    id={`declutter-transition-note-${submission.id}`}
                    value={note}
                    onChange={(event) => setNote(event.target.value)}
                    placeholder="e.g. Serial label is blurred; request a clear close-up"
                  />
                </Field>
              </div>
              {notice ? <p role="alert" className="mt-4 rounded-xl bg-[#fff2ef] px-4 py-3 text-sm font-medium text-[#a94336]">{notice}</p> : null}
              <div className="mt-5 flex flex-wrap items-center gap-3">
                <Button disabled={busy || !canWrite} onClick={() => void move()}>{busy ? 'Applying…' : 'Apply workflow decision'}</Button>
                <Button variant="ghost" disabled={busy} onClick={() => void loadEvidence()}>Reload evidence</Button>
              </div>
              {!canWrite ? <p className="mt-3 text-xs text-[#7b828c]">Your staff role can inspect this evidence but cannot change the submission workflow.</p> : null}
            </ReviewCard>
          </div>
        </div>
      </aside>
    </div>
  );
}

function ReviewCard({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-[22px] border border-[#e9e4da] bg-white p-5 shadow-[0_1px_0_rgba(12,20,31,0.02)]">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h4 className="text-base font-bold">{title}</h4>
          {description ? <p className="mt-1 max-w-2xl text-xs leading-5 text-[#7a818c]">{description}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function DataTile({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="rounded-xl bg-[#f8f6f1] px-4 py-3">
      <p className="text-[10px] font-bold uppercase tracking-[0.13em] text-[#8d8578]">{label}</p>
      <p className="mt-1 break-words text-sm font-semibold text-[#222b37]">{value || '—'}</p>
    </div>
  );
}

function EvidenceRow({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: 'good' | 'warn' | 'bad' | 'neutral';
}) {
  const styles = {
    good: 'bg-[#e1f3ef] text-[#1b7067]',
    warn: 'bg-[#fff1d2] text-[#8c681e]',
    bad: 'bg-[#fde9e6] text-[#a94336]',
    neutral: 'bg-[#eef1f4] text-[#56616e]',
  }[tone];
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl bg-[#f8f6f1] px-4 py-3">
      <span className="text-sm text-[#5b6571]">{label}</span>
      <span className={`max-w-[60%] rounded-full px-2.5 py-1 text-right text-[10px] font-bold uppercase tracking-[0.08em] ${styles}`}>{value}</span>
    </div>
  );
}
