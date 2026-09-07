/**
 * The system's edges, and the one line that makes them real.
 *
 * Regression suite for a defect found on a Samsung handset: the customer
 * header sat under the status bar, overlapping the clock. The cause was not
 * missing CSS — the drawer and the bottom navigation both already used
 * `env(safe-area-inset-*)`. It was that **`env()` reports `0px` unless the
 * viewport opts into `viewport-fit=cover`**, so every one of those rules
 * silently evaluated to no padding at all.
 *
 * That is what makes this worth a test rather than a careful review. The
 * failure is invisible in code — the CSS looks correct, the values look
 * applied — and only appears on a device with a notch. Deleting one property
 * in `layout.tsx` would restore the bug across every screen at once with
 * nothing else to show for it.
 *
 * These assertions read the source rather than render it, deliberately.
 * jsdom has no system insets and no layout engine to resolve `env()` against,
 * so a rendered test could not tell a working shell from a broken one. What
 * can be checked honestly is that the shell still opts in, still defines the
 * tokens with safe fallbacks, and still applies them in the three places that
 * own the screen edges.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const read = (path: string): string => readFileSync(join(here, path), 'utf8');

const layout = read('layout.tsx');
const globals = read('globals.css');
const header = read('../components/AppHeader.tsx');
const bottomNav = read('../components/BottomNav.tsx');
const drawer = read('../components/SideDrawer.tsx');
const customerShell = read('(customer)/layout.tsx');

describe('the viewport opts into the safe area', () => {
  it('sets viewport-fit=cover', () => {
    // Without this every `env(safe-area-inset-*)` in the app resolves to 0px
    // and the header returns to sitting under the status bar.
    expect(layout).toContain("viewportFit: 'cover'");
  });

  it('does not disable zoom while doing it', () => {
    // Locking zoom is a real accessibility failure, and it is a tempting thing
    // to add while fiddling with viewport settings.
    expect(layout).not.toContain('maximumScale');
    expect(layout).not.toContain('userScalable');
  });
});

describe('the insets are defined once, with fallbacks', () => {
  it('names all four edges', () => {
    for (const edge of ['top', 'bottom', 'left', 'right']) {
      expect(globals).toContain(`--safe-${edge}: env(safe-area-inset-${edge}, 0px)`);
    }
  });

  it('falls back to zero, so a desktop browser is unaffected', () => {
    // The fallback is what keeps this from being a mobile-only stylesheet: on
    // any device without insets every token is 0px and the layout is unchanged.
    const tokens = globals.match(/--safe-[a-z]+: env\([^)]*\)/g) ?? [];
    expect(tokens.length).toBe(4);
    for (const token of tokens) expect(token).toContain(', 0px');
  });

  it('reserves the navigation and the system inset together', () => {
    // Reserving only the bar leaves the last row of a list under the gesture
    // pill on a phone that has one.
    expect(globals).toContain(
      'calc(var(--bottom-nav-height) + var(--safe-bottom) + 1.5rem)',
    );
  });
});

describe('the shell applies them, and pages do not have to', () => {
  it('pads the header for the status bar and a landscape cutout', () => {
    expect(header).toMatch(/className="safe-top safe-x sticky top-0/);
  });

  it('pads the bottom navigation for the gesture pill', () => {
    expect(bottomNav).toMatch(/className="safe-bottom safe-x fixed inset-x-0 bottom-0/);
  });

  it('pads the drawer, which overlays the system bars on both shells', () => {
    // One drawer serves Customer and Rider, so this covers both.
    expect(drawer).toMatch(/className="safe-top safe-bottom absolute inset-y-0/);
  });

  it('reserves scroll space in the shell rather than in each screen', () => {
    expect(customerShell).toContain('pad-for-bottom-nav');
  });

  it('leaves no component reaching for env() on its own', () => {
    // The rule this enforces: screens describe themselves, the shell knows
    // where the system bars are. An inline `env()` in a component is how the
    // original bug hid — correct-looking code, silently evaluating to zero.
    for (const [name, source] of [
      ['AppHeader', header],
      ['BottomNav', bottomNav],
      ['SideDrawer', drawer],
      ['customer layout', customerShell],
    ] as const) {
      expect(source, name).not.toContain('env(safe-area-inset');
    }
  });

  it('hardcodes no device-specific padding', () => {
    // No Samsung special case, no magic 24px status-bar guess. The platform
    // reports its own geometry; the shell reads it.
    for (const source of [header, bottomNav, drawer, customerShell]) {
      expect(source.toLowerCase()).not.toContain('samsung');
      expect(source).not.toMatch(/padding-top:\s*\d+px/);
    }
  });
});
