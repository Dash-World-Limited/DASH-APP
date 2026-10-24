'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { AppHeader } from '@/components/AppHeader';
import { Button, Card, ErrorState, Field, Input, Wordmark } from '@/components/ui';
import { apiFetch, ApiRequestError } from '@/lib/api';

type Stage = 'phone' | 'verify';

function SignUpForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get('next') ?? '/browse';

  const [stage, setStage] = useState<Stage>('phone');
  const [phone, setPhone] = useState('+234');
  const [code, setCode] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [marketingOptIn, setMarketingOptIn] = useState(false);
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
      <h1 className="mt-8 text-3xl font-extrabold tracking-tight">Create your account</h1>
      <p className="mt-2 text-sm text-graphite-600">
        Sign up with your phone number. We will verify it before creating your DASH account.
      </p>

      <Card className="mt-6 p-6">
        {error ? (
          <div className="mb-4">
            <ErrorState title="Could not create account" message={error.message} requestId={error.requestId} />
          </div>
        ) : null}

        {stage === 'phone' ? (
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                const result = await apiFetch<{ sent: boolean; expiresInSeconds: number; devCode?: string }>(
                  '/v1/auth/register/request',
                  { method: 'POST', body: { phone } },
                );
                setDevCode(result.devCode ?? null);
                setStage('verify');
              });
            }}
          >
            <Field label="Phone number" htmlFor="signup-phone" hint="Include the country code, e.g. +234…">
              <Input
                id="signup-phone"
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                required
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
              />
            </Field>
            <Button type="submit" size="lg" className="w-full" disabled={busy}>
              {busy ? 'Sending…' : 'Send verification code'}
            </Button>
          </form>
        ) : (
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                await apiFetch('/v1/auth/register/verify', {
                  method: 'POST',
                  body: { phone, code, displayName, email, marketingOptIn },
                });
                // Registration sets the HttpOnly refresh cookie. A full navigation
                // lets the existing session bootstrap restore the access token.
                window.location.assign(next);
              });
            }}
          >
            <Field label="6-digit code" htmlFor="signup-code" hint={`Sent to ${phone}.`}>
              <Input
                id="signup-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="\\d{6}"
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
                  <button type="button" className="font-mono font-bold underline" onClick={() => setCode(devCode)}>
                    {devCode}
                  </button>
                  .
                </p>
              </div>
            ) : null}

            <Field label="Your name" htmlFor="signup-name">
              <Input
                id="signup-name"
                autoComplete="name"
                required
                minLength={2}
                maxLength={80}
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder="Your name"
              />
            </Field>

            <Field label="Email (optional)" htmlFor="signup-email">
              <Input
                id="signup-email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@example.com"
              />
            </Field>

            <label className="flex items-start gap-3 text-sm text-graphite-600">
              <input
                type="checkbox"
                checked={marketingOptIn}
                onChange={(event) => setMarketingOptIn(event.target.checked)}
                className="mt-1"
              />
              <span>Send me occasional DASH offers and marketplace updates.</span>
            </label>

            <Button type="submit" size="lg" className="w-full" disabled={busy}>
              {busy ? 'Creating account…' : 'Create account'}
            </Button>

            <button
              type="button"
              className="w-full text-sm text-graphite-600 underline"
              onClick={() => {
                setStage('phone');
                setCode('');
                setDevCode(null);
                setError(null);
              }}
            >
              Use a different number
            </button>
          </form>
        )}
      </Card>

      <p className="mt-6 text-center text-sm text-graphite-600">
        Already have an account?{' '}
        <button type="button" className="font-semibold underline" onClick={() => router.push(`/signin?next=${encodeURIComponent(next)}`)}>
          Sign in
        </button>
      </p>
    </main>
  );
}

export default function SignUpPage() {
  return (
    <>
      <AppHeader />
      <Suspense fallback={<div className="p-10 text-center text-sm">Loading…</div>}>
        <SignUpForm />
      </Suspense>
    </>
  );
}
