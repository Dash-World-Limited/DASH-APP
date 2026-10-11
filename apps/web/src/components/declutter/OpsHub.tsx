'use client';
import Link from 'next/link';
import { photoSrc } from '@/lib/declutter';
import { useEffect, useState } from 'react';
import { authedFetch, usePermissions, useSessionState } from '@/lib/session';
import { useStepUp } from '@/components/StepUpPrompt';
import { WorkspaceModal } from '@/app/ops/declutter/pricing';
import { SellerReviewDrawer } from '@/app/ops/declutter/OpsDashboardV2';
import { ActionCentre, ItemDetails, ItemProgress } from './SellerHub';
import { HubChat, HubInbox } from './HubChat';
import { useHub } from './use-hub';
import {
  hubButton as button,
  hubCard as card,
  hubInput as input,
  type HubItem,
} from './hub-types';

export function OpsHubAccess({ children }: { children: React.ReactNode }) {
  const session = useSessionState();
  const { permissions, loaded } = usePermissions();
  return (
    <main className="mx-auto w-full max-w-[1240px] px-5 py-10 sm:px-8">
      {session === 'restoring' || !loaded ? (
        <p role="status">Checking staff access…</p>
      ) : session === 'unauthenticated' ? (
        <Link className={button} href="/ops/declutter/signin">
          Sign in to DASH Ops
        </Link>
      ) : !permissions.has('declutter:submission:read') ? (
        <p role="alert">Staff permission is required.</p>
      ) : (
        children
      )}
    </main>
  );
}
interface Workspace {
  item: HubItem;
  sellerId: string;
  fraudFlags: { id: string; kind: string; severity: string }[];
  pricing: {
    proposedPriceKobo: number | null;
    valueCheckStatus: string;
    escalationReasons: string[];
  };
}
export function OpsItemWorkspace({ submissionId }: { submissionId: string }) {
  const { data, error, refresh } = useHub<Workspace>(
    `/v1/admin/declutter/submissions/${encodeURIComponent(submissionId)}/workspace`,
  );
  const { permissions } = usePermissions();
  const { run, prompt } = useStepUp();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [finalPrice, setFinalPrice] = useState<string | null>(null);
  const [kycOpen, setKycOpen] = useState(false);
  useEffect(() => { setFinalPrice(null); setReason(''); setNotice(null); setFailure(null); setKycOpen(false); }, [submissionId]);
  async function call(url: string, body: unknown) {
    setBusy(true);
    setFailure(null);
    setNotice(null);
    try {
      const result = await run(() =>
        authedFetch<{ message?: string }>(url, { method: 'POST', body }),
      );
      if (result) {
        setNotice(
          result.message ??
            'Saved. The item’s next stage is based on its completed checks.',
        );
        await refresh();
      }
    } catch (e) {
      setFailure(
        e instanceof Error ? e.message : 'Could not save this action.',
      );
    } finally {
      setBusy(false);
    }
  }
  const item = data?.item;
  return (
    <div className="space-y-6">
      <Link className="font-bold underline" href="/ops/declutter">
        ← Declutters Ops
      </Link>
      {prompt}
      {error ? (
        <p role="alert">{error}</p>
      ) : !item ? (
        <p role="status">Loading item workspace…</p>
      ) : (
        <>
          <header>
            <p className="dcl-eyebrow">DASH item workspace · {item.code}</p>
            <h1 className="mt-3 break-words text-3xl font-extrabold">
              {item.title}
            </h1>
            <p className="mt-3 font-bold">
              {item.status} · {item.seller.name}
            </p>
          </header>
          <div className={card}>
            <div className="flex flex-wrap gap-3">
              <Link className={button} href="/ops/declutter/inbox">
                Declutters inbox
              </Link>
              <button className={button} onClick={() => void refresh()}>
                Refresh workspace
              </button>
              <button className={button} onClick={() => setKycOpen(true)}>
                Seller verification:{' '}
                {item.seller.kycStatus === 'verified'
                  ? 'Verified'
                  : 'Needs review'}
              </button>
            </div>
            <p className="mt-3 text-sm">
              Seller price response:{' '}
              {item.priceAcceptanceValid
                ? 'Accepted'
                : item.valueCheckStatus === 'seller_declined'
                  ? 'Declined'
                  : 'Awaiting decision'}{' '}
              · Exact submitted-price consent:{' '}
              {item.preConsented ? 'Recorded' : 'Not given'}
            </p>
          </div>
          {kycOpen && data ? (
            <SellerReviewDrawer
              sellerId={data.sellerId}
              canReviewKyc={permissions.has('declutter:kyc:review')}
              onClose={() => setKycOpen(false)}
              onChanged={() => {
                setKycOpen(false);
                void refresh();
              }}
            />
          ) : null}
          <ItemProgress item={item} />
          <section className={card}>
            <h2 className="text-xl font-bold">Review context</h2>
            <p className="mt-2 text-sm text-[var(--ink-muted)]">
              Internal checks inform your decision; they do not require visiting
              separate pages. The final action below records your authority.
            </p>
            {item.blockers.length ? (
              <ul className="mt-4 list-disc space-y-2 pl-5 text-sm">
                {item.blockers.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            ) : (
              <p className="mt-4 text-sm">All mandatory gates are satisfied.</p>
            )}
            {notice ? (
              <p role="status" className="mt-4">
                {notice}
              </p>
            ) : null}
            {failure ? (
              <p role="alert" className="mt-4">
                {failure}
              </p>
            ) : null}
            <label className="mt-5 block text-sm font-bold">
              Review explanation / seller request
              <textarea
                className={`${input} mt-2`}
                rows={3}
                maxLength={500}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
            <div className="mt-4 flex flex-wrap gap-3">
              {permissions.has('declutter:pricing:decide') ? (
                <>
                  <button
                    className={button}
                    disabled={busy}
                    onClick={() =>
                      void call(
                        `/v1/admin/declutter/submissions/${item.id}/checks`,
                        { kind: 'safety', passed: true },
                      )
                    }
                  >
                    Pass safety review
                  </button>
                  <button
                    className={button}
                    disabled={busy}
                    onClick={() =>
                      void call(
                        `/v1/admin/declutter/submissions/${item.id}/checks`,
                        { kind: 'item', passed: true },
                      )
                    }
                  >
                    Pass item review
                  </button>
                  <button
                    className={button}
                    disabled={busy || reason.trim().length < 5}
                    onClick={() =>
                      void call(
                        `/v1/admin/declutter/submissions/${item.id}/checks`,
                        { kind: 'item', passed: false, sellerMessage: reason },
                      )
                    }
                  >
                    Request seller information
                  </button>
                </>
              ) : null}
            </div>
            {data?.fraudFlags.map((f) => (
              <div
                key={f.id}
                className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-[var(--line)] p-4"
              >
                <p className="text-sm">
                  Safety flag ·{' '}
                  {f.severity === 'high' ? 'High priority' : 'Review required'}
                </p>
                {permissions.has('declutter:fraud:override') ? (
                  <button
                    className={button}
                    disabled={busy || reason.trim().length < 10}
                    onClick={() =>
                      void call(
                        `/v1/admin/declutter/fraud-flags/${f.id}/resolve`,
                        { reason },
                      )
                    }
                  >
                    Dismiss with explanation
                  </button>
                ) : null}
              </div>
            ))}
            {permissions.has('declutter:pricing:authorize') &&
            permissions.has('declutter:listing:publish') ? (
              <div className="mt-6 rounded-2xl border border-[var(--primary)] bg-[var(--primary-soft)] p-4">
                <h3 className="text-lg font-bold">Approve &amp; Publish</h3>
                <p className="mt-2 text-sm leading-relaxed">
                  Your final decision overrides DASH-controlled review checks
                  and publishes the current item. Seller verification and
                  acceptance of the exact authorised price cannot be bypassed.
                  Proposed photo updates still need separate review.
                </p>
                <label className="mt-4 block text-sm font-bold">
                  Final DASH price (₦)
                  <input
                    type="number"
                    inputMode="decimal"
                    min="0.01"
                    max="1000000000"
                    step="0.01"
                    className={`${input} mt-2`}
                    value={
                      finalPrice ??
                      String(
                        (item.authorizedPriceKobo ??
                          data?.pricing?.proposedPriceKobo ??
                          item.expectedPriceKobo ??
                          0) / 100,
                      )
                    }
                    onChange={(e) => setFinalPrice(e.target.value)}
                  />
                </label>
                <button
                  className={`${button} mt-4 w-full bg-[var(--primary)] text-[var(--on-primary)]`}
                  disabled={
                    busy ||
                    Boolean(item.listing) ||
                    ['Removed', 'Sold'].includes(item.status) ||
                    (finalPrice !== null && !(Number(finalPrice) > 0))
                  }
                  onClick={() =>
                    void call(
                      `/v1/admin/declutter/submissions/${item.id}/approve-publish`,
                      {
                        ...(finalPrice !== null
                          ? { priceKobo: Math.round(Number(finalPrice) * 100) }
                          : {}),
                        ...(reason.trim() ? { reason: reason.trim() } : {}),
                      },
                    )
                  }
                >
                  {busy
                    ? 'Checking seller requirements…'
                    : item.listing?.publishedAt
                      ? 'Published / Live'
                      : 'Approve & Publish'}
                </button>
              </div>
            ) : null}
          </section>
          <div className="grid min-w-0 items-start gap-6 xl:grid-cols-2">
            <div className="min-w-0 space-y-6">
              <ItemDetails item={item} />
              <section className={card}>
                <h2 className="text-xl font-bold">
                  Seller updates awaiting review
                </h2>
                {!item.updates.length ? (
                  <p className="mt-4 text-sm">No proposed changes.</p>
                ) : (
                  item.updates.map((u) => (
                    <article
                      key={u.id}
                      className="mt-5 space-y-3 border-t border-[var(--line)] pt-4"
                    >
                      <p className="font-bold">
                        {(
                          {
                            draft: 'Unfinished draft',
                            pending: 'Awaiting review',
                            approved: 'Approved update',
                            rejected: 'Update not approved',
                            changes_requested: 'Changes requested',
                            discarded: 'Discarded draft',
                          } as Record<string, string>
                        )[u.status] ?? 'Update'}
                      </p>
                      <dl className="grid gap-3 text-sm sm:grid-cols-2">
                        <div>
                          <dt className="font-bold">Currently approved</dt>
                          <dd className="mt-2">
                            {item.title}
                            <br />
                            {item.description}
                            <br />
                            {item.condition === 'like_new'
                              ? 'Like new'
                              : item.condition}
                          </dd>
                        </div>
                        <div>
                          <dt className="font-bold">Proposed version</dt>
                          <dd className="mt-2">
                            {u.title}
                            <br />
                            {u.description}
                            <br />
                            {u.condition === 'like_new'
                              ? 'Like new'
                              : u.condition}
                          </dd>
                        </div>
                      </dl>
                      <p className="text-sm font-bold">Proposed photos</p>
                      <div className="grid grid-cols-2 gap-3">
                        {u.photos.map((p) => (
                          <img
                            key={p.id}
                            src={photoSrc(p.url)}
                            alt="Proposed photo for review"
                            className="aspect-square w-full rounded-xl object-contain"
                          />
                        ))}
                      </div>
                      {u.status === 'pending' &&
                      permissions.has('declutter:pricing:authorize') ? (
                        <div className="flex flex-wrap gap-3">
                          {(
                            [
                              'approved',
                              'rejected',
                              'changes_requested',
                            ] as const
                          ).map((decision) => (
                            <button
                              key={decision}
                              className={button}
                              disabled={
                                busy ||
                                (decision !== 'approved' &&
                                  reason.trim().length < 5)
                              }
                              onClick={() =>
                                void call(
                                  `/v1/admin/declutter/updates/${u.id}/review`,
                                  {
                                    decision,
                                    ...(reason.trim()
                                      ? { sellerMessage: reason }
                                      : {}),
                                  },
                                )
                              }
                            >
                              {
                                {
                                  approved: 'Approve update',
                                  rejected: 'Reject update',
                                  changes_requested: 'Request changes',
                                }[decision]
                              }
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </article>
                  ))
                )}
              </section>
            </div>
            <div className="min-w-0 space-y-6">
              <WorkspaceModal
                key={item.id}
                submissionId={item.id}
                canAuthorize={permissions.has('declutter:pricing:authorize')}
                onClose={() => {}}
                onChanged={() => void refresh()}
                inline
              />
              <HubChat
                conversationId={item.conversationId}
                submissionId={item.id}
                staff
                onChanged={refresh}
              />
              <ActionCentre
                actions={item.actions.map((a) => ({
                  ...a,
                  href: a.href.startsWith('#')
                    ? a.href
                    : '/ops/declutter/inbox',
                }))}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
export function OpsInbox() {
  return <HubInbox staff />;
}
