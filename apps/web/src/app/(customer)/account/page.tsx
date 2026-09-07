'use client';

/**
 * The account screen, and the doorway into Rider mode.
 *
 * This is where one identity shows both of its faces. "Switch to Rider"
 * appears only when the server has approved this account to work — see
 * `ModeSwitch` — so a customer is never shown a door that will not open.
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';

import { AppHeader } from '@/components/AppHeader';
import { Button, Card, EmptyState, LoadingBlock } from '@/components/ui';
import { signOut, useHasSession, useMe } from '@/lib/session';

export default function AccountPage() {
  const signedIn = useHasSession();
  const { me, loaded } = useMe();
  const router = useRouter();

  if (!signedIn) {
    return (
      <div className="min-h-dvh">
        <AppHeader />
        <main id="main" className="mx-auto max-w-lg px-4 py-10">
          <EmptyState
            title="You are not signed in"
            description="Sign in to see your account, orders and saved addresses."
            action={<Link href="/signin"><Button>Sign in</Button></Link>}
          />
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-dvh">
      <AppHeader />
      <main id="main" className="mx-auto max-w-lg px-4 py-6">
        <h1 className="text-2xl font-bold tracking-tight">Account</h1>

        {!loaded ? (
          <LoadingBlock label="Loading your account" />
        ) : (
          <>
            <Card className="mt-4 p-5">
              <p className="text-sm text-[var(--ink-muted)]">Signed in as</p>
              <p className="mt-1 text-lg font-bold">
                {me?.identity.displayName ?? me?.identity.phone ?? me?.identity.email ?? 'DASH customer'}
              </p>
              {me?.identity.phone ? (
                <p className="text-sm text-[var(--ink-muted)]">{me.identity.phone}</p>
              ) : null}
            </Card>

            {/*
              The mode switch is in the account drawer, not here. It belongs
              with the other account-level controls rather than being offered
              in two places with two different treatments.
            */}
            <div className="mt-4 space-y-2">
              {[
                { href: '/orders', label: 'Your orders' },
                { href: '/wallet', label: 'Wallet and credits' },
              ].map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="flex items-center justify-between rounded-[var(--radius-card)] border border-[var(--line)] bg-[var(--surface-raised)] p-4 font-semibold transition-colors hover:border-[var(--primary)]"
                >
                  {item.label}
                  <span aria-hidden="true" className="text-[var(--ink-muted)]">›</span>
                </Link>
              ))}
            </div>

            <Button
              variant="ghost"
              className="mt-6 w-full"
              onClick={() => {
                void signOut().then(() => router.push('/signin'));
              }}
            >
              Sign out
            </Button>
          </>
        )}
      </main>
    </div>
  );
}
