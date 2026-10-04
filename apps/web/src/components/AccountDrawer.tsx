'use client';

/**
 * The customer's account drawer.
 *
 * Holds who you are, where your account-level screens live, and the switch
 * into Rider mode — which appears only when the server has approved this
 * account to work. Mode switching lives here rather than on a page because it
 * is a property of the account, not of whatever screen happens to be open.
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';

import { ModeSwitch } from './ModeSwitch';
import { SideDrawer } from './SideDrawer';
import { Button } from './ui';
import { signOut, useHasSession, useMe } from '@/lib/session';

const LINKS = [
  { href: '/orders', label: 'Your orders' },
  { href: '/wallet', label: 'Wallet and credits' },
  { href: '/account', label: 'Account settings' },
];

export function AccountDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const signedIn = useHasSession();
  const { me } = useMe();
  const router = useRouter();

  return (
    <SideDrawer open={open} onClose={onClose} title="DASH">
      {signedIn ? (
        <>
          <div className="rounded-[var(--radius-card)] bg-[var(--surface-sunken)] p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-[var(--ink-muted)]">
              Signed in
            </p>
            <p className="mt-1 font-bold">
              {me?.identity.displayName ?? me?.identity.phone ?? me?.identity.email ?? 'DASH customer'}
            </p>
          </div>

          <nav className="mt-5 space-y-1" aria-label="Account">
            {LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                onClick={onClose}
                className="block rounded-[var(--radius-control)] px-3 py-3 font-semibold transition-colors hover:bg-[var(--surface-sunken)]"
              >
                {link.label}
              </Link>
            ))}
          </nav>

          {/* Only rendered for an approved rider — see ModeSwitch. */}
          <div className="mt-5">
            <ModeSwitch to="rider" />
          </div>

          <Button
            variant="ghost"
            className="mt-6 w-full"
            onClick={() => {
              onClose();
              void signOut().then(() => router.push('/signin'));
            }}
          >
            Sign out
          </Button>
        </>
      ) : (
        <>
          <p className="text-sm text-[var(--ink-muted)]">
            Sign in to see your orders, wallet and saved addresses.
          </p>
          <Link href="/signin" onClick={onClose}>
            <Button className="mt-4 w-full">Sign in</Button>
          </Link>
        </>
      )}
    </SideDrawer>
  );
}
