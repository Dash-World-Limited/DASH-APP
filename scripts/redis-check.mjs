/**
 * Redis verification against a real server.
 *
 * **This is the gate that is PENDING.** `apps/api/src/__tests__/redis.test.ts`
 * covers the *unavailable* path — the part a healthy server cannot exercise —
 * and runs in `npm test`. This covers the healthy path, needs a real Redis, and
 * is not part of the suite. Until it has been run and passed, the Redis path is
 * implemented and unverified.
 *
 *   REDIS_CHECK_URL='redis://127.0.0.1:6379' node scripts/redis-check.mjs
 *
 * Uses its own key prefix and deletes what it creates. Point it at a
 * development server anyway.
 *
 * What it proves:
 *   1. Redis answers, and the queue adapter completes a full round trip.
 *   2. `idempotencyKey` genuinely deduplicates — two enqueues, one execution.
 *   3. A delayed job is not delivered early.
 *   4. A failing job is retried up to its attempt limit and then stops.
 *   5. Rate-limit counters are *shared*: two Fastify instances pointed at the
 *      same Redis enforce one budget between them, which is the entire reason
 *      production refuses per-process counters.
 */

import { setTimeout as sleep } from 'node:timers/promises';

const url = process.env.REDIS_CHECK_URL ?? process.env.REDIS_URL;
if (!url) {
  console.error("\n  REDIS_CHECK_URL is required.\n  Example: REDIS_CHECK_URL='redis://127.0.0.1:6379'\n");
  process.exit(2);
}

let passed = 0;
let failed = 0;
const check = (label, condition, detail) => {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}`);
    if (detail !== undefined) console.log(`        ${JSON.stringify(detail).slice(0, 300)}`);
  }
};

const { createQueueRedis, pingRedis } = await import('../apps/api/src/redis/client.ts');
const { RedisQueueAdapter } = await import('../apps/api/src/adapters/redis-queue.ts');

console.log('\nDASH APP — Redis verification\n' + '='.repeat(50));

const prefix = `dashcheck:${Date.now()}`;
const connection = createQueueRedis(url);

console.log('\nConnectivity');
check('Redis answers a ping', await pingRedis(connection, 3_000));

// --- Queue -----------------------------------------------------------------
console.log('\nQueue');
const queue = new RedisQueueAdapter(connection, undefined, prefix);

const seen = [];
queue.process('check.echo', async (job) => {
  seen.push(job.payload.value);
});

await queue.enqueue({ name: 'check.echo', payload: { value: 'first' } });
await sleep(1_500);
check('a job round-trips through Redis to its worker', seen.includes('first'), seen);

// Idempotency: the same key twice must run once.
const key = `dedupe-${Date.now()}`;
await queue.enqueue({ name: 'check.echo', payload: { value: 'dedupe' }, idempotencyKey: key });
await queue.enqueue({ name: 'check.echo', payload: { value: 'dedupe' }, idempotencyKey: key });
await sleep(1_500);
check(
  'the same idempotency key runs the job exactly once',
  seen.filter((value) => value === 'dedupe').length === 1,
  seen,
);

// Delay: a delayed job must not arrive early.
await queue.enqueue({ name: 'check.echo', payload: { value: 'delayed' }, delayMs: 3_000 });
await sleep(1_000);
check('a delayed job has not run early', !seen.includes('delayed'), seen);
await sleep(3_500);
check('a delayed job runs once its delay elapses', seen.includes('delayed'), seen);

// Retries: a failing job is retried to its limit, then stops.
let attempts = 0;
queue.process('check.fail', async () => {
  attempts += 1;
  throw new Error('deliberate failure');
});
await queue.enqueue({ name: 'check.fail', payload: {}, maxAttempts: 2 });
await sleep(4_000);
check('a failing job is retried up to its attempt limit', attempts === 2, { attempts });

await queue.close();

// --- Shared rate limiting --------------------------------------------------
console.log('\nShared rate limiting');
const { createTestContext } = await import('../apps/api/src/__tests__/harness.ts');

// Two independent Fastify instances, one Redis. A per-process limiter would
// give each its own budget and let twice as many requests through.
const shared = { RATE_LIMIT_ENABLED: 'true', RATE_LIMIT_REDIS: 'true', REDIS_URL: url };
const one = await createTestContext(shared);
const two = await createTestContext(shared);

const login = (context) =>
  context.app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email: 'nobody@dashapp.test', password: 'wrong' },
    // Same key on both instances, so the limiter sees one caller.
    headers: { 'x-forwarded-for': '198.51.100.77' },
  });

let limited = false;
for (let attempt = 0; attempt < 24 && !limited; attempt += 1) {
  const response = await (attempt % 2 === 0 ? login(one) : login(two));
  if (response.statusCode === 429) limited = true;
}
check('two instances share one rate-limit budget through Redis', limited);

await one.close();
await two.close();

// --- Cleanup ---------------------------------------------------------------
const cleanup = createQueueRedis(url);
const keys = await cleanup.keys(`${prefix}*`);
if (keys.length > 0) await cleanup.del(...keys);
check('the check cleaned up its own keys', (await cleanup.keys(`${prefix}*`)).length === 0);
await cleanup.quit();

console.log('\n' + '='.repeat(50));
console.log(`  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
