/**
 * The CSRF bootstrap, and the protections it must not have weakened.
 *
 * Production ran the web app on `declutters.dashworldng.com` and the API on
 * `api.dashworldng.com`. The CSRF cookie is host-only by design, so script on
 * the web origin could not read a cookie belonging to the API origin. The
 * browser still *sent* it — the two are same-site, so `SameSite=Lax` attaches
 * it — and the result was a request carrying the cookie and no header:
 *
 *     403 csrf_missing — missing x-csrf-token header
 *
 * confirmed in the production journal at 2026-09-23 04:24:55 UTC. Sign-in was
 * impossible for anyone whose browser already held a refresh cookie, and
 * possible in a fresh incognito window, because `requiresCsrf` only enforces
 * when the refresh cookie is present. That asymmetry is what made it look
 * intermittent.
 *
 * `GET /v1/auth/csrf` hands the client the value its own browser is holding.
 * The cookie stays host-only; the alternative, `Domain=.dashworldng.com`,
 * would have broadcast the token to every subdomain including hosting we do
 * not control.
 *
 * Half of this file is therefore about what must still fail.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CSRF_COOKIE, CSRF_HEADER, REFRESH_COOKIE } from '../auth/cookies.js';
import { cookieHeader, createTestContext, findCookie, type TestContext } from './harness.js';

const WEB_ORIGIN = 'https://declutters.dashworldng.com';

let context: TestContext;

beforeAll(async () => {
  context = await createTestContext({ PUBLIC_WEB_URL: WEB_ORIGIN });
}, 120_000);

afterAll(async () => {
  await context?.close();
});

/** Any non-empty value: `requiresCsrf` tests for presence, not validity. */
const SOME_REFRESH_COOKIE = 'refresh-token-value-that-need-not-be-valid';

describe('GET /v1/auth/csrf', () => {
  it('issues a token and a matching cookie when the browser has none', async () => {
    const response = await context.app.inject({ method: 'GET', url: '/v1/auth/csrf' });

    expect(response.statusCode).toBe(200);

    const { csrfToken } = response.json<{ csrfToken: string }>();
    expect(csrfToken).toBeTruthy();

    const cookie = findCookie(response.headers['set-cookie'], CSRF_COOKIE);
    expect(cookie?.value).toBe(csrfToken);

    // Readable by script by design — the double-submit scheme needs it.
    expect(cookie?.httpOnly).toBe(false);
  });

  it('keeps the cookie host-only', async () => {
    const response = await context.app.inject({ method: 'GET', url: '/v1/auth/csrf' });

    const raw = response.headers['set-cookie'];
    const headers = Array.isArray(raw) ? raw : [raw ?? ''];
    const csrf = headers.find((header) => header.startsWith(`${CSRF_COOKIE}=`)) ?? '';

    // The decisive assertion of this whole change. A `Domain` attribute would
    // make the fix work and hand the token to every subdomain at the same
    // time, which is the outcome the bootstrap exists to avoid.
    expect(csrf.toLowerCase()).not.toContain('domain=');
  });

  it('is never cached', async () => {
    // A cached copy served to a second person would put one browser's token
    // into another's page, where it matches no cookie and every write fails.
    const response = await context.app.inject({ method: 'GET', url: '/v1/auth/csrf' });
    expect(response.headers['cache-control']).toContain('no-store');
  });

  it('returns the existing token rather than rotating it', async () => {
    // A page may already be using the current token. Re-issuing on every call
    // would invalidate an in-flight request whenever a second tab asked.
    const existing = 'an-already-issued-token';

    const response = await context.app.inject({
      method: 'GET',
      url: '/v1/auth/csrf',
      headers: { cookie: cookieHeader({ [CSRF_COOKIE]: existing }) },
    });

    expect(response.json<{ csrfToken: string }>().csrfToken).toBe(existing);
  });

  it('does not itself demand a token, even with a refresh cookie present', async () => {
    // It is a GET, so the global hook does not require a token to obtain one.
    // Were this a POST, a browser in exactly the broken state could never
    // recover.
    const response = await context.app.inject({
      method: 'GET',
      url: '/v1/auth/csrf',
      headers: { cookie: cookieHeader({ [REFRESH_COOKIE]: SOME_REFRESH_COOKIE }) },
    });

    expect(response.statusCode).toBe(200);
  });
});

