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
import type { Queue } from 'bullmq';
import { createTestContext, type TestContext } from './harness.js';
import { loadConfig, resetConfigCache } from '../config.js';
import { buildServices } from '../server.js';
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

  it('makes realtime fan-out degradable rather than retryable', () => {
    // The distinction is the whole reason the register exists. A dropped
    // notification costs freshness — the client polls the same authorized route
    // it always did — while a dropped queue job costs work that nothing will
    // ever redo. Classifying this one as retryable would put realtime on the
    // critical path of a request it has no business blocking.
    const realtime = REDIS_RESPONSIBILITIES.find((r) => r.name === 'realtime_fanout');
    expect(realtime).toBeDefined();
    expect(realtime!.failureMode).toBe('degradable');
    expect(realtime!.correctnessCritical).toBe(false);
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

describe('queue namespace isolation', () => {
  it('hands the configured prefix to BullMQ', async () => {
    const connection = createQueueRedis(DEAD_REDIS);
    const adapter = new RedisQueueAdapter(connection, undefined, 'dash-declutters');
    try {
      // `queueFor` is private; the cast reads the BullMQ Queue the adapter
      // actually builds, so this asserts the wiring rather than the field.
      const queue = (
        adapter as unknown as { queueFor(name: string): Queue }
      ).queueFor('dispatch.offer');
      expect(queue.opts.prefix).toBe('dash-declutters');
    } finally {
      // Teardown is the connection only, deliberately not `adapter.close()`:
      // closing a BullMQ Queue that never connected (this Redis is dead on
      // purpose) rejects a promise nobody awaits — BullMQ's `Queue.close()`
      // races its own still-pending `waitUntilReady` — and Vitest reports
      // it as an unhandled rejection. Nothing was enqueued or processed
      // here, so there is no worker or job to drain; disconnecting the
      // client stops the retry loop. Production `close()` runs after
      // successful use, so this is a property of the dead-Redis probe, not
      // of the shutdown path.
      connection.disconnect();
    }
  }, 20_000);

  it('builds the server queue on the declutters prefix', () => {
    resetConfigCache();
    try {
      const config = loadConfig({
        NODE_ENV: 'test',
        DATABASE_URL: 'file:./unused.db',
        JWT_ACCESS_SECRET: 'gJ7xQ2mV9wL4pR8sT1uY6zA3bC5dE0fH-access-KnMqPrSt',
        JWT_REFRESH_SECRET: 'Zx4Vn8Bq2Wr6Ty0Ui3Op5As7Df9Gh1Jk-refresh-LmNoPqRs',
        DEPLOYMENT_PROFILE: 'declutters',
        QUEUE_PROVIDER: 'redis',
        REDIS_URL: DEAD_REDIS,
        LOG_LEVEL: 'silent',
        // No encryption key in this minimal config, so MFA must be off with it.
        MFA_ENABLED: 'false',
      });
      const services = buildServices(config);
      expect(services.queue).toBeInstanceOf(RedisQueueAdapter);
      expect((services.queue as RedisQueueAdapter).prefix).toBe('dash-declutters');
    } finally {
      resetConfigCache();
    }
  });

  it('builds the server queue on the full prefix', () => {
    resetConfigCache();
    try {
      const config = loadConfig({
        NODE_ENV: 'test',
        DATABASE_URL: 'file:./unused.db',
        JWT_ACCESS_SECRET: 'gJ7xQ2mV9wL4pR8sT1uY6zA3bC5dE0fH-access-KnMqPrSt',
        JWT_REFRESH_SECRET: 'Zx4Vn8Bq2Wr6Ty0Ui3Op5As7Df9Gh1Jk-refresh-LmNoPqRs',
        DEPLOYMENT_PROFILE: 'full',
        QUEUE_PROVIDER: 'redis',
        REDIS_URL: DEAD_REDIS,
        LOG_LEVEL: 'silent',
        MFA_ENABLED: 'false',
      });
      const services = buildServices(config);
      expect(services.queue).toBeInstanceOf(RedisQueueAdapter);
      expect((services.queue as RedisQueueAdapter).prefix).toBe('dash-full');
    } finally {
      resetConfigCache();
    }
  });
});

describe('queue shutdown against dead Redis', () => {
  it('close() resolves instead of throwing when Redis never answered', async () => {
    // Regression pin for the N-4 shutdown investigation (BullMQ 5.81.5):
    // closing a Queue whose connection handshake is still pending leaves
    // one unhandled rejection, `Error: Connection is closed.`, from inside
    // BullMQ — but close() itself resolves, so the caller is unaffected
    // and no job is lost (nothing was enqueued). The test collects any
    // floating rejections only to name them: the contract pinned here is
    // that close() resolves, not that BullMQ's internal handshake promise
    // is silent. Do NOT "fix" this by awaiting the handshake in close():
    // on a retrying or blackholed connection that await has no bound, and
    // a shutdown that hangs is worse than a warning on a path production
    // only reaches when it never connected at all.
    const seen: unknown[] = [];
    const collector = (reason: unknown): void => {
      seen.push(reason);
    };
    process.on('unhandledRejection', collector);
    try {
      const connection = createQueueRedis(DEAD_REDIS);
      const adapter = new RedisQueueAdapter(connection);
      (adapter as unknown as { queueFor(name: string): Queue }).queueFor('probe.job');
      await expect(adapter.close()).resolves.toBeUndefined();
      // Give any floating promise a chance to surface.
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      for (const reason of seen) {
        expect(reason instanceof Error ? reason.message : String(reason)).toBe(
          'Connection is closed.',
        );
      }
      connection.disconnect();
    } finally {
      process.removeListener('unhandledRejection', collector);
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
