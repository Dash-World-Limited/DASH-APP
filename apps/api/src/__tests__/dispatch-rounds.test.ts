/**
 * Sequential dispatch, round by round, through the real worker.
 *
 * The queue here records instead of running, so each step — the first offer,
 * the expiry sweep, the next round — is driven by hand and nothing waits on a
 * real thirty- or sixty-second timer. What it pins:
 *
 *   - one rider is offered at a time;
 *   - a rider who must be woken gets the wake deadline, a live one thirty
 *     seconds, and the sweep is scheduled to outlast the offer;
 *   - an unanswered offer moves the order on to the next eligible rider, not
 *     back to the same one;
 *   - the order is still assigned exactly once.
 */

import type { FastifyBaseLogger } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '@dash/domain/dispatch';
import type { QueueJob, QueuePort } from '@dash/domain/ports';
import { registerDispatchWorker, type FindRiderJob } from '../workers/dispatch.js';
import { createTestContext, type TestContext } from './harness.js';
import { actAs, buildWorld, idempotencyKey, type Actor, type World } from './world.js';
import { useIntegrationTimeouts } from './timeouts.js';

useIntegrationTimeouts();

interface Enqueued {
  name: string;
  payload: unknown;
  delayMs?: number | undefined;
}

/** Holds jobs and handlers; runs nothing on its own. */
class RecordingQueue implements QueuePort {
  readonly providerName = 'recording';
  readonly jobs: Enqueued[] = [];
  readonly handlers = new Map<string, (job: QueueJob<never>) => Promise<void>>();

  async enqueue<T>(input: { name: string; payload: T; delayMs?: number | undefined }): Promise<{ jobId: string }> {
    this.jobs.push({ name: input.name, payload: input.payload, delayMs: input.delayMs });
    return { jobId: String(this.jobs.length) };
  }

  process<T>(name: string, handler: (job: QueueJob<T>) => Promise<void>): void {
    this.handlers.set(name, handler as (job: QueueJob<never>) => Promise<void>);
  }

  async close(): Promise<void> {}

  async run(name: string, payload: FindRiderJob): Promise<void> {
    const handler = this.handlers.get(name);
    if (!handler) throw new Error(`no handler for ${name}`);
    await handler({ id: 'manual', name, payload: payload as never, attempt: 1 });
  }

  last(name: string): Enqueued | undefined {
    return this.jobs.filter((job) => job.name === name).at(-1);
  }
}

let context: TestContext;
let world: World;
let customerA: Actor;
let vendorA: Actor;
let riderA: Actor;
let riderB: Actor;
/** The app's own worker: no live sockets in a test, so every rider must be woken. */
const appQueue = new RecordingQueue();

beforeAll(async () => {
  context = await createTestContext({}, { queue: appQueue });
  world = await buildWorld(context.prisma);
  customerA = await actAs(context, world.customerA.email);
  vendorA = await actAs(context, world.vendorA.ownerEmail);
  riderA = await actAs(context, world.riderA.email);
  riderB = await actAs(context, world.riderB.email);
}, 180_000);

