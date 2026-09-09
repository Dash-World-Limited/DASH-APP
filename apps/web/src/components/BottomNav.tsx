'use client';

/**
 * The customer's primary navigation.
 *
 * Five destinations, floating above the bottom of the viewport, because this is
 * a phone-first consumer app held one-handed: the reachable part of a modern
 * handset is the bottom third, and a top navigation bar puts every destination
 * where the thumb is not.
 *
 * It is deliberately not adaptive. The same five appear in the same order on
 * every screen, so the position of "Orders" is something a returning customer
 * knows rather than something they re-read.
 *
 * ## Why it floats, and why it is glass
 *
 * A bar welded to the bottom edge reads as browser chrome. A capsule with the
 * page visible around and behind it reads as part of the app, and — more
 * usefully — it keeps saying that there is content underneath, which a solid
 * bar hides. This is the one place in the customer app where glass is worth its
 * cost: it is small, it is always on screen, and what it overlays is scrolling
 * content the customer is meant to stay aware of. Product cards, prices and
 * totals stay opaque.
 *
 * ## The indicator
 *
 * One element that slides, rather than five that fade. A moving object is what
 * makes five destinations feel like one control with a position in it, and the
 * spring curve is the difference between "the highlight changed" and "the
 * highlight travelled there". It is driven by the active index alone — a
 * percentage transform over an equal-width flex row — so there is nothing to
 * measure, nothing to re-measure on rotation, and it is in the right place on
 * the very first frame rather than after a layout effect.
 *
 * Motion is not a requirement of the design: `prefers-reduced-motion` collapses
 * the transition globally and the indicator simply appears where it belongs.
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

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

/**
 * The locked customer navigation: Home, Search, Orders, Wallet, Account.
 *
 * Exported so a test can assert the order rather than restate it. Mode
 * switching between Customer and Rider is deliberately absent — it lives in the
 * account drawer, because it is a property of the account rather than a sixth
 * place to go.
 */
export const DESTINATIONS: Destination[] = [
  {
    href: '/home',
    label: 'Home',
    owns: ['/browse', '/shops', '/restaurants', '/market', '/pharmacy', '/declutter'],
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

/** Padding inside the capsule, in rem, shared by the indicator's geometry. */
const CAPSULE_PADDING_REM = 0.375;

function isHere(destination: Destination, pathname: string): boolean {
  if (pathname === destination.href) return true;
  const prefixes = [destination.href, ...(destination.owns ?? [])];
  return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export function BottomNav() {
  const pathname = usePathname();
  const activeIndex = DESTINATIONS.findIndex((destination) => isHere(destination, pathname));

  return (
    <nav
      aria-label="Primary"
      // Sits above the gesture pill or button row rather than under it, and
      // insets sideways for a landscape cutout. The shared classes replace an
      // inline `env()` that read as zero, because the viewport had never opted
      // into `viewport-fit=cover`.
      className="safe-bottom safe-x fixed inset-x-0 bottom-0 z-40"
    >
      {/*
        The float is margin on the capsule, never padding on the bar.

        `.safe-x` and `.safe-bottom` set `padding-left/right/bottom` and are
        declared after Tailwind's utilities in globals.css, so at equal
        specificity they win: a `px-4 pb-2` here computes to `0px` and the
        capsule silently sits flush against all three screen edges. Margin does
        not collide with the safe-area padding, so the two compose instead of
        fighting — the bar clears the gesture pill and the capsule floats inside
        what is left.
      */}
      <ul className="glass relative mx-4 mb-2 flex max-w-sm items-stretch rounded-[var(--radius-pill)] p-1.5 shadow-[var(--shadow-float)] sm:mx-auto">
        {activeIndex >= 0 ? (
          <li
            aria-hidden="true"
            // Behind the labels, not over them, and never in the way of a tap.
            className="pointer-events-none absolute bottom-1.5 top-1.5 rounded-[var(--radius-pill)] bg-[var(--primary-soft)] transition-transform duration-[var(--duration-base)] ease-[var(--ease-spring)]"
            style={{
              left: `${CAPSULE_PADDING_REM}rem`,
              width: `calc((100% - ${CAPSULE_PADDING_REM * 2}rem) / ${DESTINATIONS.length})`,
              transform: `translateX(${activeIndex * 100}%)`,
            }}
          />
        ) : null}

        {DESTINATIONS.map((destination, index) => {
          const here = index === activeIndex;
          return (
            <li key={destination.href} className="relative flex-1">
              <Link
                href={destination.href}
                aria-current={here ? 'page' : undefined}
                className={`flex flex-col items-center gap-1 rounded-[var(--radius-pill)] py-2 text-[11px] font-semibold transition-colors duration-[var(--duration-base)] ease-[var(--ease-standard)] ${
                  here ? 'text-[var(--primary)]' : 'text-[var(--ink-muted)]'
                }`}
              >
                {/* The active glyph lifts a couple of pixels. Small enough to
                    register as weight rather than as an animation. */}
                <span
                  className={`transition-transform duration-[var(--duration-base)] ease-[var(--ease-spring)] ${
                    here ? '-translate-y-0.5' : 'translate-y-0'
                  }`}
                >
                  {destination.icon}
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
