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
 * rather than tabs, and puts Sell an item in front of people, because half the
 * marketplace's supply arrives through somebody wondering whether their old
 * laptop is worth anything.
 *
 * Sign in is present but quiet. Browsing, searching and reading a listing all
 * work signed out; an account is needed only to ask about an item or to sell
 * one, and asking a stranger to sign in before they have seen anything is how a
 * marketplace loses them on the first screen.
 *
 * It is glass rather than a solid bar. The page beneath is photographs, and a
 * solid header would cut the top off every one of them as it scrolled past.
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

import { useHasSession } from '@/lib/session';
import { DeclutterWordmark } from './DeclutterWordmark';

const LINKS = [
  { href: '/declutter', label: 'Browse' },
  // Anchors to the category filter on the feed. There is no separate
  // categories landing page, by decision: the filter is the category
  // experience, and a page that only re-listed the same nine categories would
  // be a click between a visitor and the thing they came for.
  { href: '/declutter#browse', label: 'Categories' },
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

  // The body must not scroll behind an open full-height menu.
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  return (
    <header className="dcl-glass sticky top-0 z-50 border-x-0 border-t-0">
      <div className="mx-auto flex w-full max-w-[1240px] items-center gap-4 px-5 py-3.5 sm:px-8">
        <Link
          href="/declutter"
          // Padded so the wordmark is a comfortable tap target, not a 16px line of text.
          className="-m-2 shrink-0 rounded-lg p-2"
          aria-label="DASH World Declutters — marketplace home"
        >
          <DeclutterWordmark />
        </Link>

        <nav aria-label="Marketplace" className="ml-auto hidden items-center gap-1 md:flex">
          {LINKS.map((link) => (
            <Link
              key={link.label}
              href={link.href}
              className="rounded-full px-4 py-2 text-sm font-semibold text-[var(--ink-muted)] transition-colors hover:bg-[var(--dcl-glass)] hover:text-[var(--ink)]"
            >
              {link.label}
            </Link>
          ))}
          <Link
            href={hasSession ? '/account' : '/signin'}
            className="ml-2 rounded-full border border-[var(--line-strong)] px-4 py-2 text-sm font-semibold transition-colors hover:bg-[var(--dcl-glass)]"
          >
            {hasSession ? 'Account' : 'Sign in'}
          </Link>
        </nav>

        {/* A disclosure button, not a tab bar. On a handset the navigation
            collapses into the header rather than pinning itself to the bottom
            of the screen, which is an app pattern. */}
        <button
          type="button"
          className="ml-auto inline-flex min-h-11 items-center gap-2 rounded-full border border-[var(--line-strong)] px-4 text-sm font-semibold md:hidden"
          aria-expanded={open}
          aria-controls="declutter-menu"
          onClick={() => setOpen((current) => !current)}
        >
          <span aria-hidden className="grid gap-[3px]">
            <span className="block h-[2px] w-4 bg-current" />
            <span className="block h-[2px] w-4 bg-current" />
          </span>
          {open ? 'Close' : 'Menu'}
        </button>
      </div>

      {open ? (
        <nav
          id="declutter-menu"
          aria-label="Marketplace"
          className="border-t border-[var(--line)] bg-[var(--surface)] px-5 pb-6 pt-2 md:hidden"
        >
          <ul>
            {LINKS.map((link) => (
              <li key={link.label} className="border-b border-[var(--line)] last:border-0">
                <Link href={link.href} className="block py-4 text-base font-semibold">
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
          <Link
            href={hasSession ? '/account' : '/signin'}
            className="mt-4 block rounded-full border border-[var(--line-strong)] px-4 py-3 text-center text-sm font-semibold"
          >
            {hasSession ? 'Account' : 'Sign in'}
          </Link>
        </nav>
      ) : null}
    </header>
  );
}
