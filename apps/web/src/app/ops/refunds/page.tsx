'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

import { AppHeader } from '@/components/AppHeader';
import { useStepUp } from '@/components/StepUpPrompt';
import { Badge, Button, Card, EmptyState, ErrorState, Input, LoadingBlock, formatNaira } from '@/components/ui';
import { ApiRequestError } from '@/lib/api';
import { authedFetch, useHasSession, usePermissions } from '@/lib/session';

/**
 * Refunds owed, and confirming them with Paystack.
 *
 * DASH does not send refunds by itself. A refund is owed when an order is
 * cancelled after payment or finance approves one; a person returns the money
 * in the Paystack dashboard; then, here, they enter the refund ID Paystack
 * shows. The server asks Paystack about that ID and marks the refund done only
 * if Paystack reports it processed, for this payment, for exactly this amount.
 * There is no button that marks a refund done without Paystack's answer.
 */

type Filter = 'open' | 'refund_pending_manual_review' | 'refund_processing' | 'refund_failed' | 'refunded' | 'all';

interface Refund {
  id: string;
  amount: number;
  reason: string;
  status: string;
  label: string;
  providerRefundReference: string | null;
  providerStatus: string | null;
  providerCheckedAt: string | null;
  refundedAt: string | null;
  createdAt: string;
  paymentProvider: string;
  paymentReference: string;
  order: { id: string; code: string };
  /** Set when a person has to act on it now; decided by the server. */
  awaitingPerson: 'overdue' | 'failed' | 'needs_attention' | null;
}

/** What to do about a refund that is waiting on a person. */
const AWAITING: Record<NonNullable<Refund['awaitingPerson']>, { badge: string; text: string }> = {
  overdue: {
    badge: 'Overdue',
    text: 'Owed for more than two days and not yet refunded in Paystack. Refund it there, then enter its ID below.',
  },
  failed: {
    badge: 'Failed at Paystack',
    text: 'Paystack could not complete this refund, so the customer is still owed. Issue a new refund in Paystack and enter its ID below.',
  },
  needs_attention: {
    badge: 'Needs attention in Paystack',
    text: 'Paystack cannot finish this refund until someone acts on it in the Paystack dashboard. DASH will mark it refunded once Paystack processes it.',
  },
};

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'open', label: 'Still owed' },
  { value: 'refund_processing', label: 'Processing at Paystack' },
  { value: 'refund_failed', label: 'Failed' },
  { value: 'refunded', label: 'Refunded' },
  { value: 'all', label: 'All' },
];

function messageFor(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  return 'Something went wrong. Try again.';
}

export default function RefundsPage() {
  const hasSession = useHasSession();
  const { permissions, loaded } = usePermissions();
  const canRead = permissions.has('finance:payment:read');
  const canConfirm = permissions.has('finance:refund:approve');

  if (!hasSession) {
    return (
      <div className="min-h-dvh">
        <AppHeader variant="staff" />
        <main className="mx-auto max-w-5xl px-4 py-10">
          <EmptyState
            title="Sign in to continue"
            description="Refunds are for DASH finance staff."
            action={
              <Link href="/signin">
                <Button>Sign in</Button>
              </Link>
            }
          />
        </main>
      </div>
    );
  }

  if (loaded && !canRead) {
    return (
      <div className="min-h-dvh">
        <AppHeader variant="staff" />
        <main className="mx-auto max-w-5xl px-4 py-10">
          <EmptyState title="No access" description="Your account cannot see refunds." />
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-dvh">
      <AppHeader variant="staff" />
      <main id="main" className="mx-auto max-w-5xl space-y-6 px-4 py-8">
        <header className="space-y-2">
          <h1 className="text-2xl font-bold">Refunds</h1>
          <p className="text-sm text-[var(--ink-muted)]">
            Refund each one in the Paystack dashboard first — search Paystack for the payment reference shown. Then
            enter the refund ID Paystack gives you. DASH asks Paystack, and marks the refund done only when Paystack
            says it has been processed for this payment and this amount.
          </p>
        </header>
        <Queue canConfirm={canConfirm} />
      </main>
    </div>
  );
}

function Queue({ canConfirm }: { canConfirm: boolean }) {
  const [filter, setFilter] = useState<Filter>('open');
  const [refunds, setRefunds] = useState<Refund[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { run, prompt } = useStepUp();

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await authedFetch<{ refunds: Refund[] }>(`/v1/finance/refunds?status=${filter}`);
      setRefunds(data.refunds);
    } catch (caught) {
      setError(messageFor(caught));
    }
  }, [filter]);

  useEffect(() => {
    setRefunds(null);
    void load();
  }, [load]);

  return (
    <section className="space-y-4">
      {prompt}
      <div className="flex flex-wrap gap-2" role="group" aria-label="Filter refunds">
        {FILTERS.map((option) => (
          <Button
            key={option.value}
            size="sm"
            variant={filter === option.value ? 'primary' : 'ghost'}
            onClick={() => setFilter(option.value)}
            aria-pressed={filter === option.value}
          >
            {option.label}
          </Button>
        ))}
      </div>
      {error ? <ErrorState message={error} onRetry={() => void load()} /> : null}
      {!error && refunds === null ? <LoadingBlock label="Loading refunds" /> : null}
      {refunds && refunds.length === 0 ? <EmptyState title="Nothing here" description="No refunds in this list." /> : null}
      {refunds?.map((refund) => (
        <RefundCard
          key={refund.id}
          refund={refund}
          canConfirm={canConfirm}
          confirm={(refundReference) =>
            run(() =>
              authedFetch<{ status: string; label: string; providerStatus: string; changed: boolean }>(
                `/v1/finance/refunds/${refund.id}/confirm`,
                { method: 'POST', body: refundReference ? { refundReference } : {} },
              ),
            )
          }
          onChanged={() => void load()}
        />
      ))}
    </section>
  );
}

