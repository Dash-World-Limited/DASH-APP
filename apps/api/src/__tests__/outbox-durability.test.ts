/**
 * The milestone's headline claim, end to end.
 *
 * Before the outbox, a vendor accepting an order was a dual write: the order
 * row committed, then `queue.enqueue` was a separate network call. When Redis
 * was unreachable in that gap the request failed *after* the order had already
 * been accepted — or, worse, the enqueue was fire-and-forget and the order sat
 * accepted for ever with no rider dispatched and nothing recording that one was
 * supposed to be.
 *
 * These tests drive the real endpoints through a queue that is down, and assert
 * the two things that must both hold:
 *
 *   1. the customer-facing request still succeeds, because the intent is
 *      durable and the work is not lost; and
 *   2. the work is actually performed once the queue returns.
 *
 * A test that only checked the first would be satisfied by a system that
 * swallowed the job entirely, which is precisely the bug.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { QueuePort } from '@dash/domain/ports';
import { relayOutbox } from '../events/outbox.js';
import { createTestContext, type TestContext } from './harness.js';
import { actAs, buildWorld, idempotencyKey, type Actor, type World } from './world.js';

/** A queue that is down for as long as `broken` is true, and records otherwise. */
class FlakyQueue implements QueuePort {
  readonly providerName = 'flaky';
  broken = false;
  readonly published: { name: string; idempotencyKey?: string | undefined }[] = [];

  async enqueue(input: {
    name: string;
    payload: unknown;
    idempotencyKey?: string | undefined;
  }): Promise<{ jobId: string }> {
    if (this.broken) throw new Error('connect ECONNREFUSED 127.0.0.1:6379');
    this.published.push({ name: input.name, idempotencyKey: input.idempotencyKey });
    return { jobId: `job_${this.published.length}` };
  }

  process(): void {}
  async close(): Promise<void> {}
}

let context: TestContext;
let world: World;
let customerA: Actor;
let vendorA: Actor;
const queue = new FlakyQueue();

beforeAll(async () => {
  context = await createTestContext({}, { queue });
  world = await buildWorld(context.prisma);
  customerA = await actAs(context, world.customerA.email);
  vendorA = await actAs(context, world.vendorA.ownerEmail);
}, 180_000);

afterAll(async () => {
  await context?.close();
});

async function placeOrder(): Promise<{ id: string }> {
  const response = await context.app.inject({
    method: 'POST',
    url: '/v1/orders',
    headers: { ...customerA.headers, 'idempotency-key': idempotencyKey('durability') },
    payload: {
      branchId: world.vendorA.branchId,
      items: [{ itemId: world.vendorA.itemId, quantity: 1, modifierIds: [world.vendorA.modifierId] }],
      mode: 'delivery',
      addressId: world.customerA.addressId,
      paymentMethod: 'card',
    },
  });
  if (response.statusCode !== 200) {
    throw new Error(`placeOrder failed: ${response.statusCode} ${response.body}`);
  }
  return response.json<{ order: { id: string } }>().order;
}

/**
 * Take an order to `accepted` with the queue healthy.
 *
 * Dispatch is triggered by the move into `preparing`, not by accepting, so a
 * durability test about the dispatch job has to get the order to the point
 * where that transition is legal before it breaks the queue.
 */
async function acceptedOrder(): Promise<{ id: string }> {
  const order = await placeOrder();
  const accepted = await context.app.inject({
    method: 'POST',
    url: `/v1/vendor/orders/${order.id}/accept`,
    headers: vendorA.headers,
    payload: { prepMinutes: 20 },
  });
  if (accepted.statusCode !== 200) {
    throw new Error(`accept failed: ${accepted.statusCode} ${accepted.body}`);
  }
  return order;
}

