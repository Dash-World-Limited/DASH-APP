'use client';

/**
 * The public marketplace's own navigation.
 *
 * Deliberately not `AppHeader`. That header belongs to DASH APP and carries a
 * Basket, because everything else in the app is bought through one. Declutters
 * is not: a buyer asks to be put in touch and a DASH team member arranges it,
 * so a basket icon here would be an interface element for a transaction that
 * does not exist.
 *
 * What a website navigation owes a visitor is different from what an app's
 * navigation owes a signed-in user. This is horizontal, has real destinations
 * rather than tabs, and puts Sell an Item in front of people, because half the
 * marketplace's supply arrives through somebody wondering whether their old
 * laptop is worth anything.
 *
 * Sign in is present but quiet. Browsing, searching and reading a listing all
 * work signed out; an account is needed only to ask about an item or to sell
 * one, and asking a stranger to sign in before they have seen anything is how a
 * marketplace loses them on the first screen.
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

import { useHasSession } from '@/lib/session';

const LINKS = [
  { href: '/declutter', label: 'Browse' },
  // Anchors to the category filter on the feed. There is no separate
  // categories landing page yet, and a nav item that promised one and delivered
  // the plain feed would be worse than one that takes you to the control that
  // actually filters by category.
  { href: '/declutter#filters', label: 'Categories' },
  { href: '/declutter/sell', label: 'Sell an item' },
];

export function DeclutterHeader() {
  const pathname = usePathname();
  const hasSession = useHasSession();
  const [open, setOpen] = useState(false);

  // A menu that survives navigation is a menu covering the page the visitor
  // just asked for.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  return (
    <header className="sticky top-0 z-40 border-b bg-[var(--surface-raised)]">
      <div className="mx-auto flex w-full max-w-6xl items-center gap-3 px-4 py-3">
        <Link href="/declutter" className="flex shrink-0 items-baseline gap-1.5">
          <span className="text-lg font-extrabold tracking-tight">DASH</span>
          <span className="text-lg font-semibold text-[var(--primary)]">Declutters</span>
        </Link>

        <nav aria-label="Marketplace" className="ml-auto hidden items-center gap-1 sm:flex">
          {LINKS.map((link) => (
            <Link
              key={link.label}
              href={link.href}
              className="rounded-lg px-3 py-2 text-sm font-semibold hover:bg-graphite-100"
            >
              {link.label}
            </Link>
          ))}
          <Link
            href={hasSession ? '/account' : '/signin'}
            className="ml-1 rounded-xl border px-3 py-2 text-sm font-semibold"
          >
            {hasSession ? 'Account' : 'Sign in'}
          </Link>
        </nav>

        {/* A disclosure button, not a tab bar. On a handset the navigation
            collapses into the header rather than pinning itself to the bottom
            of the screen, which is an app pattern. */}
        <button
          type="button"
          className="ml-auto rounded-xl border px-3 py-2 text-sm font-semibold sm:hidden"
          aria-expanded={open}
          aria-controls="declutter-menu"
          onClick={() => setOpen((current) => !current)}
        >
          {open ? 'Close' : 'Menu'}
        </button>
      </div>

      {open ? (
        <nav
          id="declutter-menu"
          aria-label="Marketplace"
          className="border-t px-4 py-2 sm:hidden"
        >
          <ul className="space-y-1">
            {LINKS.map((link) => (
              <li key={link.label}>
                <Link
                  href={link.href}
                  className="block rounded-lg px-2 py-3 text-sm font-semibold"
                >
                  {link.label}
                </Link>
              </li>
            ))}
            <li>
              <Link
                href={hasSession ? '/account' : '/signin'}
                className="block rounded-lg px-2 py-3 text-sm font-semibold"
              >
                {hasSession ? 'Account' : 'Sign in'}
              </Link>
            </li>
          </ul>
        </nav>
      ) : null}
    </header>
  );
}
