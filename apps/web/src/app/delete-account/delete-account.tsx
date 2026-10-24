'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

import { Button, Card, Field, Input } from '@/components/ui';
import { ApiRequestError } from '@/lib/api';
import { authedFetch, useHasSession, useMe } from '@/lib/session';

interface Deletion {
  status: 'scheduled' | 'held' | 'cancelled' | 'completed';
  scheduledPurgeAt: string | null;
  cancellable: boolean;
}

function messageFor(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  return 'Something went wrong. Try again.';
}

/**
 * Request or cancel deletion for the signed-in account.
 *
 * Requesting is a step-up action: the server refuses it unless the session
 * proved, in the last fifteen minutes, that it holds this account's email.
 * So the flow sends a step-up code to the account's own address, redeems it,
 * and only then asks for deletion. Cancelling needs no step-up.
 */
export function DeleteAccount() {
  const signedIn = useHasSession();
  const { me } = useMe();
  const [deletion, setDeletion] = useState<Deletion | null | undefined>(undefined);
  const [stage, setStage] = useState<'idle' | 'code_sent'>('idle');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await authedFetch<{ deletion: Deletion | null }>('/v1/account/deletion');
      setDeletion(data.deletion);
    } catch (caught) {
      setNotice(messageFor(caught));
      setDeletion(null);
    }
  }, []);

  useEffect(() => {
    if (signedIn) void load();
  }, [signedIn, load]);

  if (!signedIn) {
    return (
      <Card className="space-y-3 p-6">
        <h2 className="text-lg font-bold">Request deletion here</h2>
        <p className="text-sm text-[var(--ink-muted)]">Sign in with the email address on your DASH account to continue.</p>
        <Link href="/signin?next=/delete-account">
          <Button>Sign in</Button>
        </Link>
      </Card>
    );
  }

  const email = me?.identity.email ?? null;
  const pending = deletion && (deletion.status === 'scheduled' || deletion.status === 'held');

  async function sendCode() {
    if (!email) return;
    setBusy(true);
    setNotice(null);
    try {
      await authedFetch('/v1/auth/otp/request', { method: 'POST', body: { email, purpose: 'step_up' } });
      setStage('code_sent');
    } catch (caught) {
      setNotice(messageFor(caught));
    } finally {
      setBusy(false);
    }
  }

  async function confirmAndDelete() {
    if (!email) return;
    setBusy(true);
    setNotice(null);
    try {
      await authedFetch('/v1/auth/otp/verify', { method: 'POST', body: { email, code, purpose: 'step_up' } });
      await authedFetch('/v1/account/deletion', { method: 'POST', body: {}, idempotencyKey: `web-delete-${Date.now()}` });
      setStage('idle');
      await load();
    } catch (caught) {
      setNotice(messageFor(caught));
    } finally {
      setCode('');
      setBusy(false);
    }
  }

  async function cancel() {
    setBusy(true);
    setNotice(null);
    try {
      await authedFetch('/v1/account/deletion', { method: 'DELETE' });
      await load();
    } catch (caught) {
      setNotice(messageFor(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-4 p-6">
      <h2 className="text-lg font-bold">Your account</h2>
      {deletion === undefined ? <p className="text-sm text-[var(--ink-muted)]">Loading…</p> : null}

      {pending ? (
        <div className="space-y-3">
          <p>
            Your account is scheduled for deletion
            {deletion?.scheduledPurgeAt ? ` on ${new Date(deletion.scheduledPurgeAt).toLocaleDateString()}` : ''}.
            {deletion?.status === 'held' ? ' It is on hold while an open dispute is resolved.' : ''}
          </p>
          {deletion?.cancellable ? (
            <Button variant="secondary" onClick={() => void cancel()} disabled={busy}>
              Cancel deletion
            </Button>
          ) : null}
        </div>
      ) : null}

      {deletion !== undefined && !pending ? (
        stage === 'idle' ? (
          <div className="space-y-3">
            <p className="text-sm text-[var(--ink-muted)]">
              To confirm it is you, we will email a code to {email ?? 'your account email'}.
            </p>
            <Button variant="danger" onClick={() => void sendCode()} disabled={busy || !email}>
              Delete my account
            </Button>
          </div>
        ) : (
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              void confirmAndDelete();
            }}
          >
            <Field label={`Code sent to ${email ?? 'your email'}`} htmlFor="delete-code">
              <Input
                id="delete-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
              />
            </Field>
            <div className="flex gap-2">
              <Button type="button" variant="ghost" onClick={() => setStage('idle')} disabled={busy}>
                Back
              </Button>
              <Button type="submit" variant="danger" disabled={busy || code.length !== 6}>
                Confirm deletion
              </Button>
            </div>
          </form>
        )
      ) : null}

      {notice ? (
        <p role="alert" className="text-sm font-medium text-[var(--danger)]">
          {notice}
        </p>
      ) : null}
    </Card>
  );
}
