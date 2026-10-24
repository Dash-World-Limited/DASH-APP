/**
 * Refresh-token cookies and CSRF protection.
 *
 * The refresh token moves from a JSON body field into a `HttpOnly` cookie. That
 * single change means JavaScript on the origin can no longer read it, so an XSS
 * that would previously have handed an attacker a 30-day session now cannot.
 *
 * It also introduces the problem cookies always introduce: the browser attaches
 * them automatically, so a request forged by another site carries the victim's
 * credentials. That is what the CSRF token below defends against, and why the
 * two must ship together — a cookie session without CSRF protection is a
 * downgrade, not an upgrade.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
// Imported for its type augmentation: it is what adds `reply.setCookie` and
// `request.cookies` to Fastify's types. Without this the file compiles against
// a Fastify that has never heard of cookies.
import '@fastify/cookie';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import { ApiError } from '../http/errors.js';

/** HttpOnly. Never readable by script. */
export const REFRESH_COOKIE = 'dash_rt';

/**
 * Deliberately NOT HttpOnly — the client must read it to echo it back in a
 * header. That is the whole double-submit mechanism, and it is safe because the
 * token authorises nothing on its own: it only proves the request came from
 * script running on our origin, which a cross-site attacker cannot run.
 */
export const CSRF_COOKIE = 'dash_csrf';
export const CSRF_HEADER = 'x-csrf-token';

/**
 * Scope the refresh cookie to the auth routes.
 *
 * The browser then never attaches a 30-day credential to an order, a catalogue
 * read, or a file upload. Narrowing the path narrows the blast radius of every
 * other endpoint in the system.
 */
export const REFRESH_COOKIE_PATH = '/v1/auth';

export interface CookieOptions {
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'strict' | 'lax' | 'none';
  path: string;
  maxAge?: number;
}

/**
 * Cookie attributes.
 *
 * `secure` is on whenever the configured public origin is HTTPS (and always
 * in production). Local development stays plain HTTP, but an HTTPS staging
 * deployment does not lose transport protection merely because NODE_ENV is
 * deliberately kept out of production mode while unfinished providers remain
 * mocked. `assertSecureCookieConfig()` below still makes production TLS-only.
 *
 * `sameSite: 'lax'` rather than `'strict'` because the web app and the API run
 * on different ports during development. Ports do not affect same-site
 * classification (a "site" is the registrable domain), so `lax` is enough for
 * the cross-port XHR to carry the cookie, while still blocking the cross-site
 * top-level POST that CSRF relies on. The CSRF token is the real defence; this
 * is defence in depth.
 */
export function refreshCookieOptions(config: Config): CookieOptions {
  return {
    httpOnly: true,
    secure: config.NODE_ENV === 'production' || config.PUBLIC_WEB_URL.startsWith('https://'),
    sameSite: 'lax',
    path: REFRESH_COOKIE_PATH,
    maxAge: config.REFRESH_TOKEN_TTL_SECONDS,
  };
}

export function csrfCookieOptions(config: Config): CookieOptions {
  return {
    // Readable by script by design — see the constant's comment.
    httpOnly: false,
    secure: config.NODE_ENV === 'production' || config.PUBLIC_WEB_URL.startsWith('https://'),
    sameSite: 'lax',
    // Site-wide, because any state-changing request may need to echo it.
    path: '/',
    maxAge: config.REFRESH_TOKEN_TTL_SECONDS,
  };
}

export function generateCsrfToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Set both cookies and return the CSRF token for the response body.
 *
 * The CSRF token is returned in the body as well as the cookie so a client that
 * cannot read cookies (a native app, a test harness) can still participate.
 * The refresh token itself is never returned in a body — that is the point.
 */
export function issueAuthCookies(
  reply: FastifyReply,
  config: Config,
  refreshToken: string,
): { csrfToken: string } {
  const csrfToken = generateCsrfToken();

  void reply.setCookie(REFRESH_COOKIE, refreshToken, refreshCookieOptions(config));
  void reply.setCookie(CSRF_COOKIE, csrfToken, csrfCookieOptions(config));

  return { csrfToken };
}

/**
 * The CSRF token this browser should echo, issuing one if it has none.
 *
 * The double-submit scheme needs the client to know the cookie's value. On a
 * single origin it simply reads `document.cookie`. It cannot when the web app
 * and the API are on different hosts: the cookie is deliberately host-only, so
 * script on `declutters.dashworldng.com` cannot see a cookie belonging to
 * `api.dashworldng.com`. The browser still *sends* it — the two are same-site,
 * so `SameSite=Lax` attaches it — which is the precise failure seen in
 * production: the cookie arrives, the header does not, and `assertCsrf` throws
 * `csrf_missing`.
 *
 * The alternative was `Domain=.dashworldng.com`, which would have worked and
 * would also have broadcast the token to every subdomain, including hosting we
 * do not control. This keeps the cookie host-only and returns the value over
 * an endpoint instead.
 *
 * That is safe because reading the response cross-origin requires CORS
 * approval, and the allowlist in `buildServer` never reflects an arbitrary
 * origin. An attacker's page can cause the request but cannot read the answer
 * — the same property the double-submit scheme already depends on.
 *
 * Returns the existing token when there is one, so calling it never
 * invalidates a token a page is already using.
 */