describe('an order being prepared survives a queue outage', () => {
  it('starts preparing, records the dispatch intent, and dispatches once Redis returns', async () => {
    const order = await acceptedOrder();

    // --- Redis goes down ----------------------------------------------------
    queue.broken = true;
    const published = queue.published.length;

    const response = await context.app.inject({
      method: 'POST',
      url: `/v1/vendor/orders/${order.id}/progress`,
      headers: vendorA.headers,
      payload: { to: 'preparing' },
    });

    // 1. The vendor's request succeeds. The old dual write would have thrown
    //    here, after the order had already been accepted.
    expect(response.statusCode).toBe(200);
    expect(
      (await context.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status,
    ).toBe('preparing');

    // Nothing reached the queue, and the intent is durable instead.
    expect(queue.published.length).toBe(published);
    const pending = await context.prisma.outboxEvent.findMany({
      where: { status: 'pending', name: 'dispatch.find_rider' },
    });
    expect(pending.length).toBeGreaterThan(0);
    expect(pending.some((event) => event.payload.includes(order.id))).toBe(true);

    // --- Redis comes back ---------------------------------------------------
    queue.broken = false;
    // Past the relay's backoff from the failed in-request flush.
    const later = new Date(Date.now() + 10 * 60_000);
    const result = await relayOutbox(context.prisma, queue, { now: later });

    // 2. The work actually happens.
    expect(result.published).toBeGreaterThan(0);
    // `_accepted` because the key is scoped to the transition that asked for
    // the dispatch, not just the order: checkout asks once and the vendor's
    // accept asks again, and the queue has to be able to tell them apart or it
    // discards the second as a redelivery of the first. See dispatch.test.ts.
    expect(queue.published.some((job) => job.idempotencyKey === `dispatch_${order.id}_preparing`)).toBe(true);

    const settled = await context.prisma.outboxEvent.findFirstOrThrow({
      where: { idempotencyKey: `dispatch_${order.id}_preparing` },
    });
    expect(settled.status).toBe('published');
  });

  it('queues the refund a rejected customer is owed, even with the queue down', async () => {
    // The worst of the dual-write failures: the customer is charged, the order
    // is dead, and nothing remembers that money has to go back.
    const order = await placeOrder();
    queue.broken = true;

    const response = await context.app.inject({
      method: 'POST',
      url: `/v1/vendor/orders/${order.id}/reject`,
      headers: vendorA.headers,
      payload: { reasonCode: 'out_of_stock' },
    });
    expect(response.statusCode).toBe(200);

    const refund = await context.prisma.outboxEvent.findFirstOrThrow({
      where: { idempotencyKey: `refund_${order.id}` },
    });
    expect(refund.status).toBe('pending');
    expect(refund.name).toBe('refund.full');

    queue.broken = false;
    const later = new Date(Date.now() + 10 * 60_000);
    await relayOutbox(context.prisma, queue, { now: later });

    expect(queue.published.some((job) => job.idempotencyKey === `refund_${order.id}`)).toBe(true);
  });

  it('publishes in the request when the queue is healthy, so latency is unchanged', async () => {
    // The outbox must not turn every dispatch into a wait for the next
    // scheduled relay. With Redis up, the flush publishes inline.
    const order = await acceptedOrder();
    queue.broken = false;

    await context.app.inject({
      method: 'POST',
      url: `/v1/vendor/orders/${order.id}/progress`,
      headers: vendorA.headers,
      payload: { to: 'preparing' },
    });

    expect(queue.published.some((job) => job.idempotencyKey === `dispatch_${order.id}_preparing`)).toBe(true);
    const event = await context.prisma.outboxEvent.findFirstOrThrow({
      where: { idempotencyKey: `dispatch_${order.id}_preparing` },
    });
    expect(event.status).toBe('published');
  });

  it('stores no personal data in the events it wrote', async () => {
    // Every payload written by a real endpoint, checked against the customer's
    // actual contact details rather than an invented string.
    const events = await context.prisma.outboxEvent.findMany({ select: { payload: true } });
    expect(events.length).toBeGreaterThan(0);

    const rendered = events.map((event) => event.payload).join('\n');
    expect(rendered).not.toContain(world.customerA.email);
    expect(rendered).not.toContain(world.customerA.phone);
  });
});
