'use client';
import Link from 'next/link';
import { useHub } from './use-hub';
import { hubButton, hubCard, hubDate } from './hub-types';
interface Updates {
  total: number;
  updates: {
    id: string;
    submissionId: string;
    title: string | null;
    code: string;
    sellerName: string;
    submittedAt: string | null;
  }[];
}
export function HubPendingUpdatesLink() {
  const { data } = useHub<Updates>('/v1/admin/declutter/updates');
  return (
    <Link
      href="/ops/declutter/updates"
      className="block min-h-12 rounded-2xl px-4 py-3 text-sm font-semibold"
    >
      Seller updates{data?.total ? ` (${data.total} awaiting review)` : ''}
    </Link>
  );
}
export function HubPendingUpdates() {
  const { data, error, refresh } = useHub<Updates>(
    '/v1/admin/declutter/updates',
  );
  return (
    <div className="space-y-6">
      <Link href="/ops/declutter" className={hubButton}>
        Back to Declutters Ops
      </Link>
      <h1 className="text-3xl font-bold">
        Seller updates awaiting review{data ? ` (${data.total})` : ''}
      </h1>
      {error ? (
        <p role="alert">
          {error} <button onClick={() => void refresh()}>Retry</button>
        </p>
      ) : !data ? (
        <p role="status">Loading updates…</p>
      ) : !data.updates.length ? (
        <p className={hubCard}>No updates waiting.</p>
      ) : (
        data.updates.map((u) => (
          <article className={hubCard} key={u.id}>
            <h2 className="text-lg font-bold">{u.title ?? u.code}</h2>
            <p className="mt-2 text-sm">
              {u.sellerName} · {u.code} · {hubDate(u.submittedAt)}
            </p>
            <Link
              className={`${hubButton} mt-4`}
              href={`/ops/declutter/items/${u.submissionId}`}
            >
              Review proposed changes
            </Link>
          </article>
        ))
      )}
    </div>
  );
}
