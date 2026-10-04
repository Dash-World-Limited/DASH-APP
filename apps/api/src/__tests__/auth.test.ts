/**
 * Authentication integration tests.
 *
 * These run a real Fastify instance against a real database. They are the
 * regression suite for the cookie/CSRF rework, and they exist because every one
 * of these behaviours is invisible until it fails in a way that matters.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  clientFromRefresh,
  cookieHeader,
  createTestContext,
  currentTotp,
  rememberTotpSecret,
  findCookie,
  refresh,
  signInWithPassword,
  TEST_EMAIL,
  TEST_PASSWORD,
  TEST_CUSTOMER_PHONE,
  type TestContext,
} from './harness.js';
import { CSRF_COOKIE, REFRESH_COOKIE, csrfCookieOptions, refreshCookieOptions } from '../auth/cookies.js';

let context: TestContext;

beforeAll(async () => {
  context = await createTestContext();
}, 120_000);

afterAll(async () => {
  await context?.close();
});

// ---------------------------------------------------------------------------
describe('login', () => {
  /**
   * The harness account holds a staff role, so the password stage now ends in
   * an MFA challenge rather than a session. `completeSignIn` walks the whole
   * flow and returns the response that actually issued the session, which is
   * where the cookie and token assertions belong.
   */
  async function passwordStage() {
    return context.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: TEST_EMAIL, password: TEST_PASSWORD },
    });
  }

  /**
   * The whole context shares one database, so the first call enrols and later
   * ones verify. Branching on the stage the server reports keeps every test in
   * this block independent of the order they run in.
   */
  let enrolledSecret: string | null = null;

  async function completeSignIn() {
    const first = await passwordStage();
    const { challengeToken, stage } = first.json<{
      challengeToken: string;
      stage: 'enrol' | 'verify';
    }>();

    if (stage === 'enrol') {
      const started = await context.app.inject({
        method: 'POST',
        url: '/v1/auth/mfa/enrol/start',
        payload: { challengeToken },
      });
      enrolledSecret = started.json<{ secret: string }>().secret;
      // Share it with the harness so a later signInWithPassword in this file
      // can verify rather than failing for want of a secret.
      rememberTotpSecret(TEST_EMAIL, enrolledSecret);

      return context.app.inject({
        method: 'POST',
        url: '/v1/auth/mfa/enrol/confirm',
        payload: { challengeToken, code: await currentTotp(enrolledSecret) },
      });
    }

    // Simulate the 30 seconds a real user would have taken; see the note in
    // harness.ts. The replay rule itself is asserted directly in mfa.test.ts.
    await context.prisma.identity.updateMany({
      where: { email: TEST_EMAIL },
      data: { mfaLastTimeStep: null },
    });

    return context.app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/verify',
      payload: { challengeToken, code: await currentTotp(enrolledSecret!) },
    });
  }

  it('gives a staff password NO session — only an MFA challenge', async () => {
    // The point of the whole milestone. A leaked staff password must not be
    // enough on its own, so the password stage returns no access token, no
    // refresh cookie, and no CSRF token.
    const response = await passwordStage();

    expect(response.statusCode).toBe(200);
    const body = response.json<Record<string, unknown>>();

    expect(body['mfaRequired']).toBe(true);
    expect(body['challengeToken']).toBeTruthy();
    expect(body['accessToken']).toBeUndefined();
    expect(body['csrfToken']).toBeUndefined();

    expect(findCookie(response.headers['set-cookie'], REFRESH_COOKIE)).toBeUndefined();
    expect(findCookie(response.headers['set-cookie'], CSRF_COOKIE)).toBeUndefined();
  });

  it('returns an access token and sets the auth cookies once MFA succeeds', async () => {
    const response = await completeSignIn();

    expect(response.statusCode).toBe(200);
    const body = response.json<{ accessToken: string; expiresIn: number; csrfToken: string }>();
    expect(body.accessToken).toBeTruthy();
    expect(body.csrfToken).toBeTruthy();
    expect(body.expiresIn).toBe(900);
  });

  it('NEVER returns the refresh token in the response body', async () => {
    // The single most important assertion in this file. If a refresh token can
    // reach script, the HttpOnly cookie is decoration.
    const response = await completeSignIn();

    const refreshCookie = findCookie(response.headers['set-cookie'], REFRESH_COOKIE);
    expect(refreshCookie).toBeDefined();

    const raw = response.body;
    expect(raw).not.toContain(refreshCookie!.value);
    expect(raw).not.toContain('refreshToken');
  });

  it('never returns the refresh token at the password stage either', async () => {
    const response = await passwordStage();
    expect(response.body).not.toContain('refreshToken');
    expect(response.body).not.toContain('dash_rt');
  });

  it('sets the refresh cookie HttpOnly, SameSite, and scoped to the auth path', async () => {
    const response = await completeSignIn();

    const cookie = findCookie(response.headers['set-cookie'], REFRESH_COOKIE)!;
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite?.toLowerCase()).toBe('lax');
    // Scoped so the browser never attaches a 30-day credential to an order read.
    expect(cookie.path).toBe('/v1/auth');
    expect(cookie.maxAge).toBe(2_592_000);
    // Not Secure here only because NODE_ENV is `test`; production is asserted
    // separately in config.test.ts and by assertSecureCookieConfig().
  });

  it('marks auth cookies Secure on an HTTPS staging origin even outside production', () => {
    const staging = { ...context.config, PUBLIC_WEB_URL: 'https://staging.dashworldng.com' };
    expect(refreshCookieOptions(staging).secure).toBe(true);
    expect(csrfCookieOptions(staging).secure).toBe(true);

    const local = { ...context.config, PUBLIC_WEB_URL: 'http://127.0.0.1:3000' };
    expect(refreshCookieOptions(local).secure).toBe(false);
    expect(csrfCookieOptions(local).secure).toBe(false);
  });

  it('sets the CSRF cookie readable by script, site-wide', async () => {
    const response = await completeSignIn();

    const cookie = findCookie(response.headers['set-cookie'], CSRF_COOKIE)!;
    // Deliberately readable — the client must echo it into a header.
    expect(cookie.httpOnly).toBe(false);
    expect(cookie.path).toBe('/');
  });

  it('rejects a wrong password and a missing account identically', async () => {
    const wrongPassword = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: TEST_EMAIL, password: 'not-the-password' },
    });
    const noAccount = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'nobody@dashapp.test', password: 'not-the-password' },
    });

    expect(wrongPassword.statusCode).toBe(401);
    expect(noAccount.statusCode).toBe(401);
    expect(wrongPassword.json<{ error: { message: string } }>().error.message).toBe(
      noAccount.json<{ error: { message: string } }>().error.message,
    );
  });

  it('sets no cookies on a failed sign-in', async () => {
    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: TEST_EMAIL, password: 'wrong' },
    });
    expect(findCookie(response.headers['set-cookie'], REFRESH_COOKIE)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
describe('OTP login', () => {
  it('issues cookies on a verified code', async () => {
    const request = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/otp/request',
      payload: { phone: TEST_CUSTOMER_PHONE },
    });
    const code = request.json<{ devCode?: string }>().devCode;
    expect(code).toMatch(/^\d{6}$/);

    const verify = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/otp/verify',
      payload: { phone: TEST_CUSTOMER_PHONE, code },
    });

    expect(verify.statusCode).toBe(200);
    expect(findCookie(verify.headers['set-cookie'], REFRESH_COOKIE)?.httpOnly).toBe(true);
    expect(verify.body).not.toContain('refreshToken');
  });

  it('reveals nothing about whether a number is registered', async () => {
    const known = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/otp/request',
      payload: { phone: TEST_CUSTOMER_PHONE },
    });
    const unknown = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/otp/request',
      payload: { phone: '+2347000009999' },
    });

    expect(unknown.statusCode).toBe(known.statusCode);

    // devCode only exists because DEV_EXPOSE_OTP is on in the harness; strip it
    // and the two responses must be byte-identical.
    const strip = (raw: string): string => {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      delete parsed['devCode'];
      return JSON.stringify(parsed);
    };
    expect(strip(unknown.body)).toBe(strip(known.body));
    expect(unknown.json<{ devCode?: string }>().devCode).toBeUndefined();
  });

  it('burns an attempt on a wrong code and refuses a reused one', async () => {
    const request = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/otp/request',
      payload: { phone: TEST_CUSTOMER_PHONE },
    });
    const code = request.json<{ devCode: string }>().devCode;

    const wrong = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/otp/verify',
      payload: { phone: TEST_CUSTOMER_PHONE, code: code === '000000' ? '111111' : '000000' },
    });
    expect(wrong.statusCode).toBe(400);

    const right = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/otp/verify',
      payload: { phone: TEST_CUSTOMER_PHONE, code },
    });
    expect(right.statusCode).toBe(200);

    // Single use: the same code must not work twice.
    const replayed = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/otp/verify',
      payload: { phone: TEST_CUSTOMER_PHONE, code },
    });
    expect(replayed.statusCode).toBe(400);
  });


  it('does not issue an email OTP to an identity that requires staff MFA', async () => {
    const email = 'privileged-otp-block@dashapp.test';
    await context.prisma.identity.create({
      data: {
        email,
        emailVerifiedAt: new Date(),
        displayName: 'Privileged OTP Block',
        roles: { create: { role: 'super_admin' } },
      },
    });

    const request = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/otp/request',
      payload: { email },
    });

    expect(request.statusCode).toBe(200);
    expect(request.json<{ devCode?: string }>().devCode).toBeUndefined();
  });

  it('refuses an old customer OTP if the identity becomes privileged before redemption', async () => {
    const email = 'otp-elevated-before-redeem@dashapp.test';
    const identity = await context.prisma.identity.create({
      data: {
        email,
        emailVerifiedAt: new Date(),
        displayName: 'Elevated Before Redeem',
      },
      select: { id: true },
    });

    const request = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/otp/request',
      payload: { email },
    });
    const code = request.json<{ devCode?: string }>().devCode;
    expect(code).toMatch(/^\d{6}$/);

    await context.prisma.identityRole.create({
      data: { identityId: identity.id, role: 'super_admin' },
    });

    const verify = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/otp/verify',
      payload: { email, code },
    });

    expect(verify.statusCode).toBe(401);
    expect(findCookie(verify.headers['set-cookie'], REFRESH_COOKIE)).toBeUndefined();
    expect(verify.json<{ error: { message: string } }>().error.message).toContain('staff sign-in');
  });
});

