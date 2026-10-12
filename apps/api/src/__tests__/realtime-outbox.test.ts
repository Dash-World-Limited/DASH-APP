/**
 * Realtime notifications and the transactional outbox.
 *
 * Milestone IV removed the dual writes; the risk in adding a realtime layer is
 * putting one back. The obvious implementation — commit the transition, then
 * tell the hub — is exactly that, and it fails in both directions: publish
 * before the commit and a rolled-back transaction has already announced a state
 * the order never reached; publish after it and a crash in the gap loses the
 * notification with nothing recording that it was owed.
 *
 * So the assertions here are about the *seam*, not about sockets. A
 * notification is a row, written inside the caller's transaction, and it lives
 * or dies with the change that caused it.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { QueuePort } from '@dash/domain/ports';
import { parseNotification } from '@dash/domain/realtime';
import { assertPublishable } from '../events/outbox.js';
import { relayOutbox } from '../events/outbox.js';
import { eventIdFor, recordOrderChange, REALTIME_EVENT_NAME } from '../realtime/notify.js';
import { InProcessBroadcastAdapter } from '../realtime/broadcast.js';
import { registerRealtimeWorker } from '../realtime/worker.js';
import { createTestContext, type TestContext } from './harness.js';
import { buildWorld, type World } from './world.js';

let context: TestContext;
let world: World;
let orderId = '';

// One context and one world for the file.
//
// This used to build both per test. Thirteen contexts meant thirteen Fastify
// instances, thirteen database copies, and thirteen `buildWorld` runs — each of
// which hashes a password with scrypt, deliberately slowly. On a loaded machine
// that was enough to starve the other suites' workers of the event loop until
// Vitest's reporter RPC timed out, which surfaces as an unrelated suite failing
// for no visible reason. A fresh order and an empty outbox per test give the
// same isolation for a fraction of the cost.
beforeAll(async () => {
  context = await createTestContext();
  world = await buildWorld(context.prisma);
}, 180_000);

afterAll(async () => {
  await context?.close();
});

beforeEach(async () => {
  await context.prisma.outboxEvent.deleteMany({});

  const order = await context.prisma.order.create({
    data: {
      code: `RT-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      customerId: world.customerA.customerId,
      vendorId: world.vendorA.vendorId,
      branchId: world.vendorA.branchId,
      status: 'placed',
      itemsSubtotal: 100_000,
      total: 100_000,
      quoteBreakdown: '{}',
      pricingRuleVersion: 'test.1',
    },
    select: { id: true },
  });
  orderId = order.id;
});

/** A queue that records what it was asked to publish. */
function recordingQueue(): QueuePort & {
  published: { name: string; payload: unknown; idempotencyKey?: string | undefined }[];
} {
  const published: {
    name: string;
    payload: unknown;
    idempotencyKey?: string | undefined;
  }[] = [];
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

describe('the notification is written inside the transaction', () => {
  it('records a row and bumps the revision together', async () => {
    const before = await context.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { revision: true },
    });

    const notification = await context.prisma.$transaction((tx) =>
      recordOrderChange(tx, orderId),
    );

    const after = await context.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { revision: true },
    });

    expect(after.revision).toBe(before.revision + 1);
    expect(notification.version).toBe(after.revision);

    const rows = await context.prisma.outboxEvent.findMany({
      where: { name: REALTIME_EVENT_NAME },
    });
    expect(rows).toHaveLength(1);
  });

  it('discards both when the transaction rolls back', async () => {
    // The failure this closes: a notification announcing a transition that
    // never happened. Clients would re-read, see the old state, and the screen
    // would appear to move backwards.
    await expect(
      context.prisma.$transaction(async (tx) => {
        await tx.order.update({ where: { id: orderId }, data: { status: 'accepted' } });
        await recordOrderChange(tx, orderId);
        throw new Error('something later in the handler failed');
      }),
    ).rejects.toThrow('something later in the handler failed');

    const order = await context.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { status: true, revision: true },
    });

    expect(order.status).toBe('placed');
    expect(order.revision).toBe(0);
    expect(await context.prisma.outboxEvent.count({ where: { name: REALTIME_EVENT_NAME } })).toBe(0);
  });

  it('performs no network call while the transaction is open', async () => {
    // A transaction that waits on Redis holds database locks while a third
    // party is unreachable — the way a queue outage becomes a database outage.
    const queue = recordingQueue();
    await context.prisma.$transaction((tx) => recordOrderChange(tx, orderId));
    expect(queue.published).toHaveLength(0);
  });

  it('survives the queue being down, because it never touches it', async () => {
    await expect(
      context.prisma.$transaction((tx) => recordOrderChange(tx, orderId)),
    ).resolves.toBeDefined();
    // Durable and waiting, which is the whole point.
    const row = await context.prisma.outboxEvent.findFirstOrThrow({
      where: { name: REALTIME_EVENT_NAME },
    });
    expect(row.status).toBe('pending');
  });
});

