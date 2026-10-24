'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import { DashWordmark as BrandWordmark } from '@/components/brand/DashWordmark';
import { ApiRequestError } from '@/lib/api';
import { requestOtp, verifyOtp } from '@/lib/session';
import styles from '../vendor.module.css';

function DashWordmark() {
  return (
    <span className={styles.wordmark}>
      <BrandWordmark />
    </span>
  );
}

export default function VendorSignInPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [stage, setStage] = useState<'email' | 'code'>('email');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [devCode, setDevCode] = useState<string | null>(null);

  async function sendCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const result = await requestOtp({ email: email.trim().toLowerCase() });
      setDevCode(result.devCode ?? null);
      setStage('code');
    } catch (caught) {
      setError(
        caught instanceof ApiRequestError
          ? caught.message
          : 'We could not send your sign-in code. Please try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function confirmCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      await verifyOtp({ email: email.trim().toLowerCase() }, code);
      router.replace('/vendor');
      router.refresh();
    } catch (caught) {
      setError(
        caught instanceof ApiRequestError
          ? caught.message
          : 'We could not verify that code. Please try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className={styles.signInScreen}>
      <section className={styles.signInBrand}>
        <DashWordmark />

        <div>
          <p className={styles.kickerLight}>DASH for business</p>
          <h1>Run your storefront from one calm workspace.</h1>
          <p>
            Orders, products, stock, performance and settlements—built for the people
            fulfilling every DASH order.
          </p>
        </div>

        <div className={styles.signInProof}>
          <span>Live orders</span>
          <span>Scoped access</span>
          <span>Realtime updates</span>
        </div>
      </section>

      <section className={styles.signInPanel}>
        <div className={styles.signInCard}>
          <p className={styles.eyebrow}>Vendor portal</p>
          <h2>Welcome back</h2>
          <p>Use the vendor account approved for your DASH storefront.</p>

          {error ? (
            <div
              role="alert"
              className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700"
            >
              {error}
            </div>
          ) : null}

          {stage === 'email' ? (
            <form className="space-y-4" onSubmit={sendCode}>
              <label className="block">
                <span className="mb-2 block text-xs font-semibold text-[#3d3b36]">Vendor email</span>
                <input
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="you@business.com"
                  className="min-h-[50px] w-full rounded-xl border border-[#d8cfbf] bg-white px-4 text-sm text-[#0b0d10] outline-none transition focus:border-[#946a2b] focus:ring-4 focus:ring-[#f3e8d6]"
                />
              </label>

              <button
                className={styles.primaryButton}
                type="submit"
                disabled={busy || !email.trim()}
              >
                {busy ? 'Sending code…' : 'Continue to Vendor'}
              </button>
            </form>
          ) : (
            <form className="space-y-4" onSubmit={confirmCode}>
              <label className="block">
                <span className="mb-2 block text-xs font-semibold text-[#3d3b36]">6-digit code</span>
                <input
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="\d{6}"
                  maxLength={6}
                  required
                  autoFocus
                  value={code}
                  onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="000000"
                  className="min-h-[50px] w-full rounded-xl border border-[#d8cfbf] bg-white px-4 text-center text-xl font-semibold tracking-[0.3em] text-[#0b0d10] outline-none transition focus:border-[#946a2b] focus:ring-4 focus:ring-[#f3e8d6]"
                />
              </label>

              {devCode ? (
                <button
                  type="button"
                  onClick={() => setCode(devCode)}
                  className="w-full rounded-xl border border-[#d8cfbf] bg-[#f4f2ec] px-4 py-3 text-left text-xs text-[#6e6b64]"
                >
                  Staging code: <strong className="text-[#0b0d10]">{devCode}</strong>
                </button>
              ) : null}

              <button
                className={styles.primaryButton}
                type="submit"
                disabled={busy || code.length !== 6}
              >
                {busy ? 'Checking…' : 'Sign in to Vendor'}
              </button>

              <button
                type="button"
                className="w-full text-center text-xs font-semibold text-[#6e6b64] underline underline-offset-4"
                onClick={() => {
                  setStage('email');
                  setCode('');
                  setDevCode(null);
                  setError(null);
                }}
              >
                Use a different email
              </button>
            </form>
          )}

          <small>
            Customer and rider accounts cannot enter this workspace. Access is checked
            by the API on every request.
          </small>
        </div>
      </section>
    </main>
  );
}
