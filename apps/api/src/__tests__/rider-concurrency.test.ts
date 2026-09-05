/**
 * One tap, one transition.
 *
 * A rider's lifecycle transitions are validated against a status read *before*
 * the transaction opens, so two requests arriving together can both find the
 * order in the prior state, both judge the move legal, and both write it. The
 * status itself converges, because both write the same value — which is
 * exactly what made this hard to notice. What does not converge is the record
 * around it: a second `OrderStatusEvent`, a second `revision` bump, a second
 * realtime notification, and on completion a second proof of delivery, all for
 * something that happened once.
 *
 * That record is not decoration. It is what an operator reads to reconstruct a
 * disputed delivery, what the customer's app follows, and — through
 * `pickedUpAt` — part of what a rider is paid for waiting. Ledger idempotency
 * protects the money and nothing else; these tests are about everything the
 * ledger does not guard.
 *
 * Kept in its own file because it drives the same routes as dispatch.test.ts
 * from a different angle, and because a concurrency suite that shares a
 * fixture with sequential tests invites the two to interfere.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './harness.js';
import { actAs, buildWorld, idempotencyKey, type Actor, type World } from './world.js';
import { useIntegrationTimeouts } from './timeouts.js';

useIntegrationTimeouts();

let context: TestContext;
let world: World;
let customerA: Actor;
let vendorA: Actor;
let riderA: Actor;

beforeAll(async () => {
  context = await createTestContext();
  world = await buildWorld(context.prisma);
  customerA = await actAs(context, world.customerA.email);
  vendorA = await actAs(context, world.vendorA.ownerEmail);
  riderA = await actAs(context, world.riderA.email);
}, 180_000);

afterAll(async () => {
  await context?.close();
});

/** Place an order and take it to `ready`, where a rider can be assigned. */
async function readyOrder(): Promise<{ id: string; deliveryPin: string }> {
  const created = await context.app.inject({
    method: 'POST',
    url: '/v1/orders',
    headers: { ...customerA.headers, 'idempotency-key': idempotencyKey('rconc') },
    payload: {
      branchId: world.vendorA.branchId,
      items: [{ itemId: world.vendorA.itemId, quantity: 1, modifierIds: [world.vendorA.modifierId] }],
      mode: 'delivery',
      addressId: world.customerA.addressId,
      paymentMethod: 'card',
    },
  });
  if (created.statusCode !== 200) {
    throw new Error(`order failed: ${created.statusCode} ${created.body}`);
  }
  const body = created.json<{ order: { id: string }; deliveryPin: string }>();

  for (const step of [
    { url: `/v1/vendor/orders/${body.order.id}/accept`, payload: { prepMinutes: 1 } },
    { url: `/v1/vendor/orders/${body.order.id}/progress`, payload: { to: 'preparing' } },
    { url: `/v1/vendor/orders/${body.order.id}/progress`, payload: { to: 'ready' } },
  ]) {
    await context.app.inject({ method: 'POST', url: step.url, headers: vendorA.headers, payload: step.payload });
  }

  return { id: body.order.id, deliveryPin: body.deliveryPin };
}

/** A pending offer, created directly so the test does not wait on the worker. */
async function offerTo(riderId: string, orderId: string) {
  return context.prisma.dispatchOffer.create({
    data: {
      orderId,
      riderId,
      round: 1,
      status: 'pending',
      score: 50,
      scoreBreakdown: '[]',
      ruleVersion: 'test',
      pickupEtaSeconds: 300,
      pickupDistanceMetres: 1200,
      expiresAt: new Date(Date.now() + 60_000),
    },
    select: { id: true },
  });
}

const respond = (actor: Actor, offerId: string, accept: boolean) =>
  context.app.inject({
    method: 'POST',
    url: `/v1/rider/offers/${offerId}/respond`,
    headers: actor.headers,
    payload: { accept },
  });

const riderProgress = (actor: Actor, orderId: string, to: string) =>
  context.app.inject({
    method: 'POST',
    url: `/v1/rider/deliveries/${orderId}/progress`,
    headers: actor.headers,
    payload: { to },
  });

