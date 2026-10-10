'use client';

/**
 * Public marketplace navigation.
 *
 * Declutters deliberately has its own website-style header rather than the
 * DASH APP shell. Browsing stays open to everyone; account actions appear only
 * where they are useful.
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

import { useSessionState } from '@/lib/session';
import { signInHref } from '@/lib/return-to';
import { DeclutterWordmark } from './DeclutterWordmark';

const LINKS = [
  { href: '/declutter', label: 'Browse' },
  { href: '/declutter#browse', label: 'Categories' },
  { href: '/declutter/sell', label: 'Sell an item' },
];

function joinHref(returnTo: string): string {
  const target = returnTo.startsWith('/declutter') ? returnTo : '/declutter';
  return target === '/declutter'
    ? '/declutter/join'
    : `/declutter/join?next=${encodeURIComponent(target)}`;
}

export function DeclutterHeader() {
  const pathname = usePathname();
  const sessionState = useSessionState();
  const hasSession = sessionState === 'authenticated';
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

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

          {hasSession ? (
            <Link
              href="/declutter/account"
              className="ml-2 rounded-full border border-[var(--line-strong)] px-4 py-2 text-sm font-semibold transition-colors hover:bg-[var(--dcl-glass)]"
            >
              Account
            </Link>
          ) : sessionState === 'restoring' ? <span role="status" className="px-4 text-sm text-[var(--ink-muted)]">Checking account…</span> : (
            <>
              <Link
                href={signInHref(pathname)}
                className="ml-2 rounded-full border border-[var(--line-strong)] px-4 py-2 text-sm font-semibold transition-colors hover:bg-[var(--dcl-glass)]"
              >
                Sign in
              </Link>
              <Link
                href={joinHref(pathname)}
                className="rounded-full bg-[var(--primary)] px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90"
              >
                Create account
              </Link>
            </>
          )}
        </nav>

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

          {hasSession ? (
            <Link
              href="/declutter/account"
              className="mt-4 block rounded-full border border-[var(--line-strong)] px-4 py-3 text-center text-sm font-semibold"
            >
              Account
            </Link>
          ) : sessionState === 'restoring' ? <p role="status" className="py-4 text-sm text-[var(--ink-muted)]">Checking account…</p> : (
            <div className="mt-4 grid gap-3">
              <Link
                href={signInHref(pathname)}
                className="block rounded-full border border-[var(--line-strong)] px-4 py-3 text-center text-sm font-semibold"
              >
                Sign in
              </Link>
              <Link
                href={joinHref(pathname)}
                className="block rounded-full bg-[var(--primary)] px-4 py-3 text-center text-sm font-semibold text-white"
              >
                Create account
              </Link>
            </div>
          )}
        </nav>
      ) : null}
    </header>
  );
}
