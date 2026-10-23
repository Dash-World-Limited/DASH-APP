/**
 * An explicit decline moves the order to the next rider at once.
 *
 * Staging: Rider A declined an offer and Rider B never saw the order, while
 * letting the offer time out did reach Rider B. The decline closed A's offer
 * and asked dispatch for nothing; only the round's expiry sweep, scheduled for
 * the end of the window A had just refused, ever moved the order on.
 *
 * The queue here records instead of running and deduplicates keys the way the
 * memory queue and BullMQ do, so each test can say exactly which dispatch jobs
 * a decline or a sweep asked for, run them, and show nothing extra was asked.
 * The last test uses the real in-memory queue and outbox relay end to end.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { QueueJob, QueuePort } from '@dash/domain/ports';
import type { FindRiderJob } from '../workers/dispatch.js';
import { createTestContext, type TestContext } from './harness.js';
import { actAs, buildWorld, idempotencyKey, type Actor, type World } from './world.js';
import { useIntegrationTimeouts } from './timeouts.js';

useIntegrationTimeouts();

interface Enqueued {
  name: string;
  payload: FindRiderJob;
  idempotencyKey?: string | undefined;
}

class RecordingQueue implements QueuePort {
  readonly providerName = 'recording';
  readonly jobs: Enqueued[] = [];
  /** Enqueues refused because the key was already held. */
  readonly deduped: string[] = [];
  readonly handlers = new Map<string, (job: QueueJob<never>) => Promise<void>>();
  private readonly seen = new Set<string>();

  async enqueue<T>(input: { name: string; payload: T; idempotencyKey?: string | undefined }): Promise<{ jobId: string }> {
    if (input.idempotencyKey) {
      if (this.seen.has(input.idempotencyKey)) {
        this.deduped.push(input.idempotencyKey);
        return { jobId: input.idempotencyKey };
      }
      this.seen.add(input.idempotencyKey);
    }
    this.jobs.push({ name: input.name, payload: input.payload as FindRiderJob, idempotencyKey: input.idempotencyKey });
    return { jobId: String(this.jobs.length) };
  }

  process<T>(name: string, handler: (job: QueueJob<T>) => Promise<void>): void {
    this.handlers.set(name, handler as (job: QueueJob<never>) => Promise<void>);
  }

  async close(): Promise<void> {}

  async run(job: Pick<Enqueued, 'name' | 'payload'>): Promise<void> {
    const handler = this.handlers.get(job.name);
    if (!handler) throw new Error(`no handler for ${job.name}`);
    await handler({ id: 'manual', name: job.name, payload: job.payload as never, attempt: 1 });
  }

  since(mark: number, name: string, orderId: string): Enqueued[] {
    return this.jobs.slice(mark).filter((job) => job.name === name && job.payload.orderId === orderId);
  }
}

let context: TestContext;
let world: World;
let customerA: Actor;
let vendorA: Actor;
let riderA: Actor;
let riderB: Actor;
const queue = new RecordingQueue();

beforeAll(async () => {
  context = await createTestContext({}, { queue });
  world = await buildWorld(context.prisma);
  customerA = await actAs(context, world.customerA.email);
  vendorA = await actAs(context, world.vendorA.ownerEmail);
  riderA = await actAs(context, world.riderA.email);
  riderB = await actAs(context, world.riderB.email);
}, 180_000);

beforeEach(async () => {
  await context.prisma.order.updateMany({
    where: { riderId: { in: [world.riderA.riderId, world.riderB.riderId] }, status: { notIn: ['delivered', 'cancelled'] } },
    data: { status: 'cancelled' },
  });
  await context.prisma.rider.updateMany({
    where: { id: { in: [world.riderA.riderId, world.riderB.riderId] } },
    data: {
      availability: 'idle',
      lastLatitude: 6.5,
      lastLongitude: 3.4,
      locationReportedAt: new Date(),
      onlineUntil: new Date(Date.now() + 900_000),
    },
  });
});

afterAll(async () => {
  await context?.close();
});

const post = (actor: Actor, url: string, payload: Record<string, unknown>) =>
  context.app.inject({ method: 'POST', url, headers: actor.headers, payload });

const offersFor = (orderId: string) =>
  context.prisma.dispatchOffer.findMany({
    where: { orderId },
    orderBy: { createdAt: 'asc' },
    select: { id: true, riderId: true, round: true, status: true },
  });

const actorFor = (riderId: string): Actor => (riderId === world.riderA.riderId ? riderA : riderB);
const respond = (riderId: string, offerId: string, accept: boolean) =>
  post(actorFor(riderId), `/v1/rider/offers/${offerId}/respond`, { accept });

/**
 * An order in `preparing` with round 1 run: one rider ("A" below — whichever
 * dispatch ranked first) holds the offer. Returns the round-1 sweep job too,
 * so a test can fire it as its timer would.
 */