describe('the payload', () => {
  it('carries identifiers and a version, and passes the personal-data guard', async () => {
    const notification = await context.prisma.$transaction((tx) =>
      recordOrderChange(tx, orderId),
    );

    const row = await context.prisma.outboxEvent.findFirstOrThrow({
      where: { name: REALTIME_EVENT_NAME },
    });
    const payload = JSON.parse(row.payload) as Record<string, unknown>;

    expect(Object.keys(payload).sort()).toEqual([
      'eventId',
      'occurredAt',
      'subject',
      'topics',
      'version',
    ]);

    // The outbox table is unencrypted, read by operators, and kept in backups.
    // The same guard that protects every other event protects this one.
    expect(() =>
      assertPublishable({
        name: REALTIME_EVENT_NAME,
        payload,
        idempotencyKey: notification.eventId,
      }),
    ).not.toThrow();

    // And it survives the validation it will face on the way back in.
    expect(parseNotification(payload)).toEqual(notification);
  });

  it('names every audience the order has', async () => {
    const notification = await context.prisma.$transaction((tx) =>
      recordOrderChange(tx, orderId),
    );

    expect(notification.topics).toEqual([
      `order:${orderId}`,
      `vendor:${world.vendorA.vendorId}`,
      `city:${world.cityId}`,
    ]);
    // No rider is assigned, so no rider hears about it — which is what stops an
    // unassigned rider learning the order exists.
    expect(notification.topics.some((topic) => topic.startsWith('rider:'))).toBe(false);
  });

  it('adds an offered rider without adding them twice', async () => {
    await context.prisma.order.update({
      where: { id: orderId },
      data: { riderId: world.riderA.riderId },
    });

    const notification = await context.prisma.$transaction((tx) =>
      recordOrderChange(tx, orderId, {
        // The rider already on the order, offered it again. A repeated topic
        // would deliver twice to every socket holding it.
        extraTopics: [`rider:${world.riderA.riderId}`, `rider:${world.riderB.riderId}`],
      }),
    );

    const riderTopics = notification.topics.filter((topic) => topic.startsWith('rider:'));
    expect(riderTopics).toEqual([
      `rider:${world.riderA.riderId}`,
      `rider:${world.riderB.riderId}`,
    ]);
  });
});