beforeEach(async () => {
  await context.prisma.order.updateMany({
    where: {
      riderId: { in: [world.riderA.riderId, world.riderB.riderId] },
      status: { in: ['rider_assigned', 'rider_arrived', 'picked_up', 'en_route', 'arrived'] },
    },
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

/** An order in `preparing`, which is what dispatch acts on. */
async function preparingOrder(): Promise<string> {
  const created = await context.app.inject({
    method: 'POST',
    url: '/v1/orders',
    headers: { ...customerA.headers, 'idempotency-key': idempotencyKey('rounds') },
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
  for (const step of [
    { url: `/v1/vendor/orders/${orderId}/accept`, payload: { prepMinutes: 20 } },
    { url: `/v1/vendor/orders/${orderId}/progress`, payload: { to: 'preparing' } },
  ]) {
    const response = await context.app.inject({ method: 'POST', headers: vendorA.headers, ...step });
    expect(response.statusCode, response.body).toBe(200);
  }
  return orderId;
}

const offersFor = (orderId: string) =>
  context.prisma.dispatchOffer.findMany({
    where: { orderId },
    orderBy: { round: 'asc' },
    select: { id: true, riderId: true, round: true, status: true, createdAt: true, expiresAt: true },
  });

const ttlSeconds = (offer: { createdAt: Date; expiresAt: Date }) =>
  Math.round((offer.expiresAt.getTime() - offer.createdAt.getTime()) / 1000);

const actorFor = (riderId: string): Actor => (riderId === world.riderA.riderId ? riderA : riderB);

const respond = (actor: Actor, offerId: string) =>
  context.app.inject({
    method: 'POST',
    url: `/v1/rider/offers/${offerId}/respond`,
    headers: actor.headers,
    payload: { accept: true },
  });

describe('offer deadlines', () => {
  it('gives a rider who must be woken sixty seconds, and sweeps after it', async () => {
    expect(DEFAULT_CONFIG.graceOfferTtlSeconds).toBe(60);
    const orderId = await preparingOrder();
    await appQueue.run('dispatch.find_rider', { orderId, round: 1 });

    const offers = await offersFor(orderId);
    expect(offers).toHaveLength(1);
    expect(ttlSeconds(offers[0]!)).toBe(60);
    expect(appQueue.last('dispatch.expire_round')?.delayMs).toBe((60 + 2) * 1000);
  });

  it('keeps a live rider at thirty seconds', async () => {
    expect(DEFAULT_CONFIG.offerTtlSeconds).toBe(30);
    // A second worker on its own queue, told every rider has a live socket.
    const liveQueue = new RecordingQueue();
    registerDispatchWorker({
      prisma: context.prisma,
      queue: liveQueue,
      log: context.app.log as FastifyBaseLogger,
      isIdentityLive: () => true,
    });
    const orderId = await preparingOrder();
    await liveQueue.run('dispatch.find_rider', { orderId, round: 1 });

    const offers = await offersFor(orderId);
    expect(offers).toHaveLength(1);
    expect(ttlSeconds(offers[0]!)).toBe(30);
    expect(liveQueue.last('dispatch.expire_round')?.delayMs).toBe((30 + 2) * 1000);
  });
});

describe('an unanswered offer', () => {
  it('moves to the next eligible rider, and the order is assigned once', async () => {
    const orderId = await preparingOrder();

    // Round 1: exactly one rider.
    await appQueue.run('dispatch.find_rider', { orderId, round: 1 });
    const [first] = await offersFor(orderId);
    expect(first).toBeDefined();
    expect([world.riderA.riderId, world.riderB.riderId]).toContain(first!.riderId);

    // Nobody answers. The deadline passes and the sweep runs.
    await context.prisma.dispatchOffer.update({
      where: { id: first!.id },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    await appQueue.run('dispatch.expire_round', { orderId, round: 1 });
    expect(appQueue.last('dispatch.find_rider')?.payload).toEqual({ orderId, round: 2 });

    // Round 2: the other rider, not the one who let it lapse.
    await appQueue.run('dispatch.find_rider', { orderId, round: 2 });
    const offers = await offersFor(orderId);
    expect(offers.map((offer) => offer.status)).toEqual(['expired', 'pending']);
    const second = offers[1]!;
    expect(second.round).toBe(2);
    expect(second.riderId).not.toBe(first!.riderId);

    // The first rider comes back too late; the second takes it. Both at once.
    const [late, taken] = await Promise.all([
      respond(actorFor(first!.riderId), first!.id),
      respond(actorFor(second.riderId), second.id),
    ]);
    expect(late.statusCode).toBe(409);
    expect(taken.statusCode, taken.body).toBe(200);

    const order = await context.prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { riderId: true, status: true } });
    expect(order).toEqual({ riderId: second.riderId, status: 'rider_assigned' });
    expect(await context.prisma.dispatchOffer.count({ where: { orderId, status: 'accepted' } })).toBe(1);
    expect(
      await context.prisma.orderStatusEvent.count({ where: { orderId, toStatus: 'rider_assigned' } }),
    ).toBe(1);
  });
});