async function firstRound() {
  const created = await context.app.inject({
    method: 'POST',
    url: '/v1/orders',
    headers: { ...customerA.headers, 'idempotency-key': idempotencyKey('decline') },
    payload: {
      branchId: world.vendorA.branchId,
      items: [{ itemId: world.vendorA.itemId, quantity: 1, modifierIds: [world.vendorA.modifierId] }],
      mode: 'delivery',
      addressId: world.customerA.addressId,
      paymentMethod: 'card',
    },
  });
  expect(created.statusCode, created.body).toBe(200);
  const orderId = created.json<{ order: { id: string } }>().order.id;
  let mark = queue.jobs.length;
  for (const step of [
    { url: `/v1/vendor/orders/${orderId}/accept`, payload: { prepMinutes: 20 } },
    { url: `/v1/vendor/orders/${orderId}/progress`, payload: { to: 'preparing' } },
  ]) {
    expect((await post(vendorA, step.url, step.payload)).statusCode).toBe(200);
  }
  for (const job of queue.since(mark, 'dispatch.find_rider', orderId)) await queue.run(job);
  const sweep = queue.since(mark, 'dispatch.expire_round', orderId);
  expect(sweep).toHaveLength(1);
  mark = queue.jobs.length;

  const offers = await offersFor(orderId);
  expect(offers).toHaveLength(1);
  const first = offers[0]!;
  const otherRiderId = first.riderId === world.riderA.riderId ? world.riderB.riderId : world.riderA.riderId;
  return { orderId, first, otherRiderId, sweep: sweep[0]!, mark };
}

/** What the round-1 sweep does when its timer fires: the offer's deadline has passed. */
async function fireSweep(orderId: string, sweep: Enqueued) {
  await context.prisma.dispatchOffer.updateMany({
    where: { orderId, round: 1, status: 'pending' },
    data: { expiresAt: new Date(Date.now() - 1_000) },
  });
  await queue.run(sweep);
}

describe('the next rider after rider A', () => {
  it('is reached when A lets the offer time out (unchanged)', async () => {
    const { orderId, otherRiderId, sweep, mark } = await firstRound();
    await fireSweep(orderId, sweep);
    for (const job of queue.since(mark, 'dispatch.find_rider', orderId)) await queue.run(job);

    const offers = await offersFor(orderId);
    expect(offers.map((offer) => [offer.status, offer.round])).toEqual([['expired', 1], ['pending', 2]]);
    expect(offers[1]!.riderId).toBe(otherRiderId);
  });

  it('is reached at once when A explicitly declines — no waiting for the timer', async () => {
    const { orderId, first, otherRiderId, mark } = await firstRound();

    const declined = await respond(first.riderId, first.id, false);
    expect(declined.statusCode, declined.body).toBe(200);

    // The decline itself asked for round 2. Nothing else has run.
    const next = queue.since(mark, 'dispatch.find_rider', orderId);
    expect(next.map((job) => job.payload)).toEqual([{ orderId, round: 2 }]);
    await queue.run(next[0]!);

    const offers = await offersFor(orderId);
    expect(offers.map((offer) => [offer.status, offer.round])).toEqual([['declined', 1], ['pending', 2]]);
    expect(offers[1]!.riderId).toBe(otherRiderId);
    // The order is still the customer's, still searching.
    const order = await context.prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { status: true, riderId: true } });
    expect(order).toEqual({ status: 'preparing', riderId: null });
  });

  it('lets rider B accept, and only rider B owns the order', async () => {
    const { orderId, first, mark } = await firstRound();
    await respond(first.riderId, first.id, false);
    for (const job of queue.since(mark, 'dispatch.find_rider', orderId)) await queue.run(job);
    const second = (await offersFor(orderId))[1]!;

    // A tries to take the offer they declined, while B accepts theirs.
    const [late, taken] = await Promise.all([respond(first.riderId, first.id, true), respond(second.riderId, second.id, true)]);
    expect(late.statusCode).toBe(409);
    expect(taken.statusCode, taken.body).toBe(200);

    const order = await context.prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { status: true, riderId: true } });
    expect(order).toEqual({ status: 'rider_assigned', riderId: second.riderId });
    expect(await context.prisma.dispatchOffer.count({ where: { orderId, status: 'accepted' } })).toBe(1);
    expect(await context.prisma.orderStatusEvent.count({ where: { orderId, toStatus: 'rider_assigned' } })).toBe(1);
  });
});

describe('rider A after declining', () => {
  it('is not offered the same order again', async () => {
    const { orderId, first, mark } = await firstRound();
    await respond(first.riderId, first.id, false);
    for (const job of queue.since(mark, 'dispatch.find_rider', orderId)) await queue.run(job);

    // B declines too. With only A and B in this city, nobody is left: dispatch
    // escalates rather than going back to A.
    const second = (await offersFor(orderId))[1]!;
    const mark2 = queue.jobs.length;
    expect((await respond(second.riderId, second.id, false)).statusCode).toBe(200);
    for (const job of queue.since(mark2, 'dispatch.find_rider', orderId)) await queue.run(job);

    const offers = await offersFor(orderId);
    expect(offers.map((offer) => offer.status)).toEqual(['declined', 'declined']);
    expect(offers.filter((offer) => offer.riderId === first.riderId)).toHaveLength(1);
    const escalated = await context.prisma.orderStatusEvent.count({ where: { orderId, reasonCode: 'dispatch_escalated' } });
    expect(escalated).toBe(1);
  });
});

