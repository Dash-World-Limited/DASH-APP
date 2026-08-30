'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { AppHeader } from '@/components/AppHeader';
import { Button, Card, ErrorState, Field, Input, Wordmark } from '@/components/ui';
import { ApiRequestError } from '@/lib/api';
import { requestOtp, signInWithPassword, verifyOtp } from '@/lib/session';

type Mode = 'otp' | 'password';

function SignInForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get('next') ?? '/browse';

  const [mode, setMode] = useState<Mode>('otp');
  const [phone, setPhone] = useState('+2347000000201');
  const [code, setCode] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [stage, setStage] = useState<'enter' | 'verify'>('enter');
  const [devCode, setDevCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiRequestError | null>(null);

  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(
        caught instanceof ApiRequestError
          ? caught
          : new ApiRequestError(0, 'unknown', 'Something went wrong. Please try again.'),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <main id="main" className="mx-auto max-w-md px-5 py-12">
      <Wordmark className="text-2xl" />
      <h1 className="mt-8 text-3xl font-extrabold tracking-tight">Sign in</h1>
      <p className="mt-2 text-sm text-graphite-600">
        Customers and riders use a code. Vendors and staff use a password.
      </p>

      <div className="mt-6 flex gap-1 rounded-xl border p-1" role="tablist">
        {(['otp', 'password'] as const).map((option) => (
          <button
            key={option}
            role="tab"
            aria-selected={mode === option}
            onClick={() => {
              setMode(option);
              setStage('enter');
              setError(null);
            }}
            className={`flex-1 rounded-lg px-3 py-2 text-sm font-semibold transition-colors ${
              mode === option ? 'bg-graphite-900 text-white' : 'hover:bg-[var(--surface-raised)]'
            }`}
          >
            {option === 'otp' ? 'Phone code' : 'Password'}
          </button>
        ))}
      </div>

      <Card className="mt-4 p-6">
        {error ? (
          <div className="mb-4">
            <ErrorState
              title="Could not sign in"
              message={error.message}
              requestId={error.requestId}
            />
          </div>
        ) : null}

        {mode === 'otp' ? (
          stage === 'enter' ? (
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                void run(async () => {
                  const result = await requestOtp(phone);
                  setDevCode(result.devCode ?? null);
                  setStage('verify');
                });
              }}
            >
              <Field
                label="Phone number"
                htmlFor="phone"
                hint="Include the country code, e.g. +234…"
              >
                <Input
                  id="phone"
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  required
                  value={phone}
                  onChange={(event) => setPhone(event.target.value)}
                />
              </Field>
              <Button type="submit" size="lg" className="w-full" disabled={busy}>
                {busy ? 'Sending…' : 'Send me a code'}
              </Button>
            </form>
          ) : (
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                void run(async () => {
                  await verifyOtp(phone, code);
                  router.push(next);
                });
              }}
            >
              <Field
                label="6-digit code"
                htmlFor="code"
                hint={`Sent to ${phone}. It expires in 5 minutes.`}
              >
                <Input
                  id="code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="\d{6}"
                  maxLength={6}
                  required
                  value={code}
                  onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
                  className="text-center text-2xl tracking-[0.4em]"
                />
              </Field>

              {devCode ? (
                <div className="rounded-xl border border-gold-400/40 bg-gold-50 px-4 py-3">
                  <p className="text-xs font-semibold text-gold-600">Development only</p>
                  <p className="mt-1 text-sm text-graphite-600">
                    Your code is{' '}
                    <button
                      type="button"
                      className="font-mono font-bold underline"
                      onClick={() => setCode(devCode)}
                    >
                      {devCode}
                    </button>
                    . This is never returned in production.
                  </p>
                </div>
              ) : null}

              <Button type="submit" size="lg" className="w-full" disabled={busy}>
                {busy ? 'Checking…' : 'Verify and continue'}
              </Button>
              <button
                type="button"
                className="w-full text-sm text-graphite-600 underline"
                onClick={() => setStage('enter')}
              >
                Use a different number
              </button>
            </form>
          )
        ) : (
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                await signInWithPassword(email, password);
                router.push(next);
              });
            }}
          >
            <Field label="Email" htmlFor="email">
              <Input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@example.com"
              />
            </Field>
            <Field label="Password" htmlFor="password">
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </Field>
            <Button type="submit" size="lg" className="w-full" disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>
        )}
      </Card>

      <details className="mt-6 rounded-xl border p-4 text-sm">
        <summary className="cursor-pointer font-semibold">Development accounts</summary>
        <ul className="mt-3 space-y-1 text-graphite-600">
          <li>
            <strong>Customer</strong> — code to <code>+2347000000201</code>
          </li>
          <li>
            <strong>Rider</strong> — code to <code>+2347000000301</code>
          </li>
          <li>
            <strong>Vendor</strong> — <code>iya-kemi-kitchen@dashapp.test</code>
          </li>
          <li>
            <strong>Ops</strong> — <code>ops@dashapp.test</code>
          </li>
          <li>
            <strong>Admin</strong> — <code>admin@dashapp.test</code>
          </li>
        </ul>
        <p className="mt-3 text-graphite-400">
          All passwords are <code>DashDev!2026</code>. Every account is fictional.
        </p>
      </details>
    </main>
  );
}

export default function SignInPage() {
  return (
    <>
      <AppHeader />
      <Suspense fallback={<div className="p-10 text-center text-sm">Loading…</div>}>
        <SignInForm />
      </Suspense>
    </>
  );
}
