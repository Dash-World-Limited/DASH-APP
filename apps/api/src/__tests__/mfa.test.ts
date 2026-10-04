/**
 * Administrator MFA — integration tests.
 *
 * Drives a real Fastify instance against a temporary SQLite database. These
 * tests deliberately do NOT use the harness's `signInWithPassword` helper for
 * the flows under test: that helper simulates elapsed time so the rest of the
 * suite can run, and using it here would hide the very rules being asserted.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NobleCryptoPlugin, ScureBase32Plugin, TOTP } from 'otplib';
import { hashPassword } from '@dash/domain/crypto';
import { decrypt, parseKey } from '@dash/domain/envelope';
import {
  createTestContext,
  findCookie,
  TEST_EMAIL,
  TEST_PASSWORD,
  type TestContext,
} from './harness.js';
import { CSRF_COOKIE, REFRESH_COOKIE } from '../auth/cookies.js';
import { useIntegrationTimeouts } from './timeouts.js';

// Real Fastify, real SQLite, real round trips — see timeouts.ts.
useIntegrationTimeouts();

const totp = new TOTP({
  crypto: new NobleCryptoPlugin(),
  base32: new ScureBase32Plugin(),
  algorithm: 'sha1',
  digits: 6,
  period: 30,
});

/** The code an authenticator would show for a given moment. */
async function codeFor(secret: string, atEpochSeconds?: number): Promise<string> {
  return totp.generate({
    secret,
    ...(atEpochSeconds === undefined ? {} : { epoch: atEpochSeconds }),
  });
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

let context: TestContext;

beforeAll(async () => {
  context = await createTestContext();
});

afterAll(async () => {
  await context.close();
});

/** Start over: no enrolment, no challenges, no recovery codes, no sessions. */
async function resetMfa(email = TEST_EMAIL): Promise<string> {
  const identity = await context.prisma.identity.findUniqueOrThrow({
    where: { email },
    select: { id: true },
  });

  await context.prisma.mfaRecoveryCode.deleteMany({ where: { identityId: identity.id } });
  await context.prisma.mfaChallenge.deleteMany({ where: { identityId: identity.id } });
  await context.prisma.session.deleteMany({ where: { identityId: identity.id } });
  await context.prisma.identity.update({
    where: { id: identity.id },
    data: {
      mfaSecretCipher: null,
      mfaPendingCipher: null,
      mfaPendingAt: null,
      mfaEnrolledAt: null,
      mfaLastTimeStep: null,
    },
  });

  return identity.id;
}

function login(email = TEST_EMAIL, password = TEST_PASSWORD) {
  return context.app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email, password },
  });
}

/** Password → enrol → confirm. Returns the secret and the issued session. */
async function enrolFully(
  email = TEST_EMAIL,
  password = TEST_PASSWORD,
): Promise<{
  secret: string;
  accessToken: string;
  csrfToken: string;
  recoveryCodes: string[];
}> {
  const first = await login(email, password);
  if (first.statusCode !== 200) {
    throw new Error(`enrolFully could not sign in as ${email}: ${first.statusCode} ${first.body}`);
  }
  const { challengeToken } = first.json<{ challengeToken: string }>();

  const started = await context.app.inject({
    method: 'POST',
    url: '/v1/auth/mfa/enrol/start',
    payload: { challengeToken },
  });
  const { secret } = started.json<{ secret: string }>();

  const confirmed = await context.app.inject({
    method: 'POST',
    url: '/v1/auth/mfa/enrol/confirm',
    payload: { challengeToken, code: await codeFor(secret) },
  });

  const body = confirmed.json<{
    accessToken: string;
    csrfToken: string;
    recoveryCodes: string[];
  }>();

  return { secret, ...body };
}

/**
 * Clear the recorded time step.
 *
 * Simulates the 30 seconds a real user would have taken between two sign-ins.
 * Used only where the test is about something else; the replay rule has its own
 * tests below which never call this.
 */
async function simulateTimePassing(email = TEST_EMAIL): Promise<void> {
  await context.prisma.identity.updateMany({
    where: { email },
    data: { mfaLastTimeStep: null },
  });
}