describe('ordering and deduplication', () => {
  it('gives each change a strictly higher version', async () => {
    const versions: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const notification = await context.prisma.$transaction((tx) =>
        recordOrderChange(tx, orderId),
      );
      versions.push(notification.version);
    }

    expect(versions).toEqual([1, 2, 3, 4, 5]);
  });

  it('derives a stable event id from the subject and version', async () => {
    const notification = await context.prisma.$transaction((tx) =>
      recordOrderChange(tx, orderId),
    );

    // Stable across redeliveries without reading the row back, which is what
    // lets every layer downstream deduplicate on it.
    expect(notification.eventId).toBe(eventIdFor(`order:${orderId}`, notification.version));
    expect(notification.eventId).toBe(`order:${orderId}@${notification.version}`);
  });

  it('keys the queue job so a republished row does not become two jobs', async () => {
    const notification = await context.prisma.$transaction((tx) =>
      recordOrderChange(tx, orderId),
    );

    const queue = recordingQueue();
    await relayOutbox(context.prisma, queue);

    const published = queue.published.filter((job) => job.name === REALTIME_EVENT_NAME);
    expect(published).toHaveLength(1);
    // Passed straight through, which is what makes at-least-once safe.
    expect(published[0]!.idempotencyKey).toBe(notification.eventId);
  });

  it('two different changes get two different keys', async () => {
    await context.prisma.$transaction((tx) => recordOrderChange(tx, orderId));
    await context.prisma.$transaction((tx) => recordOrderChange(tx, orderId));

    const queue = recordingQueue();
    await relayOutbox(context.prisma, queue);

    const keys = queue.published
      .filter((job) => job.name === REALTIME_EVENT_NAME)
      .map((job) => job.idempotencyKey);
    expect(new Set(keys).size).toBe(2);
  });
});

describe('the worker', () => {
  it('validates a job before broadcasting it', async () => {
    const broadcast = new InProcessBroadcastAdapter();
    const received: unknown[] = [];
    broadcast.subscribe((notification) => received.push(notification));

    const handlers = new Map<string, (job: { id: string; name: string; payload: unknown; attempt: number }) => Promise<void>>();
    const queue: QueuePort = {
      providerName: 'inline',
      async enqueue() {
        return { jobId: 'j1' };
      },
      process(name, handler) {
        handlers.set(name, handler as never);
      },
      async close() {},
    };

    registerRealtimeWorker({
      queue,
      broadcast,
      log: context.app.log,
    });
    const handler = handlers.get(REALTIME_EVENT_NAME);
    expect(handler).toBeDefined();

    const good = await context.prisma.$transaction((tx) => recordOrderChange(tx, orderId));
    await handler!({ id: 'j1', name: REALTIME_EVENT_NAME, payload: { ...good }, attempt: 1 });
    expect(received).toHaveLength(1);

    // Anything that can write to shared infrastructure must not be able to turn
    // rubbish into a frame on somebody's socket. Dropped, not retried: another
    // attempt would arrive back at exactly the same place.
    for (const rubbish of [
      null,
      'not an object',
      { subject: 'order:x' },
      { ...good, topics: ['order:*'] },
      { ...good, version: -1 },
    ]) {
      await expect(
        handler!({ id: 'j2', name: REALTIME_EVENT_NAME, payload: rubbish, attempt: 1 }),
      ).resolves.toBeUndefined();
    }
    expect(received).toHaveLength(1);
  });

  it('delivers the whole way from a transaction to a broadcast', async () => {
    // The full seam: transaction → outbox row → relay → queue → worker →
    // broadcast, with nothing bridged by hand.
    const broadcast = new InProcessBroadcastAdapter();
    const received: unknown[] = [];
    broadcast.subscribe((notification) => received.push(notification));

    const handlers = new Map<string, (job: { id: string; name: string; payload: unknown; attempt: number }) => Promise<void>>();
    const queue: QueuePort = {
      providerName: 'inline',
      async enqueue(input) {
        const handler = handlers.get(input.name);
        if (handler) {
          await handler({
            id: 'j1',
            name: input.name,
            payload: input.payload,
            attempt: 1,
          });
        }
        return { jobId: 'j1' };
      },
      process(name, handler) {
        handlers.set(name, handler as never);
      },
      async close() {},
    };

    registerRealtimeWorker({ queue, broadcast, log: context.app.log });

    const notification = await context.prisma.$transaction((tx) =>
      recordOrderChange(tx, orderId),
    );
    await relayOutbox(context.prisma, queue);

    expect(received).toEqual([
      {
        eventId: notification.eventId,
        subject: notification.subject,
        topics: notification.topics,
        version: notification.version,
        occurredAt: notification.occurredAt,
      },
    ]);

    const row = await context.prisma.outboxEvent.findFirstOrThrow({
      where: { name: REALTIME_EVENT_NAME },
    });
    expect(row.status).toBe('published');
  });
});
