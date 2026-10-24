'use client';

/**
 * Proving the email address.
 *
 * The step that turns a claimed address into an account. Redeeming the code
 * also signs the person in, because possession of a code sent to that mailbox
 * is exactly the proof a sign-in asks for, and making somebody verify and then
 * immediately sign in again is a step that protects nothing and loses people.
 *
 * The resend button is a real control with a real cooldown. The server refuses
 * inside sixty seconds and says how long is left; this shows that sentence
 * rather than pretending the click worked, because the person pressing it is
 * the one waiting for the email and a silent success looks like a broken
 * button.
 *
 * Nothing on this page confirms whether the address has an account. Somebody
 * who typed a stranger's address at signup learns nothing here.
 */

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';

import { AuthError, AuthField, AuthShell, AuthSubmit, DevCode } from '@/components/declutter/AuthShell';
import { ApiRequestError } from '@/lib/api';
import { resendVerification, verifyEmail } from '@/lib/session';
import { safeReturnTo } from '@/lib/return-to';

const COOLDOWN_SECONDS = 60;

export function VerifyPage() {
  const router = useRouter();
  const params = useSearchParams();
  const next = safeReturnTo(params.get('next'));
  const email = (params.get('email') ?? '').trim().toLowerCase();

  const [code, setCode] = useState('');
  const [devCode, setDevCode] = useState<string | null>(params.get('dev'));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(COOLDOWN_SECONDS);

  // A visible countdown, so the resend button explains itself before it is
  // pressed rather than after.
  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((seconds) => seconds - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  // Arriving here without an address means a bookmarked or hand-typed URL.
  // There is nothing to verify, so send them somewhere that works.
  if (!email) {
    return (
      <AuthShell
        eyebrow="Verify email"
        title="We need the address first."
        lede="This page confirms an email address, and no address came with the link."
      >
        <Link
          href="/declutter/join"
          className="inline-flex min-h-12 w-full items-center justify-center rounded-full bg-[var(--primary)] px-7 text-sm font-bold text-[var(--on-primary)]"
        >
          Create an account
        </Link>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      eyebrow="Verify email"
      title="Check your email."
      lede={`We sent a six-digit code to ${email}. It expires shortly, and it only works once.`}
      footer={
        <>
          Wrong address?{' '}
          <Link href="/declutter/join" className="font-semibold text-[var(--ink)] underline">
            Start again
          </Link>
        </>
      }
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          setError(null);
          setNotice(null);
          void (async () => {
            try {
              await verifyEmail(email, code.trim());
              router.push(next);
            } catch (caught) {
              setError(
                caught instanceof ApiRequestError
                  ? caught.message
                  : 'We could not check that code. Try again in a moment.',
              );
            } finally {
              setBusy(false);
            }
          })();
        }}
      >
        <AuthField
          id="verify-code"
          label="Six-digit code"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          required
          autoFocus
          value={code}
          onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
          placeholder="000000"
        />

        <DevCode code={devCode} />
        <AuthError message={error} />

        {notice ? (
          <p role="status" className="mt-4 text-sm font-semibold text-[var(--accent)]">
            {notice}
          </p>
        ) : null}

        <AuthSubmit disabled={busy || code.trim().length !== 6}>
          {busy ? 'Checking…' : 'Verify and continue'}
        </AuthSubmit>
      </form>

      <div className="mt-6 border-t border-[var(--line)] pt-5 text-sm text-[var(--ink-muted)]">
        <p>Did not get it? Check spam, then ask for another.</p>
        <button
          type="button"
          disabled={busy || cooldown > 0}
          onClick={() => {
            setBusy(true);
            setError(null);
            setNotice(null);
            void (async () => {
              try {
                const result = await resendVerification(email);
                setDevCode(result.devCode ?? null);
                setNotice('A new code is on its way. The previous one no longer works.');
                setCooldown(COOLDOWN_SECONDS);
                setCode('');
              } catch (caught) {
                setError(
                  caught instanceof ApiRequestError
                    ? caught.message
                    : 'We could not send another code. Try again shortly.',
                );
                // The server is the authority on the cooldown; if it refused,
                // start the visible countdown again rather than letting the
                // button invite another refusal immediately.
                setCooldown(COOLDOWN_SECONDS);
              } finally {
                setBusy(false);
              }
            })();
          }}
          className="dcl-glass mt-3 min-h-11 rounded-full px-5 text-sm font-bold text-[var(--ink)] disabled:opacity-50"
        >
          {cooldown > 0 ? `Resend in ${cooldown}s` : 'Send another code'}
        </button>
      </div>
    </AuthShell>
  );
}
