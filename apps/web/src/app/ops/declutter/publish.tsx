'use client';

import Link from 'next/link';
import { useStepUp } from '@/components/StepUpPrompt';
import { HUB_BLOCKER_LABELS } from '@dash/domain/declutter';
import { useCallback, useEffect, useState } from 'react';

import { Button, Card, EmptyState, ErrorState, LoadingBlock } from '@/components/ui';
import { ApiRequestError } from '@/lib/api';
import { authedFetch, usePermissions } from '@/lib/session';

interface SubmissionRow {
  id: string;
  code: string;
  title: string | null;
  status: string;
  seller?: { id: string; displayName: string; kycStatus: string };
}

interface ReadyRow extends SubmissionRow {
  gaps: string[];
  canPublish: boolean;
}

interface PublishedListing {
  id: string;
  slug: string;
  priceKobo: number;
}

function messageFor(error: unknown): string {
  return error instanceof ApiRequestError ? error.message : 'Something went wrong. Try again.';
}

export function PublishQueue({ canPublish }: { canPublish: boolean }) {
  const { run, prompt } = useStepUp();
  const { permissions } = usePermissions();
  const [notice, setNotice] = useState<string | null>(null);
  const [rows, setRows] = useState<ReadyRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await authedFetch<{ submissions: SubmissionRow[] }>(
        '/v1/admin/declutter/submissions?limit=100',
      );

      const checked = await Promise.all(
        data.submissions.map(async (submission) => {
          try {
            const readiness = await authedFetch<{ gaps: string[]; canPublish: boolean }>(
              `/v1/admin/declutter/submissions/${submission.id}/publication-readiness`,
            );
            return { ...submission, gaps: readiness.gaps, canPublish: readiness.canPublish };
          } catch {
            return { ...submission, gaps: ['readiness_check_failed'], canPublish: false };
          }
        }),
      );

      setRows(checked);
    } catch (caught) {
      setError(messageFor(caught));
      setRows([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function publish(row: ReadyRow) {
    setBusyId(row.id);
    setError(null);
    try {
      const result = await run(() => authedFetch<{ published: boolean; listing: PublishedListing | null; message: string }>(
        `/v1/admin/declutter/submissions/${row.id}/approve-publish`, { method: 'POST', body: {} },
      ));
      if (result) setNotice(result.message);
      await load();
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="space-y-4" aria-label="Publication review">
      {prompt}
      {notice ? <p role="status" className="text-sm">{notice}</p> : null}
      <div>
        <h2 className="text-sm font-semibold">Publication review</h2>
        <p className="mt-1 text-xs text-[var(--ink-muted)]">
          Approve and publish with Super Admin authority. Required seller verification and current-price consent remain mandatory.
        </p>
      </div>

      {error ? <ErrorState title="Could not load publication queue" message={error} onRetry={() => void load()} /> : null}
      {rows === null && !error ? <LoadingBlock label="Checking publication readiness" /> : null}
      {rows !== null && rows.length === 0 && !error ? (
        <EmptyState title="No submissions to review" description="Submissions will appear here as they move toward publication." />
      ) : null}

      <ul className="space-y-2">
        {(rows ?? []).map((row) => (
          <li key={row.id}>
            <Card className="flex flex-wrap items-center gap-3 p-4">
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold">{row.title ?? 'Untitled item'}</p>
                <p className="text-xs text-[var(--ink-muted)]">
                  {row.code}{row.seller ? ` · ${row.seller.displayName}` : ''}
                </p>
                {row.canPublish ? (
                  <p className="mt-1 text-xs font-medium">All publication checks passed.</p>
                ) : (
                  <p className="mt-1 text-xs text-[var(--ink-muted)]">
                    Blocked: {row.gaps.length > 0 ? row.gaps.map((gap) => HUB_BLOCKER_LABELS[gap] ?? 'Publication review required').join(' · ') : 'Publication checks are incomplete.'}
                  </p>
                )}
              </div>
              <Link className="min-h-11 py-3 text-sm font-bold underline" href={`/ops/declutter/items/${row.id}`}>Review item</Link>
              <Button
                size="sm"
                disabled={!canPublish || !permissions.has('declutter:pricing:authorize') || row.gaps.includes('already_published') || ['withdrawn', 'rejected'].includes(row.status) || busyId === row.id}
                onClick={() => void publish(row)}
              >
                {busyId === row.id ? 'Checking requirements…' : 'Approve & Publish'}
              </Button>
            </Card>
          </li>
        ))}
      </ul>

      {!canPublish && rows && rows.length > 0 ? (
        <p className="text-xs text-[var(--ink-muted)]">
          Your account can review submissions but does not have the listing publication permission.
        </p>
      ) : null}
    </section>
  );
}
