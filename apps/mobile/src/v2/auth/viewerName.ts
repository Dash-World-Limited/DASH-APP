/**
 * The signed-in person's own name, for the places a screen addresses them
 * directly — today the Rider Home header.
 *
 * Two rules, both of which the header depends on:
 *
 * - **Only real profile data.** The name comes from `/v1/auth/me`'s
 *   `identity.displayName` and nowhere else. There is no sample name and no
 *   fallback to a made-up one: a build with no API origin, a signed-out phone
 *   and a profile whose name the server has not set all return `null`, and the
 *   caller shows nothing rather than greeting someone by a name that is not
 *   theirs.
 * - **An address or a phone number is not a name.** `viewerName` in
 *   `features/signIn.ts` falls back to the email or phone because it labels an
 *   account card, where an address identifies the session usefully. A header
 *   that reads "0803…" or "ada@example.com" addresses nobody, so this does not.
 */

import type { Viewer } from './AppSessionProvider';

/**
 * The first word of the display name, or `null` when there is no name to show.
 *
 * Splitting on whitespace is deliberately the whole rule. Nigerian names run
 * to three and four parts in orders that vary, and any cleverer guess about
 * which part is the given name would be wrong more often than this is.
 */
export function viewerFirstName(viewer: Viewer | null): string | null {
  const full = viewer?.identity.displayName?.trim();
  if (!full) return null;
  const [first] = full.split(/\s+/);
  return first && first.length > 0 ? first : null;
}

/**
 * Up to two initials for the avatar, from the same real name.
 *
 * `null` when the name is unknown, so the avatar shows its own neutral mark
 * instead of standing-in initials that belong to nobody.
 */
export function viewerInitials(viewer: Viewer | null): string | null {
  const full = viewer?.identity.displayName?.trim();
  if (!full) return null;
  const letters = full
    .split(/\s+/)
    .filter((part) => part.length > 0)
    .slice(0, 2)
    .map((part) => [...part][0] ?? '')
    .join('')
    .toUpperCase();
  return letters.length > 0 ? letters : null;
}