function RefundCard({
  refund,
  canConfirm,
  confirm,
  onChanged,
}: {
  refund: Refund;
  canConfirm: boolean;
  confirm: (
    refundReference: string | undefined,
  ) => Promise<{ status: string; label: string; providerStatus: string; changed: boolean } | undefined>;
  onChanged: () => void;
}) {
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'problem'; text: string } | null>(null);
  const done = refund.status === 'refunded';
  const processing = refund.status === 'refund_processing';
  const inputId = `paystack-refund-${refund.id}`;

  async function act(withReference: boolean) {
    const entered = reference.trim();
    if (withReference && !/^\d+$/.test(entered)) {
      setNotice({ tone: 'problem', text: 'Enter the refund ID exactly as Paystack shows it — digits only.' });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const result = await confirm(withReference ? entered : undefined);
      if (result) {
        setNotice({
          tone: result.status === 'refunded' ? 'ok' : 'problem',
          text:
            result.status === 'refunded'
              ? 'Paystack confirmed this refund. The customer now sees it as refunded.'
              : result.status === 'refund_processing'
                ? `Paystack says “${result.providerStatus}”. Linked — it will complete when Paystack finishes.`
                : `Paystack reports this refund failed (“${result.providerStatus}”). The customer is still owed.`,
        });
        setReference('');
        onChanged();
      }
    } catch (caught) {
      setNotice({ tone: 'problem', text: messageFor(caught) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-3 p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-lg font-bold">{formatNaira(refund.amount)}</h2>
          <p className="text-sm text-[var(--ink-muted)]">
            Order {refund.order.code} · {refund.reason}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {refund.awaitingPerson ? <Badge tone="danger">{AWAITING[refund.awaitingPerson].badge}</Badge> : null}
          <Badge>{refund.label}</Badge>
        </div>
      </div>
      {refund.awaitingPerson ? (
        <p className="text-sm font-medium text-[var(--danger)]">{AWAITING[refund.awaitingPerson].text}</p>
      ) : null}
      <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        <Detail label="Payment reference" value={refund.paymentReference} mono />
        <Detail label="Taken through" value={refund.paymentProvider} />
        <Detail label="Owed since" value={new Date(refund.createdAt).toLocaleString()} />
        {refund.providerRefundReference ? (
          <Detail label="Paystack refund" value={refund.providerRefundReference.replace('paystack_refund_', '')} mono />
        ) : null}
        {refund.providerStatus ? (
          <Detail
            label="Paystack says"
            value={`${refund.providerStatus}${
              refund.providerCheckedAt ? ` (checked ${new Date(refund.providerCheckedAt).toLocaleString()})` : ''
            }`}
          />
        ) : null}
        {refund.refundedAt ? <Detail label="Confirmed" value={new Date(refund.refundedAt).toLocaleString()} /> : null}
      </dl>

      {canConfirm && !done && refund.paymentProvider === 'paystack' ? (
        <div className="space-y-2">
          {processing ? (
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => void act(false)}>
              Check with Paystack again
            </Button>
          ) : (
            <>
              <label className="block text-sm font-medium" htmlFor={inputId}>
                Paystack refund ID
              </label>
              <div className="flex flex-wrap gap-2">
                <Input
                  id={inputId}
                  inputMode="numeric"
                  autoComplete="off"
                  value={reference}
                  onChange={(event) => setReference(event.target.value)}
                  maxLength={20}
                  className="max-w-xs"
                />
                <Button size="sm" disabled={busy || reference.trim() === ''} onClick={() => void act(true)}>
                  Confirm with Paystack
                </Button>
              </div>
            </>
          )}
        </div>
      ) : null}
      {!done && refund.paymentProvider !== 'paystack' ? (
        <p className="text-sm text-[var(--ink-muted)]">
          This payment was not taken through Paystack, so Paystack cannot confirm a refund of it.
        </p>
      ) : null}
      {notice ? (
        <p
          role={notice.tone === 'problem' ? 'alert' : 'status'}
          className={`text-sm font-medium ${notice.tone === 'problem' ? 'text-[var(--danger)]' : 'text-[var(--success)]'}`}
        >
          {notice.text}
        </p>
      ) : null}
    </Card>
  );
}

function Detail({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex gap-2">
      <dt className="min-w-36 text-[var(--ink-muted)]">{label}</dt>
      <dd className={`break-all ${mono ? 'font-mono' : ''}`}>{value}</dd>
    </div>
  );
}
