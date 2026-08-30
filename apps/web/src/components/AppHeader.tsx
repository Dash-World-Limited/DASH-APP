'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useBasketCount } from '@/lib/basket';
import { hasSession, loadMe, signOut, subscribeToSession } from '@/lib/session';
import { Wordmark } from './ui';

export function AppHeader({ variant = 'customer' }: { variant?: 'customer' | 'staff' }) {
  const count = useBasketCount();
  const [name, setName] = useState<string | null>(null);
  const [signedIn, setSignedIn] = useState(false);

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
    <header className="sticky top-0 z-40 border-b bg-[var(--surface)]/95 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-4 px-5">
        <Link href="/" className="shrink-0">
          <Wordmark className="text-xl" />
        </Link>

        {variant === 'customer' ? (
          <nav className="hidden gap-1 sm:flex" aria-label="Main">
            <Link
              href="/browse"
              className="rounded-lg px-3 py-2 text-sm font-medium hover:bg-[var(--surface-raised)]"
            >
              Browse
            </Link>
            <Link
              href="/orders"
              className="rounded-lg px-3 py-2 text-sm font-medium hover:bg-[var(--surface-raised)]"
            >
              Orders
            </Link>
          </nav>
        ) : null}

        <div className="ml-auto flex items-center gap-2">
          {variant === 'customer' ? (
            <Link
              href="/basket"
              className="relative rounded-xl border px-3.5 py-2 text-sm font-semibold hover:bg-[var(--surface-raised)]"
            >
              Basket
              {count > 0 ? (
                <span
                  className="absolute -right-1.5 -top-1.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-gold-400 px-1 text-xs font-bold text-graphite-900"
                  aria-label={`${count} items in basket`}
                >
                  {count}
                </span>
              ) : null}
            </Link>
          ) : null}

          {signedIn ? (
            <div className="flex items-center gap-2">
              <span className="hidden text-sm text-[var(--ink-muted)] sm:inline">{name}</span>
              <button
                onClick={() => void signOut()}
                className="rounded-lg px-3 py-2 text-sm font-medium hover:bg-[var(--surface-raised)]"
              >
                Sign out
              </button>
            </div>
          ) : (
            <Link
              href="/signin"
              className="rounded-xl bg-graphite-900 px-4 py-2 text-sm font-semibold text-white"
            >
              Sign in
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}
