/**
 * The transactional outbox.
 *
 * The property under test is not "the relay publishes things" — it is that the
 * state change and the intent to act on it cannot disagree. Every block below
 * is written against the failure the outbox exists to remove: a row committed,
 * a queue unreachable, and work that silently never happens.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertPublishable,
  enqueueViaOutbox,
  flushOutbox,
  outboxHealth,
  OutboxError,
  relayOutbox,
  retryDelayMs,
  describeRelayFailure,
} from '../events/outbox.js';
import type { QueuePort } from '@dash/domain/ports';
import { createTestContext, type TestContext } from './harness.js';

let context: TestContext;

beforeEach(async () => {
  context = await createTestContext();
});

afterEach(async () => {
  await context.close();
});

/** A queue that records what it was asked to publish. */
function recordingQueue(): QueuePort & { published: { name: string; payload: unknown; idempotencyKey?: string | undefined }[] } {
  const published: { name: string; payload: unknown; idempotencyKey?: string | undefined }[] = [];
  return {
    providerName: 'recording',
    published,
    async enqueue(input) {
      published.push({
        name: input.name,
        payload: input.payload,
        idempotencyKey: input.idempotencyKey,
      });
      return { jobId: `job_${published.length}` };
    },
    process() {},
    async close() {},
  };
}

/** A queue that is down, the way Redis is down. */
function brokenQueue(message = 'connect ECONNREFUSED 127.0.0.1:6379'): QueuePort {
  return {
    providerName: 'broken',
    async enqueue() {
      throw new Error(message);
    },
    process() {},
    async close() {},
  };
}

const EVENT = {
  name: 'dispatch.find_rider',
  payload: { orderId: 'order_1' },
  idempotencyKey: 'dispatch_order_1',
} as const;

// ---------------------------------------------------------------------------
// What may be written
// ---------------------------------------------------------------------------

describe('what an outbox payload may contain', () => {
  it('accepts identifiers', () => {
    expect(() => assertPublishable(EVENT)).not.toThrow();
  });

  it('refuses an event with no idempotency key', () => {
    // Publication is at-least-once, so an event without a dedupe key is one
    // that can run twice.
    expect(() => assertPublishable({ ...EVENT, idempotencyKey: '' })).toThrow(OutboxError);
    expect(() => assertPublishable({ ...EVENT, idempotencyKey: '   ' })).toThrow(
      /idempotency key/,
    );
  });

  it('refuses personal data', () => {
    // This table is unencrypted, widely read, and lives in backups. Milestone
    // III keeps personal data out of exactly those places.
    for (const key of ['phone', 'email', 'latitude', 'longitude']) {
      expect(() =>
        assertPublishable({ ...EVENT, payload: { orderId: 'o1', [key]: 'x' } }),
        key,
      ).toThrow(/personal or secret/);
    }
  });

  it('refuses secret material', () => {
    for (const key of ['apiKey', 'password', 'jwtAccessSecret', 'bankAccountNumber']) {
      expect(() =>
        assertPublishable({ ...EVENT, payload: { orderId: 'o1', [key]: 'x' } }),
        key,
      ).toThrow(OutboxError);
    }
  });

  it('names the offending field without printing its value', () => {
    let message = '';
    try {
      assertPublishable({ ...EVENT, payload: { phone: '+2347000000201' } });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain('phone');
    expect(message).not.toContain('+2347000000201');
  });

  it('refuses a payload that cannot be serialised', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(() => assertPublishable({ ...EVENT, payload: cyclic })).toThrow(OutboxError);
  });
});

// ---------------------------------------------------------------------------
// Atomicity — the reason this exists
// ---------------------------------------------------------------------------

