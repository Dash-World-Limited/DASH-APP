'use client';

/**
 * Where a seller actually starts.
 *
 * The screen reads the caller's real seller state and keeps the full sequence
 * visible: create a seller profile, verify once, submit items, receive a DASH
 * valuation, and only then move toward publication.
 */

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

import { ApiRequestError } from '@/lib/api';
import { authedFetch, useHasSession } from '@/lib/session';
import { track } from '@/lib/analytics';
import { signInHref } from '@/lib/return-to';
import { ItemSubmissionForm } from '@/components/declutter/ItemSubmissionForm';
import { SellerItems } from '@/components/declutter/SellerItems';

interface SellerSelf {
  id: string;
  displayName: string;
  sellerType: string;
  publicArea: string | null;
  kycStatus: string;
  rejectionReason: string | null;
  canSubmit: boolean;
}

const WHATSAPP = 'https://wa.me/2349112496182';

const STEPS = [
  {
    title: 'Tell us who you are',
    body: 'A display name and the area you are in. Your address is never published.',
  },
  {
    title: 'Get verified once',
    body: 'Government ID, reviewed by a DASH team member. Once, not per item.',
  },
  {
    title: 'Show us the item',
    body: 'Photographs, condition and specifications. The more you show, the better the valuation.',
  },
  {
    title: 'We price it, you accept it',
    body: 'DASH values it against real market evidence and puts one fixed price to you. Nothing is published until you agree.',
  },
  {
    title: 'We handle the buyer',
    body: 'Enquiries come to DASH. Your phone number is never published to anyone.',
  },
];

