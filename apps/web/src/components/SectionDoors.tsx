'use client';

/**
 * The five front doors, as equals.
 *
 * DASH is a multi-service local commerce app, and Home is where that has to be
 * legible at a glance. One row, one weight, one treatment: a hero for any one
 * section would say that section is the app and the rest are extras, which is
 * the exact mistake that had Declutter rendered as a full-width banner above
 * everything else.
 *
 * ## Why the layout is three then two
 *
 * Five items do not divide into two columns, and the obvious fixes both break
 * equality: stretching the fifth tile across a row makes it the biggest thing
 * on the screen, and squeezing five across a 360px handset leaves 60px for
 * "Local Market". A six-column grid with each tile spanning two gives three
 * equal tiles, then two equal tiles centred underneath — every door the same
 * size, on the narrowest phone we support, with no breakpoint hiding anything.
 * Above 640px the same grid becomes a single row of five.
 *
 * ## What is deliberately not here
 *
 * No counts, no "popular", no "24 sellers nearby". None of that is known at
 * this point in the page and inventing it would be exactly the fake-marketplace
 * signal the product must not carry. The doors say what they are; the sellers
 * below say what is actually there.
 */

import Link from 'next/link';
import type { ReactNode } from 'react';

import { SECTIONS, type SectionSlug } from '@/lib/sections';

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

/**
 * A mark and a tint per door, keyed by the section's own slug.
 *
 * `Record<string, …>` would let a section be added to `SECTIONS` and silently
 * render nothing here. Keying on `SectionSlug` means adding a sixth door is a
 * type error until it has been given a mark, which is the point at which
 * someone should be thinking about whether a sixth door should exist at all.
 */
interface Door {
  /** Tailwind classes reading the semantic door tokens declared in globals.css. */
  tint: string;
  icon: ReactNode;
}

const DOORS: Record<SectionSlug, Door> = {
  shops: {
    tint: 'bg-[var(--door-shops-soft)] text-[var(--door-shops)]',
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="h-6 w-6" {...stroke}>
        <path d="M4 8h16l-1 11.2a1.8 1.8 0 0 1-1.8 1.6H6.8A1.8 1.8 0 0 1 5 19.2Z" />
        <path d="M8.5 8V6a3.5 3.5 0 0 1 7 0v2" />
      </svg>
    ),
  },
  restaurants: {
    tint: 'bg-[var(--door-restaurants-soft)] text-[var(--door-restaurants)]',
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="h-6 w-6" {...stroke}>
        <path d="M6 3v7a2.5 2.5 0 0 0 5 0V3M8.5 12.5V21" />
        <path d="M17 3c-1.4 1.6-2 3.4-2 5.4 0 1.6.7 2.6 2 3V21" />
      </svg>
    ),
  },
  market: {
    tint: 'bg-[var(--door-market-soft)] text-[var(--door-market)]',
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="h-6 w-6" {...stroke}>
        <path d="M3.5 9h17l-1.6 9.4a2 2 0 0 1-2 1.6H7.1a2 2 0 0 1-2-1.6Z" />
        <path d="m8 9 2.5-5M16 9l-2.5-5" />
      </svg>
    ),
  },
  pharmacy: {
    tint: 'bg-[var(--door-pharmacy-soft)] text-[var(--door-pharmacy)]',
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="h-6 w-6" {...stroke}>
        <rect x="3.5" y="3.5" width="17" height="17" rx="4.5" />
        <path d="M12 8.5v7M8.5 12h7" />
      </svg>
    ),
  },
  declutter: {
    tint: 'bg-[var(--door-declutter-soft)] text-[var(--door-declutter)]',
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="h-6 w-6" {...stroke}>
        <path d="M3.5 7.5 12 3.5l8.5 4v9L12 20.5l-8.5-4Z" />
        <path d="M3.5 7.5 12 11.5l8.5-4M12 11.5v9" />
      </svg>
    ),
  },
};

export function SectionDoors() {
  return (
    <nav aria-label="Sections">
      <ul className="grid grid-cols-6 gap-2.5 sm:grid-cols-5">
        {SECTIONS.map((section, index) => {
          const door = DOORS[section.slug];
          return (
            <li
              key={section.slug}
              // Two of six columns each: three equal tiles, then two equal
              // tiles centred by starting the fourth one column in.
              className={`col-span-2 sm:col-span-1 ${
                index === 3 ? 'col-start-2 sm:col-start-auto' : ''
              }`}
            >
              <Link
                href={`/${section.slug}`}
                title={section.blurb}
                className="flex h-full flex-col items-center gap-2 rounded-[var(--radius-card)] border border-[var(--line)] bg-[var(--surface-raised)] px-2 py-3.5 text-center shadow-[var(--shadow-card)] transition-[transform,border-color] duration-[var(--duration-base)] ease-[var(--ease-spring)] hover:border-[var(--line-strong)] active:scale-[0.97]"
              >
                <span
                  className={`flex h-11 w-11 items-center justify-center rounded-[var(--radius-control)] ${door.tint}`}
                >
                  {door.icon}
                </span>
                <span className="text-[13px] font-bold leading-tight tracking-tight">
                  {section.label}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