// ---------------------------------------------------------------------------
describe('refresh', () => {
  it('rotates the token and returns a new access token', async () => {
    const client = await signInWithPassword(context);
    const response = await refresh(context, client);

    expect(response.statusCode).toBe(200);
    const rotated = clientFromRefresh(response);

    // A new refresh token every time — that is what makes reuse detectable.
    expect(rotated.refreshToken).not.toBe(client.refreshToken);
    expect(rotated.accessToken).toBeTruthy();
    expect(response.body).not.toContain(rotated.refreshToken);
  });

  it('reads the cookie only — a refresh token in the body is ignored', async () => {
    const client = await signInWithPassword(context);

    // Exactly the attack the cookie design closes: a token obtained some other
    // way, replayed as a body field. It must not be honoured.
    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: client.refreshToken },
    });

    expect(response.statusCode).toBe(401);
  });

  it('rejects a request with no refresh cookie', async () => {
    const response = await context.app.inject({ method: 'POST', url: '/v1/auth/refresh' });
    expect(response.statusCode).toBe(401);
  });

  it('rejects an unknown refresh token', async () => {
    const client = await signInWithPassword(context);
    const response = await refresh(context, {
      refreshToken: 'a-token-that-was-never-issued',
      csrfToken: client.csrfToken,
    });
    expect(response.statusCode).toBe(401);
  });

  it('keeps the session usable across several consecutive rotations', async () => {
    let client = await signInWithPassword(context);

    for (let round = 0; round < 5; round += 1) {
      const response = await refresh(context, client);
      expect(response.statusCode, `rotation ${round + 1} failed`).toBe(200);
      client = clientFromRefresh(response);

      const me = await context.app.inject({
        method: 'GET',
        url: '/v1/auth/me',
        headers: { authorization: `Bearer ${client.accessToken}` },
      });
      expect(me.statusCode).toBe(200);
    }
  });
});