export function SellEntry() {
  const hasSession = useHasSession();
  const [seller, setSeller] = useState<SellerSelf | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!hasSession) {
      setLoaded(true);
      return;
    }
    setError(null);
    try {
      const data = await authedFetch<{ seller: SellerSelf }>('/v1/declutter/seller/me');
      setSeller(data.seller);
    } catch (caught) {
      if (caught instanceof ApiRequestError && caught.status === 404) {
        setSeller(null);
      } else {
        setError(
          caught instanceof ApiRequestError
            ? caught.message
            : 'We could not check your seller account.',
        );
      }
    } finally {
      setLoaded(true);
    }
  }, [hasSession]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    track('declutter_sell_started', {});
  }, []);

  return (
    <main id="main">
      <section className="relative overflow-hidden border-b border-[var(--line)]">
        <div
          aria-hidden
          className="pointer-events-none absolute -right-40 -top-40 h-[32rem] w-[32rem] rounded-full opacity-30 blur-[120px]"
          style={{ background: 'radial-gradient(circle, rgba(23,179,166,0.55), transparent 65%)' }}
        />
        <div className="relative mx-auto w-full max-w-[1240px] px-5 py-16 sm:px-8 sm:py-20">
          <p className="dcl-eyebrow">Selling on Declutters</p>
          <h1 className="dcl-display mt-5 max-w-3xl text-[2.4rem] sm:text-5xl lg:text-6xl">
            Find out what your things are actually worth.
          </h1>
          <p className="mt-6 max-w-xl text-base leading-relaxed text-[var(--ink-muted)] sm:text-lg">
            DASH values the item, verifies you once, and handles every buyer. You agree the price
            before anything is published — and your phone number never is.
          </p>
        </div>
      </section>

      <div className="mx-auto grid w-full max-w-[1240px] gap-12 px-5 py-16 sm:px-8 lg:grid-cols-[1fr_minmax(0,26rem)] lg:gap-16">
        <section aria-label="How selling works">
          <h2 className="dcl-eyebrow">How it works</h2>
          <ol className="mt-6 space-y-px overflow-hidden rounded-[var(--radius-card)] border border-[var(--line)] bg-[var(--line)]">
            {STEPS.map((step, index) => (
              <li key={step.title} className="flex gap-5 bg-[var(--surface)] p-6">
                <span
                  aria-hidden
                  className="dcl-display shrink-0 text-2xl text-[var(--dcl-gold)]"
                >
                  {String(index + 1).padStart(2, '0')}
                </span>
                <div>
                  <h3 className="text-base font-bold">{step.title}</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-[var(--ink-muted)]">
                    {step.body}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <aside className="lg:sticky lg:top-24 lg:self-start">
          {error ? (
            <div
              role="alert"
              className="rounded-[var(--radius-card)] border border-[var(--danger)] bg-[var(--danger-soft)] p-5"
            >
              <p className="text-sm font-bold text-[var(--danger)]">Could not load your account</p>
              <p className="mt-2 text-sm text-[var(--ink-muted)]">{error}</p>
              <button
                type="button"
                onClick={() => void load()}
                className="dcl-glass mt-5 min-h-11 rounded-full px-5 text-sm font-bold"
              >
                Try again
              </button>
            </div>
          ) : !loaded ? (
            <div className="dcl-glass rounded-[var(--radius-card)] p-6">
              <p className="sr-only" aria-live="polite">
                Checking your account
              </p>
              <div aria-hidden className="space-y-3">
                <div className="dash-pulse h-4 w-2/3 rounded bg-[var(--dcl-glass)]" />
                <div className="dash-pulse h-3 w-full rounded bg-[var(--dcl-glass)]" />
                <div className="dash-pulse h-11 w-40 rounded-full bg-[var(--dcl-glass)]" />
              </div>
            </div>
          ) : (
            <NextStep hasSession={hasSession} seller={seller} onChanged={() => void load()} />
          )}
        </aside>
      </div>
    </main>
  );
}

function Panel({ children }: { children: React.ReactNode }) {
  return <div className="dcl-glass rounded-[var(--radius-card)] p-6">{children}</div>;
}

function NextStep({
  hasSession,
  seller,
  onChanged,
}: {
  hasSession: boolean;
  seller: SellerSelf | null;
  onChanged: () => void;
}) {
  if (!hasSession) {
    return (
      <Panel>
        <p className="text-base font-bold">Use your DASH account to start</p>
        <p className="mt-2 text-sm text-[var(--ink-muted)]">
          One account works across DASH. Sign in if you already have one, or create one now.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Link
            href={signInHref('/declutter/sell')}
            className="inline-flex min-h-12 items-center rounded-full border border-[var(--line-strong)] px-6 text-sm font-bold"
          >
            Sign in
          </Link>
          <Link
            href="/declutter/join?next=%2Fdeclutter%2Fsell"
            className="inline-flex min-h-12 items-center rounded-full bg-[var(--primary)] px-6 text-sm font-bold text-[var(--on-primary)]"
          >
            Create account
          </Link>
        </div>
      </Panel>
    );
  }

  if (!seller) return <BecomeSeller onCreated={onChanged} />;

  if (seller.kycStatus === 'suspended') {
    return (
      <Panel>
        <p className="text-base font-bold">Selling is paused on this account</p>
        <p className="mt-3 text-sm leading-relaxed text-[var(--ink-muted)]">
          Contact DASH support and we will explain what happened.
        </p>
        <a
          href={WHATSAPP}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-6 inline-flex min-h-12 items-center rounded-full bg-[var(--primary)] px-7 text-sm font-bold text-[var(--on-primary)]"
        >
          Contact Declutters support
        </a>
      </Panel>
    );
  }

  return (
    <div className="space-y-5">
      <VerificationPrompt seller={seller} />
      <SellerItems />
      <ItemSubmissionForm kycStatus={seller.kycStatus} />
    </div>
  );
}

function VerificationPrompt({ seller }: { seller: SellerSelf }) {
  if (seller.kycStatus === 'verified') return null;

  if (seller.kycStatus === 'pending') {
    return (
      <div className="rounded-[var(--radius-card)] border border-[var(--line)] bg-[var(--surface)] p-5">
        <p className="text-sm font-bold">Seller verification is under review</p>
        <p className="mt-2 text-xs leading-relaxed text-[var(--ink-muted)]">
          You can submit an item now. It will stay private until DASH finishes verifying you.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-[var(--radius-card)] border border-[var(--dcl-gold)]/40 bg-[var(--surface)] p-5">
      <p className="text-sm font-bold">
        {seller.kycStatus === 'rejected' ? 'Update your seller verification' : 'Verify your seller profile'}
      </p>
      <p className="mt-2 text-xs leading-relaxed text-[var(--ink-muted)]">
        {seller.kycStatus === 'rejected' && seller.rejectionReason
          ? seller.rejectionReason
          : 'Upload your government ID and private contact details once. You can still submit an item now, but it cannot go live until verification is approved.'}
      </p>
      <Link
        href="/declutter/seller/verify"
        className="mt-4 inline-flex min-h-11 items-center rounded-full bg-[var(--primary)] px-5 text-xs font-bold text-[var(--on-primary)]"
      >
        {seller.kycStatus === 'rejected' ? 'Fix verification' : 'Verify seller profile'}
      </Link>
    </div>
  );
}

function BecomeSeller({ onCreated }: { onCreated: () => void }) {
  const [displayName, setDisplayName] = useState('');
  const [publicArea, setPublicArea] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await authedFetch('/v1/declutter/seller', {
        method: 'POST',
        body: {
          displayName: displayName.trim(),
          ...(publicArea.trim() ? { publicArea: publicArea.trim() } : {}),
        },
      });
      onCreated();
    } catch (caught) {
      setError(
        caught instanceof ApiRequestError ? caught.message : 'We could not set that up. Try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel>
      <p className="text-base font-bold">Start selling</p>

      <div className="mt-5 space-y-4">
        <div>
          <label htmlFor="seller-display-name" className="block text-sm font-semibold">
            Display name
          </label>
          <input
            id="seller-display-name"
            value={displayName}
            maxLength={80}
            onChange={(event) => setDisplayName(event.target.value)}
            placeholder="e.g. Chinedu"
            className="mt-2 min-h-12 w-full rounded-xl border border-[var(--line)] bg-[var(--surface-sunken)] px-4 text-sm text-[var(--ink)] outline-none placeholder:text-[var(--ink-muted)] focus:border-[var(--primary)]"
          />
          <p className="mt-1.5 text-xs text-[var(--ink-muted)]">
            What buyers see. Your legal name is never published.
          </p>
        </div>

        <div>
          <label htmlFor="seller-area" className="block text-sm font-semibold">
            Area <span className="font-normal text-[var(--ink-muted)]">(optional)</span>
          </label>
          <input
            id="seller-area"
            value={publicArea}
            maxLength={80}
            onChange={(event) => setPublicArea(event.target.value)}
            placeholder="e.g. Lekki, Lagos"
            className="mt-2 min-h-12 w-full rounded-xl border border-[var(--line)] bg-[var(--surface-sunken)] px-4 text-sm text-[var(--ink)] outline-none placeholder:text-[var(--ink-muted)] focus:border-[var(--primary)]"
          />
          <p className="mt-1.5 text-xs text-[var(--ink-muted)]">
            A general area only — never a street address.
          </p>
        </div>
      </div>

      {error ? (
        <p role="alert" className="mt-4 text-sm font-semibold text-[var(--danger)]">
          {error}
        </p>
      ) : null}

      <button
        type="button"
        onClick={() => void submit()}
        disabled={busy || displayName.trim().length < 2}
        className="mt-6 min-h-12 w-full rounded-full bg-[var(--primary)] px-7 text-sm font-bold text-[var(--on-primary)] transition-colors hover:bg-[var(--primary-hover)] disabled:opacity-50"
      >
        {busy ? 'Setting up…' : 'Continue'}
      </button>
    </Panel>
  );
}
