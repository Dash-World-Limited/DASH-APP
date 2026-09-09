/**
 * The end of the page.
 *
 * A website has a footer; an app has a tab bar. This one is deliberately plain
 * and says the two things a visitor to a second-hand marketplace actually wants
 * confirmed — who is behind it, and how the money and the safety work — rather
 * than a wall of links to pages that do not exist yet.
 *
 * A server component: nothing here is interactive, so none of it needs to be
 * JavaScript the visitor downloads.
 */

import Link from 'next/link';

export function DeclutterFooter() {
  return (
    <footer className="mt-12 border-t bg-[var(--surface-raised)]">
      <div className="mx-auto w-full max-w-6xl px-4 py-8">
        <div className="grid gap-6 sm:grid-cols-3">
          <div>
            <p className="flex items-baseline gap-1.5">
              <span className="text-base font-extrabold tracking-tight">DASH</span>
              <span className="text-base font-semibold text-[var(--primary)]">Declutters</span>
            </p>
            <p className="mt-2 max-w-xs text-sm text-[var(--ink-muted)]">
              Curated second-hand in Lagos and Asaba. Every item checked by the DASH team, every
              price fixed, every seller identity-verified.
            </p>
          </div>

          <nav aria-label="Marketplace">
            <p className="text-sm font-semibold">Marketplace</p>
            <ul className="mt-2 space-y-1 text-sm text-[var(--ink-muted)]">
              <li>
                <Link href="/declutter" className="hover:underline">
                  Browse everything
                </Link>
              </li>
              <li>
                <Link href="/declutter/sell" className="hover:underline">
                  Sell an item
                </Link>
              </li>
            </ul>
          </nav>

          <div>
            <p className="text-sm font-semibold">How it works</p>
            <ul className="mt-2 space-y-1 text-sm text-[var(--ink-muted)]">
              <li>DASH sets the price. There is no haggling.</li>
              <li>Sellers are verified against government ID.</li>
              <li>Contact details are never published — DASH arranges introductions.</li>
            </ul>
          </div>
        </div>

        <p className="mt-8 border-t pt-6 text-xs text-[var(--ink-muted)]">
          DASH World Limited · Lagos and Asaba, Nigeria
        </p>
      </div>
    </footer>
  );
}