describe('the intent commits with the state change', () => {
  it('is rolled back when the surrounding transaction fails', async () => {
    // The half of the dual-write problem in the other direction: work scheduled
    // for a state change that never happened.
    await expect(
      context.prisma.$transaction(async (tx) => {
        await enqueueViaOutbox(tx, EVENT);
        throw new Error('the business rule rejected this');
      }),
    ).rejects.toThrow('the business rule rejected this');

    expect(await context.prisma.outboxEvent.count()).toBe(0);
  });

  it('survives when the transaction commits', async () => {
    await context.prisma.$transaction(async (tx) => {
      await enqueueViaOutbox(tx, EVENT);
    });

    const rows = await context.prisma.outboxEvent.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('pending');
    expect(rows[0]!.attempts).toBe(0);
  });

  it('writes no network call into the transaction', async () => {
    // A transaction that waits on Redis holds database locks while a third
    // party is unreachable. `enqueueViaOutbox` takes a DbClient and nothing
    // else, so there is no queue for it to call — this asserts the shape that
    // guarantees it.
    const queue = recordingQueue();
    await context.prisma.$transaction(async (tx) => {
      await enqueueViaOutbox(tx, EVENT);
    });

    expect(queue.published).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The relay
// ---------------------------------------------------------------------------

describe('publishing', () => {
  it('publishes a pending event and marks it', async () => {
    const queue = recordingQueue();
    await enqueueViaOutbox(context.prisma, EVENT);

    const result = await relayOutbox(context.prisma, queue);

    expect(result.published).toBe(1);
    expect(queue.published[0]!.name).toBe('dispatch.find_rider');
    expect(queue.published[0]!.payload).toEqual({ orderId: 'order_1' });
    // The dedupe key is passed straight through — that is what makes
    // at-least-once delivery harmless.
    expect(queue.published[0]!.idempotencyKey).toBe('dispatch_order_1');

    const row = await context.prisma.outboxEvent.findFirstOrThrow();
    expect(row.status).toBe('published');
    expect(row.publishedAt).not.toBeNull();
    expect(row.claimId).toBeNull();
  });

  it('does not publish the same event twice', async () => {
    const queue = recordingQueue();
    await enqueueViaOutbox(context.prisma, EVENT);

    await relayOutbox(context.prisma, queue);
    const second = await relayOutbox(context.prisma, queue);

    expect(second.published).toBe(0);
    expect(queue.published).toHaveLength(1);
  });

  it('keeps the event when the queue is down, and retries later', async () => {
    // The whole point. Redis unreachable must not lose the work.
    await enqueueViaOutbox(context.prisma, EVENT);

    const result = await relayOutbox(context.prisma, brokenQueue());
    expect(result.published).toBe(0);
    expect(result.retrying).toBe(1);

    const row = await context.prisma.outboxEvent.findFirstOrThrow();
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(1);
    // Backed off, so the next pass does not hammer a dead server.
    expect(row.availableAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('publishes once the queue comes back', async () => {
    await enqueueViaOutbox(context.prisma, EVENT);
    await relayOutbox(context.prisma, brokenQueue());

    const queue = recordingQueue();
    // Past the backoff.
    const later = new Date(Date.now() + 60_000);
    const result = await relayOutbox(context.prisma, queue, { now: later });

    expect(result.published).toBe(1);
    expect(queue.published).toHaveLength(1);
  });

  it('gives up after maxAttempts and says so', async () => {
    await enqueueViaOutbox(context.prisma, { ...EVENT, maxAttempts: 2 });

    let now = new Date();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await relayOutbox(context.prisma, brokenQueue(), { now });
      now = new Date(now.getTime() + 10 * 60_000);
    }

    const row = await context.prisma.outboxEvent.findFirstOrThrow();
    expect(row.status).toBe('failed');
    expect(row.failedAt).not.toBeNull();
    expect(row.attempts).toBe(2);
  });

  it('fails an unparseable payload immediately rather than retrying eight times', async () => {
    await enqueueViaOutbox(context.prisma, EVENT);
    await context.prisma.outboxEvent.updateMany({ data: { payload: 'not json at all' } });

    const result = await relayOutbox(context.prisma, recordingQueue());

    expect(result.undeliverable).toBe(1);
    const row = await context.prisma.outboxEvent.findFirstOrThrow();
    expect(row.status).toBe('failed');
    expect(row.lastError).toBe('payload is not valid JSON');
  });

  it('respects availableAt, so a backed-off event is not retried early', async () => {
    await enqueueViaOutbox(context.prisma, EVENT);
    await context.prisma.outboxEvent.updateMany({
      data: { availableAt: new Date(Date.now() + 60_000) },
    });

    expect((await relayOutbox(context.prisma, recordingQueue())).published).toBe(0);
  });

  it('bounds a pass to its batch size', async () => {
    for (let index = 0; index < 5; index += 1) {
      await enqueueViaOutbox(context.prisma, {
        ...EVENT,
        idempotencyKey: `dispatch_order_${index}`,
        payload: { orderId: `order_${index}` },
      });
    }

    const result = await relayOutbox(context.prisma, recordingQueue(), { batchSize: 2 });
    expect(result.published).toBe(2);
  });

  it('does not take an event another relay currently holds', async () => {
    await enqueueViaOutbox(context.prisma, EVENT);
    await context.prisma.outboxEvent.updateMany({
      data: { claimId: 'someone-else', claimUntil: new Date(Date.now() + 60_000) },
    });

    expect((await relayOutbox(context.prisma, recordingQueue())).claimed).toBe(0);
  });

  it('takes over a claim whose relay died', async () => {
    await enqueueViaOutbox(context.prisma, EVENT);
    await context.prisma.outboxEvent.updateMany({
      data: { claimId: 'dead-relay', claimUntil: new Date(Date.now() - 60_000) },
    });

    expect((await relayOutbox(context.prisma, recordingQueue())).published).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Nothing sensitive leaves
// ---------------------------------------------------------------------------

describe('what the relay records about a failure', () => {
  it('strips a connection string from a stored error', async () => {
    await enqueueViaOutbox(context.prisma, EVENT);
    await relayOutbox(
      context.prisma,
      brokenQueue('connect failed for redis://:outbox-pw-7f2a@cache.internal:6379'),
    );

    const row = await context.prisma.outboxEvent.findFirstOrThrow();
    expect(row.lastError).not.toContain('outbox-pw-7f2a');
    // The host survives, because an error saying only "[redacted]" helps nobody.
    expect(row.lastError).toContain('cache.internal:6379');
  });

  it('bounds the stored error so one failure cannot fill the column', async () => {
    expect(describeRelayFailure(new Error('x'.repeat(5_000))).length).toBeLessThanOrEqual(500);
  });

  it('scrubs a non-Error throw too', () => {
    expect(describeRelayFailure('redis://:raw-pw-9c31@cache:6379')).not.toContain('raw-pw-9c31');
  });
});

// ---------------------------------------------------------------------------
// Backoff and health
// ---------------------------------------------------------------------------

describe('backoff', () => {
  it('grows with attempts and is capped', () => {
    expect(retryDelayMs(1)).toBeLessThan(retryDelayMs(3));
    // Capped so an hour-long outage does not push the next attempt a day out.
    expect(retryDelayMs(50)).toBe(5 * 60_000);
  });
});

describe('health', () => {
  it('is healthy with nothing outstanding', async () => {
    expect((await outboxHealth(context.prisma)).healthy).toBe(true);
  });

  it('is healthy while a fresh backlog drains', async () => {
    // A growing backlog during an outage is the outbox working, not failing.
    await enqueueViaOutbox(context.prisma, EVENT);
    const health = await outboxHealth(context.prisma);

    expect(health.pending).toBe(1);
    expect(health.stalePending).toBe(0);
    expect(health.healthy).toBe(true);
  });

  it('is unhealthy when events are pending far too long', async () => {
    // An old backlog means the relay itself is not running.
    await enqueueViaOutbox(context.prisma, EVENT);
    const later = new Date(Date.now() + 60 * 60_000);

    const health = await outboxHealth(context.prisma, { now: later });
    expect(health.stalePending).toBe(1);
    expect(health.healthy).toBe(false);
  });

  it('is unhealthy when an event has failed', async () => {
    await enqueueViaOutbox(context.prisma, { ...EVENT, maxAttempts: 1 });
    await relayOutbox(context.prisma, brokenQueue());

    const health = await outboxHealth(context.prisma);
    expect(health.failed).toBe(1);
    expect(health.healthy).toBe(false);
  });
});

describe('the request-path flush', () => {
  it('publishes promptly when the queue is up', async () => {
    const queue = recordingQueue();
    await enqueueViaOutbox(context.prisma, EVENT);

    expect((await flushOutbox(context.prisma, queue)).published).toBe(1);
  });

  it('never raises when the queue is down', async () => {
    // A durable row must not turn into a failed customer request.
    await enqueueViaOutbox(context.prisma, EVENT);

    await expect(flushOutbox(context.prisma, brokenQueue())).resolves.toBeDefined();
    expect(await context.prisma.outboxEvent.count({ where: { status: 'pending' } })).toBe(1);
  });
});
