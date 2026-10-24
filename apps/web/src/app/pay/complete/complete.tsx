'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';

import { Button, Card, Wordmark } from '@/components/ui';
import { apiFetch } from '@/lib/api';

/** The app's own scheme; the Orders tab is where a returning customer lands. */
const APP_ORDERS_LINK = 'dash://orders';

/** Paystack appends both; they carry the same value. Anything else is ignored. */
function referenceFrom(params: URLSearchParams): string | null {
  const value = params.get('reference') ?? params.get('trxref');
  return value && /^[A-Za-z0-9._-]{4,80}$/.test(value) ? value : null;
}

/**
 * The page after Paystack.
 *
 * It says nothing about whether the payment worked, because it does not know:
 * the server checks with Paystack and the app shows the result. What it does:
 *
 *   1. Asks the server to check this reference with Paystack now, so the order
 *      is settled even if the webhook is slow and the customer never returns
 *      to the app. The answer is only "checked" — never the order's state.
 *   2. Tries to reopen the DASH app, and offers a button in case the browser
 *      blocks the automatic hand-off.
 *   3. Tells the customer what to do if the app does not open: return to it
 *      and use Check payment on the order.
 */
export function PayComplete() {
  const params = useSearchParams();
  const reference = referenceFrom(params);
  const [checked, setChecked] = useState<'idle' | 'checking' | 'done' | 'unreachable'>('idle');

  useEffect(() => {
    if (!reference) return;
    let live = true;
    setChecked('checking');
    apiFetch('/v1/payments/return', { method: 'POST', body: { reference } })
      .then(() => live && setChecked('done'))
      .catch(() => live && setChecked('unreachable'))
      .finally(() => {
        // Hand back to the app whatever the check said: the app asks the
        // server itself, and that answer is the one that counts.
        if (live) window.location.href = APP_ORDERS_LINK;
      });
    return () => {
      live = false;
    };
  }, [reference]);

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-6 px-4 py-10 text-center">
      <Wordmark />
      <Card className="flex w-full flex-col gap-4 p-6">
        <h1 className="text-xl font-bold">Return to the DASH app</h1>
        <p className="text-sm text-[var(--ink-muted)]" aria-live="polite">
          {checked === 'checking'
            ? 'Checking your payment with Paystack…'
            : 'Your order screen in the DASH app shows whether Paystack confirmed your payment.'}
        </p>
        <a href={APP_ORDERS_LINK}>
          <Button className="w-full" size="lg">
            Open the DASH app
          </Button>
        </a>
        <p className="text-sm text-[var(--ink-muted)]">
          If the app does not open, go back to it yourself and tap <strong>Check payment</strong> on your order. Do not pay
          again until the app says the payment did not go through.
        </p>
        <p className="text-xs text-[var(--ink-muted)]">
          Ordering on the website? <Link href="/orders" className="underline">See your orders</Link>.
        </p>
      </Card>
      {reference ? null : (
        <p className="text-xs text-[var(--ink-muted)]">No payment reference was received from Paystack.</p>
      )}
    </main>
  );
}
