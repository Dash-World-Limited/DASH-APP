import type { Metadata } from 'next';
import { Suspense } from 'react';

import { PayComplete } from './complete';

/**
 * Where Paystack sends the customer's browser after checkout.
 *
 * This page decides nothing. Arriving here means only that the customer left
 * Paystack's checkout — paid, cancelled or abandoned, it cannot tell. It asks
 * the server to check with Paystack (the server alone decides whether an order
 * is paid, and tells this page nothing about the order), then sends the
 * customer back to the DASH app, where the order screen shows what the server
 * found.
 *
 * Never indexed: it is reached only from a checkout.
 */
export const metadata: Metadata = {
  title: 'Returning to DASH',
  description: 'Your payment is being confirmed with Paystack.',
  robots: { index: false, follow: false },
};

export default function Page() {
  return (
    <Suspense fallback={null}>
      <PayComplete />
    </Suspense>
  );
}