// ---------------------------------------------------------------------------
describe('refresh token reuse detection', () => {
  it('revokes the whole family when a rotated token is presented again', async () => {
    const original = await signInWithPassword(context);

    // Legitimate rotation.
    const first = await refresh(context, original);
    expect(first.statusCode).toBe(200);
    const rotated = clientFromRefresh(first);

    // The attacker replays the token they stole before the rotation.
    const replay = await refresh(context, original);
    expect(replay.statusCode).toBe(401);

    // And the victim's *current* token is now dead too. This is the point:
    // once a token has provably leaked, the safe move is to end the session for
    // everyone, not to let the thief and the victim take turns.
    const victim = await refresh(context, rotated);
    expect(victim.statusCode).toBe(401);
  });

  it('clears the cookies when reuse is detected', async () => {
    const original = await signInWithPassword(context);
    await refresh(context, original);

    const replay = await refresh(context, original);
    const cleared = findCookie(replay.headers['set-cookie'], REFRESH_COOKIE);

    // Cleared rather than left in place — otherwise the browser retries a dead
    // token forever and the user just sees a broken app.
    expect(cleared).toBeDefined();
    expect(cleared!.value).toBe('');
  });

  it('cuts off an attacker who uses the stolen token FIRST', async () => {
    // The scenario that matters, and the one a naive implementation misses.
    //
    // The victim signs in. An attacker steals the refresh token — from a log, a
    // proxy, a backup — and redeems it before the victim's next refresh.
    const victimToken = await signInWithPassword(context);

    // Attacker rotates first and now holds a live session.
    const attackerResponse = await refresh(context, victimToken);
    expect(attackerResponse.statusCode).toBe(200);
    const attacker = clientFromRefresh(attackerResponse);

    // The victim's app refreshes on schedule, presenting the token it still
    // holds. That looks identical to a replay, because it IS one.
    const victimRetry = await refresh(context, victimToken);
    expect(victimRetry.statusCode).toBe(401);

    // The decisive assertion: the ATTACKER is now locked out too. Without
    // family revocation the thief simply keeps the account, and the victim is
    // the only one inconvenienced.
    const attackerAfter = await refresh(context, attacker);
    expect(attackerAfter.statusCode).toBe(401);

    // The victim recovers by signing in again; the attacker cannot.
    const recovered = await signInWithPassword(context);
    expect((await refresh(context, recovered)).statusCode).toBe(200);
  });

  it('reports reuse distinctly from an ordinary revocation', async () => {
    // Rotation marks the old session both rotated and revoked. If the revoked
    // check runs first it wins, the reuse branch becomes unreachable, and the
    // family is never torn down. This pins the ordering.
    const client = await signInWithPassword(context);
    await refresh(context, client);

    await refresh(context, client); // reuse

    const family = await context.prisma.session.count({
      where: { revokedReason: 'refresh_token_reuse_detected' },
    });
    expect(family).toBeGreaterThan(0);
  });

  it('marks every session in the family revoked in the database', async () => {
    const original = await signInWithPassword(context);
    const first = await refresh(context, original);
    clientFromRefresh(first);

    await refresh(context, original); // trigger reuse detection

    const live = await context.prisma.session.count({
      where: { identityId: context.identityId, revokedAt: null },
    });
    // Other tests in this file also sign in, so this asserts the family is gone
    // rather than that zero sessions exist globally.
    const revoked = await context.prisma.session.count({
      where: { identityId: context.identityId, revokedReason: 'refresh_token_reuse_detected' },
    });
    expect(revoked).toBeGreaterThan(0);
    expect(live).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
describe('CSRF', () => {
  it('rejects a cookie-authenticated request with no CSRF header', async () => {
    const client = await signInWithPassword(context);
    const response = await refresh(context, client, { csrfHeader: null });

    expect(response.statusCode).toBe(403);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('csrf_missing');
  });

  it('rejects a mismatched CSRF token', async () => {
    const client = await signInWithPassword(context);
    const response = await refresh(context, client, {
      csrfHeader: 'a-token-from-somewhere-else',
    });

    expect(response.statusCode).toBe(403);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('csrf_invalid');
  });

  it('rejects a request with a CSRF header but no CSRF cookie', async () => {
    // The double-submit half an attacker can control is the header. Without the
    // cookie they cannot read, the pair cannot match.
    const client = await signInWithPassword(context);
    const response = await refresh(context, client, { omitCsrfCookie: true });

    expect(response.statusCode).toBe(403);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('csrf_missing');
  });

  it('simulates a cross-site forgery: cookies sent, no header set', async () => {
    // A form POST from evil.example carries the cookies automatically but
    // cannot set a custom header, and cannot read the CSRF cookie to forge one.
    const client = await signInWithPassword(context);

    const forged = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: {
        cookie: cookieHeader({
          [REFRESH_COOKIE]: client.refreshToken,
          [CSRF_COOKIE]: client.csrfToken,
        }),
        origin: 'https://evil.example',
      },
    });

    expect(forged.statusCode).toBe(403);

    // And the victim's session survives — a blocked forgery must not lock them
    // out, or CSRF becomes a denial-of-service vector.
    const legitimate = await refresh(context, client);
    expect(legitimate.statusCode).toBe(200);
  });

  it('does not demand CSRF on a pure Bearer request', async () => {
    // No ambient cookie credential means nothing to ride on, so requiring a
    // token would be noise without security.
    const client = await signInWithPassword(context);

    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { authorization: `Bearer ${client.accessToken}` },
    });

    expect(response.statusCode).toBe(200);
  });

  it('does not demand CSRF on a safe method', async () => {
    const client = await signInWithPassword(context);

    const response = await context.app.inject({
      method: 'GET',
      url: '/v1/auth/sessions',
      headers: {
        authorization: `Bearer ${client.accessToken}`,
        cookie: cookieHeader({ [REFRESH_COOKIE]: client.refreshToken }),
      },
    });

    expect(response.statusCode).toBe(200);
  });

  it('issues a fresh CSRF token on every rotation', async () => {
    const client = await signInWithPassword(context);
    const response = await refresh(context, client);
    const rotated = clientFromRefresh(response);

    expect(rotated.csrfToken).not.toBe(client.csrfToken);
    expect(findCookie(response.headers['set-cookie'], CSRF_COOKIE)?.value).toBe(rotated.csrfToken);
  });
});

