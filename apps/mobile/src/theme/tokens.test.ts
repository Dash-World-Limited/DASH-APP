/**
 * The token layer holds only if every screen reads from it and both themes
 * stay complete. These are the rules that would otherwise erode one hex value
 * at a time.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { DEFAULT_APPEARANCE, parseAppearance } from './appearance';
import { fontFamily, nairaFamily, palettes, typeScale } from './tokens';

/** WCAG 2.x relative luminance and contrast ratio. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

describe('the two themes', () => {
  it('define exactly the same tokens', () => {
    // A key present in Light and missing in Dark is a screen that renders
    // `undefined` the day someone switches.
    const keys = (value: object): string[] =>
      Object.entries(value).flatMap(([k, v]) => (v && typeof v === 'object' ? keys(v).map((sub) => `${k}.${sub}`) : [k]));
    expect(keys(palettes.dark).sort()).toEqual(keys(palettes.light).sort());
  });

  it('keep body text readable on every surface', () => {
    for (const scheme of ['light', 'dark'] as const) {
      const p = palettes[scheme];
      for (const ground of [p.background, p.surface, p.surfaceMuted, p.sand]) {
        expect(contrast(p.text, ground), `${scheme} text on ${ground}`).toBeGreaterThanOrEqual(7);
        expect(contrast(p.textMuted, ground), `${scheme} muted on ${ground}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('keep text on the accent at least AA-large, and name the one exception', () => {
    // White on the approved bronze is 3.9:1 — AA for large text, short of the
    // 4.5:1 the boards' 15-16pt button labels need. Reproduced as approved and
    // reported for a director decision (see `light.onAccent`). Pinned here so
    // changing it, either way, is a deliberate, visible act.
    const light = contrast(palettes.light.onAccent, palettes.light.accent);
    expect(light).toBeGreaterThanOrEqual(3);
    expect(light).toBeLessThan(4.5);
    // Dark was derived, so it has no excuse: full AA.
    expect(contrast(palettes.dark.onAccent, palettes.dark.accent)).toBeGreaterThanOrEqual(4.5);
  });

  it('carry no blue as a brand colour', () => {
    // The director retired the blue-led identity. Blue survives only as the
    // map's route to the merchant, which is a map convention.
    const isBlue = (hex: string): boolean => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
      return b > r + 60 && b > g + 30;
    };
    for (const scheme of ['light', 'dark'] as const) {
      const { map, ...brand } = palettes[scheme];
      for (const [name, value] of Object.entries(brand)) {
        if (typeof value === 'string' && value.startsWith('#')) expect(isBlue(value), `${scheme}.${name}`).toBe(false);
      }
      expect(map).toBeDefined();
    }
  });
});

describe('appearance', () => {
  it('defaults to Light', () => {
    expect(DEFAULT_APPEARANCE).toBe('light');
  });

  it('reads only a known choice from storage, and nothing else as Dark', () => {
    expect(parseAppearance('dark')).toBe('dark');
    expect(parseAppearance('light')).toBe('light');
    for (const junk of [null, undefined, '', 'Dark', 'system', 'auto', 42, {}]) {
      expect(parseAppearance(junk), String(junk)).toBe('light');
    }
  });
});

describe('type', () => {
  it('uses only the weights the app loads', () => {
    for (const style of Object.values(typeScale)) expect(fontFamily[style.weight]).toBeDefined();
  });

  it('has a Naira sign face for every weight', () => {
    // Manrope has no ₦; every weight Text can render must have a sign to swap in.
    expect(Object.keys(nairaFamily).sort()).toEqual(Object.keys(fontFamily).sort());
  });
});

describe('colour lives in the tokens', () => {
  /**
   * Every hex value outside tokens.ts is listed here with its reason. A new
   * one fails until someone decides it belongs — which is the conversation the
   * web app skipped and paid for with 190 hand-edits.
   */
  const ALLOWED: Record<string, string> = {
    'src/data/staging.ts': 'product colour swatches — merchant data',
    'src/ui/Controls.tsx': 'the toggle knob is white on both themes, as drawn',
    'src/ui/IconButton.tsx': 'white glyph on the photo scrim',
    'src/rider/MapShell.native.tsx': 'white marker rings and marker glyphs on map pins',
    'src/rider/MapFallback.tsx': 'white marker rings, matching the native map',
    'src/v2/App.tsx': 'the six service identity colours from the approved board — category identity, not theme',
    'src/v2/artwork/CategoryArtwork.tsx': 'drawn category illustrations — artwork, not theme',
    'src/v2/catalog/CatalogScreens.tsx':
      'accents on the placeholder merchant list, which is stand-in content awaiting real catalogue data',
    'src/v2/orders/CustomerOrderScreens.tsx':
      'white tick on the filled progress dot; the dot is palette.success in both schemes, so onAccent (near-black in dark) would be wrong',
  };

  const root = fileURLToPath(new URL('../..', import.meta.url));
  const walk = (dir: string): string[] =>
    !existsSync(dir)
      ? []
      : readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (['node_modules', 'dist', '.expo', 'assets'].includes(name)) return [];
      return statSync(path).isDirectory() ? walk(path) : /\.tsx?$/.test(name) && !/\.test\./.test(name) ? [path] : [];
    });

  it('keeps hex colours out of screens and components', () => {
    const offenders = walk(join(root, 'src'))
      .map((path) => relative(root, path).replace(/\\/g, '/'))
      .filter((file) => file !== 'src/theme/tokens.ts' && !(file in ALLOWED))
      .filter((file) => /#[0-9A-Fa-f]{3,8}\b/.test(readFileSync(join(root, file), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
