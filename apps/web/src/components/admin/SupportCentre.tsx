'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useStepUp } from '@/components/StepUpPrompt';
import { ApiRequestError } from '@/lib/api';
import { authedFetch, useHasSession, usePermissions } from '@/lib/session';
import {
  accountName,
  formatWhen,
  inboxPath,
  previewLine,
  roleLabel,
  SUPPORT_REPLY_MAX,
  threadPath,
  type AudienceFilter,
  type StatusFilter,
  type SupportAccount,
  type SupportInbox,
  type SupportThread,
  type SupportThreadMessage,
} from '@/lib/support-inbox';

/** How often the open inbox and conversation refresh while the tab is visible. */
const INBOX_REFRESH_MS = 15_000;
const THREAD_REFRESH_MS = 8_000;

const visible = () => typeof document === 'undefined' || document.visibilityState === 'visible';

const describe = (caught: unknown, fallback: string) => (caught instanceof ApiRequestError ? caught.message : fallback);

/**
 * In-app support conversations with customers and riders.
 *
 * Every request is authorised on the server (`support:case:read` to look,
 * `support:case:write` to reply or change status); the permission checks here
 * only decide which controls to show. Opening a conversation marks the
 * person's messages read; replies and status changes are audited server-side.
 */
export function SupportCentre() {
  const signedIn = useHasSession();
  const { permissions, loaded } = usePermissions();
  const canRead = permissions.has('support:case:read');
  const canWrite = permissions.has('support:case:write');
  const { run: runStepUp, prompt: stepUpPrompt } = useStepUp();

  const [audience, setAudience] = useState<AudienceFilter>('all');
  const [status, setStatus] = useState<StatusFilter>('open');
  const [inbox, setInbox] = useState<SupportInbox | null>(null);
  const [inboxError, setInboxError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const loadInbox = useCallback(
    async (quiet = false) => {
      if (!signedIn || !canRead) return;
      if (!quiet) setInboxError(null);
      try {
        // Background refreshes never raise the step-up prompt; only a load
        // the admin asked for does.
        const fetchInbox = () => authedFetch<SupportInbox>(inboxPath(audience, status));
        const result = quiet ? await fetchInbox() : await runStepUp(fetchInbox);
        if (result) setInbox(result);
      } catch (caught) {
        if (!quiet) setInboxError(describe(caught, 'Could not load support conversations.'));
      }
    },
    [audience, canRead, runStepUp, signedIn, status],
  );

  useEffect(() => {
    setInbox(null);
    void loadInbox();
    const timer = setInterval(() => {
      if (visible()) void loadInbox(true);
    }, INBOX_REFRESH_MS);
    return () => clearInterval(timer);
  }, [loadInbox]);

  if (!signedIn && loaded) {
    return (
      <div className="mx-auto max-w-3xl px-5 py-16">
        <div className="admin-card rounded-3xl p-8 text-center">
          <h1 className="text-2xl font-extrabold">Staff sign-in required</h1>
          <Link href="/admin/signin" className="mt-5 inline-flex rounded-xl bg-[var(--primary)] px-4 py-2.5 text-sm font-extrabold text-[var(--on-primary)]">
            Sign in
          </Link>
        </div>
      </div>
    );
  }

  if (loaded && !canRead) {
    return (
      <div className="mx-auto max-w-3xl px-5 py-16">
        <div className="admin-card rounded-3xl p-8 text-center">
          <p className="admin-kicker">Restricted</p>
          <h1 className="mt-2 text-2xl font-extrabold">No access to support conversations</h1>
          <p className="mt-3 text-sm text-[var(--ink-muted)]">This account does not hold the support permission.</p>
        </div>
      </div>
    );
  }

  const conversations = inbox?.conversations ?? null;

  return (
    <div className="min-h-[calc(100vh-4.5rem)] px-4 py-6 sm:px-6 sm:py-8 xl:px-8">
      <div className="mx-auto max-w-7xl">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="admin-kicker">Customer care</p>
            <h1 className="mt-1 text-3xl font-extrabold tracking-[-0.03em]">Support centre</h1>
            <p className="mt-2 text-sm text-[var(--ink-muted)]">Conversations customers and riders started from the DASH app.</p>
          </div>
          <div className="rounded-2xl bg-[var(--surface-sunken)] px-4 py-3 text-sm" data-testid="support-unread-total">
            <span className="font-extrabold">{inbox?.unreadTotal ?? '—'}</span>
            <span className="ml-1.5 text-[var(--ink-muted)]">unread</span>
          </div>
        </div>

        <div className="mt-6 flex flex-wrap gap-3">
          <Segmented
            label="Who"
            value={audience}
            options={[
              ['all', 'All'],
              ['customer', 'Customers'],
              ['rider', 'Riders'],
            ]}
            onChange={(value) => {
              setSelected(null);
              setAudience(value);
            }}
          />
          <Segmented
            label="Status"
            value={status}
            options={[
              ['open', 'Open'],
              ['resolved', 'Resolved'],
              ['all', 'All'],
            ]}
            onChange={(value) => {
              setSelected(null);
              setStatus(value);
            }}
          />
        </div>

        {inboxError ? (
          <div role="alert" className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-[var(--danger-soft)] px-5 py-4 text-sm font-semibold text-[var(--danger)]">
            {inboxError}
            <button type="button" onClick={() => void loadInbox()} className="rounded-lg border border-current px-3 py-1.5 text-xs font-bold">
              Try again
            </button>
          </div>
        ) : null}

        <div className="mt-6 grid gap-4 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
          <section aria-label="Conversations" className={selected ? 'hidden lg:block' : ''}>
            {conversations === null ? (
              inboxError ? null : <div className="admin-card rounded-3xl p-8 text-center text-sm text-[var(--ink-muted)]">Loading conversations…</div>
            ) : conversations.length === 0 ? (
              <div className="admin-card rounded-3xl p-10 text-center">
                <h2 className="text-xl font-extrabold">Nothing here</h2>
                <p className="mt-2 text-sm text-[var(--ink-muted)]">No {status === 'all' ? '' : `${status} `}conversations{audience === 'all' ? '' : ` with ${audience}s`} right now.</p>
              </div>
            ) : (
              <ul className="space-y-2">
                {conversations.map((conversation) => {
                  const active = conversation.id === selected;
                  return (
                    <li key={conversation.id}>
                      <button
                        type="button"
                        onClick={() => setSelected(conversation.id)}
                        aria-current={active ? 'true' : undefined}
                        className={
                          'admin-card w-full rounded-2xl p-4 text-left transition ' +
                          (active ? 'ring-2 ring-[var(--primary)]' : 'hover:bg-[var(--surface-sunken)]')
                        }
                      >
                        <div className="flex items-start gap-3">
                          <Avatar name={accountName(conversation.account)} />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <p className={'truncate text-sm ' + (conversation.unread > 0 ? 'font-extrabold' : 'font-bold')}>{accountName(conversation.account)}</p>
                              <RoleBadge role={conversation.audience} />
                              <span className="ml-auto shrink-0 text-[11px] text-[var(--ink-muted)]">{formatWhen(conversation.lastMessage?.createdAt ?? conversation.updatedAt)}</span>
                            </div>
                            <div className="mt-1 flex items-center gap-2">
                              <p className="min-w-0 flex-1 truncate text-xs text-[var(--ink-muted)]">{previewLine(conversation)}</p>
                              {conversation.unread > 0 ? (
                                <span className="shrink-0 rounded-full bg-[var(--primary)] px-2 py-0.5 text-[10px] font-extrabold text-[var(--on-primary)]" aria-label={`${conversation.unread} unread`}>
                                  {conversation.unread}
                                </span>
                              ) : null}
                            </div>
                            <p className="mt-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--ink-muted)]">
                              {conversation.code}
                              {conversation.status === 'resolved' ? ' · Resolved' : ''}
                            </p>
                          </div>
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section aria-label="Conversation" className={selected ? '' : 'hidden lg:block'}>
            {selected ? (
              <Thread
                key={selected}
                id={selected}
                canWrite={canWrite}
                runStepUp={runStepUp}
                onBack={() => setSelected(null)}
                onChanged={() => void loadInbox(true)}
              />
            ) : (
              <div className="admin-card flex min-h-64 items-center justify-center rounded-3xl p-8 text-center text-sm text-[var(--ink-muted)]">
                Choose a conversation to read and reply.
              </div>
            )}
          </section>
        </div>
      </div>
      {stepUpPrompt}
    </div>
  );
}

function Thread({
  id,
  canWrite,
  runStepUp,
  onBack,
  onChanged,
}: {
  id: string;
  canWrite: boolean;
  runStepUp: <T>(action: () => Promise<T>) => Promise<T | undefined>;
  onBack: () => void;
  onChanged: () => void;
}) {
  const [thread, setThread] = useState<SupportThread | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [changing, setChanging] = useState(false);
  const end = useRef<HTMLDivElement | null>(null);
  const sendingRef = useRef(false);

  const load = useCallback(
    async (quiet = false) => {
      try {
        const fetchThread = () => authedFetch<SupportThread>(threadPath(id));
        const result = quiet ? await fetchThread() : await runStepUp(fetchThread);
        if (result) {
          setThread(result);
          if (!quiet) setError(null);
        }
      } catch (caught) {
        if (!quiet) setError(describe(caught, 'Could not open this conversation.'));
      }
    },
    [id, runStepUp],
  );

  const changed = useRef(onChanged);
  changed.current = onChanged;

  useEffect(() => {
    // Opening marks the person's messages read, so the list's counts change.
    void load().then(() => changed.current());
    const timer = setInterval(() => {
      if (visible()) void load(true);
    }, THREAD_REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const count = thread?.messages.length ?? 0;
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'nearest' });
  }, [count]);

  const send = async () => {
    const body = draft.trim();
    if (!body || sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    setError(null);
    try {
      const result = await runStepUp(() =>
        authedFetch<{ message: SupportThreadMessage }>(`${threadPath(id)}/messages`, { method: 'POST', body: { body } }),
      );
      if (result) {
        setDraft('');
        await load(true);
        onChanged();
      }
    } catch (caught) {
      setError(describe(caught, 'Your reply was not sent. Please try again.'));
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  const changeStatus = async (next: 'open' | 'resolved') => {
    setChanging(true);
    setError(null);
    try {
      const result = await runStepUp(() => authedFetch(`${threadPath(id)}/status`, { method: 'POST', body: { status: next } }));
      if (result !== undefined) {
        await load(true);
        onChanged();
      }
    } catch (caught) {
      setError(describe(caught, 'The status was not changed.'));
    } finally {
      setChanging(false);
    }
  };

  if (!thread) {
    return (
      <div className="admin-card rounded-3xl p-8 text-center text-sm text-[var(--ink-muted)]">
        {error ? (
          <div role="alert" className="text-[var(--danger)]">
            <p className="font-semibold">{error}</p>
            <button type="button" onClick={() => void load()} className="mt-3 rounded-lg border border-current px-3 py-1.5 text-xs font-bold">
              Try again
            </button>
          </div>
        ) : (
          'Opening conversation…'
        )}
      </div>
    );
  }

  const { conversation, messages } = thread;
  const resolved = conversation.status === 'resolved';
  const canSend = canWrite && draft.trim().length > 0 && !sending;

  return (
    <article className="admin-card flex flex-col rounded-3xl" data-testid="support-thread">
      <header className="border-b border-[var(--line)] p-5">
        <button type="button" onClick={onBack} className="mb-3 text-xs font-bold text-[var(--primary)] lg:hidden">
          ← All conversations
        </button>
        <div className="flex flex-wrap items-start gap-3">
          <Avatar name={accountName(conversation.account)} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-lg font-extrabold">{accountName(conversation.account)}</h2>
              <RoleBadge role={conversation.audience} />
              {resolved ? <span className="rounded-full bg-[var(--success-soft)] px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-wide text-[var(--success)]">Resolved</span> : null}
            </div>
            <p className="mt-1 text-xs text-[var(--ink-muted)]">
              {conversation.code} · started {new Date(conversation.createdAt).toLocaleString()}
            </p>
          </div>
          {canWrite ? (
            <button
              type="button"
              disabled={changing}
              onClick={() => void changeStatus(resolved ? 'open' : 'resolved')}
              className="min-h-10 rounded-xl border border-[var(--line)] bg-[var(--surface-raised)] px-4 text-xs font-bold text-[var(--ink-muted)] hover:text-[var(--ink)] disabled:opacity-50"
            >
              {changing ? 'Saving…' : resolved ? 'Reopen' : 'Mark resolved'}
            </button>
          ) : null}
        </div>
        <AccountDetails account={conversation.account} />
      </header>

      <div className="max-h-[55vh] min-h-48 space-y-3 overflow-y-auto p-5" aria-live="polite">
        {messages.length === 0 ? <p className="text-center text-sm text-[var(--ink-muted)]">No messages yet.</p> : null}
        {messages.map((message) => (
          <div key={message.id} className={'flex ' + (message.from === 'staff' ? 'justify-end' : 'justify-start')}>
            <div
              className={
                'max-w-[85%] rounded-2xl px-4 py-2.5 text-sm ' +
                (message.from === 'staff' ? 'bg-[var(--primary)] text-[var(--on-primary)]' : 'bg-[var(--surface-sunken)]')
              }
            >
              <p className="text-[10px] font-extrabold uppercase tracking-wide opacity-80">
                {message.from === 'staff' ? message.staffName ?? 'DASH Support' : roleLabel(conversation.audience)}
              </p>
              <p className="mt-0.5 whitespace-pre-wrap break-words">{message.body}</p>
              <p className="mt-1 text-[10px] opacity-70">
                {new Date(message.createdAt).toLocaleString()}
                {message.from === 'staff' ? (message.readAt ? ' · Read' : ' · Sent') : ''}
              </p>
            </div>
          </div>
        ))}
        <div ref={end} />
      </div>

      {error ? (
        <p role="alert" className="mx-5 rounded-xl bg-[var(--danger-soft)] px-4 py-3 text-xs font-semibold text-[var(--danger)]">
          {error}
        </p>
      ) : null}

      {canWrite ? (
        <form
          className="border-t border-[var(--line)] p-4"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <label htmlFor="support-reply" className="sr-only">
            Reply to {accountName(conversation.account)}
          </label>
          <textarea
            id="support-reply"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void send();
              }
            }}
            maxLength={SUPPORT_REPLY_MAX}
            rows={3}
            disabled={sending}
            placeholder={resolved ? 'Write a reply… Sending it reopens this conversation.' : 'Write a reply…'}
            className="w-full resize-y rounded-xl border border-[var(--line)] bg-[var(--surface-raised)] px-3.5 py-2.5 text-sm outline-none focus:border-[var(--primary)]"
          />
          <div className="mt-2 flex items-center justify-between gap-3">
            <span className="text-[11px] text-[var(--ink-muted)]">
              {draft.length}/{SUPPORT_REPLY_MAX} · Ctrl/⌘ + Enter to send
            </span>
            <button
              type="submit"
              disabled={!canSend}
              className="min-h-11 rounded-xl bg-[var(--primary)] px-5 text-sm font-extrabold text-[var(--on-primary)] transition hover:bg-[var(--primary-hover)] disabled:opacity-50"
            >
              {sending ? 'Sending…' : 'Send reply'}
            </button>
          </div>
        </form>
      ) : (
        <p className="border-t border-[var(--line)] p-4 text-xs text-[var(--ink-muted)]">This account can read conversations but not reply.</p>
      )}
    </article>
  );
}

function AccountDetails({ account }: { account: SupportAccount | null }) {
  if (!account) return <p className="mt-3 text-xs text-[var(--ink-muted)]">The account behind this conversation is no longer available.</p>;
  return (
    <dl className="mt-4 grid grid-cols-2 gap-3 rounded-2xl bg-[var(--surface-sunken)] p-4 text-xs sm:grid-cols-4" data-testid="support-account">
      <div>
        <dt className="text-[var(--ink-muted)]">Role</dt>
        <dd className="mt-1 font-bold">{roleLabel(account.role)}</dd>
      </div>
      <div className="min-w-0">
        <dt className="text-[var(--ink-muted)]">Email</dt>
        <dd className="mt-1 truncate font-bold">{account.email ?? '—'}</dd>
      </div>
      <div>
        <dt className="text-[var(--ink-muted)]">Phone</dt>
        <dd className="mt-1 font-bold">{account.phone ?? '—'}</dd>
      </div>
      <div>
        <dt className="text-[var(--ink-muted)]">Account</dt>
        <dd className="mt-1 font-bold capitalize">
          {account.accountStatus.replace(/_/g, ' ')}
          {account.riderStatus ? ` · rider ${account.riderStatus.replace(/_/g, ' ')}` : ''}
        </dd>
      </div>
      <div className="col-span-2 min-w-0 sm:col-span-4">
        <dt className="text-[var(--ink-muted)]">Account ID</dt>
        <dd className="mt-1 truncate font-mono text-[11px]">{account.identityId}</dd>
      </div>
    </dl>
  );
}

function RoleBadge({ role }: { role: 'customer' | 'rider' }) {
  return (
    <span
      className={
        'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wide ' +
        (role === 'rider' ? 'bg-[var(--success-soft)] text-[var(--success)]' : 'bg-[var(--primary-soft)] text-[var(--primary)]')
      }
    >
      {roleLabel(role)}
    </span>
  );
}

function Avatar({ name }: { name: string }) {
  return (
    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-[var(--primary-soft)] text-sm font-extrabold text-[var(--primary)]" aria-hidden>
      {name.slice(0, 1).toUpperCase()}
    </div>
  );
}

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<readonly [T, string]>;
  onChange: (value: T) => void;
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex rounded-xl bg-[var(--surface-sunken)] p-1">
      {options.map(([option, text]) => (
        <button
          key={option}
          type="button"
          aria-pressed={value === option}
          onClick={() => onChange(option)}
          className={
            'min-w-20 rounded-lg px-3 py-2 text-xs font-bold transition ' +
            (value === option ? 'bg-[var(--ink)] text-[var(--ink-inverted)]' : 'text-[var(--ink-muted)]')
          }
        >
          {text}
        </button>
      ))}
    </div>
  );
}
