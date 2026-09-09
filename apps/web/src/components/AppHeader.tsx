'use client';

/**
 * The customer shell's top bar.
 *
 * It carries *state*, not destinations: who you are, where you are ordering to,
 * and what is in your basket. The destinations live in the bottom navigation,
 * where a thumb can reach them, and putting a second set of links up here would
 * be the same journey offered twice.
 *
 * Rendered by the customer layout rather than by each screen. It used to be
 * pasted into every page — and into each of that page's loading and error
 * branches, so a screen with three states rendered it three times — which meant
 * the shell was something a new screen had to remember rather than something it
 * received.
 */

import Link from 'next/link';
import { useState } from 'react';

import { useBasketCount } from '@/lib/basket';
import { locationLabel, useDeliveryLocation } from '@/lib/delivery-location';
import { useMe } from '@/lib/session';
import { AccountDrawer } from './AccountDrawer';
import { MenuButton } from './SideDrawer';
import { Wordmark } from './ui';

/**
 * Where the customer is ordering to, as a control rather than a caption.
 *
 * The delivery location decides which sellers appear, what they cost to reach
 * and whether DASH covers the address at all, so it belongs where it can be
 * seen and changed on any screen — not buried on Home, which is where it was.
 *
 * It shows the server's own name for the place and nothing while that is still
 * unknown. A placeholder here would be a guess presented as an answer, and the
 * one thing worse than not knowing where a customer is, is being confidently
 * wrong about it.
 */
function LocationPill() {
  const location = useDeliveryLocation();
  const label = locationLabel(location);
  const unserviceable = location.serviceability?.serviceable === false;

  return (
    <Link
      href="/account"
      className="group flex min-w-0 flex-1 items-center gap-1.5 rounded-[var(--radius-pill)] px-2 py-1.5 text-left transition-colors duration-[var(--duration-fast)] hover:bg-[var(--surface-sunken)]"
    >
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        className={`h-4 w-4 shrink-0 ${unserviceable ? 'text-[var(--danger)]' : 'text-[var(--primary)]'}`}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M12 21s-6.5-5.4-6.5-10a6.5 6.5 0 1 1 13 0c0 4.6-6.5 10-6.5 10Z" />
        <circle cx="12" cy="11" r="2.25" />
      </svg>
      <span className="min-w-0">
        <span className="sr-only">Delivering to</span>
        {label ? (
          <span className="block truncate text-sm font-semibold leading-tight">{label}</span>
        ) : (
          // Nothing resolved yet. A neutral prompt, not a fake place name.
          <span className="block truncate text-sm font-semibold leading-tight text-[var(--ink-muted)]">
            Choose your location
          </span>
        )}
      </span>
    </Link>
  );
}

function BasketButton({ count }: { count: number }) {
  return (
    <Link
      href="/basket"
      aria-label={count > 0 ? `Basket, ${count} item${count === 1 ? '' : 's'}` : 'Basket'}
      className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-control)] transition-[background-color,transform] duration-[var(--duration-fast)] ease-[var(--ease-standard)] hover:bg-[var(--surface-sunken)] active:scale-95"
    >
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        className="h-6 w-6"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M5 8h14l-1.1 11a2 2 0 0 1-2 1.8H8.1a2 2 0 0 1-2-1.8Z" />
        <path d="M9 8V6.5a3 3 0 0 1 6 0V8" />
      </svg>
      {count > 0 ? (
        <span
          aria-hidden="true"
          // `--on-primary`, not `--ink`: navy on electric blue is 3.6:1, and
          // this is two-digit text at 10px.
          className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--primary)] px-1 text-[10px] font-bold leading-none text-[var(--on-primary)]"
        >
          {count > 9 ? '9+' : count}
        </span>
      ) : null}
    </Link>
  );
}

export function AppHeader({ variant = 'customer' }: { variant?: 'customer' | 'staff' }) {
  const count = useBasketCount();
  const { me, loaded } = useMe();
  const [menuOpen, setMenuOpen] = useState(false);
  const customer = variant === 'customer';

  return (
    // `safe-top` pads the bar itself so its background reaches the top of the
    // screen while the controls clear the status bar. `safe-x` handles a cutout
    // that moves to the side in landscape.
    <header className="safe-top safe-x sticky top-0 z-40 border-b border-[var(--line)] bg-[var(--surface)]/85 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-1.5 px-3">
        {/*
          Account controls live behind this, not on the page — see
          AccountDrawer.
        */}
        {customer ? <MenuButton onClick={() => setMenuOpen(true)} /> : null}

        <Link href={customer ? '/home' : '/'} className="shrink-0 px-1">
          <Wordmark className="text-lg" />
        </Link>

        {customer ? (
          <LocationPill />
        ) : (
          // Staff shells keep what they had: who is signed in, or the way in.
          // A customer signs in through the drawer, which prompts for it; an
          // operator arriving at a console cold has no drawer to find.
          <span className="ml-auto flex min-w-0 items-center">
            {me ? (
              <span className="truncate text-sm text-[var(--ink-muted)]">
                {me.identity.displayName ?? me.identity.email}
              </span>
            ) : loaded ? (
              <Link
                href="/signin"
                className="rounded-[var(--radius-control)] bg-[var(--ink)] px-4 py-2 text-sm font-semibold text-[var(--ink-inverted)]"
              >
                Sign in
              </Link>
            ) : null}
          </span>
        )}

        {customer ? <BasketButton count={count} /> : null}
      </div>

      {customer ? <AccountDrawer open={menuOpen} onClose={() => setMenuOpen(false)} /> : null}
    </header>
  );
}
