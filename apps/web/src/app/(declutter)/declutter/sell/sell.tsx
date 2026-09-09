'use client';

/**
 * Where a seller actually starts.
 *
 * The whole point of this screen is to tell someone the truth about the
 * sequence before they invest effort in it. Selling on Declutters is not
 * "upload a photo and set a price" — DASH verifies who you are, values the
 * item, and puts a price to you that you accept or decline. That is the
 * product, and hiding it behind a form that only reveals the next obstacle
 * after each step is how people abandon a marketplace.
 *
 * So the page reads the caller's actual state and shows them the step they are
 * on, rather than a generic funnel.
 */

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

import { Badge, Button, Card, ErrorState, Field, Input, LoadingBlock } from '@/components/ui';
import { ApiRequestError } from '@/lib/api';
import { authedFetch, useHasSession } from '@/lib/session';
import { track } from '@/lib/analytics';

interface SellerSelf {
  id: string;
  displayName: string;
  sellerType: string;
  publicArea: string | null;
  kycStatus: string;
  rejectionReason: string | null;
  canSubmit: boolean;
}

const STEPS = [
  {
    title: 'Tell us who you are',
    body: 'A display name and the area you are in. Your address is never published.',
  },
  {
    title: 'Get verified once',
    body: 'Government ID, checked by a DASH team member. This happens once, not per item.',
  },
  {
    title: 'Describe the item',
    body: 'Photographs, condition and specifications. The more you show, the better the valuation.',
  },
  {
    title: 'DASH sets a price, you accept it',
    body: 'We value it and put one fixed price to you. Nothing is published until you agree.',
  },
  {
    title: 'We handle the buyer',
    body: 'Enquiries come to DASH. Your phone number is not published to anyone.',
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
      // A 404 is the ordinary case: signed in, has never sold anything. It is
      // not an error worth showing.
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
    <main id="main" className="mx-auto w-full max-w-3xl px-4 py-6">
      <h1 className="text-2xl font-bold sm:text-3xl">Sell an item</h1>
      <p className="mt-2 text-sm text-[var(--ink-muted)]">
        DASH values it, verifies you once, and handles the buyer. You agree the price before
        anything is published.
      </p>

      <ol className="mt-6 space-y-3">
        {STEPS.map((step, index) => (
          <li key={step.title}>
            <Card className="flex gap-3 p-4">
              <span
                aria-hidden
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--primary)] text-sm font-bold text-[var(--ink)]"
              >
                {index + 1}
              </span>
              <div>
                <p className="text-sm font-semibold">{step.title}</p>
                <p className="mt-0.5 text-sm text-[var(--ink-muted)]">{step.body}</p>
              </div>
            </Card>
          </li>
        ))}
      </ol>

      <div className="mt-6">
        {error ? (
          <ErrorState title="Could not load" message={error} onRetry={() => void load()} />
        ) : !loaded ? (
          <LoadingBlock label="Checking your account" />
        ) : (
          <NextStep hasSession={hasSession} seller={seller} onChanged={() => void load()} />
        )}
      </div>
    </main>
  );
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
      <Card className="p-4">
        <p className="font-semibold">Sign in to start</p>
        <p className="mt-1 text-sm text-[var(--ink-muted)]">
          You need a DASH account. If you already order on DASH, that is the same account.
        </p>
        <Link href="/signin" className="mt-4 inline-block">
          <Button>Sign in</Button>
        </Link>
      </Card>
    );
  }

  if (!seller) return <BecomeSeller onCreated={onChanged} />;

  if (seller.kycStatus === 'verified') {
    return (
      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-semibold">You are verified</p>
          <Badge tone="success">Verified seller</Badge>
        </div>
        <p className="mt-1 text-sm text-[var(--ink-muted)]">
          Send the item to the Declutters team and we will value it. Photographs, the condition and
          anything that is not perfect about it all help — an item described honestly is valued
          faster and sells sooner.
        </p>
        <a
          className="mt-4 inline-block"
          href="https://wa.me/2349112496182"
          target="_blank"
          rel="noopener noreferrer"
        >
          <Button>Send an item on WhatsApp</Button>
        </a>
      </Card>
    );
  }

  if (seller.kycStatus === 'pending') {
    return (
      <Card className="p-4">
        <p className="font-semibold">Your verification is with us</p>
        <p className="mt-1 text-sm text-[var(--ink-muted)]">
          A DASH team member is checking your details. You will be able to submit items as soon as
          that is done.
        </p>
      </Card>
    );
  }

  if (seller.kycStatus === 'suspended') {
    return (
      <Card className="p-4">
        <p className="font-semibold">Selling is paused on this account</p>
        <p className="mt-1 text-sm text-[var(--ink-muted)]">
          Contact DASH support and we will explain what happened.
        </p>
      </Card>
    );
  }

  return (
    <Card className="p-4">
      <p className="font-semibold">
        {seller.kycStatus === 'rejected' ? 'Your verification was not accepted' : 'Get verified'}
      </p>
      {seller.rejectionReason ? (
        <p className="mt-1 text-sm text-[var(--ink-muted)]">{seller.rejectionReason}</p>
      ) : (
        <p className="mt-1 text-sm text-[var(--ink-muted)]">
          One government ID and a phone number. This happens once, and it is why buyers can trust
          the marketplace.
        </p>
      )}
      <p className="mt-3 text-sm text-[var(--ink-muted)]">
        Verification is completed with the Declutters team directly while the seller portal is being
        finished.
      </p>
      <a
        className="mt-4 inline-block"
        href="https://wa.me/2349112496182"
        target="_blank"
        rel="noopener noreferrer"
      >
        <Button>Continue on WhatsApp</Button>
      </a>
    </Card>
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
        body: JSON.stringify({
          displayName: displayName.trim(),
          ...(publicArea.trim() ? { publicArea: publicArea.trim() } : {}),
        }),
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
    <Card className="space-y-3 p-4">
      <p className="font-semibold">Start selling</p>

      <Field
        label="Display name"
        htmlFor="seller-display-name"
        hint="What buyers see. Your legal name is never published."
      >
        <Input
          id="seller-display-name"
          value={displayName}
          maxLength={80}
          onChange={(event) => setDisplayName(event.target.value)}
          placeholder="e.g. Chinedu"
        />
      </Field>

      <Field
        label="Area (optional)"
        htmlFor="seller-area"
        hint="A general area only — never a street address."
      >
        <Input
          id="seller-area"
          value={publicArea}
          maxLength={80}
          onChange={(event) => setPublicArea(event.target.value)}
          placeholder="e.g. Lekki, Lagos"
        />
      </Field>

      {error ? (
        <p role="alert" className="text-sm font-medium text-[var(--danger)]">
          {error}
        </p>
      ) : null}

      <Button onClick={() => void submit()} disabled={busy || displayName.trim().length < 2}>
        {busy ? 'Setting up…' : 'Continue'}
      </Button>
    </Card>
  );
}
