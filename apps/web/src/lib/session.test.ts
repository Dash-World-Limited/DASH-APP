// @vitest-environment jsdom

/**
 * Password sign-in, and the second factor staff accounts require.
 *
 * This is a regression suite for a defect found by signing in to the ops
 * console in a browser: `signInWithPassword` handed every 200 response to
 * `storeAccess`, including the one that is deliberately **not** a session.
 *
 * A staff password stage answers `200 { mfaRequired: true, challengeToken }`
 * with no access token at all — that is the whole point of requiring a second
 * factor. Storing it set the token to `undefined`, reported success, and let
 * the caller redirect. The console then made authorized requests holding
 * nothing and rendered "You do not have access to perform this action", which
 * blamed the operator's permissions for a sign-in that had never finished.
 *
 * So the assertions here are less about the happy path than about the one
 * property that was violated: **no session exists until a real access token
 * does.**
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearSession, getAccessToken, hasSession, signInWithPassword, verifyMfa, verifyMfaWithRecoveryCode } from './session';

/** A `fetch` the test controls, returning whatever the API is pretending to say. */
function stubFetch(responses: { status: number; body: unknown }[]): ReturnType<typeof vi.fn> {
  const queue = [...responses];
  const stub = vi.fn(async () => {
    const next = queue.shift();
    if (!next) throw new Error('fetch called more times than the test expected');
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => next.body,
      text: async () => JSON.stringify(next.body),
    } as unknown as Response;
  });
  vi.stubGlobal('fetch', stub);
  return stub;
}

const CHALLENGE = {
  mfaRequired: true,
  stage: 'verify',
  challengeToken: 'challenge-token-abc',
  expiresAt: '2026-09-03T18:00:00.000Z',
};

const SESSION = { accessToken: 'access-token-xyz', expiresIn: 900, csrfToken: 'csrf-abc' };

beforeEach(() => {
  clearSession();
  // `hasSession` also consults the CSRF cookie, which jsdom would otherwise
  // carry between tests.
  if (typeof document !== 'undefined') document.cookie = '';
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearSession();
});

describe('a staff MFA challenge is not a session', () => {
  it('adopts a recovery-code session through the same MFA endpoint', async () => {
    const fetch = stubFetch([{ status: 200, body: SESSION }]);
    await verifyMfaWithRecoveryCode('challenge', 'recovery-code');
    expect(await getAccessToken()).toBe(SESSION.accessToken);
    const expectedBody = JSON.stringify({ challengeToken: 'challenge', recoveryCode: 'recovery-code' });
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/v1/auth/mfa/verify'), expect.objectContaining({
      body: expectedBody,
    }));
  });
  it('reports that a second factor is required rather than signing in', async () => {
    stubFetch([{ status: 200, body: CHALLENGE }]);

    const result = await signInWithPassword('ops@dashapp.test', 'DashDev!2026');

    expect(result.kind).toBe('mfa_required');
    if (result.kind !== 'mfa_required') throw new Error('unreachable');
    expect(result.stage).toBe('verify');
    expect(result.challengeToken).toBe('challenge-token-abc');
  });

  it('stores no access token for a challenge', async () => {
    stubFetch([{ status: 200, body: CHALLENGE }]);

    await signInWithPassword('ops@dashapp.test', 'DashDev!2026');

    // The defect in one assertion. Before the fix, `storeAccess` had run on a
    // response with no token, leaving the app convinced it was signed in.
    expect(hasSession()).toBe(false);
    await expect(getAccessToken()).resolves.toBeNull();
  });

  it('refuses a 200 that carries neither a token nor a challenge', async () => {
    // Defence in depth: an API that changes shape must fail loudly here rather
    // than produce a session-shaped nothing.
    stubFetch([{ status: 200, body: { unexpected: true } }]);

    await expect(signInWithPassword('ops@dashapp.test', 'DashDev!2026')).rejects.toThrow();
    expect(hasSession()).toBe(false);
  });
});

describe('completing the second factor', () => {
  it('establishes the session only after the code is accepted', async () => {
    stubFetch([
      { status: 200, body: CHALLENGE },
      { status: 200, body: SESSION },
    ]);

    const first = await signInWithPassword('ops@dashapp.test', 'DashDev!2026');
    expect(hasSession()).toBe(false);
    if (first.kind !== 'mfa_required') throw new Error('expected a challenge');

    await verifyMfa(first.challengeToken, '123456');

    expect(hasSession()).toBe(true);
    await expect(getAccessToken()).resolves.toBe('access-token-xyz');
  });

  it('sends the challenge token with the code', async () => {
    const stub = stubFetch([
      { status: 200, body: CHALLENGE },
      { status: 200, body: SESSION },
    ]);

    const first = await signInWithPassword('ops@dashapp.test', 'DashDev!2026');
    if (first.kind !== 'mfa_required') throw new Error('expected a challenge');
    await verifyMfa(first.challengeToken, '123456');

    const verifyCall = stub.mock.calls.at(-1);
    const [url, init] = verifyCall as [string, RequestInit];
    expect(String(url)).toContain('/v1/auth/mfa/verify');
    expect(JSON.parse(String(init.body))).toEqual({
      challengeToken: 'challenge-token-abc',
      code: '123456',
    });
  });

  it('leaves no session behind when the code is wrong', async () => {
    stubFetch([
      { status: 200, body: CHALLENGE },
      {
        status: 401,
        body: { error: { code: 'unauthorized', message: 'That code is not correct.' } },
      },
    ]);

    const first = await signInWithPassword('ops@dashapp.test', 'DashDev!2026');
    if (first.kind !== 'mfa_required') throw new Error('expected a challenge');

    await expect(verifyMfa(first.challengeToken, '000000')).rejects.toThrow();

    // The sign-in screen keeps the operator on the verification step, so the
    // important thing is that a failed attempt has not half-created anything.
    expect(hasSession()).toBe(false);
  });
});

describe('a non-staff password sign-in', () => {
  it('still signs in directly when no second factor is required', async () => {
    stubFetch([{ status: 200, body: SESSION }]);

    const result = await signInWithPassword('suya-republic@dashapp.test', 'DashDev!2026');

    expect(result.kind).toBe('session');
    expect(hasSession()).toBe(true);
  });
});