export function ensureCsrfCookie(
  request: FastifyRequest,
  reply: FastifyReply,
  config: Config,
): string {
  const existing = request.cookies[CSRF_COOKIE];
  if (typeof existing === 'string' && existing.length > 0) return existing;

  const csrfToken = generateCsrfToken();
  void reply.setCookie(CSRF_COOKIE, csrfToken, csrfCookieOptions(config));

  return csrfToken;
}

/**
 * Clear both cookies.
 *
 * The attributes must match those used to set them or the browser keeps the
 * original — a silent logout failure that leaves a live session behind.
 */
export function clearAuthCookies(reply: FastifyReply, config: Config): void {
  const refresh = refreshCookieOptions(config);
  const csrf = csrfCookieOptions(config);

  void reply.clearCookie(REFRESH_COOKIE, {
    httpOnly: refresh.httpOnly,
    secure: refresh.secure,
    sameSite: refresh.sameSite,
    path: refresh.path,
  });
  void reply.clearCookie(CSRF_COOKIE, {
    httpOnly: csrf.httpOnly,
    secure: csrf.secure,
    sameSite: csrf.sameSite,
    path: csrf.path,
  });
}

export function readRefreshCookie(request: FastifyRequest): string | null {
  const value = request.cookies[REFRESH_COOKIE];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Constant-time string comparison.
 *
 * `===` on a secret leaks its prefix through timing. The length check happens
 * first and is not constant-time, but a length difference is not a useful
 * oracle here: the token length is fixed and public.
 */
function safeEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

/**
 * Double-submit CSRF check.
 *
 * The request must carry the same token in a cookie and in a header. A
 * cross-site attacker can cause the browser to send the cookie, but cannot read
 * it to set the header — the same-origin policy stops them — and cannot set a
 * custom header on a simple form post at all.
 *
 * Enforced only when the request actually carries the refresh cookie. A pure
 * Bearer request has no ambient credential for an attacker to ride on, so
 * demanding a CSRF token there would be noise without security.
 */
export function assertCsrf(request: FastifyRequest): void {
  const cookieToken = request.cookies[CSRF_COOKIE];
  const headerValue = request.headers[CSRF_HEADER];
  const headerToken = Array.isArray(headerValue) ? headerValue[0] : headerValue;

  if (!cookieToken) {
    throw new ApiError(
      403,
      'csrf_missing',
      'Your session could not be verified. Please refresh the page and try again.',
      undefined,
      'no CSRF cookie present on a cookie-authenticated request',
    );
  }
  if (!headerToken) {
    throw new ApiError(
      403,
      'csrf_missing',
      'Your session could not be verified. Please refresh the page and try again.',
      undefined,
      `missing ${CSRF_HEADER} header`,
    );
  }
  if (!safeEquals(cookieToken, headerToken)) {
    throw new ApiError(
      403,
      'csrf_invalid',
      'Your session could not be verified. Please refresh the page and try again.',
      undefined,
      'CSRF header did not match the cookie',
    );
  }
}

/** Methods that can change state and therefore need CSRF protection. */
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function requiresCsrf(request: FastifyRequest): boolean {
  if (!UNSAFE_METHODS.has(request.method)) return false;
  // Only requests riding an ambient cookie credential are forgeable.
  return readRefreshCookie(request) !== null;
}

/**
 * Boot-time assertion that production cookies are actually secure.
 *
 * Called from `buildServer`. If someone later makes `secure` unconditional or
 * flips SameSite to `none` without thinking, the process refuses to start in
 * production rather than silently shipping a cookie that leaks over HTTP or
 * rides cross-site.
 */
export function assertSecureCookieConfig(config: Config): void {
  if (config.NODE_ENV !== 'production') return;

  const refresh = refreshCookieOptions(config);
  const problems: string[] = [];

  if (!refresh.httpOnly) problems.push('refresh cookie must be HttpOnly');
  if (!refresh.secure) problems.push('refresh cookie must be Secure in production');
  if (refresh.sameSite === 'none') {
    problems.push('refresh cookie must not use SameSite=None');
  }
  if (!refresh.path.startsWith('/v1/auth')) {
    problems.push('refresh cookie must be scoped to the auth path');
  }

  if (problems.length > 0) {
    throw new Error(`Insecure cookie configuration for production:\n  ${problems.join('\n  ')}`);
  }
}
