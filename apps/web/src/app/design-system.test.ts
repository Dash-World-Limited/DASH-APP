/**
 * The rules the design system is only worth having if they hold.
 *
 * Tokens do not enforce themselves. A palette can be declared perfectly and
 * then bypassed by one component that hardcodes a colour, and nothing fails —
 * the app still builds, still renders, still looks approximately right in the
 * screenshot the author is looking at. The cost arrives later, when the brand
 * changes and 190 references have to be found by hand. That already happened
 * here once.
 *
 * So these read the source, in the same spirit as the safe-area suite. What can
 * be checked honestly without a rendering engine is that the decisions are
 * still made where they were meant to be made: colour in the token layer,
 * glass on floating surfaces only, and no component quietly reintroducing a
 * combination that fails contrast.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const read = (path: string): string => readFileSync(join(here, path), 'utf8');

const globals = read('globals.css');
const ui = read('../components/ui.tsx');
const bottomNav = read('../components/BottomNav.tsx');
const header = read('../components/AppHeader.tsx');
const home = read('(customer)/home/page.tsx');
const basket = read('(customer)/basket/page.tsx');
const doors = read('../components/SectionDoors.tsx');

describe('what goes on top of the primary', () => {
  it('never puts body ink on a primary fill', () => {
    // `--ink` on `--primary` is navy on electric blue: 3.6:1, under the 4.5:1 a
    // label needs. It was correct when the primary was gold and survived the
    // rebrand on the most-pressed control in the app.
    for (const [name, source] of [
      ['ui', ui],
      ['BottomNav', bottomNav],
      ['AppHeader', header],
    ] as const) {
      expect(source, name).not.toMatch(/bg-\[var\(--primary\)\][^"'`]*text-\[var\(--ink\)\]/);
    }
  });

  it('declares the ink for a primary fill beside the primary itself', () => {
    // Both surfaces. The dark shells lighten the primary, so white on top of it
    // stops working and the pairing has to invert with it.
    expect(globals).toContain('--on-primary: #ffffff');
    expect(globals).toContain('--on-primary: var(--color-navy-900)');
  });

  it('does not press a button into the brand gold', () => {
    // Gold is a Dash World mark — a wordmark, a premium badge. It is not a
    // surface, not a button and not a pressed state.
    expect(ui).not.toContain('active:bg-gold');
  });
});

describe('glass is a material for floating things', () => {
  it('is declared once, with a fallback for a WebView without blur', () => {
    // A translucent bar with no blur behind it is a bar with body text showing
    // through the labels.
    expect(globals).toContain('.glass {');
    expect(globals).toContain('@supports not ((backdrop-filter: blur(1px))');
  });

  it('is used on the floating navigation', () => {
    expect(bottomNav).toContain('glass');
  });

  it('is not used on the surfaces that carry money', () => {
    // Readability outranks effect where a total is concerned, and what is
    // behind a basket total is a scrolling list.
    expect(basket).not.toContain('glass');
    expect(home).not.toContain('"glass');
  });
});

describe('motion is a token, not a number', () => {
  it('names its durations and curves once', () => {
    for (const token of [
      '--duration-fast',
      '--duration-base',
      '--ease-standard',
      '--ease-spring',
    ]) {
      expect(globals, token).toContain(`${token}:`);
    }
  });

  it('honours a reduced-motion preference globally, not per component', () => {
    // A component cannot forget to do this, which is the only way it gets done
    // everywhere.
    expect(globals).toContain('@media (prefers-reduced-motion: reduce)');
    expect(globals).toContain('transition-duration: 0.01ms !important');
  });

  it('leaves no component inventing its own timing', () => {
    // An arbitrary `duration-300` next to a token is how two things that should
    // move together stop moving together.
    for (const [name, source] of [
      ['BottomNav', bottomNav],
      ['SectionDoors', doors],
      ['AppHeader', header],
    ] as const) {
      expect(source, name).not.toMatch(/duration-\d/);
    }
  });
});

describe('the safe-area classes are not quietly overridden', () => {
  /**
   * Found in the browser, not in review: the floating navigation was flush
   * against all three screen edges.
   *
   * `.safe-x` and `.safe-bottom` set `padding-left/right/bottom`, and they are
   * declared in globals.css *after* Tailwind's utilities. Two plain classes,
   * equal specificity, so source order decides — and a `px-4 pb-2` written on
   * the same element computes to `0px`. Nothing errors, the classes are all
   * present in the markup, and the element simply has no padding.
   *
   * This is the same family of bug as the original safe-area defect: correct
   * looking code that silently evaluates to zero. The fix is to inset with
   * margin, which does not collide, and the rule is that nothing carrying a
   * `safe-*` class also carries a padding utility.
   */
  const PADDING = /(?:^|\s)(?:px|py|pt|pb|pl|pr|p)-[\d.]+/;

  it('puts no padding utility on an element that also has one', () => {
    for (const [name, source] of [
      ['BottomNav', bottomNav],
      ['AppHeader', header],
      ['SideDrawer', read('../components/SideDrawer.tsx')],
    ] as const) {
      const collisions = (source.match(/className="[^"]*safe-[^"]*"/g) ?? []).filter((attribute) =>
        PADDING.test(attribute),
      );
      expect(collisions, `${name}: padding on a safe-area element computes to 0`).toEqual([]);
    }
  });
});

describe('the shell is the shell', () => {
  it('is not pasted into the screens it wraps', () => {
    // Every customer page used to render the header itself — and each of its
    // loading and error branches rendered another. Twenty copies of one bar.
    expect(home).not.toContain('AppHeader');
    expect(basket).not.toContain('AppHeader');
  });

  it('keeps the customer navigation to five destinations', () => {
    const hrefs = bottomNav.match(/href: '\/[a-z]+'/g) ?? [];
    expect(hrefs).toHaveLength(5);
  });
});

describe('the front doors are the structure', () => {
  it('leaves no competing top-level list on Home', () => {
    // `Everything · Food · Groceries · Essentials` was the previous structure,
    // and it sat directly beneath the five doors that replaced it — with
    // Groceries offered alongside the section that contains it.
    for (const legacy of ["label: 'Everything'", "label: 'Food'", "label: 'Groceries'", "label: 'Essentials'"]) {
      expect(home, legacy).not.toContain(legacy);
    }
  });

  it('reads the doors from one table rather than listing them again', () => {
    expect(doors).toContain("from '@/lib/sections'");
  });
});
