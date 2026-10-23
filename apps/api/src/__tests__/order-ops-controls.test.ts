/**
 * Stopping orders and moving riders on and off them, through the real routes
 * and the real dispatch worker.
 *
 * The queue records instead of running, so every dispatch round is driven by
 * hand and the assertions can say exactly which jobs a decline, release,
 * cancellation or reassignment asked for — and that nothing was asked for
 * when nothing should be.
 *
 * Covers the staging report that started this: a rider said no, the order did
 * not move on, and the vendor was left looking at an order as if a rider were
 * coming.
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
  payload: unknown;
  idempotencyKey?: string | undefined;
}

/** Holds jobs and handlers; runs nothing on its own. Dedupes keys like the real queues. */
class RecordingQueue implements QueuePort {
  readonly providerName = 'recording';
  readonly jobs: Enqueued[] = [];
  readonly handlers = new Map<string, (job: QueueJob<never>) => Promise<void>>();
  private readonly seen = new Set<string>();

  async enqueue<T>(input: { name: string; payload: T; idempotencyKey?: string | undefined }): Promise<{ jobId: string }> {
    if (input.idempotencyKey) {
      if (this.seen.has(input.idempotencyKey)) return { jobId: `deduped_${input.idempotencyKey}` };
      this.seen.add(input.idempotencyKey);
    }
    this.jobs.push({ name: input.name, payload: input.payload, idempotencyKey: input.idempotencyKey });
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

  /** Dispatch jobs recorded for this order since `from`. */
  findRiderJobs(orderId: string, from = 0): Enqueued[] {
    return this.jobs
      .slice(from)
      .filter((job) => job.name === 'dispatch.find_rider' && (job.payload as FindRiderJob).orderId === orderId);
  }

  jobsNamed(name: string, orderId: string): Enqueued[] {
    return this.jobs.filter((job) => job.name === name && (job.payload as { orderId?: string }).orderId === orderId);
  }

  /** Run every dispatch job recorded for this order since `from`, in order. */
  async runFindRider(orderId: string, from: number): Promise<void> {
    for (const job of this.findRiderJobs(orderId, from)) {
      await this.run('dispatch.find_rider', job.payload as FindRiderJob);
    }
  }
}

let context: TestContext;
let world: World;
let customerA: Actor;
let vendorA: Actor;
let riderA: Actor;
let riderB: Actor;
let dispatcher: Actor;
let superAdmin: Actor;
const queue = new RecordingQueue();

beforeAll(async () => {
  context = await createTestContext({}, { queue });
  world = await buildWorld(context.prisma);
  customerA = await actAs(context, world.customerA.email);
  vendorA = await actAs(context, world.vendorA.ownerEmail);
  riderA = await actAs(context, world.riderA.email);
  riderB = await actAs(context, world.riderB.email);
  dispatcher = await actAs(context, world.dispatcher.email);
  superAdmin = await actAs(context, world.admin.email);
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

const post = (actor: Actor, url: string, payload: unknown = {}) =>
  context.app.inject({ method: 'POST', url, headers: actor.headers, payload: payload as Record<string, unknown> });

/** An order in `preparing`, with its first dispatch round run. Returns the order and the rider offered. */
async function dispatchedOrder(options: { ready?: boolean } = {}): Promise<{ orderId: string; first: Offer }> {
  const created = await context.app.inject({
    method: 'POST',
    url: '/v1/orders',
    headers: { ...customerA.headers, 'idempotency-key': idempotencyKey('ops') },
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
  const mark = queue.jobs.length;
  for (const step of [
    { url: `/v1/vendor/orders/${orderId}/accept`, payload: { prepMinutes: 20 } },
    { url: `/v1/vendor/orders/${orderId}/progress`, payload: { to: 'preparing' } },
    ...(options.ready ? [{ url: `/v1/vendor/orders/${orderId}/progress`, payload: { to: 'ready' } }] : []),
  ]) {
    const response = await post(vendorA, step.url, step.payload);
    expect(response.statusCode, response.body).toBe(200);
  }
  await queue.runFindRider(orderId, mark);
  const offers = await offersFor(orderId);
  expect(offers).toHaveLength(1);
  return { orderId, first: offers[0]! };
}

type Offer = Awaited<ReturnType<typeof offersFor>>[number];

const offersFor = (orderId: string) =>
  context.prisma.dispatchOffer.findMany({
    where: { orderId },
    orderBy: { createdAt: 'asc' },
    select: { id: true, riderId: true, round: true, status: true, expiresAt: true },
  });

const orderRow = (orderId: string) =>
  context.prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { status: true, riderId: true } });

const availabilityOf = async (riderId: string) =>
  (await context.prisma.rider.findUniqueOrThrow({ where: { id: riderId }, select: { availability: true } })).availability;

const actorFor = (riderId: string): Actor => (riderId === world.riderA.riderId ? riderA : riderB);
const otherRider = (riderId: string): string => (riderId === world.riderA.riderId ? world.riderB.riderId : world.riderA.riderId);
const respond = (actor: Actor, offerId: string, accept: boolean) =>
  post(actor, `/v1/rider/offers/${offerId}/respond`, { accept });

/** Take an order to `rider_assigned` with the first offered rider. */
async function assignedOrder(options: { ready?: boolean } = {}) {
  const { orderId, first } = await dispatchedOrder(options);
  const accepted = await respond(actorFor(first.riderId), first.id, true);
  expect(accepted.statusCode, accepted.body).toBe(200);
  return { orderId, first, riderId: first.riderId };
}

async function customerView(orderId: string) {
  const response = await context.app.inject({ method: 'GET', url: `/v1/orders/${orderId}`, headers: customerA.headers });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<{ order: { status: string; statusLabel: string; riderSearch: string | null; rider: unknown } }>().order;
}

async function vendorView(orderId: string) {
  const response = await context.app.inject({ method: 'GET', url: '/v1/vendor/orders?status=active', headers: vendorA.headers });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<{ orders: { id: string; status: string; riderSearch: string | null; rider: unknown }[] }>().orders.find(
    (order) => order.id === orderId,
  );
}

// ---------------------------------------------------------------------------
describe('a rider declining an offer', () => {
  it('moves the order to the next rider at once, without waiting out the offer', async () => {
    const { orderId, first } = await dispatchedOrder();
    expect(first.expiresAt.getTime()).toBeGreaterThan(Date.now() + 20_000);

    const mark = queue.jobs.length;
    const declined = await respond(actorFor(first.riderId), first.id, false);
    expect(declined.statusCode, declined.body).toBe(200);

    // The next round was asked for by the decline itself.
    const next = queue.findRiderJobs(orderId, mark);
    expect(next).toHaveLength(1);
    expect(next[0]!.payload).toEqual({ orderId, round: 2 });
    await queue.runFindRider(orderId, mark);

    const offers = await offersFor(orderId);
    expect(offers.map((offer) => offer.status)).toEqual(['declined', 'pending']);
    expect(offers[1]!.riderId).toBe(otherRider(first.riderId));

    // The declining rider is still available, and the order still searching.
    expect(await availabilityOf(first.riderId)).toBe('idle');
    expect(await orderRow(orderId)).toEqual({ status: 'preparing', riderId: null });
  });

  it("does not start another round when the declined round's sweep fires later", async () => {
    const { orderId, first } = await dispatchedOrder();
    const mark = queue.jobs.length;
    await respond(actorFor(first.riderId), first.id, false);
    await queue.runFindRider(orderId, mark);

    // Round 1's sweep, as if its timer had now run.
    const sweepMark = queue.jobs.length;
    await queue.run('dispatch.expire_round', { orderId, round: 1 });
    await queue.runFindRider(orderId, sweepMark);
    expect(await offersFor(orderId)).toHaveLength(2);
  });

  it('never cancels the customer’s order', async () => {
    const { orderId, first } = await dispatchedOrder();
    await respond(actorFor(first.riderId), first.id, false);
    expect((await orderRow(orderId)).status).toBe('preparing');
    expect((await customerView(orderId)).status).toBe('preparing');
  });
});

// ---------------------------------------------------------------------------
describe('a rider giving back an accepted job before pickup', () => {
  it('returns the order to dispatch and the next rider gets it', async () => {
    const { orderId, first, riderId } = await assignedOrder();

    const mark = queue.jobs.length;
    const released = await post(actorFor(riderId), `/v1/rider/deliveries/${orderId}/release`, {
      reasonCode: 'vehicle_problem',
      note: 'Flat tyre',
    });
    expect(released.statusCode, released.body).toBe(200);
    // Food not marked ready yet, so the order goes back to preparing, not ready.
    expect(released.json<{ status: string }>().status).toBe('preparing');

    expect(await orderRow(orderId)).toEqual({ status: 'preparing', riderId: null });
    expect(await availabilityOf(riderId)).toBe('idle');
    const firstOffer = (await offersFor(orderId)).find((offer) => offer.id === first.id);
    expect(firstOffer?.status).toBe('withdrawn');

    expect(queue.findRiderJobs(orderId, mark)).toHaveLength(1);
    await queue.runFindRider(orderId, mark);
    const offers = await offersFor(orderId);
    const replacement = offers.at(-1)!;
    expect(replacement.status).toBe('pending');
    expect(replacement.riderId).toBe(otherRider(riderId));

    const accepted = await respond(actorFor(replacement.riderId), replacement.id, true);
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(await orderRow(orderId)).toEqual({ status: 'rider_assigned', riderId: replacement.riderId });
  });

  it('goes back to ready when the kitchen had already marked it ready', async () => {
    const { orderId, riderId } = await assignedOrder({ ready: true });
    const released = await post(actorFor(riderId), `/v1/rider/deliveries/${orderId}/release`, { reasonCode: 'emergency' });
    expect(released.statusCode, released.body).toBe(200);
    expect(await orderRow(orderId)).toEqual({ status: 'ready', riderId: null });
  });

  it('demands a reason', async () => {
    const { orderId, riderId } = await assignedOrder();
    const response = await post(actorFor(riderId), `/v1/rider/deliveries/${orderId}/release`, {});
    expect(response.statusCode).toBe(400);
    expect((await orderRow(orderId)).riderId).toBe(riderId);
  });

  it('leaves the old rider unable to accept or reclaim the order', async () => {
    const { orderId, first, riderId } = await assignedOrder();
    const mark = queue.jobs.length;
    await post(actorFor(riderId), `/v1/rider/deliveries/${orderId}/release`, { reasonCode: 'other' });
    await queue.runFindRider(orderId, mark);

    // Replaying the old offer, releasing again, and progressing the job all fail.
    expect((await respond(actorFor(riderId), first.id, true)).statusCode).toBe(409);
    expect((await post(actorFor(riderId), `/v1/rider/deliveries/${orderId}/release`, { reasonCode: 'other' })).statusCode).toBe(404);
    expect((await post(actorFor(riderId), `/v1/rider/deliveries/${orderId}/progress`, { to: 'rider_arrived' })).statusCode).toBe(404);
    expect((await orderRow(orderId)).riderId).toBeNull();

    // And the old rider is not offered it again in this search.
    const offers = await offersFor(orderId);
    expect(offers.filter((offer) => offer.riderId === riderId)).toHaveLength(1);
  });

  it('cannot walk back onto a ready order, or read it, once released', async () => {
    const { orderId, riderId } = await assignedOrder({ ready: true });
    await post(actorFor(riderId), `/v1/rider/deliveries/${orderId}/release`, { reasonCode: 'other' });
    expect(await orderRow(orderId)).toEqual({ status: 'ready', riderId: null });

    // `ready -> rider_arrived` and `ready -> picked_up` are rider moves in the
    // state machine; only the assignment check keeps them to the assigned rider.
    for (const to of ['rider_arrived', 'picked_up']) {
      const response = await post(actorFor(riderId), `/v1/rider/deliveries/${orderId}/progress`, { to });
      expect(response.statusCode, to).toBe(404);
    }
    const detail = await context.app.inject({ method: 'GET', url: `/v1/rider/deliveries/${orderId}`, headers: actorFor(riderId).headers });
    expect(detail.statusCode).toBe(404);
    expect(await orderRow(orderId)).toEqual({ status: 'ready', riderId: null });
  });

  it('assigns exactly one rider when the old offer and the new one are accepted together', async () => {
    const { orderId, first, riderId } = await assignedOrder();
    const mark = queue.jobs.length;
    await post(actorFor(riderId), `/v1/rider/deliveries/${orderId}/release`, { reasonCode: 'other' });
    await queue.runFindRider(orderId, mark);
    const replacement = (await offersFor(orderId)).at(-1)!;

    const [stale, fresh] = await Promise.all([
      respond(actorFor(riderId), first.id, true),
      respond(actorFor(replacement.riderId), replacement.id, true),
    ]);
    expect(stale.statusCode).toBe(409);
    expect(fresh.statusCode, fresh.body).toBe(200);
    expect(await orderRow(orderId)).toEqual({ status: 'rider_assigned', riderId: replacement.riderId });
    expect(await context.prisma.orderStatusEvent.count({ where: { orderId, toStatus: 'rider_assigned' } })).toBe(2);
    expect(await context.prisma.dispatchOffer.count({ where: { orderId, status: 'accepted' } })).toBe(1);
  });

  it('shows customer and vendor that another rider is being found, and no rider', async () => {
    const { orderId, riderId } = await assignedOrder();
    expect((await customerView(orderId)).statusLabel).toBe('Rider on the way to collect');

    await post(actorFor(riderId), `/v1/rider/deliveries/${orderId}/release`, { reasonCode: 'other' });

    const customer = await customerView(orderId);
    expect(customer.statusLabel).toBe('Finding another rider');
    expect(customer.riderSearch).toBe('finding_another');
    expect(customer.rider).toBeNull();

    const vendor = await vendorView(orderId);
    expect(vendor?.riderSearch).toBe('finding_another');
    expect(vendor?.rider).toBeNull();
  });

  it('is refused after pickup, and nothing is redispatched', async () => {
    const { orderId, riderId } = await assignedOrder({ ready: true });
    const rider = actorFor(riderId);
    for (const to of ['rider_arrived', 'picked_up']) {
      expect((await post(rider, `/v1/rider/deliveries/${orderId}/progress`, { to })).statusCode).toBe(200);
    }

    const mark = queue.jobs.length;
    const response = await post(rider, `/v1/rider/deliveries/${orderId}/release`, { reasonCode: 'emergency' });
    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: { message: string } }>().error.message).toMatch(/Contact DASH support/);
    expect(await orderRow(orderId)).toEqual({ status: 'picked_up', riderId });
    expect(queue.findRiderJobs(orderId, mark)).toHaveLength(0);
  });

  it("cannot be done to another rider's job", async () => {
    const { orderId, riderId } = await assignedOrder();
    const response = await post(actorFor(otherRider(riderId)), `/v1/rider/deliveries/${orderId}/release`, { reasonCode: 'other' });
    expect(response.statusCode).toBe(404);
    expect((await orderRow(orderId)).riderId).toBe(riderId);
  });
});

// ---------------------------------------------------------------------------
describe('a vendor cancelling', () => {
  it('stops a searching order: offers withdrawn, refund queued, no dispatch again', async () => {
    const { orderId, first } = await dispatchedOrder();
    const mark = queue.jobs.length;
    const response = await post(vendorA, `/v1/vendor/orders/${orderId}/cancel`, { reasonCode: 'out_of_stock' });
    expect(response.statusCode, response.body).toBe(200);

    expect((await orderRow(orderId)).status).toBe('cancelled');
    expect((await offersFor(orderId)).map((offer) => offer.status)).toEqual(['withdrawn']);
    expect(queue.jobsNamed('refund.full', orderId)).toHaveLength(1);

    // The offered rider cannot take it, and dispatch will not offer it again.
    expect((await respond(actorFor(first.riderId), first.id, true)).statusCode).toBe(409);
    expect((await orderRow(orderId)).status).toBe('cancelled');
    expect(queue.findRiderJobs(orderId, mark)).toHaveLength(0);
    await queue.run('dispatch.find_rider', { orderId, round: 5 });
    await queue.run('dispatch.expire_round', { orderId, round: 1 });
    expect(await offersFor(orderId)).toHaveLength(1);
  });

  it('stands down a rider who was on the way', async () => {
    const { orderId, riderId } = await assignedOrder();
    expect(await availabilityOf(riderId)).toBe('on_delivery');
    const response = await post(vendorA, `/v1/vendor/orders/${orderId}/cancel`, { reasonCode: 'kitchen_problem', note: 'Gas ran out' });
    expect(response.statusCode, response.body).toBe(200);
    expect(await availabilityOf(riderId)).toBe('idle');
    // Off the rider's list, and they can go offline.
    const deliveries = await context.app.inject({ method: 'GET', url: '/v1/rider/deliveries', headers: actorFor(riderId).headers });
    expect(deliveries.json<{ deliveries: { id: string }[] }>().deliveries.some((d) => d.id === orderId)).toBe(false);
    expect((await post(actorFor(riderId), '/v1/rider/availability', { availability: 'offline' })).statusCode).toBe(200);
  });

  it('demands a reason, and is refused after pickup and to other parties', async () => {
    const { orderId, riderId } = await assignedOrder({ ready: true });
    expect((await post(vendorA, `/v1/vendor/orders/${orderId}/cancel`, {})).statusCode).toBe(400);
    for (const actor of [customerA, riderA, riderB]) {
      expect((await post(actor, `/v1/vendor/orders/${orderId}/cancel`, { reasonCode: 'other' })).statusCode).toBe(403);
    }
    const rider = actorFor(riderId);
    await post(rider, `/v1/rider/deliveries/${orderId}/progress`, { to: 'rider_arrived' });
    await post(rider, `/v1/rider/deliveries/${orderId}/progress`, { to: 'picked_up' });
    expect((await post(vendorA, `/v1/vendor/orders/${orderId}/cancel`, { reasonCode: 'other' })).statusCode).toBe(409);
    expect((await orderRow(orderId)).status).toBe('picked_up');
  });
});

// ---------------------------------------------------------------------------
describe('a customer cancelling', () => {
  it('withdraws an open offer, so the cancelled order cannot be taken', async () => {
    const { orderId, first } = await dispatchedOrder();
    expect((await post(customerA, `/v1/orders/${orderId}/cancel`)).statusCode).toBe(200);
    expect((await respond(actorFor(first.riderId), first.id, true)).statusCode).toBe(409);
    expect(await orderRow(orderId)).toEqual({ status: 'cancelled', riderId: null });
  });

  it('frees the rider who had accepted it', async () => {
    const { orderId, riderId } = await assignedOrder();
    expect((await post(customerA, `/v1/orders/${orderId}/cancel`)).statusCode).toBe(200);
    expect(await availabilityOf(riderId)).toBe('idle');
    expect((await post(actorFor(riderId), '/v1/rider/availability', { availability: 'offline' })).statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
describe('staff cancelling', () => {
  it('cancels before pickup with a reason, and nothing dispatches again', async () => {
    const { orderId, riderId } = await assignedOrder();
    const mark = queue.jobs.length;
    expect((await post(superAdmin, `/v1/ops/orders/${orderId}/cancel`, { reasonCode: 'customer_request' })).statusCode).toBe(400);

    const response = await post(superAdmin, `/v1/ops/orders/${orderId}/cancel`, {
      reasonCode: 'vendor_unavailable',
      note: 'Vendor phoned to say they closed',
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<{ refundDecisionNeeded: boolean }>().refundDecisionNeeded).toBe(true);
    expect((await orderRow(orderId)).status).toBe('cancelled');
    expect(await availabilityOf(riderId)).toBe('idle');
    expect(queue.findRiderJobs(orderId, mark)).toHaveLength(0);

    const audit = await context.prisma.auditLog.findFirst({ where: { resourceId: orderId, action: 'ops.order.cancelled' } });
    expect(audit).not.toBeNull();
  });

  it('after pickup, only as an incident, keeping who has the order', async () => {
    const { orderId, riderId } = await assignedOrder({ ready: true });
    const rider = actorFor(riderId);
    await post(rider, `/v1/rider/deliveries/${orderId}/progress`, { to: 'rider_arrived' });
    await post(rider, `/v1/rider/deliveries/${orderId}/progress`, { to: 'picked_up' });

    const plain = await post(dispatcher, `/v1/ops/orders/${orderId}/cancel`, { reasonCode: 'customer_request', note: 'Asked to' });
    expect(plain.statusCode).toBe(409);
    const incident = await post(dispatcher, `/v1/ops/orders/${orderId}/cancel`, {
      reasonCode: 'delivery_incident',
      note: 'Rider crashed; food lost',
    });
    expect(incident.statusCode, incident.body).toBe(200);
    expect(incident.json<{ riderHadCustody: boolean }>().riderHadCustody).toBe(true);
    expect(await orderRow(orderId)).toEqual({ status: 'cancelled', riderId });
  });

  it('is refused to riders, vendors and customers', async () => {
    const { orderId } = await dispatchedOrder();
    for (const actor of [riderA, vendorA, customerA]) {
      const response = await post(actor, `/v1/ops/orders/${orderId}/cancel`, { reasonCode: 'other', note: 'nope' });
      expect(response.statusCode).toBe(403);
    }
    expect((await orderRow(orderId)).status).toBe('preparing');
  });
});

// ---------------------------------------------------------------------------
describe('staff reassigning', () => {
  it('removes the rider before pickup and dispatch resumes without them', async () => {
    const { orderId, riderId } = await assignedOrder();
    const mark = queue.jobs.length;
    const response = await post(superAdmin, `/v1/ops/orders/${orderId}/reassign`, { reasonCode: 'rider_unresponsive' });
    expect(response.statusCode, response.body).toBe(200);
    expect(await orderRow(orderId)).toEqual({ status: 'preparing', riderId: null });
    expect(await availabilityOf(riderId)).toBe('idle');

    await queue.runFindRider(orderId, mark);
    const replacement = (await offersFor(orderId)).at(-1)!;
    expect(replacement.status).toBe('pending');
    expect(replacement.riderId).toBe(otherRider(riderId));
    expect((await customerView(orderId)).statusLabel).toBe('Finding another rider');
  });

  it('is refused after pickup', async () => {
    const { orderId, riderId } = await assignedOrder({ ready: true });
    const rider = actorFor(riderId);
    await post(rider, `/v1/rider/deliveries/${orderId}/progress`, { to: 'rider_arrived' });
    await post(rider, `/v1/rider/deliveries/${orderId}/progress`, { to: 'picked_up' });
    const response = await post(superAdmin, `/v1/ops/orders/${orderId}/reassign`, { reasonCode: 'rider_incident' });
    expect(response.statusCode).toBe(409);
    expect(await orderRow(orderId)).toEqual({ status: 'picked_up', riderId });
  });

  it('can reopen the search once every rider has been tried', async () => {
    const { orderId, first } = await dispatchedOrder();
    let mark = queue.jobs.length;
    await respond(actorFor(first.riderId), first.id, false);
    await queue.runFindRider(orderId, mark);
    const second = (await offersFor(orderId)).at(-1)!;
    mark = queue.jobs.length;
    await respond(actorFor(second.riderId), second.id, false);
    await queue.runFindRider(orderId, mark);
    // Both riders said no: nobody left, so dispatch escalated.
    expect(await offersFor(orderId)).toHaveLength(2);

    mark = queue.jobs.length;
    const reopened = await post(dispatcher, `/v1/ops/orders/${orderId}/redispatch`, { reasonCode: 'riders_back_online' });
    expect(reopened.statusCode, reopened.body).toBe(200);
    await queue.runFindRider(orderId, mark);
    const offers = await offersFor(orderId);
    expect(offers).toHaveLength(3);
    expect(offers[2]!.status).toBe('pending');
  });

  it('shows staff the rider, the offers and the history', async () => {
    const { orderId, riderId } = await assignedOrder();
    await post(superAdmin, `/v1/ops/orders/${orderId}/reassign`, { reasonCode: 'rider_unresponsive', note: 'No answer on phone' });
    const response = await context.app.inject({ method: 'GET', url: `/v1/admin/orders/${orderId}`, headers: superAdmin.headers });
    expect(response.statusCode, response.body).toBe(200);
    const order = response.json<{
      order: {
        rider: unknown;
        riderSearch: string | null;
        dispatchOffers: { status: string; rider: { id: string } }[];
        statusEvents: { reasonCode: string | null; reason: string | null }[];
      };
    }>().order;
    expect(order.rider).toBeNull();
    expect(order.riderSearch).toBe('finding_another');
    expect(order.dispatchOffers.find((offer) => offer.rider.id === riderId)?.status).toBe('withdrawn');
    expect(order.statusEvents.some((event) => event.reasonCode === 'rider_unresponsive' && event.reason === 'No answer on phone')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('a delivered order', () => {
  it('cannot be cancelled, reassigned or given back', async () => {
    const { orderId, riderId } = await assignedOrder({ ready: true });
    await context.prisma.order.update({ where: { id: orderId }, data: { status: 'delivered', deliveredAt: new Date() } });

    expect((await post(actorFor(riderId), `/v1/rider/deliveries/${orderId}/release`, { reasonCode: 'other' })).statusCode).toBe(409);
    expect((await post(vendorA, `/v1/vendor/orders/${orderId}/cancel`, { reasonCode: 'other' })).statusCode).toBe(409);
    expect((await post(superAdmin, `/v1/ops/orders/${orderId}/cancel`, { reasonCode: 'delivery_incident', note: 'try' })).statusCode).toBe(409);
    expect((await post(superAdmin, `/v1/ops/orders/${orderId}/reassign`, { reasonCode: 'other' })).statusCode).toBe(409);
    expect((await post(superAdmin, `/v1/ops/orders/${orderId}/redispatch`, { reasonCode: 'other' })).statusCode).toBe(409);
    expect(await orderRow(orderId)).toEqual({ status: 'delivered', riderId });
  });
});
