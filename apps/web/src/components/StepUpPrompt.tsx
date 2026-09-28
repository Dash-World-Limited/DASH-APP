'use client';

import { useCallback, useRef, useState, type ReactNode } from 'react';

import { Button, Field, Input } from '@/components/ui';
import { ApiRequestError } from '@/lib/api';
import { authedFetch } from '@/lib/session';

/**
 * Step-up for staff actions that need it.
 *
 * Consequential decisions (approving a vendor or rider, KYC review, refunds)
 * are refused with `step_up_required` unless the session proved its second
 * factor in the last fifteen minutes. This wraps such an action: if the
 * server asks for step-up, it shows a field for the six-digit authenticator
 * code, posts it to /v1/auth/mfa/step-up, and runs the action once more. One
 * step-up then covers the whole queue for the window the server allows.
 *
 * The code is never stored; the field clears after every attempt.
 */
export function useStepUp(): {
  /** Run an action, stepping up first if the server asks. Rejects with its error otherwise. */
  run: <T>(action: () => Promise<T>) => Promise<T | undefined>;
  prompt: ReactNode;
} {
  const [pending, setPending] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const resume = useRef<((ok: boolean) => void) | null>(null);

  const run = useCallback(async <T,>(action: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await action();
    } catch (caught) {
      if (!(caught instanceof ApiRequestError) || !caught.needsStepUp) throw caught;
      const confirmed = await new Promise<boolean>((resolve) => {
        resume.current = resolve;
        setError(null);
        setCode('');
        setPending(true);
      });
      if (!confirmed) return undefined;
      return action();
    }
  }, []);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await authedFetch('/v1/auth/mfa/step-up', { method: 'POST', body: { code } });
      setPending(false);
      resume.current?.(true);
    } catch (caught) {
      setError(caught instanceof ApiRequestError ? caught.message : 'That code did not work. Try again.');
    } finally {
      setCode('');
      setBusy(false);
    }
  }

  function cancel() {
    setPending(false);
    resume.current?.(false);
  }

  const prompt = pending ? (
    <div role="dialog" aria-modal="true" aria-labelledby="step-up-title" className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
      <form
        className="w-full max-w-sm space-y-4 rounded-2xl bg-[var(--surface)] p-6"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <h2 id="step-up-title" className="text-lg font-bold">
          Confirm it is you
        </h2>
        <p className="text-sm text-[var(--ink-muted)]">
          Enter the six-digit code from your authenticator app. It covers decisions for the next fifteen minutes.
        </p>
        <Field label="Authenticator code" htmlFor="step-up-code" {...(error ? { error } : {})}>
          <Input
            id="step-up-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
            autoFocus
          />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={cancel} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy || code.length !== 6}>
            Confirm
          </Button>
        </div>
      </form>
    </div>
  ) : null;

  return { run, prompt };
}
