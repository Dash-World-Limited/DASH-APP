import type { Metadata } from 'next';

import { DeleteAccount } from './delete-account';

/**
 * How to delete a DASH account — the public page Google Play links to.
 *
 * Play requires a web address, reachable without the app, that explains how
 * to request deletion, what is deleted and what is kept. This page does both:
 * it states the policy in plain words, and a signed-in customer can request
 * (or cancel) deletion here, confirmed by a code sent to their own email.
 *
 * The statements below follow docs/RETENTION.md. If that policy changes, this
 * page and the in-app screen must change with it.
 */
export const metadata: Metadata = {
  title: 'Delete your DASH account',
  description: 'How to delete your DASH account, what is deleted, and what DASH keeps.',
};

export default function Page() {
  return (
    <main className="mx-auto max-w-2xl space-y-8 px-4 py-10">
      <header className="space-y-2">
        <h1 className="text-2xl font-bold">Delete your DASH account</h1>
        <p className="text-[var(--ink-muted)]">DASH is operated by DASH World Limited. You can delete your account at any time.</p>
      </header>

      <section className="space-y-2">
        <h2 className="text-lg font-bold">How to ask</h2>
        <ol className="list-decimal space-y-1 pl-5">
          <li>
            <strong>In the DASH app:</strong> Account → Delete account. You confirm with a code sent to your email.
          </li>
          <li>
            <strong>On this page:</strong> sign in with your email below and confirm with a code sent to your email.
          </li>
          <li>
            <strong>If you cannot sign in:</strong> email <a className="underline" href="mailto:info@dashworldng.com?subject=Delete%20my%20DASH%20account">info@dashworldng.com</a> from the address on your account and
            we will confirm it is you before acting.
          </li>
        </ol>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-bold">What happens</h2>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            Your account is scheduled for deletion after a <strong>14-day</strong> cooling-off period. You can cancel at any time before
            then.
          </li>
          <li>
            <strong>Deleted:</strong> your sign-in sessions and devices, one-time codes, security recovery codes and your saved cart.
          </li>
          <li>
            <strong>Anonymised:</strong> your name, email, phone number, saved addresses, delivery notes and review comments. Your email
            is replaced so the account can no longer be signed in to.
          </li>
          <li>
            <strong>Kept:</strong> records of orders, payments, refunds and the accounts ledger, with their amounts and dates, because the
            law requires financial records to be kept. They are no longer linked to your name or contact details.
          </li>
          <li>An account under an open legal or payment dispute is held until that is resolved, then deleted.</li>
        </ul>
      </section>

      <DeleteAccount />
    </main>
  );
}