describe('rider transitions under concurrency', () => {
  /**
   * One tap, one transition — even when the tap arrives twice at once.
   *
   * `assertTransition` judges a status read before the transaction opens, so
   * two simultaneous requests can both find the order in the prior state, both
   * judge the move legal, and both write it. The status itself converges,
   * because both write the same value — which is exactly what makes this easy
   * to miss. What does not converge is the record around it: a second status
   * event, a second revision bump, and a second realtime notification for a
   * change that happened once.
   *
   * The lifecycle record is not decoration. It is what an operator reads to
   * reconstruct a disputed delivery, and what the customer's app follows.
   */
  const realtimeEventCount = async (orderId: string): Promise<number> => {
    const rows = await context.prisma.outboxEvent.findMany({
      where: { name: 'realtime.notify' },
      select: { payload: true },
    });
    return rows.filter((row) => {
      try {
        return (JSON.parse(row.payload) as { subject?: string }).subject === `order:${orderId}`;
      } catch {
        return false;
      }
    }).length;
  };

  async function assigned(): Promise<{ id: string; deliveryPin: string }> {
    const order = await readyOrder();
    const offer = await offerTo(world.riderA.riderId, order.id);
    await respond(riderA, offer.id, true);
    return order;
  }

  it('records one transition when two identical progress requests race', async () => {
    const order = await assigned();
    const before = await context.prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      select: { revision: true },
    });
    const realtimeBefore = await realtimeEventCount(order.id);

    const responses = await Promise.all([
      riderProgress(riderA, order.id, 'rider_arrived'),
      riderProgress(riderA, order.id, 'rider_arrived'),
    ]);

    // Exactly one winner, and the loser is refused rather than silently
    // succeeding at something that already happened.
    expect(responses.filter((response) => response.statusCode === 200)).toHaveLength(1);
    expect(responses.find((response) => response.statusCode !== 200)?.statusCode).toBe(409);

    const after = await context.prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      select: { revision: true, status: true },
    });
    expect(after.status).toBe('rider_arrived');
    expect(after.revision).toBe(before.revision + 1);

    const events = await context.prisma.orderStatusEvent.findMany({
      where: { orderId: order.id, toStatus: 'rider_arrived' },
    });
    expect(events).toHaveLength(1);

    expect(await realtimeEventCount(order.id)).toBe(realtimeBefore + 1);
  });

  it('stamps pickedUpAt once when two pickups race', async () => {
    const order = await assigned();
    await riderProgress(riderA, order.id, 'rider_arrived');

    const responses = await Promise.all([
      riderProgress(riderA, order.id, 'picked_up'),
      riderProgress(riderA, order.id, 'picked_up'),
    ]);
    expect(responses.filter((response) => response.statusCode === 200)).toHaveLength(1);

    const events = await context.prisma.orderStatusEvent.findMany({
      where: { orderId: order.id, toStatus: 'picked_up' },
    });
    expect(events).toHaveLength(1);

    // Billable waiting time is measured from this stamp, so a second write
    // moving it is a small distortion of what the rider is owed.
    const row = await context.prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      select: { pickedUpAt: true, status: true },
    });
    expect(row.status).toBe('picked_up');
    expect(row.pickedUpAt).not.toBeNull();
  });

  it('completes once when two completions race', async () => {
    const order = await readyOrder();
    const offer = await offerTo(world.riderA.riderId, order.id);
    await respond(riderA, offer.id, true);
    for (const step of ['rider_arrived', 'picked_up', 'en_route'] as const) {
      await riderProgress(riderA, order.id, step);
    }

    const before = await context.prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      select: { revision: true },
    });

    const attempt = () =>
      context.app.inject({
        method: 'POST',
        url: `/v1/rider/deliveries/${order.id}/complete`,
        headers: riderA.headers,
        payload: { pin: order.deliveryPin },
      });
    const responses = await Promise.all([attempt(), attempt()]);

    expect(responses.filter((response) => response.statusCode === 200)).toHaveLength(1);

    // The loser must not have mutated anything on its way to failing.
    const after = await context.prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      select: { status: true, revision: true, deliveredAt: true },
    });
    expect(after.status).toBe('delivered');
    expect(after.revision).toBe(before.revision + 1);
    expect(after.deliveredAt).not.toBeNull();

    expect(
      await context.prisma.orderStatusEvent.findMany({
        where: { orderId: order.id, toStatus: 'delivered' },
      }),
    ).toHaveLength(1);

    // Proof of delivery is evidence in a dispute; two rows for one handover
    // is a false record.
    expect(
      await context.prisma.deliveryProof.findMany({ where: { orderId: order.id } }),
    ).toHaveLength(1);

    // Rider pay, from both directions: the ledger's own idempotency key, and
    // the entries it produced. Ledger idempotency alone is not the assertion
    // being made here — the lifecycle around it has to be right too.
    const ledger = await context.prisma.ledgerTransaction.findMany({
      where: { idempotencyKey: `rider_assign_${order.id}` },
      select: { id: true, entries: { select: { amount: true, accountKind: true } } },
    });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.entries.reduce((sum, entry) => sum + entry.amount, 0)).toBe(0);
  });
});

