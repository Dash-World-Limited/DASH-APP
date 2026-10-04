'use client';

/**
 * Where to send somebody after they sign in.
 *
 * A `next` parameter that is used without checking is an open redirect: a link
 * to `…/signin?next=https://evil.example/dash` looks like it came from DASH,
 * carries the DASH domain in front of the victim, and lands them on a copy of
 * this site asking for a code. It is the single most common way a marketplace
 * sign-in page gets weaponised, and it costs three lines to close.
 *
 * So a return target is only ever a path on this origin. Anything with a
 * scheme, anything protocol-relative, anything that is not a single leading
 * slash, and anything outside the marketplace is discarded in favour of the
 * marketplace home. There is no allowlist of hosts because there is no case for
 * sending anybody to another host at all.
 */

const DEFAULT_RETURN = '/declutter';

/**
 * Paths a return target may start with.
 *
 * Deliberately narrow. Auth here belongs to the Declutters website, and
 * bouncing somebody into the operations console or the rider app because a
 * query parameter said so is not a journey this page should be able to
 * complete.
 */
const ALLOWED_PREFIXES = ['/declutter'];

export function safeReturnTo(candidate: string | null | undefined): string {
  if (!candidate) return DEFAULT_RETURN;

  // Must be a path, and must not be protocol-relative: `//evil.example` is a
  // valid URL to another host that also happens to start with a slash.
  if (!candidate.startsWith('/') || candidate.startsWith('//')) return DEFAULT_RETURN;

  // A backslash is treated as a slash by some browsers when resolving, so
  // `/\evil.example` can escape the origin.
  if (candidate.includes('\\')) return DEFAULT_RETURN;

  const path = candidate.split(/[?#]/)[0] ?? '';
  const allowed = ALLOWED_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );

  return allowed ? candidate : DEFAULT_RETURN;
}

/**
 * The current location, as something safe to hand to a sign-in link.
 *
 * Used by the pages that send somebody to authenticate mid-action — asking
 * about an item, starting to sell one — so they come back to what they were
 * doing rather than to the front page.
 */
export function currentReturnTo(): string {
  if (typeof window === 'undefined') return DEFAULT_RETURN;
  return safeReturnTo(window.location.pathname + window.location.search);
}

/** A sign-in link that returns here. */
export function signInHref(returnTo?: string): string {
  const target = safeReturnTo(returnTo ?? currentReturnTo());
  return target === DEFAULT_RETURN
    ? '/declutter/signin'
    : `/declutter/signin?next=${encodeURIComponent(target)}`;
}
