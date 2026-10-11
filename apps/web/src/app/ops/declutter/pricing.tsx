'use client';

import { useCallback, useEffect, useState } from 'react';
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
import { useStepUp } from '@/components/StepUpPrompt';
import { ApiRequestError } from '@/lib/api';
import { authedFetch } from '@/lib/session';

/**
 * The DASH ValueCheck workspace.
 *
 * A reviewer's screen, and it is built around one rule: the model's
 * recommendation and the human's decision are always shown as two separate
 * things. There is no control here that overwrites the AI figure, and the
 * proposed price starts as a copy the reviewer has to change deliberately —
 * so nothing on this page can end up implying ValueCheck recommended a number
 * a person chose.
 *
 * Confidence is shown next to the warnings that produced it rather than as a
 * lone percentage, because "84%" tells a reviewer nothing while "84%, and no
 * photograph shows a label" tells them where to look.
 *
 * Every result carries the provider that produced it. When that provider is
 * the local deterministic adapter the page says so outright, so development
 * arithmetic can never be mistaken for a live valuation.
 */

interface Warning {
  code: string;
  detail: string;
}
interface Factor {
  label: string;
  direction: 'raises' | 'lowers' | 'neutral';
  weight: 'high' | 'medium' | 'low';
}
interface Comparable {
  id: string;
  source: string;
  description: string;
  condition: string | null;
  market: string | null;
  askingPriceKobo: number | null;
  soldPriceKobo: number | null;
  observedAt: string;
}
interface Valuation {
  id: string;
  provider: string | null;
  isLive: boolean;
  estimatedLowKobo: number | null;
  estimatedHighKobo: number | null;
  recommendedPriceKobo: number | null;
  confidenceBasisPoints: number | null;
  factors: Factor[];
  warnings: Warning[];
  reasoning: string | null;
  evidenceSummary: string | null;
  createdAt: string;
}
interface Decision {
  id: string;
  actorRole: string;
  kind: string;
  recommendedPriceKobo: number | null;
  proposedPriceKobo: number | null;
  reason: string | null;
  createdAt: string;
}
interface Workspace {
  submission: {
    id: string;
    code: string;
    title: string | null;
    condition: string | null;
    categoryKey: string | null;
    expectedPriceKobo: number | null;
    submittedPriceConsentKobo: number | null;
    submittedPriceConsentAt: string | null;
    attributes: Record<string, unknown>;
    photoCount: number;
    valueCheckStatus: string;
    escalationReasons: string[];
    authorizedPriceKobo: number | null;
    authorizationVersion: number;
    sellerAcceptedPriceKobo: number | null;
    acceptanceValid: boolean;
    seller: { displayName: string; kycStatus: string; sellerType: string };
    openFraudFlags: number;
  };
  comparables: Comparable[];
  valuation: Valuation | null;
  decisions: Decision[];
}

const ESCALATION_LABELS: Record<string, string> = {
  price_at_or_above_threshold: 'At or above the approval threshold',
  low_confidence: 'ValueCheck confidence is low',
  fraud_flag: 'An open fraud or duplicate-image flag',
  kyc_concern: 'A concern on the seller’s verification',
  large_admin_adjustment: 'The admin moved the price a long way',
  suspicious_comparables: 'The comparable evidence looks unreliable',
  high_risk_category: 'A category that always needs approval',
  trusted_partner_exception: 'A Trusted Partner exception was applied',
  manual_escalation: 'Escalated by hand',
  evidence_inconsistent: 'The valuation evidence contradicts itself',
};

function readable(value: string): string {
  return value.replace(/_/g, ' ');
}
function messageFor(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  return 'Something went wrong. Try again.';
}
function confidencePercent(basisPoints: number | null): string {
  return basisPoints === null ? '—' : `${Math.round(basisPoints / 100)}%`;
}

// ---------------------------------------------------------------------------