describe('safety', () => {
  it('treats a repeated decline as the first one and asks for nothing more', async () => {
    const { orderId, first, mark } = await firstRound();
    expect((await respond(first.riderId, first.id, false)).statusCode).toBe(200);
    const again = await respond(first.riderId, first.id, false);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ accepted: false });

    expect(queue.since(mark, 'dispatch.find_rider', orderId)).toHaveLength(1);
    const offer = await context.prisma.dispatchOffer.findUniqueOrThrow({ where: { id: first.id }, select: { status: true } });
    expect(offer.status).toBe('declined');
  });

  it('starts no second round when the declined round’s sweep fires later', async () => {
    const { orderId, first, sweep, mark } = await firstRound();
    await respond(first.riderId, first.id, false);
    for (const job of queue.since(mark, 'dispatch.find_rider', orderId)) await queue.run(job);

    const dedupedBefore = queue.deduped.length;
    await fireSweep(orderId, sweep);
    // The sweep asked for round 2 under the decline's key: the queue already
    // held it, so no new job exists.
    expect(queue.deduped.slice(dedupedBefore)).toEqual([`dispatch_${orderId}_round_2`]);
    expect(queue.since(mark, 'dispatch.find_rider', orderId)).toHaveLength(1);
    expect(await offersFor(orderId)).toHaveLength(2);
  });

  it('offers no ghost rider even if the queue has forgotten the key', async () => {
    const { orderId, first, mark } = await firstRound();
    await respond(first.riderId, first.id, false);
    const [job] = queue.since(mark, 'dispatch.find_rider', orderId);
    await queue.run(job!);
    // The same round run again, as if a queue evicted the key and accepted
    // the sweep's copy: rider B's offer is live, so nobody else is offered it.
    await queue.run(job!);
    await queue.run({ name: 'dispatch.find_rider', payload: { orderId, round: 3 } });

    const offers = await offersFor(orderId);
    expect(offers).toHaveLength(2);
    expect(offers.filter((offer) => offer.status === 'pending')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
describe('through the real in-memory queue and outbox relay', () => {
  let real: TestContext;
  let realWorld: World;

  beforeAll(async () => {
    real = await createTestContext();
    realWorld = await buildWorld(real.prisma);
    await real.prisma.rider.updateMany({
      where: { id: { in: [realWorld.riderA.riderId, realWorld.riderB.riderId] } },
      data: {
        availability: 'idle',
        lastLatitude: 6.5,
        lastLongitude: 3.4,
        locationReportedAt: new Date(),
        onlineUntil: new Date(Date.now() + 900_000),
      },
    });
  }, 180_000);

  afterAll(async () => {
    await real?.close();
  });

  async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
    const deadline = Date.now() + 5_000;
    let value = await read();
    while (!done(value) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      value = await read();
    }
    return value;
  }

  it('reaches rider B within moments of rider A declining', async () => {
    const customer = await actAs(real, realWorld.customerA.email);
    const vendor = await actAs(real, realWorld.vendorA.ownerEmail);
    const riders = new Map([
      [realWorld.riderA.riderId, await actAs(real, realWorld.riderA.email)],
      [realWorld.riderB.riderId, await actAs(real, realWorld.riderB.email)],
    ]);
    const created = await real.app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: { ...customer.headers, 'idempotency-key': idempotencyKey('real') },
      payload: {
        branchId: realWorld.vendorA.branchId,
        items: [{ itemId: realWorld.vendorA.itemId, quantity: 1, modifierIds: [realWorld.vendorA.modifierId] }],
        mode: 'delivery',
        addressId: realWorld.customerA.addressId,
        paymentMethod: 'card',
      },
    });
    const orderId = created.json<{ order: { id: string } }>().order.id;
    for (const step of [
      { url: `/v1/vendor/orders/${orderId}/accept`, payload: { prepMinutes: 20 } },
      { url: `/v1/vendor/orders/${orderId}/progress`, payload: { to: 'preparing' } },
    ]) {
      await real.app.inject({ method: 'POST', headers: vendor.headers, ...step });
    }
    const read = () => real.prisma.dispatchOffer.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' } });

    const [first] = await waitFor(read, (offers) => offers.length >= 1);
    const declined = await real.app.inject({
      method: 'POST',
      url: `/v1/rider/offers/${first!.id}/respond`,
      headers: riders.get(first!.riderId)!.headers,
      payload: { accept: false },
    });
    expect(declined.statusCode).toBe(200);

    // Well inside the 60s window A declined: only the decline can have moved it.
    const offers = await waitFor(read, (all) => all.length >= 2);
    expect(offers).toHaveLength(2);
    expect(offers[1]!.riderId).not.toBe(first!.riderId);
    expect(offers[1]!.status).toBe('pending');
  });
});
