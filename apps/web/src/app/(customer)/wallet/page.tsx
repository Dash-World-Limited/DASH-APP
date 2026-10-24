'use client';

/**
 * Wallet — a truthful shell.
 *
 * DASH will hold customer credits: refunds returned to the account, promotional
 * balances, and the history behind both. None of that is wired yet, and the
 * honest thing on a screen about someone's money is to say so.
 *
 * So there is deliberately **no balance here** — not a zero presented as a
 * fact, not a placeholder figure, not a total assembled from data that does not
 * mean that. A number on a wallet screen is a promise about money, and inventing
 * one to make the screen look finished would be the single worst thing this
 * milestone could ship. The navigation, the route and the shape exist; the
 * figures arrive when there is a server projection to read them from.
 *
 * V1 stays read-only regardless: credits, refunds and promotional balances.
 * No deposits, no withdrawals, no transfers, no stored value.
 */

import Link from 'next/link';

import { AppHeader } from '@/components/AppHeader';
import { Button, Card, EmptyState } from '@/components/ui';
import { useHasSession } from '@/lib/session';

export default function WalletPage() {
  const signedIn = useHasSession();

  return (
    <div className="min-h-dvh">
      <AppHeader />
      <main id="main" className="mx-auto max-w-lg px-4 py-6">
        <h1 className="text-2xl font-bold tracking-tight">Wallet</h1>
        <p className="mt-1 text-sm text-[var(--ink-muted)]">
          Credits, refunds and promotional balances.
        </p>

        {!signedIn ? (
          <div className="mt-6">
            <EmptyState
              title="Sign in to see your wallet"
              description="Your credits and refunds are tied to your DASH account."
              action={
                <Link href="/signin">
                  <Button>Sign in</Button>
                </Link>
              }
            />
          </div>
        ) : (
          <>
            <Card className="mt-5 p-5">
              <p className="text-sm font-semibold text-[var(--ink-muted)]">Available credit</p>
              <p className="mt-2 text-lg font-bold text-[var(--ink)]">Not available yet</p>
              <p className="mt-2 text-sm leading-relaxed text-[var(--ink-muted)]">
                DASH is not holding a balance for you. When a refund is returned to your
                account or a promotion credits it, the amount and its history appear here.
              </p>
            </Card>

            <section className="mt-6">
              <h2 className="text-sm font-bold uppercase tracking-wide text-[var(--ink-muted)]">
                History
              </h2>
              <div className="mt-3">
                <EmptyState
                  title="Nothing here yet"
                  description="Refunds and credits will be listed here as they happen."
                />
              </div>
            </section>

            <p className="mt-6 text-xs leading-relaxed text-[var(--ink-muted)]">
              DASH Wallet holds credits and refunds only. It is not a bank account: you
              cannot deposit, withdraw or transfer money.
            </p>
          </>
        )}
      </main>
    </div>
  );
}
