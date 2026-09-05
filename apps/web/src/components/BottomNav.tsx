'use client';

/**
 * The customer's primary navigation.
 *
 * Five destinations, fixed to the bottom of the viewport, because this is a
 * phone-first consumer app held one-handed: the reachable part of a modern
 * handset is the bottom third, and a top navigation bar puts every destination
 * where the thumb is not.
 *
 * It is deliberately not adaptive. The same five appear in the same order on
 * every screen, so the position of "Orders" is something a returning customer
 * knows rather than something they re-read.
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

import { useBasketCount } from '@/lib/basket';

interface Destination {
  href: string;
  label: string;
  icon: ReactNode;
  /** Also treat these prefixes as "here", so a detail page keeps its tab lit. */
  owns?: string[];
}

/**
 * Line icons, inline.
 *
 * No icon dependency for five glyphs: the bundle cost of a library exceeds
 * the markup, and these never need to change independently of this file.
 */
const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

const DESTINATIONS: Destination[] = [
  {
    href: '/home',
    label: 'Home',
    owns: ['/browse'],
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="h-6 w-6" {...stroke}>
        <path d="M3 10.5 12 3l9 7.5" />
        <path d="M5.5 9.5V20a1 1 0 0 0 1 1H10v-5.5h4V21h3.5a1 1 0 0 0 1-1V9.5" />
      </svg>
    ),
  },
  {
    href: '/search',
    label: 'Search',
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="h-6 w-6" {...stroke}>
        <circle cx="11" cy="11" r="6.5" />
        <path d="m16 16 4.5 4.5" />
      </svg>
    ),
  },
  {
    href: '/orders',
    label: 'Orders',
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="h-6 w-6" {...stroke}>
        <path d="M6 3h12l1.5 4.5v12a1.5 1.5 0 0 1-1.5 1.5H6a1.5 1.5 0 0 1-1.5-1.5v-12Z" />
        <path d="M4.5 7.5h15M9.5 11.5h5" />
      </svg>
    ),
  },
  {
    href: '/wallet',
    label: 'Wallet',
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="h-6 w-6" {...stroke}>
        <rect x="3" y="6" width="18" height="13" rx="2.5" />
        <path d="M3 10h18M16.5 14.5h1.5" />
      </svg>
    ),
  },
  {
    href: '/account',
    label: 'Account',
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="h-6 w-6" {...stroke}>
        <circle cx="12" cy="8.5" r="3.5" />
        <path d="M4.5 20a7.5 7.5 0 0 1 15 0" />
      </svg>
    ),
  },
];

export function BottomNav() {
  const pathname = usePathname();
  const basket = useBasketCount();

  const isHere = (destination: Destination): boolean => {
    if (pathname === destination.href) return true;
    const prefixes = [destination.href, ...(destination.owns ?? [])];
    return prefixes.some((prefix) => pathname.startsWith(`${prefix}/`));
  };

  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-[var(--line)] bg-[var(--surface-raised)]"
      // Sits above the home indicator on a modern handset rather than under it.
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <ul className="mx-auto flex max-w-lg items-stretch">
        {DESTINATIONS.map((destination) => {
          const here = isHere(destination);
          return (
            <li key={destination.href} className="flex-1">
              <Link
                href={destination.href}
                aria-current={here ? 'page' : undefined}
                className={`flex flex-col items-center gap-1 py-2.5 text-[11px] font-semibold transition-colors ${
                  here ? 'text-[var(--primary)]' : 'text-[var(--ink-muted)]'
                }`}
              >
                <span className="relative">
                  {destination.icon}
                  {destination.href === '/orders' && basket > 0 ? (
                    <span
                      className="absolute -right-2 -top-1 min-w-4 rounded-full bg-[var(--primary)] px-1 text-center text-[10px] font-bold leading-4 text-[var(--on-primary)]"
                      aria-label={`${basket} item${basket === 1 ? '' : 's'} in basket`}
                    >
                      {basket}
                    </span>
                  ) : null}
                </span>
                {destination.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
