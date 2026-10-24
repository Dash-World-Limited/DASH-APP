'use client';

/**
 * Signing in to Declutters.
 *
 * By email, because that is the address the website asked somebody to prove
 * when they created their account and the one they will remember. The phone
 * number they gave has never been verified — SMS is off for V1 — so it is not
 * offered as a way in here; the app's own sign-in still uses it, unchanged.
 *
 * Two stages on one page. Splitting them across routes would mean the address
 * has to survive a navigation, which either puts it in a URL or in storage, and
 * neither is worth it for a form somebody is in the middle of.
 */

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';

import { AuthError, AuthField, AuthShell, AuthSubmit, DevCode } from '@/components/declutter/AuthShell';
import { ApiRequestError } from '@/lib/api';
import { requestOtp, verifyOtp } from '@/lib/session';
import { safeReturnTo } from '@/lib/return-to';

export function SignInPage() {
  const router = useRouter();
  const params = useSearchParams();
  // Checked, never trusted. See lib/return-to.ts — an unchecked `next` is an
  // open redirect, and a sign-in page is exactly where one is worth the most.
  const next = safeReturnTo(params.get('next'));

  const [stage, setStage] = useState<'address' | 'code'>('address');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [devCode, setDevCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (caught) {
      setError(
        caught instanceof ApiRequestError
          ? caught.message
          : 'Something went wrong. Try again in a moment.',
      );
    } finally {
      setBusy(false);
    }
  }

  if (stage === 'address') {
    return (
      <AuthShell
        eyebrow="Sign in"
        title="Welcome back."
        lede="Enter the email address on your DASH account and we will send you a six-digit code. No password to remember."
        footer={
          <>
            No account yet?{' '}
            <Link
              href={`/declutter/join?next=${encodeURIComponent(next)}`}
              className="font-semibold text-[var(--ink)] underline"
            >
              Create one
            </Link>
          </>
        }
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              const result = await requestOtp({ email: email.trim().toLowerCase() });
              setDevCode(result.devCode ?? null);
              setStage('code');
            });
          }}
        >
          <AuthField
            id="signin-email"
            label="Email address"
            type="email"
            autoComplete="email"
            inputMode="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@example.com"
          />
          <AuthError message={error} />
          <AuthSubmit disabled={busy || email.trim().length < 3}>
            {busy ? 'Sending…' : 'Send me a code'}
          </AuthSubmit>
        </form>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      eyebrow="Sign in"
      title="Check your email."
      // Deliberately does not confirm the address has an account. The request
      // endpoint answers identically either way, and saying "we sent it" here
      // would undo that.
      lede={`If ${email.trim().toLowerCase()} has a DASH account, a six-digit code is on its way.`}
      footer={
        <button
          type="button"
          onClick={() => {
            setStage('address');
            setCode('');
            setDevCode(null);
            setError(null);
          }}
          className="font-semibold text-[var(--ink)] underline"
        >
          Use a different address
        </button>
      }
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            await verifyOtp({ email: email.trim().toLowerCase() }, code.trim());
            router.push(next);
          });
        }}
      >
        <AuthField
          id="signin-code"
          label="Six-digit code"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          required
          value={code}
          onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
          placeholder="000000"
        />
        <DevCode code={devCode} />
        <AuthError message={error} />
        <AuthSubmit disabled={busy || code.trim().length !== 6}>
          {busy ? 'Checking…' : 'Sign in'}
        </AuthSubmit>
      </form>
    </AuthShell>
  );
}
