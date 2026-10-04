'use client';

import { useCallback, useEffect, useState } from 'react';

import { Button, Card, EmptyState, ErrorState, LoadingBlock } from '@/components/ui';
import { ApiRequestError } from '@/lib/api';
import { authedFetch } from '@/lib/session';

interface SubmissionRow {
  id: string;
  code: string;
  title: string | null;
  status: string;
  seller?: { id: string; displayName: string; kycStatus: string };
}

interface ReadyRow extends SubmissionRow {
  gaps: string[];
}

function messageFor(error: unknown): string {
  return error instanceof ApiRequestError ? error.message : 'Something went wrong. Try again.';
}

export function PublishQueue({ canPublish }: { canPublish: boolean }) {
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
            return readiness.canPublish ? { ...submission, gaps: readiness.gaps } : null;
          } catch {
            return null;
          }
        }),
      );

      setRows(checked.filter((row): row is ReadyRow => row !== null));
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
      await authedFetch(`/v1/admin/declutter/submissions/${row.id}/publish`, {
        method: 'POST',
      });
      await load();
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="space-y-4" aria-label="Ready to publish">
      <div>
        <h2 className="text-sm font-semibold">Ready to publish</h2>
        <p className="mt-1 text-xs text-[var(--ink-muted)]">
          Only submissions that passed seller verification, pricing, seller acceptance, photo,
          location and fraud checks appear here.
        </p>
      </div>

      {error ? <ErrorState title="Could not load publication queue" message={error} onRetry={() => void load()} /> : null}
      {rows === null && !error ? <LoadingBlock label="Checking publication readiness" /> : null}
      {rows !== null && rows.length === 0 && !error ? (
        <EmptyState title="Nothing ready" description="Approved items will appear here after every publication check passes." />
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
              </div>
              <Button
                size="sm"
                disabled={!canPublish || busyId === row.id}
                onClick={() => void publish(row)}
              >
                {busyId === row.id ? 'Publishing…' : 'Publish'}
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