describe('the login journey that production could not complete', () => {
  it('a returning browser can request an OTP using the bootstrapped token', async () => {
    // 1. The browser already holds a refresh cookie, so CSRF is enforced.
    // 2. It cannot read the host-only CSRF cookie, so it bootstraps.
    const bootstrap = await context.app.inject({
      method: 'GET',
      url: '/v1/auth/csrf',
      headers: { cookie: cookieHeader({ [REFRESH_COOKIE]: SOME_REFRESH_COOKIE }) },
    });

    const { csrfToken } = bootstrap.json<{ csrfToken: string }>();

    // 3. It echoes the token, and the request is no longer refused.
    const otp = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/otp/request',
      headers: {
        cookie: cookieHeader({
          [REFRESH_COOKIE]: SOME_REFRESH_COOKIE,
          [CSRF_COOKIE]: csrfToken,
        }),
        [CSRF_HEADER]: csrfToken,
      },
      payload: { email: 'nobody-in-particular@dashapp.test', purpose: 'login' },
    });

    expect(otp.statusCode).not.toBe(403);
  });

  it('a fresh browser with no refresh cookie is unaffected', async () => {
    // The incognito case: no ambient credential, so nothing to forge, so no
    // token demanded. This is why the bug looked intermittent.
    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/otp/request',
      payload: { email: 'nobody-in-particular@dashapp.test', purpose: 'login' },
    });

    expect(response.statusCode).not.toBe(403);
  });
});

describe('CSRF still refuses what it always refused', () => {
  it('rejects a cookie-carrying write with no header', async () => {
    // The exact production failure. It must still be a failure.
    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/otp/request',
      headers: {
        cookie: cookieHeader({
          [REFRESH_COOKIE]: SOME_REFRESH_COOKIE,
          [CSRF_COOKIE]: 'a-token',
        }),
      },
      payload: { email: 'nobody-in-particular@dashapp.test', purpose: 'login' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('csrf_missing');
  });

  it('rejects a header that does not match the cookie', async () => {
    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/otp/request',
      headers: {
        cookie: cookieHeader({
          [REFRESH_COOKIE]: SOME_REFRESH_COOKIE,
          [CSRF_COOKIE]: 'the-real-token',
        }),
        [CSRF_HEADER]: 'a-token-an-attacker-guessed',
      },
      payload: { email: 'nobody-in-particular@dashapp.test', purpose: 'login' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('csrf_invalid');
  });

  it('rejects a write carrying the cookie but no CSRF cookie at all', async () => {
    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/otp/request',
      headers: { cookie: cookieHeader({ [REFRESH_COOKIE]: SOME_REFRESH_COOKIE }) },
      payload: { email: 'nobody-in-particular@dashapp.test', purpose: 'login' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('csrf_missing');
  });
});

describe('only an allowed origin can read the token', () => {
  /**
   * This is what keeps the bootstrap safe. An attacker's page can cause the
   * request — the browser will send it — but without CORS approval it cannot
   * read the response, so the token stays as unreachable as the cookie was.
   */
  it('allows the configured web origin', async () => {
    const response = await context.app.inject({
      method: 'GET',
      url: '/v1/auth/csrf',
      headers: { origin: WEB_ORIGIN },
    });

    expect(response.headers['access-control-allow-origin']).toBe(WEB_ORIGIN);
    expect(response.headers['access-control-allow-credentials']).toBe('true');
  });

  it('does not allow an origin that merely looks similar', async () => {
    const response = await context.app.inject({
      method: 'GET',
      url: '/v1/auth/csrf',
      headers: { origin: 'https://declutters.dashworldng.com.evil.test' },
    });

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});