/** Place an order and stop, so the accept itself can be raced. */
async function placedOrder(): Promise<{ id: string }> {
  const created = await context.app.inject({
    method: 'POST',
    url: '/v1/orders',
    headers: { ...customerA.headers, 'idempotency-key': idempotencyKey('vacc') },
    payload: {
      branchId: world.vendorA.branchId,
      items: [{ itemId: world.vendorA.itemId, quantity: 1, modifierIds: [world.vendorA.modifierId] }],
      mode: 'delivery',
      addressId: world.customerA.addressId,
      paymentMethod: 'card',
    },
  });
  if (created.statusCode !== 200) {
    throw new Error(`order failed: ${created.statusCode} ${created.body}`);
  }
  return { id: created.json<{ order: { id: string } }>().order.id };
}

/** Outbox rows of one name whose payload names exactly this order. */
async function outboxFor(name: string, orderId: string): Promise<string[]> {
  const rows = await context.prisma.outboxEvent.findMany({
    where: { name },
    select: { idempotencyKey: true, payload: true },
  });
  return rows
    .filter((row) => {
      try {
        const payload = JSON.parse(row.payload) as { orderId?: string; subject?: string };
        return payload.orderId === orderId || payload.subject === `order:${orderId}`;
      } catch {
        return false;
      }
    })
    .map((row) => row.idempotencyKey ?? '');
}

describe('vendor accept under concurrency', () => {
  /**
   * Accepting is the vendor's one irreversible commitment to make the food,
   * and it is the button most likely to be pressed twice — a counter tablet
   * with a slow connection, two staff working the same queue, a retried
   * request. `assertTransition` judges a status read before the transaction
   * opens, so both attempts could find the order `placed`, both judge
   * `accepted` legal, and both write it.
   *
   * The status converged, so nothing looked wrong. What did not converge was
   * the record: two `OrderStatusEvent` rows, two `revision` bumps, two
   * realtime notifications, and `acceptedAt` overwritten — a field the rider's
   * billable waiting time is measured from.
   */
  it('accepts once when two vendor accepts race', async () => {
    const order = await placedOrder();
    const before = await context.prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      select: { revision: true },
    });
    const realtimeBefore = (await outboxFor('realtime.notify', order.id)).length;

    const attempt = () =>
      context.app.inject({
        method: 'POST',
        url: `/v1/vendor/orders/${order.id}/accept`,
        headers: vendorA.headers,
        payload: { prepMinutes: 20 },
      });
    const responses = await Promise.all([attempt(), attempt()]);

    expect(responses.filter((response) => response.statusCode === 200)).toHaveLength(1);
    expect(responses.find((response) => response.statusCode !== 200)?.statusCode).toBe(409);

    const after = await context.prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      select: { revision: true, status: true, acceptedAt: true, estimatedReadyAt: true },
    });
    expect(after.status).toBe('accepted');
    expect(after.revision).toBe(before.revision + 1);
    expect(after.acceptedAt).not.toBeNull();
    expect(after.estimatedReadyAt).not.toBeNull();

    expect(
      await context.prisma.orderStatusEvent.findMany({
        where: { orderId: order.id, toStatus: 'accepted' },
      }),
    ).toHaveLength(1);

    expect(await outboxFor('realtime.notify', order.id)).toHaveLength(realtimeBefore + 1);
  });

  it('creates no dispatch job at all when accepts race', async () => {
    // Preparing is the only normal dispatch trigger, and a race must not be a
    // way around that. Zero, not "one" — accepting sends no rider.
    const order = await placedOrder();

    const attempt = () =>
      context.app.inject({
        method: 'POST',
        url: `/v1/vendor/orders/${order.id}/accept`,
        headers: vendorA.headers,
        payload: { prepMinutes: 20 },
      });
    await Promise.all([attempt(), attempt()]);

    expect(await outboxFor('dispatch.find_rider', order.id)).toEqual([]);
  });

  it('leaves the order untouched when the loser is refused', async () => {
    // A second accept arriving after the first has settled is the sequential
    // case, already covered by the state machine — asserted here too so the
    // compare-and-set cannot regress it into a silent success.
    const order = await placedOrder();

    const accept = () =>
      context.app.inject({
        method: 'POST',
        url: `/v1/vendor/orders/${order.id}/accept`,
        headers: vendorA.headers,
        payload: { prepMinutes: 20 },
      });

    expect((await accept()).statusCode).toBe(200);
    const settled = await context.prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      select: { revision: true, acceptedAt: true },
    });

    const second = await accept();
    expect(second.statusCode).toBeGreaterThanOrEqual(400);

    const after = await context.prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      select: { revision: true, acceptedAt: true },
    });
    expect(after.revision).toBe(settled.revision);
    expect(after.acceptedAt?.getTime()).toBe(settled.acceptedAt?.getTime());
    expect(
      await context.prisma.orderStatusEvent.findMany({
        where: { orderId: order.id, toStatus: 'accepted' },
      }),
    ).toHaveLength(1);
  });
});
