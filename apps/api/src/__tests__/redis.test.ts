/**
 * Redis: what it is trusted with, and what happens when it is not there.
 *
 * No Redis server is needed to run this file, and that is deliberate rather
 * than a compromise — every test here is about the *unavailable* path, which is
 * exactly the path a healthy server cannot exercise. The clients are pointed at
 * a port nothing listens on, which is a truthful simulation of an outage: the
 * connection is refused by the operating system in the same way it would be if
 * the server had died.
 *
 * The healthy path needs a real server and is covered by
 * `scripts/redis-check.mjs`, which is **not** part of this suite and is
 * reported as PENDING until it has been run.
 *
 * The property that matters most: **rate limiting fails closed.** A Redis
 * outage must not quietly turn off the only defence against credential
 * stuffing and OTP brute force.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './harness.js';
import {
  createQueueRedis,
  createRateLimitRedis,
  pingRedis,
  REDIS_RESPONSIBILITIES,
} from '../redis/client.js';
import { RedisQueueAdapter } from '../adapters/redis-queue.js';

/** A port in the ephemeral range with nothing bound to it. */
const DEAD_REDIS = 'redis://127.0.0.1:6390';

describe('the register of what Redis is trusted with', () => {
  it('classifies every responsibility', () => {
    expect(REDIS_RESPONSIBILITIES.length).toBeGreaterThan(0);
    for (const responsibility of REDIS_RESPONSIBILITIES) {
      expect(['fail_closed', 'degradable', 'retryable']).toContain(responsibility.failureMode);
      expect(typeof responsibility.correctnessCritical).toBe('boolean');
      expect(
        responsibility.rationale.length,
        `${responsibility.name} has no written rationale`,
      ).toBeGreaterThan(40);
    }
  });

  it('makes rate limiting fail closed and correctness-critical', () => {
    const rateLimit = REDIS_RESPONSIBILITIES.find((r) => r.name === 'rate_limit');
    expect(rateLimit).toBeDefined();
    expect(rateLimit!.failureMode).toBe('fail_closed');
    expect(rateLimit!.correctnessCritical).toBe(true);
  });

  it('makes the queue retryable rather than silently degradable', () => {
    // "Degradable" would mean dropping the job and carrying on, which is how an
    // export sits `pending` forever with nobody aware.
    const queue = REDIS_RESPONSIBILITIES.find((r) => r.name === 'queue');
    expect(queue).toBeDefined();
    expect(queue!.failureMode).toBe('retryable');
  });

  it('trusts Redis with nothing durable', () => {
    // Sessions, OTP challenges, idempotency keys, and the ledger are
    // PostgreSQL rows. If one of those names ever appears here, durable
    // business state has moved into a cache.
    const names = REDIS_RESPONSIBILITIES.map((r) => r.name);
    for (const durable of ['session', 'otp', 'ledger', 'idempotency', 'order', 'payment']) {
      expect(names.some((name) => name.includes(durable)), `Redis owns "${durable}"`).toBe(false);
    }
  });
});

describe('when Redis is unavailable', () => {
  it('reports a ping as false rather than throwing', async () => {
    const client = createRateLimitRedis(DEAD_REDIS);
    try {
      // Readiness needs a boolean, not an exception, and must not hang.
      expect(await pingRedis(client, 500)).toBe(false);
    } finally {
      client.disconnect();
    }
  }, 20_000);

  it('makes an enqueue reject instead of returning a fake job id', async () => {
    const connection = createQueueRedis(DEAD_REDIS);
    const queue = new RedisQueueAdapter(connection);
    try {
      // The failure has to surface. Returning `{ jobId: ... }` for work that
      // was never queued is the one outcome that loses the job silently.
      await expect(
        Promise.race([
          queue.enqueue({ name: 'account.export.build', payload: { requestId: 'x' } }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('did not settle')), 8_000)),
        ]),
      ).rejects.toBeTruthy();
    } finally {
      connection.disconnect();
    }
  }, 20_000);
});

describe('rate limiting fails closed, not open', () => {
  let context: TestContext;

  beforeAll(async () => {
    // Rate limiting on, pointed at a Redis that is not there.
    context = await createTestContext({
      RATE_LIMIT_ENABLED: 'true',
      RATE_LIMIT_REDIS: 'true',
      REDIS_URL: DEAD_REDIS,
    });
  }, 60_000);

  afterAll(async () => {
    await context?.close();
  });

  it('refuses the request rather than serving it unlimited', async () => {
    // `@fastify/rate-limit` defaults to `skipOnError: true`, which would let
    // this through and return 200 — the limiter silently absent. The server
    // registers `skipOnError: false` precisely so this is a rejection.
    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'nobody@dashapp.test', password: 'whatever' },
    });

    expect(response.statusCode).not.toBe(200);
    expect(response.statusCode).toBeGreaterThanOrEqual(429);
  }, 30_000);

  it('never discloses that the outage is Redis', async () => {
    const response = await context.app.inject({ method: 'GET', url: '/health/ready' });
    const body = response.body.toLowerCase();

    // Readiness names a dependency by role — `queue` — exactly as it names the
    // database `database` rather than `postgres`. An unauthenticated endpoint
    // that names its infrastructure is free reconnaissance.
    for (const leak of ['redis', 'ioredis', '6390', '127.0.0.1', 'bullmq', 'econnrefused']) {
      expect(body, `leaked "${leak}"`).not.toContain(leak);
    }
  }, 30_000);

  it('reports itself not ready while the queue is down', async () => {
    const response = await context.app.inject({ method: 'GET', url: '/health/ready' });
    const body = response.json<{ ready: boolean; checks: { name: string; status: string }[] }>();

    // An instance that cannot rate-limit must not take traffic, and readiness
    // is how a load balancer is told.
    expect(body.ready).toBe(false);
    expect(response.statusCode).toBe(503);
    expect(body.checks.find((check) => check.name === 'queue')?.status).not.toBe('ok');
  }, 30_000);
});
