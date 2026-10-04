/**
 * Where to go after signing in: a path on this site, or the default.
 *
 * `next` comes from the query string, so anyone can write it. A full URL or
 * a protocol-relative `//host` would make sign-in an open redirect — a genuine
 * DASH sign-in that ends on a stranger's site — so only a plain same-site
 * path is accepted.
 */
export function safeNext(candidate: string | null | undefined, fallback = '/browse'): string {
  if (!candidate || !candidate.startsWith('/') || candidate.startsWith('//') || candidate.includes('\\')) return fallback;
  return candidate;
}
