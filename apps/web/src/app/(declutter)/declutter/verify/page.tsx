import type { Metadata } from 'next';
import { Suspense } from 'react';

import { SITE_ORIGIN } from '@/lib/declutter';
import { VerifyPage } from './verify';

/**
 * Verify email.
 *
 * Never indexed, whatever `NEXT_PUBLIC_DECLUTTER_INDEXABLE` says. An auth
 * screen in a search result is a page a stranger arrives at with no context,
 * and it competes with the marketplace pages that should rank instead.
 *
 * The form reads `next` from the query string, so it is wrapped in `Suspense`:
 * `useSearchParams` opts a route into client rendering, and Next requires the
 * boundary rather than silently making the whole page dynamic.
 */
export const metadata: Metadata = {
  title: 'Verify your email — DASH World Declutters',
  description: 'Enter the six-digit code sent to your email address.',
  alternates: { canonical: `${SITE_ORIGIN}/declutter/verify` },
  robots: { index: false, follow: false },
};

export default function Page() {
  return (
    <Suspense fallback={null}>
      <VerifyPage />
    </Suspense>
  );
}