// ---------------------------------------------------------------------------

describe('a staff password alone is not enough', () => {
  beforeEach(async () => {
    await resetMfa();
  });

  it('returns a challenge, not a session, when MFA is not yet set up', async () => {
    const response = await login();
    const body = response.json<Record<string, unknown>>();

    expect(response.statusCode).toBe(200);
    expect(body['mfaRequired']).toBe(true);
    expect(body['stage']).toBe('enrol');

    // The assertions that matter: nothing usable came back.
    expect(body['accessToken']).toBeUndefined();
    expect(body['csrfToken']).toBeUndefined();
    expect(findCookie(response.headers['set-cookie'], REFRESH_COOKIE)).toBeUndefined();
    expect(findCookie(response.headers['set-cookie'], CSRF_COOKIE)).toBeUndefined();
  });

  it('returns a challenge, not a session, when MFA IS set up', async () => {
    await enrolFully();

    const response = await login();
    const body = response.json<Record<string, unknown>>();

    expect(body['stage']).toBe('verify');
    expect(body['accessToken']).toBeUndefined();
    expect(findCookie(response.headers['set-cookie'], REFRESH_COOKIE)).toBeUndefined();
  });

  it('will not let the challenge token act as an access token', async () => {
    const { challengeToken } = (await login()).json<{ challengeToken: string }>();

    const response = await context.app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${challengeToken}` },
    });

    expect(response.statusCode).toBe(401);
  });

  it('will not let the challenge token be refreshed into a session', async () => {
    const { challengeToken } = (await login()).json<{ challengeToken: string }>();

    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: {
        cookie: `${REFRESH_COOKIE}=${challengeToken}; ${CSRF_COOKIE}=x`,
        'x-csrf-token': 'x',
      },
    });

    expect(response.statusCode).toBe(401);
  });

  it('still refuses a wrong password before any MFA stage', async () => {
    const response = await login(TEST_EMAIL, 'not-the-password');
    expect(response.statusCode).toBe(401);
    expect(response.body).not.toContain('challengeToken');
  });

  it('does not require MFA for a customer', async () => {
    const password = await hashPassword('CustomerOnly!2026');
    await context.prisma.identity.create({
      data: {
        email: 'mfa-customer@dashapp.test',
        phone: '+2347000009301',
        passwordHash: password,
        roles: { create: { role: 'customer' } },
      },
    });

    const response = await login('mfa-customer@dashapp.test', 'CustomerOnly!2026');
    const body = response.json<Record<string, unknown>>();

    expect(body['mfaRequired']).toBeUndefined();
    expect(body['accessToken']).toBeTruthy();
  });
});

describe('enrolment', () => {
  beforeEach(async () => {
    await resetMfa();
  });

  it('offers a secret and a scannable otpauth URI', async () => {
    const { challengeToken } = (await login()).json<{ challengeToken: string }>();

    const started = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/enrol/start',
      payload: { challengeToken },
    });

    const body = started.json<{ secret: string; otpauthUri: string }>();
    expect(body.secret).toMatch(/^[A-Z2-7]{16,}$/);
    expect(body.otpauthUri).toContain('otpauth://totp/');
    expect(body.otpauthUri).toContain('issuer=DASH%20APP');
  });

  it('does not activate MFA until possession is proved', async () => {
    const { challengeToken } = (await login()).json<{ challengeToken: string }>();
    await context.app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/enrol/start',
      payload: { challengeToken },
    });

    const identity = await context.prisma.identity.findUniqueOrThrow({
      where: { email: TEST_EMAIL },
      select: { mfaPendingCipher: true, mfaSecretCipher: true, mfaEnrolledAt: true },
    });

    // A pending secret exists, but nothing that can authenticate.
    expect(identity.mfaPendingCipher).not.toBeNull();
    expect(identity.mfaSecretCipher).toBeNull();
    expect(identity.mfaEnrolledAt).toBeNull();
  });

  it('an unconfirmed enrolment cannot be used to sign in', async () => {
    const { challengeToken } = (await login()).json<{ challengeToken: string }>();
    const started = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/enrol/start',
      payload: { challengeToken },
    });
    const { secret } = started.json<{ secret: string }>();

    // A perfectly valid code for the pending secret — but the account is not
    // enrolled, so /verify must not accept it.
    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/verify',
      payload: { challengeToken, code: await codeFor(secret) },
    });

    expect(response.statusCode).toBe(400);
    expect(findCookie(response.headers['set-cookie'], REFRESH_COOKIE)).toBeUndefined();
  });

  it('rejects a wrong confirmation code and stays unenrolled', async () => {
    const { challengeToken } = (await login()).json<{ challengeToken: string }>();
    await context.app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/enrol/start',
      payload: { challengeToken },
    });

    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/enrol/confirm',
      payload: { challengeToken, code: '000000' },
    });

    expect(response.statusCode).toBe(400);
    const identity = await context.prisma.identity.findUniqueOrThrow({
      where: { email: TEST_EMAIL },
      select: { mfaEnrolledAt: true },
    });
    expect(identity.mfaEnrolledAt).toBeNull();
  });

  it('rejects a malformed code without touching the enrolment', async () => {
    const { challengeToken } = (await login()).json<{ challengeToken: string }>();
    await context.app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/enrol/start',
      payload: { challengeToken },
    });

    for (const code of ['12345', '1234567', 'abcdef', '', '12 34 5']) {
      const response = await context.app.inject({
        method: 'POST',
        url: '/v1/auth/mfa/enrol/confirm',
        payload: { challengeToken, code },
      });
      expect(response.statusCode, `code ${JSON.stringify(code)}`).toBe(400);
    }
  });

  it('accepts a code with the spaces an authenticator app displays', async () => {
    const { challengeToken } = (await login()).json<{ challengeToken: string }>();
    const started = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/enrol/start',
      payload: { challengeToken },
    });
    const { secret } = started.json<{ secret: string }>();
    const code = await codeFor(secret);

    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/enrol/confirm',
      payload: { challengeToken, code: `${code.slice(0, 3)} ${code.slice(3)}` },
    });

    expect(response.statusCode).toBe(200);
  });

  it('refuses to re-enrol from a challenge token once already enrolled', async () => {
    await enrolFully();
    await simulateTimePassing();

    const { challengeToken } = (await login()).json<{ challengeToken: string }>();
    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/enrol/start',
      payload: { challengeToken },
    });

    // Replacing a working authenticator requires proving possession of the
    // current one first, which means a session and a step-up.
    expect(response.statusCode).toBe(409);
  });

  it('discards an enrolment that was never confirmed in time', async () => {
    const { challengeToken } = (await login()).json<{ challengeToken: string }>();
    const started = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/enrol/start',
      payload: { challengeToken },
    });
    const { secret } = started.json<{ secret: string }>();

    // Age the pending enrolment past its window.
    await context.prisma.identity.updateMany({
      where: { email: TEST_EMAIL },
      data: { mfaPendingAt: new Date(Date.now() - 3_600_000) },
    });

    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/enrol/confirm',
      payload: { challengeToken, code: await codeFor(secret) },
    });

    expect(response.statusCode).toBe(409);
    const identity = await context.prisma.identity.findUniqueOrThrow({
      where: { email: TEST_EMAIL },
      select: { mfaPendingCipher: true },
    });
    expect(identity.mfaPendingCipher).toBeNull();
  });

  it('issues a session and recovery codes on confirmation', async () => {
    const result = await enrolFully();

    expect(result.accessToken).toBeTruthy();
    expect(result.csrfToken).toBeTruthy();
    expect(result.recoveryCodes).toHaveLength(10);
    expect(new Set(result.recoveryCodes).size).toBe(10);
  });
});

describe('the secret is never exposed after enrolment', () => {
  beforeEach(async () => {
    await resetMfa();
  });

  it('is stored encrypted, not in plaintext', async () => {
    const { secret } = await enrolFully();

    const identity = await context.prisma.identity.findUniqueOrThrow({
      where: { email: TEST_EMAIL },
      select: { mfaSecretCipher: true },
    });

    expect(identity.mfaSecretCipher).not.toBeNull();
    expect(identity.mfaSecretCipher).not.toContain(secret);
    expect(identity.mfaSecretCipher).toMatch(/^v1\./);
  });

  it('is bound to the identity that owns it', async () => {
    const identityId = (
      await context.prisma.identity.findUniqueOrThrow({
        where: { email: TEST_EMAIL },
        select: { id: true },
      })
    ).id;

    const { secret } = await enrolFully();
    const cipher = (
      await context.prisma.identity.findUniqueOrThrow({
        where: { id: identityId },
        select: { mfaSecretCipher: true },
      })
    ).mfaSecretCipher!;

    const keyring = {
      active: {
        keyId: context.config.ENCRYPTION_KEY_ID,
        key: parseKey(context.config.ENCRYPTION_KEY!),
      },
      retired: [],
    };

    // Correct owner: opens.
    expect(
      decrypt(cipher, keyring, { purpose: 'mfa_totp_secret', subjectId: identityId }).plaintext,
    ).toBe(secret);

    // Copied to another identity's row: does not.
    expect(() =>
      decrypt(cipher, keyring, { purpose: 'mfa_totp_secret', subjectId: 'someone-else' }),
    ).toThrow();
  });

  it('does not appear in the MFA status endpoint', async () => {
    const { secret, accessToken } = await enrolFully();

    const response = await context.app.inject({
      method: 'GET',
      url: '/v1/auth/mfa',
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(secret);
    expect(response.body).not.toContain('Cipher');
    expect(response.json<{ active: boolean }>().active).toBe(true);
  });

  it('does not appear in the identity read', async () => {
    const { secret, accessToken } = await enrolFully();

    const response = await context.app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(response.body).not.toContain(secret);
    expect(response.body).not.toContain('mfaSecret');
  });

  it('does not appear in the audit log', async () => {
    const { secret } = await enrolFully();

    const entries = await context.prisma.auditLog.findMany({
      where: { action: { startsWith: 'auth.mfa' } },
    });

    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(JSON.stringify(entry)).not.toContain(secret);
    }
  });
});

describe('TOTP verification', () => {
  let secret: string;

  beforeEach(async () => {
    await resetMfa();
    secret = (await enrolFully()).secret;
    await simulateTimePassing();
  });

  it('accepts a valid code and issues a session', async () => {
    const { challengeToken } = (await login()).json<{ challengeToken: string }>();

    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/verify',
      payload: { challengeToken, code: await codeFor(secret) },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ accessToken: string }>().accessToken).toBeTruthy();
    expect(findCookie(response.headers['set-cookie'], REFRESH_COOKIE)).toBeDefined();
  });

  it('rejects a wrong code', async () => {
    const { challengeToken } = (await login()).json<{ challengeToken: string }>();

    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/verify',
      payload: { challengeToken, code: '000000' },
    });

    expect(response.statusCode).toBe(400);
    expect(findCookie(response.headers['set-cookie'], REFRESH_COOKIE)).toBeUndefined();
  });

  it('rejects a code from too far in the past', async () => {
    const { challengeToken } = (await login()).json<{ challengeToken: string }>();
    const stale = await codeFor(secret, nowSeconds() - 300);

    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/verify',
      payload: { challengeToken, code: stale },
    });

    expect(response.statusCode).toBe(400);
  });

  it('rejects a code from too far in the future', async () => {
    const { challengeToken } = (await login()).json<{ challengeToken: string }>();
    const early = await codeFor(secret, nowSeconds() + 300);

    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/verify',
      payload: { challengeToken, code: early },
    });

    expect(response.statusCode).toBe(400);
  });

  it('REFUSES TO REPLAY a code that already succeeded', async () => {
    // The core replay rule. Deliberately no simulateTimePassing() here — that
    // is the whole point of the test.
    const code = await codeFor(secret);

    const firstLogin = (await login()).json<{ challengeToken: string }>();
    const first = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/verify',
      payload: { challengeToken: firstLogin.challengeToken, code },
    });
    expect(first.statusCode).toBe(200);

    const secondLogin = (await login()).json<{ challengeToken: string }>();
    const second = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/verify',
      payload: { challengeToken: secondLogin.challengeToken, code },
    });

    expect(second.statusCode).toBe(400);
    expect(findCookie(second.headers['set-cookie'], REFRESH_COOKIE)).toBeUndefined();
  });

  it('reports a replayed code exactly like a wrong one', async () => {
    const code = await codeFor(secret);
    const firstLogin = (await login()).json<{ challengeToken: string }>();
    await context.app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/verify',
      payload: { challengeToken: firstLogin.challengeToken, code },
    });

    const replayLogin = (await login()).json<{ challengeToken: string }>();
    const replay = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/verify',
      payload: { challengeToken: replayLogin.challengeToken, code },
    });

    const wrongLogin = (await login()).json<{ challengeToken: string }>();
    const wrong = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/verify',
      payload: { challengeToken: wrongLogin.challengeToken, code: '000000' },
    });

    // Telling them apart would confirm to someone replaying a captured code
    // that they had the right digits.
    expect(replay.statusCode).toBe(wrong.statusCode);
    expect(replay.json<{ error: { message: string } }>().error.message).toBe(
      wrong.json<{ error: { message: string } }>().error.message,
    );
  });

  it('records the accepted step so it cannot be reused', async () => {
    const { challengeToken } = (await login()).json<{ challengeToken: string }>();
    await context.app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/verify',
      payload: { challengeToken, code: await codeFor(secret) },
    });

    const identity = await context.prisma.identity.findUniqueOrThrow({
      where: { email: TEST_EMAIL },
      select: { mfaLastTimeStep: true },
    });
    expect(identity.mfaLastTimeStep).toBeGreaterThan(0);
  });

  it('rejects a code for a challenge that was already used', async () => {
    const { challengeToken } = (await login()).json<{ challengeToken: string }>();
    const first = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/verify',
      payload: { challengeToken, code: await codeFor(secret) },
    });
    expect(first.statusCode).toBe(200);

    await simulateTimePassing();
    const second = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/verify',
      payload: { challengeToken, code: await codeFor(secret) },
    });

    expect(second.statusCode).toBe(401);
  });

  it('rejects an expired challenge', async () => {
    const { challengeToken } = (await login()).json<{ challengeToken: string }>();

    await context.prisma.mfaChallenge.updateMany({
      where: { consumedAt: null },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/verify',
      payload: { challengeToken, code: await codeFor(secret) },
    });

    expect(response.statusCode).toBe(401);
  });

  it('rejects an unknown challenge token', async () => {
    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/verify',
      payload: { challengeToken: 'not-a-real-challenge-token-at-all', code: await codeFor(secret) },
    });

    expect(response.statusCode).toBe(401);
  });

  it('stops accepting attempts once the limit is spent', async () => {
    const { challengeToken } = (await login()).json<{ challengeToken: string }>();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await context.app.inject({
        method: 'POST',
        url: '/v1/auth/mfa/verify',
        payload: { challengeToken, code: '000000' },
      });
    }

    // Even the correct code is refused now — the challenge is spent.
    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/verify',
      payload: { challengeToken, code: await codeFor(secret) },
    });

    expect([401, 429]).toContain(response.statusCode);
  });

  it('refuses both factors at once', async () => {
    const { challengeToken } = (await login()).json<{ challengeToken: string }>();

    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/verify',
      payload: { challengeToken, code: await codeFor(secret), recoveryCode: 'ABCD-2345-EFGH-6789' },
    });

    expect(response.statusCode).toBe(400);
  });

  it('refuses neither factor', async () => {
    const { challengeToken } = (await login()).json<{ challengeToken: string }>();

    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/verify',
      payload: { challengeToken },
    });

    expect(response.statusCode).toBe(400);
  });
});

describe('recovery codes', () => {
  let codes: string[];
  let secret: string;

  beforeEach(async () => {
    await resetMfa();
    const result = await enrolFully();
    codes = result.recoveryCodes;
    secret = result.secret;
    await simulateTimePassing();
  });

  it('signs in with a recovery code', async () => {
    const { challengeToken } = (await login()).json<{ challengeToken: string }>();

    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/verify',
      payload: { challengeToken, recoveryCode: codes[0] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ accessToken: string }>().accessToken).toBeTruthy();
  });

  it('accepts a code typed without its dashes', async () => {
    const { challengeToken } = (await login()).json<{ challengeToken: string }>();

    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/verify',
      payload: { challengeToken, recoveryCode: codes[0]!.replace(/-/g, '').toLowerCase() },
    });

    expect(response.statusCode).toBe(200);
  });

  it('works exactly once', async () => {
    const first = (await login()).json<{ challengeToken: string }>();
    const used = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/verify',
      payload: { challengeToken: first.challengeToken, recoveryCode: codes[0] },
    });
    expect(used.statusCode).toBe(200);

    const second = (await login()).json<{ challengeToken: string }>();
    const reused = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/verify',
      payload: { challengeToken: second.challengeToken, recoveryCode: codes[0] },
    });

    expect(reused.statusCode).toBe(400);
  });

  it('leaves the other codes usable', async () => {
    const first = (await login()).json<{ challengeToken: string }>();
    await context.app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/verify',
      payload: { challengeToken: first.challengeToken, recoveryCode: codes[0] },
    });

    const second = (await login()).json<{ challengeToken: string }>();
    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/verify',
      payload: { challengeToken: second.challengeToken, recoveryCode: codes[1] },
    });

    expect(response.statusCode).toBe(200);
  });

  it('rejects a code that was never issued', async () => {
    const { challengeToken } = (await login()).json<{ challengeToken: string }>();

    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/verify',
      payload: { challengeToken, recoveryCode: 'ZZZZ-ZZZZ-ZZZZ-ZZZZ' },
    });

    expect(response.statusCode).toBe(400);
  });

  it('rejects another account’s recovery code', async () => {
    const password = await hashPassword('OtherStaff!2026');
    await context.prisma.identity.create({
      data: {
        email: 'mfa-other@dashapp.test',
        phone: '+2347000009302',
        passwordHash: password,
        roles: { create: { role: 'finance_analyst' } },
      },
    });
    const other = await enrolFully('mfa-other@dashapp.test', 'OtherStaff!2026');

    const { challengeToken } = (await login()).json<{ challengeToken: string }>();
    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/verify',
      payload: { challengeToken, recoveryCode: other.recoveryCodes[0] },
    });

    expect(response.statusCode).toBe(400);
  });

  it('stores only hashes, never the codes themselves', async () => {
    const rows = await context.prisma.mfaRecoveryCode.findMany();
    const serialised = JSON.stringify(rows);

    for (const code of codes) {
      expect(serialised).not.toContain(code);
      expect(serialised).not.toContain(code.replace(/-/g, ''));
    }
  });

  it('reports how many remain', async () => {
    const { challengeToken } = (await login()).json<{ challengeToken: string }>();
    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/verify',
      payload: { challengeToken, recoveryCode: codes[0] },
    });

    const body = response.json<{ recoveryCodes: { remaining: number } }>();
    expect(body.recoveryCodes.remaining).toBe(9);
  });

  it('regenerating voids every unused code', async () => {
    const { challengeToken } = (await login()).json<{ challengeToken: string }>();
    const signIn = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/verify',
      payload: { challengeToken, code: await codeFor(secret) },
    });
    const { accessToken, csrfToken } = signIn.json<{ accessToken: string; csrfToken: string }>();

    // Regeneration needs a fresh step-up.
    await simulateTimePassing();
    await context.app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/step-up',
      headers: { authorization: `Bearer ${accessToken}`, 'x-csrf-token': csrfToken },
      payload: { code: await codeFor(secret) },
    });

    const regenerated = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/recovery/regenerate',
      headers: { authorization: `Bearer ${accessToken}`, 'x-csrf-token': csrfToken },
    });
    expect(regenerated.statusCode).toBe(200);
    const fresh = regenerated.json<{ recoveryCodes: string[] }>().recoveryCodes;
    expect(fresh).toHaveLength(10);

    // An old code no longer works…
    await simulateTimePassing();
    const oldAttempt = (await login()).json<{ challengeToken: string }>();
    const usingOld = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/verify',
      payload: { challengeToken: oldAttempt.challengeToken, recoveryCode: codes[1] },
    });
    expect(usingOld.statusCode).toBe(400);

    // …and a new one does.
    const newAttempt = (await login()).json<{ challengeToken: string }>();
    const usingNew = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/verify',
      payload: { challengeToken: newAttempt.challengeToken, recoveryCode: fresh[0] },
    });
    expect(usingNew.statusCode).toBe(200);
  });

  it('will not regenerate without a fresh step-up', async () => {
    const { challengeToken } = (await login()).json<{ challengeToken: string }>();
    const signIn = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/verify',
      payload: { challengeToken, code: await codeFor(secret) },
    });
    const { accessToken, csrfToken } = signIn.json<{ accessToken: string; csrfToken: string }>();

    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/recovery/regenerate',
      headers: { authorization: `Bearer ${accessToken}`, 'x-csrf-token': csrfToken },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('step_up_required');
  });
});

describe('disabling MFA', () => {
  let secret: string;
  let accessToken: string;
  let csrfToken: string;

  beforeEach(async () => {
    await resetMfa();
    const enrolled = await enrolFully();
    secret = enrolled.secret;
    accessToken = enrolled.accessToken;
    csrfToken = enrolled.csrfToken;
    await simulateTimePassing();
  });

  it('requires a fresh step-up', async () => {
    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/disable',
      headers: { authorization: `Bearer ${accessToken}`, 'x-csrf-token': csrfToken },
    });

    expect(response.statusCode).toBe(403);
    const identity = await context.prisma.identity.findUniqueOrThrow({
      where: { email: TEST_EMAIL },
      select: { mfaEnrolledAt: true },
    });
    expect(identity.mfaEnrolledAt).not.toBeNull();
  });

  it('revokes every session when it succeeds', async () => {
    await context.app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/step-up',
      headers: { authorization: `Bearer ${accessToken}`, 'x-csrf-token': csrfToken },
      payload: { code: await codeFor(secret) },
    });

    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/disable',
      headers: { authorization: `Bearer ${accessToken}`, 'x-csrf-token': csrfToken },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ sessionsRevoked: number }>().sessionsRevoked).toBeGreaterThan(0);

    // The caller's own access token dies with everyone else's.
    const after = await context.app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(after.statusCode).toBe(401);
  });

  it('wipes the secret and every recovery code', async () => {
    await context.app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/step-up',
      headers: { authorization: `Bearer ${accessToken}`, 'x-csrf-token': csrfToken },
      payload: { code: await codeFor(secret) },
    });
    await context.app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/disable',
      headers: { authorization: `Bearer ${accessToken}`, 'x-csrf-token': csrfToken },
    });

    const identity = await context.prisma.identity.findUniqueOrThrow({
      where: { email: TEST_EMAIL },
      select: { id: true, mfaSecretCipher: true, mfaEnrolledAt: true, mfaLastTimeStep: true },
    });

    expect(identity.mfaSecretCipher).toBeNull();
    expect(identity.mfaEnrolledAt).toBeNull();
    expect(identity.mfaLastTimeStep).toBeNull();
    expect(
      await context.prisma.mfaRecoveryCode.count({ where: { identityId: identity.id } }),
    ).toBe(0);
  });

  it('still demands MFA at the next sign-in — disabling does not opt out', async () => {
    await context.app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/step-up',
      headers: { authorization: `Bearer ${accessToken}`, 'x-csrf-token': csrfToken },
      payload: { code: await codeFor(secret) },
    });
    await context.app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/disable',
      headers: { authorization: `Bearer ${accessToken}`, 'x-csrf-token': csrfToken },
    });

    // The role still requires it, so the account is back to needing enrolment
    // rather than being let in on a password.
    const body = (await login()).json<Record<string, unknown>>();
    expect(body['mfaRequired']).toBe(true);
    expect(body['stage']).toBe('enrol');
    expect(body['accessToken']).toBeUndefined();
  });

  it('records a high-signal audit event without secrets', async () => {
    await context.app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/step-up',
      headers: { authorization: `Bearer ${accessToken}`, 'x-csrf-token': csrfToken },
      payload: { code: await codeFor(secret) },
    });
    await context.app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/disable',
      headers: { authorization: `Bearer ${accessToken}`, 'x-csrf-token': csrfToken },
    });

    const entry = await context.prisma.auditLog.findFirst({
      where: { action: 'auth.mfa.disabled' },
    });

    expect(entry).not.toBeNull();
    expect(JSON.stringify(entry)).not.toContain(secret);
  });
});

describe('cross-user attempts', () => {
  beforeEach(async () => {
    await resetMfa();
  });

  it('a challenge token only ever enrols its own account', async () => {
    const password = await hashPassword('Victim!2026');
    const victim = await context.prisma.identity.create({
      data: {
        email: 'mfa-victim@dashapp.test',
        phone: '+2347000009303',
        passwordHash: password,
        roles: { create: { role: 'super_admin' } },
      },
      select: { id: true },
    });

    // Attacker signs in as themselves and drives enrolment with their own
    // challenge. The victim must be untouched.
    const { challengeToken } = (await login()).json<{ challengeToken: string }>();
    await context.app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/enrol/start',
      payload: { challengeToken },
    });

    const victimRow = await context.prisma.identity.findUniqueOrThrow({
      where: { id: victim.id },
      select: { mfaPendingCipher: true, mfaSecretCipher: true },
    });
    expect(victimRow.mfaPendingCipher).toBeNull();
    expect(victimRow.mfaSecretCipher).toBeNull();
  });

  it('one user cannot disable another user’s MFA', async () => {
    const password = await hashPassword('Target!2026');
    await context.prisma.identity.create({
      data: {
        email: 'mfa-target@dashapp.test',
        phone: '+2347000009304',
        passwordHash: password,
        roles: { create: { role: 'super_admin' } },
      },
    });
    const target = await enrolFully('mfa-target@dashapp.test', 'Target!2026');

    const attacker = await enrolFully();
    await simulateTimePassing();

    // The disable route acts on the caller's own identity only — there is no
    // id to substitute, which is the point.
    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/disable',
      headers: {
        authorization: `Bearer ${attacker.accessToken}`,
        'x-csrf-token': attacker.csrfToken,
      },
    });
    expect(response.statusCode).toBe(403);

    const targetRow = await context.prisma.identity.findUniqueOrThrow({
      where: { email: 'mfa-target@dashapp.test' },
      select: { mfaEnrolledAt: true },
    });
    expect(targetRow.mfaEnrolledAt).not.toBeNull();
    expect(target.accessToken).toBeTruthy();
  });
});

describe('role changes cannot bypass MFA', () => {
  it('a newly privileged account is challenged at its next sign-in', async () => {
    const password = await hashPassword('Promoted!2026');
    const identity = await context.prisma.identity.create({
      data: {
        email: 'mfa-promoted@dashapp.test',
        phone: '+2347000009305',
        passwordHash: password,
        roles: { create: { role: 'customer' } },
      },
      select: { id: true },
    });

    // As a customer: straight in, no second factor.
    const before = (await login('mfa-promoted@dashapp.test', 'Promoted!2026')).json<
      Record<string, unknown>
    >();
    expect(before['accessToken']).toBeTruthy();

    await context.prisma.identityRole.create({
      data: { identityId: identity.id, role: 'finance_analyst' },
    });

    // The moment they can approve a refund, the password stops being enough.
    const after = (await login('mfa-promoted@dashapp.test', 'Promoted!2026')).json<
      Record<string, unknown>
    >();
    expect(after['mfaRequired']).toBe(true);
    expect(after['accessToken']).toBeUndefined();
  });
});
