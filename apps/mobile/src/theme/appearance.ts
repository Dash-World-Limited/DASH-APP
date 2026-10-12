/**
 * Which theme a person sees, decided in one pure function.
 *
 * The Appearance control on both boards offers exactly two choices, Light and
 * Dark, with Light selected — so that is the whole preference space, and Light
 * is what anyone gets until they choose otherwise. Following the operating
 * system is deliberately not offered: the boards do not show it, and a
 * premium-feeling light product that turns dark because a phone's battery saver
 * flipped a setting is not the product the director approved.
 *
 * Kept free of React Native so the rule can be tested directly.
 */

import type { ColorScheme } from './tokens';

export type AppearancePreference = ColorScheme;

export const DEFAULT_APPEARANCE: AppearancePreference = 'light';

/** Where the preference is kept. Versioned so a future shape can migrate. */
export const APPEARANCE_STORAGE_KEY = 'dash.appearance.v1';

/**
 * Read a stored preference defensively.
 *
 * Storage can hold anything — an older build's value, a corrupted write, a
 * hand-edited device. Anything that is not exactly a known choice is the
 * default, never a crash and never an accidental Dark.
 */
export function parseAppearance(raw: unknown): AppearancePreference {
  return raw === 'light' || raw === 'dark' ? raw : DEFAULT_APPEARANCE;
}
