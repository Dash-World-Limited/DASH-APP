'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useBasketCount } from '@/lib/basket';
import { hasSession, loadMe, subscribeToSession } from '@/lib/session';
import { AccountDrawer } from './AccountDrawer';
import { MenuButton } from './SideDrawer';
import { Wordmark } from './ui';

export function AppHeader({ variant = 'customer' }: { variant?: 'customer' | 'staff' }) {
  const count = useBasketCount();
  const [name, setName] = useState<string | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const sync = async (): Promise<void> => {
      if (!hasSession()) {
        if (!cancelled) {
          setSignedIn(false);
          setName(null);
        }
        return;
      }
      const me = await loadMe();
      if (cancelled) return;
      setSignedIn(me !== null);
      setName(me?.identity.displayName ?? me?.identity.email ?? null);
    };

    void sync();
    const unsubscribe = subscribeToSession(() => void sync());
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return (
    // `safe-top` pads the bar itself so its background reaches the top of the
    // screen while the logo and menu button clear the status bar. `safe-x`
    // handles a cutout that moves to the side in landscape.
    <header className="safe-top safe-x sticky top-0 z-40 border-b bg-[var(--surface)]/95 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-3 px-5">
        {/*
          Account controls live behind this, not on the page — see
          AccountDrawer. The bottom navigation already carries the
          destinations, so a second row of links in the header would be the
          same journey offered twice.
        */}
        {variant === 'customer' ? <MenuButton onClick={() => setMenuOpen(true)} /> : null}

        <Link href="/" className="shrink-0">
          <Wordmark className="text-xl" />
        </Link>

        <div className="ml-auto flex items-center gap-2">
          {variant === 'customer' ? (
            <Link
              href="/basket"
              className="relative rounded-xl border px-3.5 py-2 text-sm font-semibold hover:bg-[var(--surface-raised)]"
            >
              Basket
              {count > 0 ? (
                <span
                  className="absolute -right-1.5 -top-1.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-[var(--primary)] px-1 text-xs font-bold text-[var(--ink)]"
                  aria-label={`${count} items in basket`}
                >
                  {count}
                </span>
              ) : null}
            </Link>
          ) : null}

          {signedIn ? (
            // Sign-out lives in the drawer with the rest of the account
            // controls. The header shows who you are and nothing else.
            <span className="hidden text-sm text-[var(--ink-muted)] sm:inline">{name}</span>
          ) : (
            <Link
              href="/signin"
              className="rounded-xl bg-[var(--ink)] px-4 py-2 text-sm font-semibold text-white"
            >
              Sign in
            </Link>
          )}
        </div>
      </div>

      {variant === 'customer' ? (
        <AccountDrawer open={menuOpen} onClose={() => setMenuOpen(false)} />
      ) : null}
    </header>
  );
}
