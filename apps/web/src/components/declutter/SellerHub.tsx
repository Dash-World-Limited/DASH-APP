'use client';
import Link from 'next/link';
import { photoSrc } from '@/lib/declutter';
import { useEffect, useState } from 'react';
import { authedFetch, signOut, useMe } from '@/lib/session';
import { signInHref } from '@/lib/return-to';
import { AccountPhoneEditor } from './AccountPhoneEditor';
import { HubChat } from './HubChat';
import { useHub } from './use-hub';
import {
  hubButton as button,
  hubCard as card,
  hubInput as input,
  hubMoney as money,
  hubDate as date,
  type HubAction,
  type HubItem,
  type HubSummary,
} from './hub-types';

export function HubAuth({
  session,
  returnTo,
}: {
  session: string;
  returnTo: string;
}) {
  return session === 'restoring' ? (
    <p role="status">Checking your account…</p>
  ) : (
    <section className={card}>
      <h2 className="text-xl font-bold">Sign in to your Declutters account</h2>
      <p className="mt-3 text-sm">
        Your item workspace and messages are private.
      </p>
      <div className="mt-5 flex flex-wrap gap-3">
        <Link className={button} href={signInHref(returnTo)}>
          Sign in
        </Link>
        <Link
          className={button}
          href={`/declutter/join?next=${encodeURIComponent(returnTo)}`}
        >
          Create account
        </Link>
      </div>
    </section>
  );
}
export function ActionCentre({
  actions,
  base = '',
}: {
  actions: HubAction[];
  base?: string;
}) {
  return (
    <section
      className={`${card} border-[var(--primary)]`}
      aria-label="Action required"
    >
      <h2 className="text-xl font-bold">Action required</h2>
      {!actions.length ? (
        <p className="mt-3 text-sm text-[var(--ink-muted)]">
          You’re up to date. DASH will let you know when something needs your
          attention.
        </p>
      ) : (
        <div className="mt-4 space-y-3">
          {actions.map((a, i) => (
            <div
              key={`${a.href}-${i}`}
              className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--line)] pt-3"
            >
              <p className="min-w-0 break-words text-sm font-semibold">
                {a.label}
              </p>
              <Link
                className={button}
                href={a.href.startsWith('#') ? `${base}${a.href}` : a.href}
              >
                {a.cta}
              </Link>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
export function ItemProgress({ item }: { item: HubItem }) {
  return (
    <section className={card}>
      <h2 className="text-xl font-bold">Item progress</h2>
      <ol className="mt-5 grid gap-4 sm:grid-cols-3">
        {item.progress.map((p, i) => (
          <li
            key={p.key}
            className={`flex min-w-0 gap-3 rounded-xl border p-3 ${['current', 'action_required', 'paused'].includes(p.state) ? 'border-[var(--primary)] bg-[var(--surface-sunken)]' : 'border-[var(--line)]'}`}
          >
            <span
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-[var(--line-strong)] font-bold"
              aria-hidden="true"
            >
              {p.state === 'completed' ? '✓' : i + 1}
            </span>
            <div className="min-w-0">
              <p className="text-sm font-bold">{p.label}</p>
              <p className="mt-1 text-xs text-[var(--ink-muted)]">
                {(
                  {
                    completed: 'Completed',
                    current: 'In progress',
                    pending: 'Pending',
                    action_required: 'Action required',
                    paused: 'Paused',
                  } as Record<string, string>
                )[p.state] ?? 'Pending'}
              </p>
              {p.at ? <p className="mt-1 text-xs">{date(p.at)}</p> : null}
            </div>
          </li>
        ))}
      </ol>
      <div className="mt-5 border-t border-[var(--line)] pt-4">
        <h3 className="font-bold">What happens next?</h3>
        <p className="mt-2 text-sm leading-relaxed">{item.next}</p>
      </div>
    </section>
  );
}
export function SellerDashboard() {
  const { data, error, refresh, session } =
    useHub<HubSummary>('/v1/declutter/hub');
  const { me } = useMe();
  const [signingOut, setSigningOut] = useState(false);
  const items = data?.items ?? [];
  const groups = new Map<string, HubItem[]>();
  for (const item of items)
    groups.set(item.status, [...(groups.get(item.status) ?? []), item]);
  const actions = items.flatMap((item) =>
    item.actions.map((a) => ({
      ...a,
      label: `${item.title ?? item.code}: ${a.label}`,
      href: a.href.startsWith('#')
        ? `/declutter/account/items/${item.id}${a.href}`
        : a.href,
    })),
  );
  if (
    data?.seller &&
    ['unverified', 'rejected'].includes(data.seller.kycStatus) &&
    !actions.some((a) => a.href === '/declutter/seller/verify')
  )
    actions.unshift({
      label: 'Seller verification required',
      cta: 'Review verification',
      href: '/declutter/seller/verify',
    });
  return (
    <main
      id="main"
      className="mx-auto w-full max-w-[1240px] px-5 py-10 sm:px-8"
    >
      <p className="dcl-eyebrow">Your seller hub</p>
      <h1 className="dcl-display mt-3 text-3xl font-extrabold sm:text-5xl">
        Your Declutters, in one place.
      </h1>
      <p className="mt-4 max-w-xl text-sm leading-relaxed text-[var(--ink-muted)]">
        Follow every item, review your prices, improve your listings and talk to
        DASH.
      </p>
      {session !== 'authenticated' ? (
        <div className="mt-7">
          <HubAuth session={session} returnTo="/declutter/account" />
        </div>
      ) : (
        <div className="mt-8 space-y-6">
          <section className={card}>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <h2 className="break-words text-xl font-bold">
                  {me?.identity.displayName ?? 'Your account'}
                </h2>
                <p className="mt-2 break-all text-sm">{me?.identity.email}</p>
                <p className="mt-2 text-sm">
                  Seller verification:{' '}
                  {data?.seller?.kycStatus === 'verified'
                    ? 'Verified'
                    : data?.seller?.kycStatus === 'pending'
                      ? 'Under review'
                      : data?.seller?.kycStatus === 'suspended'
                        ? 'Selling paused'
                        : 'Verification required'}
                </p>
              </div>
              <div className="flex flex-wrap gap-3">
                {!data?.seller || data.seller.canSubmit ? (
                  <Link
                    href="/declutter/sell"
                    className={`${button} bg-[var(--primary)] text-[var(--on-primary)]`}
                  >
                    Sell another item
                  </Link>
                ) : null}
                <Link href="/declutter/account/messages" className={button}>
                  Messages
                  {data?.unreadCount ? ` (${data.unreadCount} unread)` : ''}
                </Link>
                <button
                  disabled={signingOut}
                  className={button}
                  onClick={() => {
                    setSigningOut(true);
                    void signOut().finally(() => setSigningOut(false));
                  }}
                >
                  Sign out
                </button>
              </div>
            </div>
            {me ? (
              <AccountPhoneEditor
                key={me.identity.id}
                initialPhone={me.identity.phone}
              />
            ) : null}
            {data?.seller &&
            ['unverified', 'rejected'].includes(data.seller.kycStatus) ? (
              <Link
                className={`${button} mt-4`}
                href="/declutter/seller/verify"
              >
                {data.seller.kycStatus === 'rejected'
                  ? 'Update verification'
                  : 'Verify seller profile'}
              </Link>
            ) : null}
            {data?.seller?.kycStatus === 'suspended' ? (
              <Link
                href="/declutter/account/messages"
                className={`${button} mt-4`}
              >
                Contact DASH support
              </Link>
            ) : null}
          </section>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            {[
              ['Total items', data?.totals.total],
              ['Under review', data?.totals.underReview],
              ['Action required', data?.totals.actionRequired],
              ['Approved', data?.totals.approved],
              ['Published / Live', data?.totals.live],
              ['Unread messages', data?.unreadCount],
            ].map(([label, n]) => (
              <div key={label} className={card}>
                <p className="text-xs font-bold text-[var(--ink-muted)]">
                  {label}
                </p>
                <p className="mt-3 text-3xl font-extrabold">{n ?? '—'}</p>
              </div>
            ))}
          </div>
          <ActionCentre actions={actions} />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-2xl font-bold">Your items</h2>
            <button className={button} onClick={() => void refresh()}>
              Refresh items
            </button>
          </div>
          {error ? (
            <p role="alert">{error}</p>
          ) : !data ? (
            <p role="status">Loading your items…</p>
          ) : !items.length ? (
            <section className={card}>
              <h3 className="font-bold">No items yet</h3>
              <p className="mt-2 text-sm">
                Submit your first item to see its progress here.
              </p>
            </section>
          ) : null}
          {[...groups].map(([status, rows]) => (
            <section key={status} aria-label={status}>
              <h3 className="mb-4 text-lg font-bold">
                {status} ({rows.length})
              </h3>
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {rows.map((item) => (
                  <article key={item.id} className={card}>
                    {item.photos[0] ? (
                      <img
                        src={photoSrc(item.photos[0].url)}
                        alt={item.title ?? 'Item photo'}
                        className="aspect-[4/3] w-full rounded-xl object-cover"
                      />
                    ) : (
                      <div className="flex aspect-[4/3] items-center justify-center rounded-xl bg-[var(--surface-sunken)] text-sm">
                        Photos awaiting upload
                      </div>
                    )}
                    <h4 className="mt-4 break-words text-lg font-bold">
                      {item.title ?? 'Your item'}
                    </h4>
                    <p className="mt-2 text-xs text-[var(--ink-muted)]">
                      {item.code} · {date(item.createdAt)}
                    </p>
                    <p className="mt-2 text-sm font-semibold">{item.status}</p>
                    <dl className="mt-4 space-y-2 text-sm">
                      <div className="flex flex-wrap justify-between gap-2">
                        <dt>Your submitted price</dt>
                        <dd className="font-bold">
                          {money(item.expectedPriceKobo)}
                        </dd>
                      </div>
                      <div className="flex flex-wrap justify-between gap-2">
                        <dt>DASH authorised price</dt>
                        <dd className="font-bold">
                          {money(item.authorizedPriceKobo)}
                        </dd>
                      </div>
                    </dl>
                    <p className="mt-3 text-xs">
                      {
                        item.progress.filter((p) => p.state === 'completed')
                          .length
                      }{' '}
                      of {item.progress.length} stages completed
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2 text-xs font-bold">
                      {item.actions.length ? (
                        <span className="rounded-full border border-[var(--primary)] px-3 py-2">
                          Action required
                        </span>
                      ) : null}
                      {item.unreadCount ? (
                        <span className="rounded-full border border-[var(--line)] px-3 py-2">
                          {item.unreadCount} unread
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-4 flex flex-wrap gap-2">
                      <Link
                        className={button}
                        href={`/declutter/account/items/${item.id}`}
                      >
                        Manage item
                      </Link>
                      <Link
                        className={button}
                        href={`/declutter/account/items/${item.id}#chat`}
                      >
                        Chat with DASH
                      </Link>
                      {item.listing?.publishedAt ? (
                        <Link
                          className="min-h-11 py-3 text-sm font-bold underline"
                          href={`/declutter/${item.listing.slug}`}
                        >
                          View listing
                        </Link>
                      ) : null}
                    </div>
                  </article>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </main>
  );
}
export function ItemDetails({ item }: { item: HubItem }) {
  return (
    <section className={card}>
      <h2 className="text-xl font-bold">Item details</h2>
      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        {item.photos.map((p, i) => (
          <figure key={p.id}>
            <img
              src={photoSrc(p.url)}
              alt={`${item.title ?? 'Item'} — ${i === 0 ? 'main photo' : `photo ${i + 1}`}`}
              className="aspect-[4/3] w-full rounded-xl object-contain bg-[var(--surface-sunken)]"
            />
            {i === 0 ? (
              <figcaption className="mt-2 text-xs font-bold">
                Main photo
              </figcaption>
            ) : null}
          </figure>
        ))}
      </div>
      <p className="mt-5 whitespace-pre-wrap break-words text-sm leading-relaxed">
        {item.description}
      </p>
      <dl className="mt-5 grid gap-4 text-sm sm:grid-cols-2">
        {[
          ['Category', item.category],
          [
            'Condition',
            (
              {
                new: 'New',
                like_new: 'Like new',
                good: 'Good',
                fair: 'Fair',
              } as Record<string, string>
            )[item.condition ?? ''],
          ],
          ['Location', item.location],
          ['Submitted', date(item.createdAt)],
          ['Reference', item.code],
          ['Status', item.status],
        ].map(([label, value]) => (
          <div key={label}>
            <dt className="text-xs text-[var(--ink-muted)]">{label}</dt>
            <dd className="mt-1 font-bold">{value ?? 'Not set'}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
function SellerItemEditor({
  item,
  onChanged,
}: {
  item: HubItem;
  onChanged: () => Promise<void>;
}) {
  const [title, setTitle] = useState(item.title ?? '');
  const [description, setDescription] = useState(item.description ?? '');
  const [condition, setCondition] = useState(item.condition ?? 'good');
  const [keep, setKeep] = useState(item.photos.map((p) => p.id));
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const existing = item.updates.find((u) =>
    ['draft', 'pending'].includes(u.status),
  );
  const photoIds = item.photos.map((p) => p.id).join(';');
  useEffect(() => {
    setKeep(photoIds.split(';').filter(Boolean));
  }, [photoIds]);
  useEffect(() => {
    setTitle(item.title ?? '');
    setDescription(item.description ?? '');
    setCondition(item.condition ?? 'good');
  }, [item.title, item.description, item.condition]);
  async function uploadSaved(files: File[]) {
    if (!existing) return;
    setBusy(true);
    setError(null);
    try {
      for (const file of files) {
        if (file.size > 8 * 1024 * 1024)
          throw new Error('Choose photos under 8 MB.');
        const data = await new Promise<string>((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(String(r.result).split(',')[1]!);
          r.onerror = () => reject(new Error('Could not read photo.'));
          r.readAsDataURL(file);
        });
        await authedFetch(`/v1/declutter/updates/${existing.id}/photos`, {
          method: 'POST',
          body: { data, contentType: file.type, role: 'other' },
        });
      }
      await onChanged();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : 'Upload failed. Your existing draft is preserved.',
      );
    } finally {
      setBusy(false);
    }
  }
  async function submit() {
    setBusy(true);
    setError(null);
    setNotice(null);
    let updateId: string | undefined;
    try {
      const response = await authedFetch<{ updateId: string }>(
        `/v1/declutter/account/items/${item.id}/updates`,
        {
          method: 'POST',
          body: { title, description, condition, keepPhotoIds: keep },
        },
      );
      updateId = response.updateId;
      for (const file of files) {
        const data = await new Promise<string>((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(String(r.result).split(',')[1]!);
          r.onerror = () => reject(new Error('Could not read photo.'));
          r.readAsDataURL(file);
        });
        await authedFetch(`/v1/declutter/updates/${updateId}/photos`, {
          method: 'POST',
          body: { data, contentType: file.type, role: 'other' },
        });
      }
      await authedFetch(`/v1/declutter/updates/${updateId}/submit`, {
        method: 'POST',
        body: {},
      });
      setNotice(
        'Your changes were submitted and are awaiting DASH review. Your current listing remains unchanged until the update is approved.',
      );
      setFiles([]);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Could not submit your changes.',
      );
      if (updateId)
        setNotice(
          'Your unfinished update is saved. Finish or discard it below before starting another.',
        );
    } finally {
      await onChanged();
      setBusy(false);
    }
  }
  return (
    <section id="edit" className={`${card} scroll-mt-24`}>
      <h2 className="text-xl font-bold">Improve your item</h2>
      <p className="mt-3 text-sm leading-relaxed">
        Replace poor photos or update item details. DASH reviews every proposed
        update before it changes an approved or live listing.
      </p>
      {item.updates[0]?.sellerMessage ? (
        <p className="mt-3 text-sm">DASH: {item.updates[0].sellerMessage}</p>
      ) : null}
      {notice ? (
        <p role="status" className="mt-4 text-sm">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-4 text-sm">
          {error}
        </p>
      ) : null}
      {existing ? (
        <div className="mt-4 space-y-3">
          <p className="font-bold">
            {existing.status === 'pending'
              ? 'Your changes were submitted and are awaiting DASH review. Your current listing remains unchanged until the update is approved.'
              : 'You have an unfinished update.'}
          </p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {existing.photos.map((p) => (
              <img
                key={p.id}
                src={photoSrc(p.url)}
                alt="Proposed item photo"
                className="aspect-square w-full rounded-xl object-cover"
              />
            ))}
          </div>
          {existing.status === 'draft' ? (
            <label className="block text-sm font-bold">
              Add / retry draft photos
              <input
                type="file"
                multiple
                accept="image/jpeg,image/png,image/webp"
                disabled={busy}
                className={`${input} mt-2`}
                onChange={(e) =>
                  void uploadSaved(Array.from(e.target.files ?? []))
                }
              />
            </label>
          ) : null}
          {existing.status === 'draft' ? (
            <div className="flex flex-wrap gap-3">
              <button
                className={button}
                disabled={busy || !existing.photos.length}
                onClick={() => {
                  setBusy(true);
                  void authedFetch(
                    `/v1/declutter/updates/${existing.id}/submit`,
                    { method: 'POST', body: {} },
                  )
                    .then(onChanged)
                    .catch((e) => setError(e.message))
                    .finally(() => setBusy(false));
                }}
              >
                Submit saved update
              </button>
              <button
                className={button}
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void authedFetch(
                    `/v1/declutter/updates/${existing.id}/discard`,
                    { method: 'POST', body: {} },
                  )
                    .then(onChanged)
                    .catch((e) => setError(e.message))
                    .finally(() => setBusy(false));
                }}
              >
                Discard draft
              </button>
            </div>
          ) : null}
        </div>
      ) : (
        <form
          className="mt-5 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <label className="block text-sm font-bold">
            Item title
            <input
              className={`${input} mt-2`}
              value={title}
              minLength={3}
              maxLength={160}
              required
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label className="block text-sm font-bold">
            Description
            <textarea
              className={`${input} mt-2`}
              rows={5}
              value={description}
              minLength={10}
              maxLength={4000}
              required
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          <label className="block text-sm font-bold">
            Condition
            <select
              className={`${input} mt-2`}
              value={condition}
              onChange={(e) => setCondition(e.target.value)}
            >
              <option value="new">New</option>
              <option value="like_new">Like new</option>
              <option value="good">Good</option>
              <option value="fair">Fair</option>
            </select>
          </label>
          <fieldset>
            <legend className="text-sm font-bold">Keep existing photos</legend>
            <p className="mt-2 text-xs">
              Uncheck photos you want to replace. The first retained or new
              photo becomes the main photo.
            </p>
            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
              {item.photos.map((p, i) => (
                <label
                  key={p.id}
                  className="rounded-xl border border-[var(--line)] p-3"
                >
                  <img
                    src={photoSrc(p.url)}
                    alt={`Current photo ${i + 1}`}
                    className="aspect-square w-full rounded-lg object-cover"
                  />
                  <span className="mt-3 flex min-h-11 items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={keep.includes(p.id)}
                      onChange={(e) =>
                        setKeep((old) =>
                          e.target.checked
                            ? [...old, p.id]
                            : old.filter((id) => id !== p.id),
                        )
                      }
                    />
                    Keep photo {i + 1}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <label className="block text-sm font-bold">
            New / replacement photos
            <input
              type="file"
              multiple
              accept="image/jpeg,image/png,image/webp"
              className={`${input} mt-2`}
              onChange={(e) => {
                const next = Array.from(e.target.files ?? []);
                if (
                  next.some((f) => f.size > 8 * 1024 * 1024) ||
                  next.length + keep.length > 12
                ) {
                  setError('Use at most 12 images under 8 MB each.');
                  return;
                }
                setError(null);
                setFiles(next);
              }}
            />
          </label>
          {files.length ? (
            <p className="text-sm">{files.map((f) => f.name).join(', ')}</p>
          ) : null}
          <button
            className={`${button} bg-[var(--primary)] text-[var(--on-primary)]`}
            disabled={busy || (!keep.length && !files.length)}
          >
            {busy ? 'Uploading changes…' : 'Submit changes for review'}
          </button>
        </form>
      )}
    </section>
  );
}
export function SellerItemWorkspace({
  submissionId,
}: {
  submissionId: string;
}) {
  const { data, error, refresh, session } = useHub<{ item: HubItem }>(
    `/v1/declutter/account/items/${encodeURIComponent(submissionId)}`,
  );
  const item = data?.item;
  const [busy, setBusy] = useState(false);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [declineReason, setDeclineReason] = useState('');
  async function answer(response: 'accept' | 'decline') {
    if (!item) return;
    setBusy(true);
    setDecisionError(null);
    try {
      await authedFetch(`/v1/declutter/submissions/${item.id}/price-response`, {
        method: 'POST',
        body: {
          response,
          priceKobo: item.authorizedPriceKobo,
          ...(response === 'decline' ? { reason: declineReason.trim() } : {}),
        },
      });
      await refresh();
    } catch (e) {
      setDecisionError(
        e instanceof Error ? e.message : 'Could not save your decision.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <main
      id="main"
      className="mx-auto w-full max-w-[1240px] px-5 py-10 sm:px-8"
    >
      <Link href="/declutter/account" className="text-sm font-bold underline">
        ← Your seller dashboard
      </Link>
      {session !== 'authenticated' ? (
        <div className="mt-6">
          <HubAuth
            session={session}
            returnTo={`/declutter/account/items/${submissionId}`}
          />
        </div>
      ) : error ? (
        <p role="alert" className="mt-5">
          {error}{' '}
          <button className={button} onClick={() => void refresh()}>
            Retry
          </button>
        </p>
      ) : !item ? (
        <p role="status" className="mt-5">
          Loading your item…
        </p>
      ) : (
        <div className="mt-6 space-y-6">
          <header>
            <p className="dcl-eyebrow">{item.code}</p>
            <h1 className="dcl-display mt-3 break-words text-3xl font-extrabold sm:text-5xl">
              {item.title ?? 'Your item'}
            </h1>
            <p className="mt-3 text-lg font-bold">{item.status}</p>
          </header>
          {item.listing?.publishedAt ? (
            <section className={`${card} border-[var(--primary)]`}>
              <h2 className="text-2xl font-extrabold">YOUR ITEM IS LIVE</h2>
              <p className="mt-3">
                Public price: {money(item.listing.priceKobo)} · Published{' '}
                {date(item.listing.publishedAt)}
              </p>
              <Link
                className={`${button} mt-4`}
                href={`/declutter/${item.listing.slug}`}
              >
                View live listing
              </Link>
            </section>
          ) : null}
          <ActionCentre actions={item.actions} />
          <ItemProgress item={item} />
          <div className="grid min-w-0 items-start gap-6 lg:grid-cols-2">
            <div className="min-w-0 space-y-6">
              <ItemDetails item={item} />
              <SellerItemEditor key={item.id} item={item} onChanged={refresh} />
            </div>
            <div className="min-w-0 space-y-6">
              <section id="price" className={`${card} scroll-mt-24`}>
                <h2 className="text-xl font-bold">Your price decision</h2>
                <dl className="mt-5 space-y-4">
                  <div>
                    <dt className="text-sm text-[var(--ink-muted)]">
                      Your submitted price
                    </dt>
                    <dd className="mt-1 text-2xl font-bold">
                      {money(item.expectedPriceKobo)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-sm text-[var(--ink-muted)]">
                      DASH authorised price
                    </dt>
                    <dd className="mt-1 text-2xl font-bold">
                      {money(item.authorizedPriceKobo)}
                    </dd>
                  </div>
                </dl>
                {item.priceAcceptanceValid ? (
                  <p className="mt-5 font-bold">
                    Price accepted
                    {item.preConsented
                      ? ' · your exact-price pre-consent was honoured'
                      : ''}
                    .
                  </p>
                ) : item.valueCheckStatus === 'seller_declined' ? (
                  <p className="mt-5 text-sm">
                    You declined DASH’s authorised price. Your item will not
                    publish. Chat with DASH about the next step.
                  </p>
                ) : item.valueCheckStatus === 'seller_acceptance_pending' ? (
                  <div className="mt-5 space-y-3">
                    <p className="text-sm">
                      Your decision is required before this item can proceed.
                    </p>
                    <label className="block text-sm">
                      Reason for declining (optional)
                      <input
                        value={declineReason}
                        onChange={(e) => setDeclineReason(e.target.value)}
                        maxLength={500}
                        className={`${input} mt-2`}
                      />
                    </label>
                    <div className="flex flex-wrap gap-3">
                      <button
                        disabled={busy}
                        className={`${button} bg-[var(--primary)] text-[var(--on-primary)]`}
                        onClick={() => void answer('accept')}
                      >
                        Accept {money(item.authorizedPriceKobo)}
                      </button>
                      <button
                        disabled={busy}
                        className={button}
                        onClick={() => void answer('decline')}
                      >
                        Decline
                      </button>
                    </div>
                  </div>
                ) : (
                  <p className="mt-5 text-sm">
                    DASH is reviewing the price. We’ll let you know when it is
                    ready.
                  </p>
                )}
                {decisionError ? (
                  <p role="alert" className="mt-4">
                    {decisionError}
                  </p>
                ) : null}
                <Link href="#chat" className={`${button} mt-4`}>
                  Chat with DASH about this price
                </Link>
              </section>
              <HubChat
                conversationId={item.conversationId}
                submissionId={item.id}
                onChanged={refresh}
              />
              <section className={card}>
                <h2 className="text-xl font-bold">
                  Activity & pricing history
                </h2>
                <ol className="mt-5 space-y-4">
                  {item.history.map((e, i) => (
                    <li
                      key={`${e.at}-${i}`}
                      className="border-l-2 border-[var(--line-strong)] pl-4"
                    >
                      <p className="text-sm font-bold">{e.label}</p>
                      <p className="mt-1 text-xs">{date(e.at)}</p>
                    </li>
                  ))}
                </ol>
              </section>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
