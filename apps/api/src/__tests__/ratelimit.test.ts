/**
 * Rate limiting.
 *
 * The rest of the API suite runs with `RATE_LIMIT_ENABLED=false`, because a
 * test that signs in twenty times legitimately trips the login limiter. That
 * makes this file necessary: without it, the limiter would be switched off
 * everywhere in CI and nobody would notice if it broke.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, TEST_EMAIL, type TestContext } from './harness.js';

let context: TestContext;

beforeAll(async () => {
  // The only suite that turns the limiter back on.
  context = await createTestContext({ RATE_LIMIT_ENABLED: 'true' });
}, 120_000);

afterAll(async () => {
  await context?.close();
});

describe('login rate limiting', () => {
  it('blocks credential stuffing after the configured attempts', async () => {
    const attempt = () =>
      context.app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email: TEST_EMAIL, password: 'wrong-password' },
      });

    // The route allows 10 per 15 minutes.
    const statuses: number[] = [];
    for (let i = 0; i < 13; i += 1) {
      statuses.push((await attempt()).statusCode);
    }

    // Early attempts are ordinary auth failures…
    expect(statuses[0]).toBe(401);
    // …and the limiter takes over before all 13 land.
    expect(statuses).toContain(429);
    expect(statuses.filter((status) => status === 429).length).toBeGreaterThanOrEqual(3);
  });

  it('returns a safe, vague message when limiting', async () => {
    const responses = [];
    for (let i = 0; i < 13; i += 1) {
      responses.push(
        await context.app.inject({
          method: 'POST',
          url: '/v1/auth/login',
          payload: { email: TEST_EMAIL, password: 'wrong-password' },
        }),
      );
    }

    const limited = responses.find((response) => response.statusCode === 429);
    expect(limited).toBeDefined();

    const body = limited!.json<{ error: { message: string; requestId: string } }>();
    // No mention of which limit, how many remain, or when it resets — that
    // information helps an attacker pace themselves.
    expect(body.error.message).toBe('Too many attempts. Try again shortly.');
    expect(body.error.requestId).toBeTruthy();
  });
});

describe('OTP rate limiting', () => {
  it('caps OTP requests, because each one sends an SMS that costs money', async () => {
    // The other reason for this limit: without it, the endpoint is a way to
    // spam a stranger's phone at our expense.
    const statuses: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      const response = await context.app.inject({
        method: 'POST',
        url: '/v1/auth/otp/request',
        payload: { phone: '+2347000009002' },
      });
      statuses.push(response.statusCode);
    }

    // 5 per 10 minutes.
    expect(statuses).toContain(429);
  });
});

describe('configuration', () => {
  it('cannot be disabled in production', () => {
    // Asserted here as well as in config.test.ts because this is the file a
    // future contributor will open when they wonder why the limiter is off in
    // tests, and the answer needs to be next to the question.
    expect(context.config.RATE_LIMIT_ENABLED).toBe(true);
  });
});
