'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { authedFetch } from '@/lib/session';
import { useHub } from './use-hub';
import {
  hubButton,
  hubCard,
  hubDate,
  hubInput,
  hubMoney,
  type HubItem,
} from './hub-types';

interface ChatData {
  nextCursor?: string | null;
  conversation: { id: string; status: string; submissionId: string | null };
  messages: {
    id: string;
    body: string;
    senderType: string;
    createdAt: string;
    readAt: string | null;
  }[];
}
export function HubChat({
  conversationId: initialId,
  submissionId,
  staff = false,
  onChanged,
}: {
  conversationId?: string | null;
  submissionId?: string;
  staff?: boolean;
  onChanged?: () => void;
}) {
  const [id, setId] = useState(initialId ?? null);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [older, setOlder] = useState<ChatData['messages']>([]);
  const [olderCursor, setOlderCursor] = useState<string | null | undefined>(
    undefined,
  );
  const [loadingOlder, setLoadingOlder] = useState(false);
  const retryKey = useRef<string | null>(null);
  const previousBody = useRef('');
  const prefix = staff ? '/v1/admin/declutter' : '/v1/declutter';
  const {
    data,
    error: loadError,
    refresh,
    session,
  } = useHub<ChatData>(id ? `${prefix}/conversations/${id}` : null);
  useEffect(() => {
    setId(initialId ?? null);
    setOlder([]);
    setOlderCursor(undefined);
  }, [initialId]);
  async function loadOlder() {
    const cursor = olderCursor === undefined ? data?.nextCursor : olderCursor;
    if (!id || !cursor || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const previous = await authedFetch<ChatData>(
        `${prefix}/conversations/${id}?before=${encodeURIComponent(cursor)}`,
      );
      setOlder((current) => [...previous.messages, ...current]);
      setOlderCursor(previous.nextCursor ?? null);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Earlier messages could not load.',
      );
    } finally {
      setLoadingOlder(false);
    }
  }
  const markRead = useCallback(async () => {
    if (!id || document.hidden || session !== 'authenticated') return;
    await authedFetch(`${prefix}/conversations/${id}/read`, {
      method: 'POST',
      body: {},
    });
    onChanged?.();
  }, [id, prefix, session, onChanged]);
  useEffect(() => {
    if (!id) return;
    void markRead().catch(() => {});
    const timer = setInterval(() => {
      if (!document.hidden) void markRead().catch(() => {});
    }, 15_000);
    return () => clearInterval(timer);
  }, [id, markRead, data?.messages.length]);
  async function send() {
    if (!body.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      let current = id;
      if (!current) {
        const created = await authedFetch<{ conversationId: string }>(
          `${prefix}/conversations`,
          { method: 'POST', body: submissionId ? { submissionId } : {} },
        );
        current = created.conversationId;
        setId(current);
      }
      if (!retryKey.current || previousBody.current !== body) {
        retryKey.current = crypto.randomUUID();
        previousBody.current = body;
      }
      await authedFetch(`${prefix}/conversations/${current}/messages`, {
        method: 'POST',
        body: { body: body.trim(), clientMessageId: retryKey.current },
      });
      setBody('');
      retryKey.current = null;
      await refresh();
      onChanged?.();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Message could not be sent. Try again.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section id="chat" className={`${hubCard} scroll-mt-24`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-bold">
          {staff ? 'Conversation' : 'Chat with DASH'}
        </h2>
        {data?.conversation.status === 'resolved' ? (
          <span className="text-sm">
            Resolved · a new message reopens this chat
          </span>
        ) : null}
      </div>
      {!id ? (
        <p className="mt-4 text-sm text-[var(--ink-muted)]">
          Ask about your item, price or account. DASH will reply here.
        </p>
      ) : !data && !loadError ? (
        <p role="status" className="mt-4">
          Loading messages…
        </p>
      ) : null}
      {loadError ? (
        <p role="alert" className="mt-4">
          {loadError}{' '}
          <button className="underline" onClick={() => void refresh()}>
            Retry
          </button>
        </p>
      ) : null}
      {data?.messages.length === 0 ? (
        <p className="mt-4 text-sm">
          No messages yet. Start the conversation below.
        </p>
      ) : null}
      <div
        aria-label="Messages"
        aria-live="polite"
        className="mt-5 max-h-[440px] space-y-3 overflow-y-auto overscroll-contain"
      >
        {(olderCursor === undefined ? data?.nextCursor : olderCursor) ? (
          <button
            className={`${hubButton} w-full`}
            disabled={loadingOlder}
            onClick={() => void loadOlder()}
          >
            {loadingOlder
              ? 'Loading earlier messages…'
              : 'Load earlier messages'}
          </button>
        ) : null}
        {[...older, ...(data?.messages ?? [])]
          .filter(
            (message, index, messages) =>
              messages.findIndex((m) => m.id === message.id) === index,
          )
          .map((m) => {
            const own = staff
              ? m.senderType === 'staff'
              : m.senderType === 'seller';
            return (
              <article
                key={m.id}
                className={`w-fit max-w-[90%] rounded-2xl border border-[var(--line)] p-4 ${own ? 'ml-auto bg-[var(--surface-sunken)]' : 'bg-[var(--surface)]'}`}
              >
                <p className="mb-2 text-xs font-bold">
                  {m.senderType === 'staff' ? 'DASH' : staff ? 'Seller' : 'You'}
                </p>
                <p className="whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere]">
                  {m.body}
                </p>
                <p className="mt-2 text-[11px] text-[var(--ink-muted)]">
                  {hubDate(m.createdAt)}
                  {own && m.readAt ? ' · Read' : ''}
                </p>
              </article>
            );
          })}
      </div>
      {error ? (
        <p role="alert" className="mt-4 text-sm">
          {error} Your message is kept below so you can retry.
        </p>
      ) : null}
      <form
        className="mt-5 space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <label className="block text-sm font-bold">
          Message
          <textarea
            value={body}
            maxLength={4000}
            onChange={(e) => setBody(e.target.value)}
            disabled={busy}
            rows={3}
            className={`${hubInput} mt-2 resize-y`}
            placeholder="How can DASH help?"
          />
        </label>
        <div className="flex flex-wrap items-center gap-3">
          <button
            disabled={busy || !body.trim() || (staff && !id && !submissionId)}
            className={`${hubButton} bg-[var(--primary)] text-[var(--on-primary)]`}
          >
            {busy ? 'Sending…' : error ? 'Retry send' : 'Send message'}
          </button>
          {staff && id ? (
            <button
              type="button"
              className={hubButton}
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void authedFetch(`${prefix}/conversations/${id}/status`, {
                  method: 'POST',
                  body: {
                    status:
                      data?.conversation.status === 'resolved'
                        ? 'open'
                        : 'resolved',
                  },
                })
                  .then(() => refresh())
                  .then(() => onChanged?.())
                  .catch((e) => setError(e.message))
                  .finally(() => setBusy(false));
              }}
            >
              {data?.conversation.status === 'resolved'
                ? 'Reopen conversation'
                : 'Mark resolved'}
            </button>
          ) : null}
        </div>
      </form>
    </section>
  );
}
interface Conversation {
  id: string;
  status: string;
  sellerName: string | null;
  submissionId: string | null;
  title: string;
  code: string | null;
  workflowStatus: string;
  priceState: string | null;
  lastMessage: string | null;
  updatedAt: string;
  unreadCount: number;
}
export function HubInbox({ staff = false }: { staff?: boolean }) {
  const { data, error, refresh, session } = useHub<{
    conversations: Conversation[];
  }>(`${staff ? '/v1/admin/declutter' : '/v1/declutter'}/conversations`);
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState('open');
  const cs = data?.conversations ?? [];
  const active = cs.find((c) => c.id === selected);
  const filtered = cs.filter(
    (c) =>
      filter === 'all' ||
      (filter === 'unread' && c.unreadCount > 0) ||
      (filter === 'pricing' &&
        [
          'seller_acceptance_pending',
          'seller_declined',
          'super_admin_approval_pending',
        ].includes(c.priceState ?? '')) ||
      (filter === 'action' &&
        (c.unreadCount > 0 ||
          c.workflowStatus === 'Price decision required')) ||
      c.status === filter,
  );
  if (session !== 'authenticated')
    return (
      <p role="status">
        {session === 'restoring'
          ? 'Checking your account…'
          : 'Sign in to open your messages.'}
      </p>
    );
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-3xl font-bold">
          {staff ? 'Declutters inbox' : 'Messages / Chat with DASH'}{' '}
          <span className="text-lg">
            ({cs.reduce((n, c) => n + c.unreadCount, 0)} unread)
          </span>
        </h1>
        <Link
          className={hubButton}
          href={staff ? '/ops/declutter' : '/declutter/account'}
        >
          Back to dashboard
        </Link>
      </div>
      <nav aria-label="Message filters" className="flex flex-wrap gap-2">
        {['all', 'unread', 'open', 'pricing', 'action', 'resolved'].map((f) => (
          <button
            key={f}
            className={`${hubButton} ${filter === f ? 'bg-[var(--surface-sunken)]' : ''}`}
            onClick={() => setFilter(f)}
          >
            {
              (
                {
                  all: 'All',
                  unread: 'Unread',
                  open: 'Open',
                  pricing: 'Pricing',
                  action: 'Action required',
                  resolved: 'Resolved',
                } as Record<string, string>
              )[f]
            }
          </button>
        ))}
      </nav>
      {error ? (
        <p role="alert">{error}</p>
      ) : !data ? (
        <p role="status">Loading conversations…</p>
      ) : null}
      <div className="grid min-w-0 gap-6 lg:grid-cols-[320px_minmax(0,1fr)]">
        <div className="space-y-3">
          {data && !filtered.length ? (
            <p className={hubCard}>No conversations in this view.</p>
          ) : null}
          {filtered.map((c) => (
            <button
              key={c.id}
              onClick={() => setSelected(c.id)}
              className={`${hubCard} w-full text-left ${selected === c.id ? 'ring-2 ring-[var(--primary)]' : ''}`}
            >
              {staff ? (
                <p className="text-sm font-bold">{c.sellerName ?? 'Seller'}</p>
              ) : null}
              <p className="mt-1 break-words font-bold">{c.title}</p>
              <p className="mt-1 text-xs">
                {c.code} · {c.workflowStatus}
              </p>
              <p className="mt-2 break-words text-sm text-[var(--ink-muted)]">
                {c.lastMessage ?? 'No messages yet'}
              </p>
              <p className="mt-2 text-xs">
                {hubDate(c.updatedAt)}{' '}
                {c.unreadCount ? `· ${c.unreadCount} unread` : ''}
              </p>
            </button>
          ))}
        </div>
        <div className="min-w-0 space-y-4">
          {active ? (
            <>
              <p className={hubCard}>
                {active.title} · {active.code} · {active.workflowStatus}
                {active.submissionId ? (
                  <Link
                    className="ml-3 underline"
                    href={`${staff ? '/ops/declutter/items' : '/declutter/account/items'}/${active.submissionId}`}
                  >
                    Manage item
                  </Link>
                ) : null}
              </p>
              {active.submissionId ? (
                <ConversationContext
                  submissionId={active.submissionId}
                  staff={staff}
                />
              ) : null}
              <HubChat
                key={active.id}
                conversationId={active.id}
                staff={staff}
                onChanged={refresh}
              />
            </>
          ) : !staff ? (
            <HubChat onChanged={refresh} />
          ) : (
            <p className={hubCard}>Select a conversation to reply.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function ConversationContext({
  submissionId,
  staff,
}: {
  submissionId: string;
  staff: boolean;
}) {
  const url = staff
    ? `/v1/admin/declutter/submissions/${submissionId}/workspace`
    : `/v1/declutter/account/items/${submissionId}`;
  const { data, error } = useHub<{ item: HubItem }>(url);
  const item = data?.item;
  return (
    <aside className={hubCard} aria-label="Conversation item context">
      {error ? (
        <p role="alert">{error}</p>
      ) : !item ? (
        <p role="status">Loading item context…</p>
      ) : (
        <>
          <p className="font-bold">
            {item.seller.name} · {item.status}
          </p>
          <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt>Your submitted price</dt>
              <dd className="mt-1 font-bold">
                {hubMoney(item.expectedPriceKobo)}
              </dd>
            </div>
            <div>
              <dt>DASH authorised price</dt>
              <dd className="mt-1 font-bold">
                {hubMoney(item.authorizedPriceKobo)}
              </dd>
            </div>
          </dl>
          <p className="mt-4 text-sm">
            Seller price decision:{' '}
            {item.priceAcceptanceValid
              ? 'Accepted'
              : item.valueCheckStatus === 'seller_declined'
                ? 'Declined'
                : 'Awaiting acceptance'}
          </p>
        </>
      )}
    </aside>
  );
}
