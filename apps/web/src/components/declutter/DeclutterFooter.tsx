/**
 * The end of the page.
 *
 * A website has a footer; an app has a tab bar. This one says the things a
 * visitor to a second-hand marketplace actually wants confirmed — who is behind
 * it, and how the price and the safety work — and links back to Dash World,
 * because Declutters is a Dash World product and a visitor who arrived here
 * from a shared listing has no other way to find that out.
 *
 * It claims nothing it cannot support. No review count, no "10,000 happy
 * customers", no activity ticker. Invented social proof on a marketplace that
 * has just launched is the fastest way to make every other claim on the page
 * suspect.
 *
 * A server component: nothing here is interactive, so none of it is JavaScript
 * the visitor downloads.
 */

import Link from 'next/link';

import { DASH_WORLD_URL } from '@/lib/declutter';
import { DeclutterWordmark } from './DeclutterWordmark';

export function DeclutterFooter() {
  return (
    <footer className="mt-24 border-t border-[var(--line)] bg-[var(--surface-sunken)]">
      <div className="mx-auto w-full max-w-[1240px] px-5 py-14 sm:px-8">
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-4">
          <div className="lg:col-span-2">
            <DeclutterWordmark />
            <p className="mt-4 max-w-sm text-sm leading-relaxed text-[var(--ink-muted)]">
              Curated second-hand in Lagos and Asaba. Every item reviewed by the DASH team, every
              price fixed, every seller identity-verified before anything goes live.
            </p>
            <a
              href={DASH_WORLD_URL}
              className="mt-6 inline-flex items-center gap-2 text-sm font-semibold text-[var(--ink)] hover:text-[var(--primary)]"
            >
              <span className="h-[5px] w-[5px] rounded-full bg-[var(--dcl-gold)]" aria-hidden />
              A Dash World product
              <span aria-hidden>→</span>
            </a>
          </div>

          <nav aria-label="Marketplace">
            <p className="dcl-eyebrow">Marketplace</p>
            <ul className="mt-3 space-y-0.5 text-sm text-[var(--ink-muted)]">
              <li>
                <Link href="/declutter" className="-my-1 inline-block py-2 hover:text-[var(--ink)]">
                  Browse everything
                </Link>
              </li>
              <li>
                <Link href="/declutter#browse" className="-my-1 inline-block py-2 hover:text-[var(--ink)]">
                  Categories
                </Link>
              </li>
              <li>
                <Link href="/declutter/sell" className="-my-1 inline-block py-2 hover:text-[var(--ink)]">
                  Sell an item
                </Link>
              </li>
            </ul>
          </nav>

          <div>
            <p className="dcl-eyebrow">How it works</p>
            <ul className="mt-3 space-y-0.5 text-sm text-[var(--ink-muted)]">
              <li>DASH sets the price. There is no negotiation.</li>
              <li>Sellers are verified against government ID.</li>
              <li>Contact details are never published — DASH arranges introductions.</li>
              <li>Items are listed by area. No addresses, ever.</li>
            </ul>
          </div>
        </div>

        <hr className="dcl-rule my-10" />

        <div className="flex flex-col gap-3 text-xs text-[var(--ink-muted)] sm:flex-row sm:items-center sm:justify-between">
          <p>DASH World Limited · Lagos and Asaba, Nigeria</p>
          <p>Prices in Nigerian naira. Fixed at listing.</p>
        </div>
      </div>
    </footer>
  );
}
