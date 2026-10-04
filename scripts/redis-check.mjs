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
 *   6. A realtime notification published by one instance reaches *another*
 *      instance's hub. This is the property the in-process adapter cannot
 *      provide and the entire reason `RealtimeBroadcastPort` exists — a
 *      single-instance developer machine cannot tell the two apart, and a
 *      production deployment loses most updates if it is wrong.
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

// --- Realtime fan-out ------------------------------------------------------
//
// The one thing an in-process adapter can never do: reach a socket that is
// being served by a different process. Two adapters here stand in for two API
// instances, exactly as the two Fastify instances above stand in for two rate
// limiters.
console.log('\nRealtime fan-out');
const { RedisBroadcastAdapter, channelFor } = await import('../apps/api/src/realtime/broadcast.ts');
const { createBroadcastRedis } = await import('../apps/api/src/redis/client.ts');
const { RealtimeHub, Connection } = await import('../apps/api/src/realtime/hub.ts');
const { parseNotification } = await import('../packages/domain/src/realtime/index.ts');

const rtPrefix = `${prefix}:rt`;

/** One "instance": a broadcast adapter feeding its own hub. */
const buildInstance = () => {
  const adapter = new RedisBroadcastAdapter(
    createBroadcastRedis(url),
    createBroadcastRedis(url),
    undefined,
    rtPrefix,
  );
  const hub = new RealtimeHub();
  const delivered = [];

  adapter.subscribe((raw) => {
    // Validated before it is believed, exactly as the server does. A shared
    // Redis is a trust boundary, not an internal channel.
    try {
      delivered.push(parseNotification(raw));
    } catch {
      delivered.push('rejected');
    }
  });

  return { adapter, hub, delivered };
};

const alpha = buildInstance();
const beta = buildInstance();
// A third on a different prefix, standing in for staging sharing this Redis.
const otherDeployment = (() => {
  const adapter = new RedisBroadcastAdapter(
    createBroadcastRedis(url),
    createBroadcastRedis(url),
    undefined,
    `${prefix}:other`,
  );
  const delivered = [];
  adapter.subscribe(() => delivered.push('received'));
  return { adapter, delivered };
})();

// Give the SUBSCRIBE commands time to land before anything is published.
await sleep(1_000);

const notification = {
  eventId: 'order:check@1',
  subject: 'order:check',
  topics: ['order:check'],
  version: 1,
  occurredAt: Date.now(),
};

await alpha.adapter.publish(notification);
await sleep(1_000);

check(
  'a notification published by one instance reaches another instance',
  beta.delivered.some((entry) => entry !== 'rejected' && entry.eventId === notification.eventId),
  beta.delivered,
);
check(
  'the publishing instance serves its own sockets too',
  alpha.delivered.some((entry) => entry !== 'rejected' && entry.eventId === notification.eventId),
  alpha.delivered,
);
check(
  'a deployment on a different prefix receives nothing',
  otherDeployment.delivered.length === 0,
  otherDeployment.delivered,
);
check('the channel is namespaced by prefix', channelFor(rtPrefix) === `${rtPrefix}:realtime`);

// A socket on the second instance receives the frame the notification became.
const frames = [];
const socket = {
  bufferedAmount: 0,
  send: (data) => frames.push(JSON.parse(data)),
  close: () => undefined,
};
const watcher = new Connection('check-1', socket, Date.now());
// Authorisation is not under test here — the hub's own suite covers it. What
// is under test is that the notification crossed a process boundary and became
// a frame on the far side.
watcher.actor = { identityId: 'check', sessionId: 'check', roles: [], permissions: new Set() };
watcher.authorityExpiresAt = Date.now() + 60_000;
beta.hub.add(watcher);
beta.hub.subscribe(watcher, 'order:check');

const second = { ...notification, eventId: 'order:check@2', version: 2 };
let deliveredToSocket = false;
beta.adapter.subscribe((raw) => {
  try {
    if (beta.hub.publish(parseNotification(raw)) > 0) deliveredToSocket = true;
  } catch {
    // Counted by the rejection check above.
  }
});
await alpha.adapter.publish(second);
await sleep(1_000);

check(
  'a notification from another instance becomes a frame on a local socket',
  deliveredToSocket && frames.some((frame) => frame.eventId === second.eventId),
  frames,
);

// Anything at all can be published to a Redis channel by anything holding the
// credentials. It must not become a frame.
const rawPublisher = createBroadcastRedis(url);
await rawPublisher.publish(channelFor(rtPrefix), 'not json at all');
await rawPublisher.publish(
  channelFor(rtPrefix),
  JSON.stringify({ eventId: 'x', subject: 'order:x', topics: ['order:*'], version: 1, occurredAt: 1 }),
);
await sleep(1_000);
check(
  'malformed and crafted broadcasts are rejected, not delivered',
  beta.delivered.filter((entry) => entry === 'rejected').length >= 1 &&
    !frames.some((frame) => frame.subject === 'order:x'),
  { rejected: beta.delivered.filter((entry) => entry === 'rejected').length },
);
await rawPublisher.quit();

await alpha.adapter.close();
await beta.adapter.close();
await otherDeployment.adapter.close();

// --- Cleanup ---------------------------------------------------------------
const cleanup = createQueueRedis(url);
const keys = await cleanup.keys(`${prefix}*`);
if (keys.length > 0) await cleanup.del(...keys);
check('the check cleaned up its own keys', (await cleanup.keys(`${prefix}*`)).length === 0);
await cleanup.quit();

console.log('\n' + '='.repeat(50));
console.log(`  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