export function PricingQueue({ canAuthorize }: { canAuthorize: boolean }) {
  const [rows, setRows] = useState<{ id: string; code: string; title: string | null }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await authedFetch<{ submissions: { id: string; code: string; title: string | null }[] }>(
        '/v1/admin/declutter/submissions?status=valuation_pending',
      );
      setRows(data.submissions);
    } catch (caught) {
      setError(messageFor(caught));
      setRows([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="space-y-4" aria-label="ValueCheck queue">
      {canAuthorize ? <ApprovalQueue onOpen={setOpenId} /> : null}

      <h2 className="text-sm font-semibold">Awaiting valuation</h2>
      {error ? <ErrorState title="Could not load" message={error} onRetry={() => void load()} /> : null}
      {rows === null && !error ? <LoadingBlock label="Loading" /> : null}
      {rows !== null && rows.length === 0 && !error ? (
        <EmptyState title="Nothing waiting" description="No submissions are ready to value." />
      ) : null}

      <ul className="space-y-2">
        {(rows ?? []).map((row) => (
          <li key={row.id}>
            <Card className="flex flex-wrap items-center gap-3 p-4">
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold">{row.title ?? 'Untitled'}</p>
                <p className="text-xs text-[var(--ink-muted)]">{row.code}</p>
              </div>
              <Button size="sm" variant="secondary" onClick={() => setOpenId(row.id)}>
                ValueCheck
              </Button>
            </Card>
          </li>
        ))}
      </ul>

      {openId ? (
        <WorkspaceModal
          submissionId={openId}
          canAuthorize={canAuthorize}
          onClose={() => setOpenId(null)}
          onChanged={() => void load()}
        />
      ) : null}
    </section>
  );
}

/** Prices waiting on a super admin, and why each is here. */
function ApprovalQueue({ onOpen }: { onOpen: (id: string) => void }) {
  const { run: runWithStepUp, prompt: stepUpPrompt } = useStepUp();
  const [rows, setRows] = useState<
    | {
        id: string;
        code: string;
        title: string | null;
        proposedPriceKobo: number | null;
        escalationReasons: string[];
      }[]
    | null
  >(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await runWithStepUp(() =>
        authedFetch<{ approvals: NonNullable<typeof rows> }>(
          '/v1/admin/declutter/approvals',
        ),
      );
      if (data === undefined) return;
      setRows(data.approvals);
    } catch (caught) {
      setError(messageFor(caught));
      setRows([]);
    }
  }, [runWithStepUp]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) {
    // Most often a missing step-up. The API's own wording is the useful thing
    // to show, rather than hiding the queue and explaining nothing.
    return <>{stepUpPrompt}<ErrorState title="Approvals unavailable" message={error} onRetry={() => void load()} /></>;
  }
  if (rows === null) return <>{stepUpPrompt}<LoadingBlock label="Loading approvals" /></>;
  if (rows.length === 0) return <>{stepUpPrompt}</>;

  return (
    <div className="space-y-2">
      {stepUpPrompt}
      <h2 className="text-sm font-semibold">Waiting on your approval</h2>
      <ul className="space-y-2">
        {rows.map((row) => (
          <li key={row.id}>
            <Card className="space-y-2 p-4">
              <div className="flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold">{row.title ?? 'Untitled'}</p>
                  <p className="text-xs text-[var(--ink-muted)]">{row.code}</p>
                </div>
                {row.proposedPriceKobo === null ? null : (
                  <span className="font-semibold">{formatNaira(row.proposedPriceKobo)}</span>
                )}
                <Button size="sm" onClick={() => onOpen(row.id)}>
                  Review
                </Button>
              </div>
              <div className="flex flex-wrap gap-1">
                {row.escalationReasons.map((reason) => (
                  <Badge key={reason} tone="warning">
                    {ESCALATION_LABELS[reason] ?? readable(reason)}
                  </Badge>
                ))}
              </div>
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------

function WorkspaceModal({
  submissionId,
  canAuthorize,
  onClose,
  onChanged,
}: {
  submissionId: string;
  canAuthorize: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [data, setData] = useState<Workspace | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [priceNaira, setPriceNaira] = useState('');
  const [reason, setReason] = useState('');
  const { run: runWithStepUp, prompt: stepUpPrompt } = useStepUp();

  const load = useCallback(async () => {
    setError(null);
    try {
      const body = await authedFetch<Workspace>(
        `/v1/admin/declutter/submissions/${submissionId}/valuecheck`,
      );
      setData(body);
      // Pre-filled with the recommendation, so an adjustment is something the
      // reviewer types rather than something that happens by default.
      if (body.valuation?.recommendedPriceKobo) {
        setPriceNaira(String(body.valuation.recommendedPriceKobo / 100));
      }
    } catch (caught) {
      setError(messageFor(caught));
    }
  }, [submissionId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function call(path: string, body: Record<string, unknown>) {
    setBusy(true);
    setNotice(null);
    try {
      const completed = await runWithStepUp(async () => {
        await authedFetch(`/v1/admin/declutter/submissions/${submissionId}/${path}`, {
          method: 'POST',
          body,
        });
        return true;
      });
      if (!completed) return;
      await load();
      onChanged();
    } catch (caught) {
      setNotice(messageFor(caught));
    } finally {
      setBusy(false);
    }
  }

  const recommended = data?.valuation?.recommendedPriceKobo ?? null;
  const typedKobo = Math.round(Number(priceNaira || '0') * 100);
  const isAdjustment = recommended !== null && typedKobo !== recommended;

  return (
    <Modal title="DASH ValueCheck" onClose={onClose}>
      {stepUpPrompt}
      {error ? <ErrorState title="Could not open" message={error} onRetry={() => void load()} /> : null}
      {!data && !error ? <LoadingBlock label="Loading" /> : null}

      {data ? (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">{data.submission.title ?? data.submission.code}</span>
            <Badge tone="neutral">{readable(data.submission.valueCheckStatus)}</Badge>
            {data.submission.openFraudFlags > 0 ? <Badge tone="danger">Fraud flag</Badge> : null}
            {data.submission.seller.kycStatus !== 'verified' ? (
              <Badge tone="warning">Seller {readable(data.submission.seller.kycStatus)}</Badge>
            ) : null}
          </div>

          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <Row label="Category" value={data.submission.categoryKey} />
            <Row label="Condition" value={data.submission.condition ? readable(data.submission.condition) : null} />
            <Row
              label="Seller expects"
              value={
                data.submission.expectedPriceKobo === null
                  ? null
                  : formatNaira(data.submission.expectedPriceKobo)
              }
            />
              <Row label="Seller price pre-authorisation" value={data.submission.submittedPriceConsentAt && data.submission.submittedPriceConsentKobo !== null ? `Exact submitted price only: ${formatNaira(data.submission.submittedPriceConsentKobo)}` : 'Not given — seller must accept the authorised price'} />
              <Row label="Photographs" value={String(data.submission.photoCount)} />
            {Object.entries(data.submission.attributes).map(([key, value]) => (
              <Row key={key} label={readable(key)} value={String(value)} />
            ))}
          </dl>

          <ComparableSection
            submissionId={submissionId}
            comparables={data.comparables}
            onChanged={() => void load()}
          />

          <section className="space-y-2">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold">Valuation</h3>
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => void call('valuecheck', {})}>
                {data.valuation ? 'Run again' : 'Run ValueCheck'}
              </Button>
            </div>

            {!data.valuation ? (
              <p className="text-sm text-[var(--ink-muted)]">Not valued yet.</p>
            ) : (
              <div className="space-y-2 rounded-xl border p-3 text-sm">
                {!data.valuation.isLive ? (
                  // Never dressed up. Development arithmetic is not a valuation
                  // service, and the screen says which one produced this.
                  <Badge tone="warning">
                    Local adapter ({data.valuation.provider}) — not live AI
                  </Badge>
                ) : (
                  <Badge tone="neutral">{data.valuation.provider}</Badge>
                )}

                <p>
                  <strong>Recommended {formatNaira(data.valuation.recommendedPriceKobo ?? 0)}</strong>
                  {data.valuation.estimatedLowKobo !== null &&
                  data.valuation.estimatedHighKobo !== null ? (
                    <span className="text-[var(--ink-muted)]">
                      {' '}
                      · range {formatNaira(data.valuation.estimatedLowKobo)}–
                      {formatNaira(data.valuation.estimatedHighKobo)}
                    </span>
                  ) : null}
                  <span className="text-[var(--ink-muted)]">
                    {' '}
                    · confidence {confidencePercent(data.valuation.confidenceBasisPoints)}
                  </span>
                </p>

                {data.valuation.warnings.length > 0 ? (
                  <ul className="space-y-1">
                    {data.valuation.warnings.map((warning) => (
                      <li key={warning.code} className="text-xs text-[var(--ink-muted)]">
                        ⚠ {warning.detail}
                      </li>
                    ))}
                  </ul>
                ) : null}

                {data.valuation.factors.length > 0 ? (
                  <p className="text-xs text-[var(--ink-muted)]">
                    {data.valuation.factors
                      .map((factor) => `${factor.label} (${factor.direction})`)
                      .join(' · ')}
                  </p>
                ) : null}

                {data.valuation.reasoning ? (
                  <p className="text-xs text-[var(--ink-muted)]">{data.valuation.reasoning}</p>
                ) : null}
              </div>
            )}
          </section>

          {data.decisions.length > 0 ? (
            <section className="space-y-1">
              <h3 className="text-sm font-semibold">Decisions</h3>
              <ul className="space-y-1 text-xs text-[var(--ink-muted)]">
                {data.decisions.map((decision) => (
                  <li key={decision.id}>
                    {readable(decision.actorRole)} · {decision.kind}
                    {decision.recommendedPriceKobo !== null && decision.proposedPriceKobo !== null
                      ? ` · ${formatNaira(decision.recommendedPriceKobo)} → ${formatNaira(decision.proposedPriceKobo)}`
                      : ''}
                    {decision.reason ? ` · ${decision.reason}` : ''}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {data.submission.escalationReasons.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {data.submission.escalationReasons.map((code) => (
                <Badge key={code} tone="warning">
                  {ESCALATION_LABELS[code] ?? readable(code)}
                </Badge>
              ))}
            </div>
          ) : null}

          {data.submission.authorizedPriceKobo !== null ? (
            <p className="text-sm">
              Authorised at <strong>{formatNaira(data.submission.authorizedPriceKobo)}</strong> (v
              {data.submission.authorizationVersion}) ·{' '}
              {data.submission.acceptanceValid ? 'seller has accepted' : 'awaiting the seller'}
            </p>
          ) : null}

          <Field label="Price (₦)" htmlFor="vc-price" hint="Changing this records an adjustment.">
            <Input
              id="vc-price"
              inputMode="numeric"
              value={priceNaira}
              onChange={(event) => setPriceNaira(event.target.value)}
            />
          </Field>
          <Field
            label="Reason"
            htmlFor="vc-reason"
            hint="Required to adjust or reject. Kept with the decision."
          >
            <Input
              id="vc-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="e.g. Two comparable Lagos listings are currently under ₦440,000"
            />
          </Field>

          {notice ? (
            <p role="alert" className="text-sm font-medium text-[var(--danger)]">
              {notice}
            </p>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <Button
              disabled={busy || !data.valuation}
              onClick={() =>
                void call('pricing-decision', {
                  kind: isAdjustment ? 'adjusted' : 'approved',
                  ...(isAdjustment ? { adminPriceKobo: typedKobo, reason: reason.trim() } : {}),
                })
              }
            >
              {isAdjustment ? 'Adjust & submit' : 'Approve recommendation'}
            </Button>
            <Button
              variant="secondary"
              disabled={busy || !data.valuation}
              onClick={() =>
                void call('pricing-decision', { kind: 'approved', escalate: true })
              }
            >
              Send to super admin
            </Button>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => void call('pricing-decision', { kind: 'rejected', reason: reason.trim() })}
            >
              Reject
            </Button>
          </div>

          {canAuthorize && data.submission.valueCheckStatus === 'super_admin_approval_pending' ? (
            <div className="space-y-2 rounded-xl border-2 p-3">
              <h3 className="text-sm font-semibold">Super admin authorisation</h3>
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={busy}
                  onClick={() =>
                    void call('authorize', {
                      kind: isAdjustment ? 'adjusted' : 'approved',
                      ...(isAdjustment ? { priceKobo: typedKobo, reason: reason.trim() } : {}),
                    })
                  }
                >
                  {isAdjustment ? 'Adjust & authorise' : 'Authorise'}
                </Button>
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => void call('authorize', { kind: 'returned', reason: reason.trim() })}
                >
                  Return for review
                </Button>
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => void call('authorize', { kind: 'rejected', reason: reason.trim() })}
                >
                  Reject
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </Modal>
  );
}

function ComparableSection({
  submissionId,
  comparables,
  onChanged,
}: {
  submissionId: string;
  comparables: Comparable[];
  onChanged: () => void;
}) {
  const [source, setSource] = useState('');
  const [description, setDescription] = useState('');
  const [asking, setAsking] = useState('');
  const [sold, setSold] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function add() {
    setBusy(true);
    setNotice(null);
    try {
      await authedFetch(`/v1/admin/declutter/submissions/${submissionId}/comparables`, {
        method: 'POST',
        body: {
          source: source.trim(),
          description: description.trim(),
          ...(asking ? { askingPriceKobo: Math.round(Number(asking) * 100) } : {}),
          ...(sold ? { soldPriceKobo: Math.round(Number(sold) * 100) } : {}),
          observedAt: new Date().toISOString(),
        },
      });
      setSource('');
      setDescription('');
      setAsking('');
      setSold('');
      onChanged();
    } catch (caught) {
      setNotice(messageFor(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold">Market comparables</h3>
      {comparables.length === 0 ? (
        <p className="text-sm text-[var(--ink-muted)]">
          None yet. A valuation with no comparable evidence is capped at low confidence.
        </p>
      ) : (
        <ul className="space-y-1 text-sm">
          {comparables.map((comparable) => (
            <li key={comparable.id} className="flex flex-wrap gap-2 rounded-lg border p-2">
              <span className="flex-1">{comparable.description}</span>
              <span className="text-xs text-[var(--ink-muted)]">{comparable.source}</span>
              {comparable.soldPriceKobo !== null ? (
                // A confirmed sale is worth more than a hope, and the screen
                // should not let the two look alike.
                <Badge tone="success">sold {formatNaira(comparable.soldPriceKobo)}</Badge>
              ) : null}
              {comparable.askingPriceKobo !== null ? (
                <Badge tone="neutral">asking {formatNaira(comparable.askingPriceKobo)}</Badge>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <div className="grid gap-2 sm:grid-cols-2">
        <Input placeholder="Source" value={source} onChange={(e) => setSource(e.target.value)} />
        <Input
          placeholder="What it was"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <Input
          placeholder="Asking ₦"
          inputMode="numeric"
          value={asking}
          onChange={(e) => setAsking(e.target.value)}
        />
        <Input
          placeholder="Sold ₦ (only if confirmed)"
          inputMode="numeric"
          value={sold}
          onChange={(e) => setSold(e.target.value)}
        />
      </div>
      {notice ? (
        <p role="alert" className="text-xs font-medium text-[var(--danger)]">
          {notice}
        </p>
      ) : null}
      <Button size="sm" variant="secondary" disabled={busy} onClick={() => void add()}>
        Add comparable
      </Button>
    </section>
  );
}

function Row({ label, value }: { label: string; value: string | null }) {
  return (
    <>
      <dt className="text-[var(--ink-muted)]">{label}</dt>
      <dd className="font-medium">{value ?? '—'}</dd>
    </>
  );
}