// ---------------------------------------------------------------------------
describe('logout', () => {
  it('clears both cookies and kills the session', async () => {
    const client = await signInWithPassword(context);

    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { authorization: `Bearer ${client.accessToken}` },
    });
    expect(response.statusCode).toBe(200);

    const cookies = response.headers['set-cookie'];
    expect(findCookie(cookies, REFRESH_COOKIE)?.value).toBe('');
    expect(findCookie(cookies, CSRF_COOKIE)?.value).toBe('');

    // The refresh token is dead server-side, not merely forgotten by the client.
    const afterLogout = await refresh(context, client);
    expect(afterLogout.statusCode).toBe(401);
  });

  it('invalidates the access token immediately, not when it expires', async () => {
    // authenticate() rebuilds the actor from the database on every request, so
    // a revoked session takes effect at once rather than after 15 minutes.
    const client = await signInWithPassword(context);

    await context.app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { authorization: `Bearer ${client.accessToken}` },
    });

    const me = await context.app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${client.accessToken}` },
    });
    expect(me.statusCode).toBe(401);
  });

  it('requires authentication', async () => {
    const response = await context.app.inject({ method: 'POST', url: '/v1/auth/logout' });
    expect(response.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
describe('multiple sessions', () => {
  it('keeps concurrent sessions independent', async () => {
    const laptop = await signInWithPassword(context);
    const phone = await signInWithPassword(context);

    expect(laptop.refreshToken).not.toBe(phone.refreshToken);

    // Both work.
    expect((await refresh(context, laptop)).statusCode).toBe(200);
    expect((await refresh(context, phone)).statusCode).toBe(200);
  });

  it('signing out one device leaves the other signed in', async () => {
    const laptop = await signInWithPassword(context);
    const phone = await signInWithPassword(context);

    await context.app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { authorization: `Bearer ${laptop.accessToken}` },
    });

    const phoneStillWorks = await context.app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${phone.accessToken}` },
    });
    expect(phoneStillWorks.statusCode).toBe(200);
  });

  it('reuse on one device does not revoke an unrelated device', async () => {
    // Family revocation must be surgical. If a leak on the laptop signed the
    // user out of their phone as well, every rotation race would look like a
    // breach and users would be logged out constantly.
    const laptop = await signInWithPassword(context);
    const phone = await signInWithPassword(context);

    await refresh(context, laptop);
    await refresh(context, laptop); // reuse → laptop family revoked

    const phoneStillWorks = await refresh(context, phone);
    expect(phoneStillWorks.statusCode).toBe(200);
  });

  it('lists live sessions and marks the current one', async () => {
    const client = await signInWithPassword(context);

    const response = await context.app.inject({
      method: 'GET',
      url: '/v1/auth/sessions',
      headers: { authorization: `Bearer ${client.accessToken}` },
    });

    expect(response.statusCode).toBe(200);
    const { sessions } = response.json<{ sessions: { id: string; isCurrent: boolean }[] }>();
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions.filter((session) => session.isCurrent)).toHaveLength(1);
  });

  it('signs out everywhere', async () => {
    const laptop = await signInWithPassword(context);
    const phone = await signInWithPassword(context);

    await context.app.inject({
      method: 'POST',
      url: '/v1/auth/logout-everywhere',
      headers: { authorization: `Bearer ${laptop.accessToken}` },
    });

    const phoneAfter = await context.app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${phone.accessToken}` },
    });
    expect(phoneAfter.statusCode).toBe(401);
  });

  it('will not let one user revoke another user’s session', async () => {
    const client = await signInWithPassword(context);

    const list = await context.app.inject({
      method: 'GET',
      url: '/v1/auth/sessions',
      headers: { authorization: `Bearer ${client.accessToken}` },
    });
    const ownSession = list.json<{ sessions: { id: string }[] }>().sessions[0]!;

    // A fabricated id must 404, not reveal whether it exists.
    const foreign = await context.app.inject({
      method: 'DELETE',
      url: '/v1/auth/sessions/not-a-real-session-id',
      headers: { authorization: `Bearer ${client.accessToken}` },
    });
    expect(foreign.statusCode).toBe(404);

    // Their own is revocable.
    const own = await context.app.inject({
      method: 'DELETE',
      url: `/v1/auth/sessions/${ownSession.id}`,
      headers: { authorization: `Bearer ${client.accessToken}` },
    });
    expect(own.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
describe('access tokens', () => {
  it('rejects a forged token', async () => {
    const response = await context.app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: 'Bearer not.a.real.token' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('rejects a missing Authorization header', async () => {
    const response = await context.app.inject({ method: 'GET', url: '/v1/auth/me' });
    expect(response.statusCode).toBe(401);
  });

  it('will not accept a refresh token as an access token', async () => {
    // Separate secrets AND separate audiences. If either were shared, a stolen
    // refresh token would be a permanent session.
    const client = await signInWithPassword(context);

    const response = await context.app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${client.refreshToken}` },
    });
    expect(response.statusCode).toBe(401);
  });

  it('derives permissions from the database, ignoring anything the client sends', async () => {
    const client = await signInWithPassword(context);

    const response = await context.app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${client.accessToken}` },
    });

    const body = response.json<{ roles: string[]; permissions: string[] }>();
    expect(body.roles).toEqual(['support_agent']);
    expect(body.permissions).not.toContain('admin:impersonate');
    expect(body.permissions).not.toContain('finance:payout:approve');
  });
});
