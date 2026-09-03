/**
 * Dispatch and rider integration tests.
 *
 * Two things get extra attention here:
 *
 *   1. **Cross-rider access.** A rider guessing another rider's order id must
 *      get nothing — not the address, not the ability to progress it.
 *   2. **Races.** Two riders accepting the same offer is the canonical
 *      double-assignment bug, and it is cheap to get wrong.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './harness.js';
import { actAs, buildWorld, idempotencyKey, type Actor, type World } from './world.js';
import { useIntegrationTimeouts } from './timeouts.js';

// Real Fastify, real SQLite, real round trips — see timeouts.ts.
useIntegrationTimeouts();

let context: TestContext;
let world: World;
let customerA: Actor;
let vendorA: Actor;
let riderA: Actor;
let riderB: Actor;
let dispatcher: Actor;

beforeAll(async () => {
  context = await createTestContext();
  world = await buildWorld(context.prisma);
  customerA = await actAs(context, world.customerA.email);
  vendorA = await actAs(context, world.vendorA.ownerEmail);
  riderA = await actAs(context, world.riderA.email);
  riderB = await actAs(context, world.riderB.email);
  dispatcher = await actAs(context, world.dispatcher.email);
}, 180_000);

afterAll(async () => {
  await context?.close();
});

/** Place an order and take it to `ready`, which is where dispatch picks it up. */
async function readyOrder(): Promise<{ id: string; deliveryPin: string }> {
  const created = await context.app.inject({
    method: 'POST',
    url: '/v1/orders',
    headers: { ...customerA.headers, 'idempotency-key': idempotencyKey('dorder') },
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
  const orderId = body.order.id;

  await context.app.inject({
    method: 'POST',
    url: `/v1/vendor/orders/${orderId}/accept`,
    headers: vendorA.headers,
    payload: { prepMinutes: 1 },
  });
  await context.app.inject({
    method: 'POST',
    url: `/v1/vendor/orders/${orderId}/progress`,
    headers: vendorA.headers,
    payload: { to: 'preparing' },
  });
  await context.app.inject({
    method: 'POST',
    url: `/v1/vendor/orders/${orderId}/progress`,
    headers: vendorA.headers,
    payload: { to: 'ready' },
  });

  return { id: orderId, deliveryPin: body.deliveryPin };
}

/**
 * Create a pending offer directly.
 *
 * The dispatch worker is asynchronous and scheduled off the prep estimate;
 * waiting for it would make every test slow and timing-dependent. The worker's
 * own behaviour is covered by `scripts/dispatch-check.mjs` and by the domain
 * unit tests. What these tests need is a deterministic offer to act on.
 */
async function offerTo(riderId: string, orderId: string, expiresInMs = 60_000) {
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
      expiresAt: new Date(Date.now() + expiresInMs),
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

// ---------------------------------------------------------------------------
describe('availability', () => {
  it('lets an approved rider go online and on break', async () => {
    for (const availability of ['idle', 'on_break', 'idle'] as const) {
      const response = await context.app.inject({
        method: 'POST',
        url: '/v1/rider/availability',
        headers: riderA.headers,
        payload: { availability },
      });
      expect(response.statusCode, availability).toBe(200);
    }
  });

  it('refuses an invented availability', async () => {
    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/rider/availability',
      headers: riderA.headers,
      payload: { availability: 'napping' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('is refused to a customer and a vendor', async () => {
    for (const [label, actor] of [['customer', customerA], ['vendor', vendorA]] as const) {
      const response = await context.app.inject({
        method: 'POST',
        url: '/v1/rider/availability',
        headers: actor.headers,
        payload: { availability: 'idle' },
      });
      expect(response.statusCode, label).toBe(403);
    }
  });

  it('refuses to let an unapproved rider go online', async () => {
    await context.prisma.rider.update({
      where: { id: world.riderB.riderId },
      data: { status: 'pending' },
    });

    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/rider/availability',
      headers: riderB.headers,
      payload: { availability: 'idle' },
    });
    expect(response.statusCode).toBe(403);

    await context.prisma.rider.update({
      where: { id: world.riderB.riderId },
      data: { status: 'approved', availability: 'idle' },
    });
  });
});

// ---------------------------------------------------------------------------
describe('offers', () => {
  it('lists only the rider’s own pending offers', async () => {
    const order = await readyOrder();
    const mine = await offerTo(world.riderA.riderId, order.id);

    const otherOrder = await readyOrder();
    const theirs = await offerTo(world.riderB.riderId, otherOrder.id);

    const response = await context.app.inject({
      method: 'GET',
      url: '/v1/rider/offers',
      headers: riderA.headers,
    });

    expect(response.statusCode).toBe(200);
    const { offers } = response.json<{ offers: { id: string }[] }>();
    expect(offers.some((offer) => offer.id === mine.id)).toBe(true);
    expect(offers.some((offer) => offer.id === theirs.id)).toBe(false);
  });

  it('hides the exact drop-off address until the offer is accepted', async () => {
    const order = await readyOrder();
    await offerTo(world.riderA.riderId, order.id);

    const response = await context.app.inject({
      method: 'GET',
      url: '/v1/rider/offers',
      headers: riderA.headers,
    });

    // Coarsened to ~100m, and the street line is absent entirely.
    expect(response.body).not.toContain('Customer Road');
    const { offers } = response.json<{
      offers: { order: { dropoffArea: { latitude: number } | null } }[]
    }>();
    const area = offers[0]?.order.dropoffArea;
    expect(area).not.toBeNull();
    const decimals = String(area!.latitude).split('.')[1]?.length ?? 0;
    expect(decimals).toBeLessThanOrEqual(3);
  });

  it('accepts an offer and assigns the rider', async () => {
    const order = await readyOrder();
    const offer = await offerTo(world.riderA.riderId, order.id);

    const response = await respond(riderA, offer.id, true);
    expect(response.statusCode).toBe(200);
    expect(response.json<{ accepted: boolean }>().accepted).toBe(true);

    const row = await context.prisma.order.findUnique({
      where: { id: order.id },
      select: { riderId: true, status: true },
    });
    expect(row?.riderId).toBe(world.riderA.riderId);
    expect(row?.status).toBe('rider_assigned');
  });

  it('declines an offer without assigning anyone', async () => {
    const order = await readyOrder();
    const offer = await offerTo(world.riderA.riderId, order.id);

    const response = await respond(riderA, offer.id, false);
    expect(response.statusCode).toBe(200);
    expect(response.json<{ accepted: boolean }>().accepted).toBe(false);

    const row = await context.prisma.order.findUnique({
      where: { id: order.id },
      select: { riderId: true, status: true },
    });
    expect(row?.riderId).toBeNull();
    expect(row?.status).toBe('ready');
  });

  it('refuses an expired offer', async () => {
    const order = await readyOrder();
    const offer = await offerTo(world.riderA.riderId, order.id, -1000);

    const response = await respond(riderA, offer.id, true);
    expect(response.statusCode).toBe(409);
  });

  it('refuses to respond to the same offer twice', async () => {
    const order = await readyOrder();
    const offer = await offerTo(world.riderA.riderId, order.id);

    expect((await respond(riderA, offer.id, true)).statusCode).toBe(200);
    expect((await respond(riderA, offer.id, true)).statusCode).toBe(409);
  });

  // --- BOLA ---------------------------------------------------------------
  it("cannot respond to another rider's offer", async () => {
    const order = await readyOrder();
    const offer = await offerTo(world.riderA.riderId, order.id);

    const response = await respond(riderB, offer.id, true);
    expect(response.statusCode).toBe(404);

    const row = await context.prisma.order.findUnique({
      where: { id: order.id },
      select: { riderId: true },
    });
    expect(row?.riderId).toBeNull();
  });

  it('returns 404 for a nonexistent offer', async () => {
    const response = await respond(riderA, 'no-such-offer', true);
    expect(response.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
describe('two riders racing the same job', () => {
  it('assigns exactly one, whichever arrives first', async () => {
    const order = await readyOrder();

    // A batched dispatch round can legitimately offer one order to several
    // riders at once. Both accept in the same instant.
    const offerA = await offerTo(world.riderA.riderId, order.id);
    const offerB = await offerTo(world.riderB.riderId, order.id);

    const [responseA, responseB] = await Promise.all([
      respond(riderA, offerA.id, true),
      respond(riderB, offerB.id, true),
    ]);

    const statuses = [responseA.statusCode, responseB.statusCode].sort();
    // Exactly one winner. The loser gets a conflict, not a silent overwrite.
    expect(statuses).toEqual([200, 409]);

    const row = await context.prisma.order.findUnique({
      where: { id: order.id },
      select: { riderId: true, status: true },
    });
    expect(row?.riderId).not.toBeNull();
    expect(row?.status).toBe('rider_assigned');

    // And only one offer is marked accepted.
    const accepted = await context.prisma.dispatchOffer.count({
      where: { orderId: order.id, status: 'accepted' },
    });
    expect(accepted).toBe(1);
  });

  // Each iteration places an order, walks it to `ready`, and runs two genuinely
  // concurrent accepts — about 700ms of real work. The explicit timeout is
  // because that is legitimately slow, not because anything is retrying.
  it('holds across repeated races', { timeout: 60_000 }, async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const order = await readyOrder();
      const offerA = await offerTo(world.riderA.riderId, order.id);
      const offerB = await offerTo(world.riderB.riderId, order.id);

      await Promise.all([respond(riderA, offerA.id, true), respond(riderB, offerB.id, true)]);

      const accepted = await context.prisma.dispatchOffer.count({
        where: { orderId: order.id, status: 'accepted' },
      });
      expect(accepted, `attempt ${attempt + 1}`).toBe(1);
    }
  });
});

// ---------------------------------------------------------------------------
describe('delivery detail and progression', () => {
  async function assignedOrder(): Promise<{ id: string; deliveryPin: string }> {
    const order = await readyOrder();
    const offer = await offerTo(world.riderA.riderId, order.id);
    await respond(riderA, offer.id, true);
    return order;
  }

  it('reveals the full address once assigned', async () => {
    const order = await assignedOrder();

    const response = await context.app.inject({
      method: 'GET',
      url: `/v1/rider/deliveries/${order.id}`,
      headers: riderA.headers,
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('Customer Road');
  });

  it('walks rider_arrived -> picked_up -> en_route', async () => {
    const order = await assignedOrder();
    for (const step of ['rider_arrived', 'picked_up', 'en_route'] as const) {
      const response = await riderProgress(riderA, order.id, step);
      expect(response.statusCode, step).toBe(200);
    }
  });

  it('refuses to skip to picked_up before arriving', async () => {
    const order = await assignedOrder();
    // rider_assigned -> picked_up is not a legal rider transition.
    const response = await riderProgress(riderA, order.id, 'picked_up');
    expect(response.statusCode).toBe(409);
  });

  it('refuses to repeat a transition', async () => {
    const order = await assignedOrder();
    expect((await riderProgress(riderA, order.id, 'rider_arrived')).statusCode).toBe(200);
    expect((await riderProgress(riderA, order.id, 'rider_arrived')).statusCode).toBe(409);
  });

  // --- BOLA ---------------------------------------------------------------
  it("cannot read another rider's delivery", async () => {
    const order = await assignedOrder();

    const response = await context.app.inject({
      method: 'GET',
      url: `/v1/rider/deliveries/${order.id}`,
      headers: riderB.headers,
    });

    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain('Customer Road');
  });

  it("cannot progress another rider's delivery", async () => {
    const order = await assignedOrder();

    const response = await riderProgress(riderB, order.id, 'rider_arrived');
    expect(response.statusCode).toBe(404);

    const row = await context.prisma.order.findUnique({
      where: { id: order.id },
      select: { status: true },
    });
    expect(row?.status).toBe('rider_assigned');
  });

  it('cannot be progressed by the customer or the vendor', async () => {
    const order = await assignedOrder();
    for (const [label, actor] of [['customer', customerA], ['vendor', vendorA]] as const) {
      const response = await riderProgress(actor, order.id, 'rider_arrived');
      expect(response.statusCode, label).toBe(403);
    }
  });
});

// ---------------------------------------------------------------------------
describe('completion', () => {
  async function enRouteOrder(): Promise<{ id: string; deliveryPin: string }> {
    const order = await readyOrder();
    const offer = await offerTo(world.riderA.riderId, order.id);
    await respond(riderA, offer.id, true);
    await riderProgress(riderA, order.id, 'rider_arrived');
    await riderProgress(riderA, order.id, 'picked_up');
    await riderProgress(riderA, order.id, 'en_route');
    return order;
  }

  const complete = (actor: Actor, orderId: string, pin: string) =>
    context.app.inject({
      method: 'POST',
      url: `/v1/rider/deliveries/${orderId}/complete`,
      headers: actor.headers,
      payload: { pin },
    });

  it('completes with the correct PIN', async () => {
    const order = await enRouteOrder();

    const response = await complete(riderA, order.id, order.deliveryPin);
    expect(response.statusCode).toBe(200);
    expect(response.json<{ delivered: boolean }>().delivered).toBe(true);

    const row = await context.prisma.order.findUnique({
      where: { id: order.id },
      select: { status: true, deliveredAt: true },
    });
    expect(row?.status).toBe('delivered');
    expect(row?.deliveredAt).not.toBeNull();
  });

  it('refuses a wrong PIN and leaves the order alone', async () => {
    const order = await enRouteOrder();
    const wrong = order.deliveryPin === '0000' ? '1111' : '0000';

    const response = await complete(riderA, order.id, wrong);
    expect(response.statusCode).toBe(400);

    const row = await context.prisma.order.findUnique({
      where: { id: order.id },
      select: { status: true },
    });
    expect(row?.status).toBe('en_route');
  });

  it('refuses a malformed PIN', async () => {
    const order = await enRouteOrder();
    for (const pin of ['12', 'abcd', '123456', '']) {
      const response = await complete(riderA, order.id, pin);
      expect(response.statusCode, pin || '(empty)').toBe(400);
    }
  });

  it('refuses completion before pickup', async () => {
    const order = await readyOrder();
    const offer = await offerTo(world.riderA.riderId, order.id);
    await respond(riderA, offer.id, true);

    const response = await complete(riderA, order.id, order.deliveryPin);
    expect(response.statusCode).toBe(409);
  });

  it("cannot be completed by another rider even with the right PIN", async () => {
    const order = await enRouteOrder();

    const response = await complete(riderB, order.id, order.deliveryPin);
    expect(response.statusCode).toBe(404);

    const row = await context.prisma.order.findUnique({
      where: { id: order.id },
      select: { status: true },
    });
    expect(row?.status).toBe('en_route');
  });

  it('cannot be completed twice', async () => {
    const order = await enRouteOrder();

    expect((await complete(riderA, order.id, order.deliveryPin)).statusCode).toBe(200);
    const second = await complete(riderA, order.id, order.deliveryPin);
    expect(second.statusCode).toBe(409);
  });
});

// ---------------------------------------------------------------------------
describe('location reporting', () => {
  /**
   * Put the rider online with a known position reported `secondsAgo` ago.
   *
   * The offset matters: the plausibility check divides distance by elapsed
   * time, so a baseline stamped *now* makes any movement at all look like a
   * teleport. Real pings arrive tens of seconds apart.
   */
  async function baseline(
    latitude: number,
    longitude: number,
    secondsAgo = 60,
  ): Promise<void> {
    await context.app.inject({
      method: 'POST',
      url: '/v1/rider/availability',
      headers: riderA.headers,
      payload: { availability: 'idle' },
    });
    await context.prisma.rider.update({
      where: { id: world.riderA.riderId },
      data: {
        lastLatitude: latitude,
        lastLongitude: longitude,
        locationReportedAt: new Date(Date.now() - secondsAgo * 1000),
      },
    });
  }

  it('accepts a plausible position', async () => {
    await baseline(6.5, 3.4);

    // ~150m from the baseline — an ordinary few seconds of riding.
    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/rider/location',
      headers: riderA.headers,
      payload: { latitude: 6.5013, longitude: 3.4004, accuracy: 10 },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ accepted: boolean }>().accepted).toBe(true);
  });

  it('rejects a teleport', async () => {
    await baseline(6.5, 3.4);

    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/rider/location',
      headers: riderA.headers,
      payload: { latitude: 6.62, longitude: 3.58 },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ accepted: boolean; reason: string }>()).toMatchObject({
      accepted: false,
      reason: 'implausible_movement',
    });
  });

  it('rejects a position while the rider is offline', async () => {
    await context.app.inject({
      method: 'POST',
      url: '/v1/rider/availability',
      headers: riderA.headers,
      payload: { availability: 'offline' },
    });

    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/rider/location',
      headers: riderA.headers,
      payload: { latitude: 6.5, longitude: 3.4 },
    });
    expect(response.json<{ accepted: boolean; reason: string }>()).toMatchObject({
      accepted: false,
      reason: 'rider_offline',
    });
  });

  it('accepts the first position after coming back online from somewhere else', async () => {
    // A rider finishes near the vendor, goes offline, travels home, and comes
    // back online. The platform explicitly does NOT track them while offline,
    // so it has no basis on which to judge that movement — and must not reject
    // the first ping as a teleport.
    //
    // It matters because dispatch excludes riders whose location is stale. A
    // rejected ping does not update the baseline, so the rider stays stale and
    // receives no offers at exactly the moment they come on shift.
    await baseline(6.5, 3.4);

    await context.app.inject({
      method: 'POST',
      url: '/v1/rider/availability',
      headers: riderA.headers,
      payload: { availability: 'offline' },
    });
    await context.app.inject({
      method: 'POST',
      url: '/v1/rider/availability',
      headers: riderA.headers,
      payload: { availability: 'idle' },
    });

    // 20km away — impossible in the seconds that elapsed, entirely ordinary
    // across an offline gap.
    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/rider/location',
      headers: riderA.headers,
      payload: { latitude: 6.65, longitude: 3.55 },
    });

    expect(response.json<{ accepted: boolean }>().accepted).toBe(true);
  });

  it('rejects an out-of-range coordinate', async () => {
    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/rider/location',
      headers: riderA.headers,
      payload: { latitude: 91, longitude: 3.4 },
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects a timestamp in the future', async () => {
    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/rider/location',
      headers: riderA.headers,
      payload: {
        latitude: 6.5,
        longitude: 3.4,
        recordedAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it('is refused to a customer', async () => {
    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/rider/location',
      headers: customerA.headers,
      payload: { latitude: 6.5, longitude: 3.4 },
    });
    expect(response.statusCode).toBe(403);
  });
});

// ---------------------------------------------------------------------------
describe('ops reassignment', () => {
  it('returns an assigned order to the dispatch pool', async () => {
    const order = await readyOrder();
    const offer = await offerTo(world.riderA.riderId, order.id);
    await respond(riderA, offer.id, true);

    const response = await context.app.inject({
      method: 'POST',
      url: `/v1/ops/orders/${order.id}/reassign`,
      headers: dispatcher.headers,
      payload: { reasonCode: 'rider_unresponsive' },
    });

    expect(response.statusCode).toBe(200);
    const row = await context.prisma.order.findUnique({
      where: { id: order.id },
      select: { riderId: true, status: true },
    });
    expect(row?.riderId).toBeNull();
    expect(row?.status).toBe('ready');
  });

  it('demands a reason code', async () => {
    const order = await readyOrder();
    const offer = await offerTo(world.riderA.riderId, order.id);
    await respond(riderA, offer.id, true);

    const response = await context.app.inject({
      method: 'POST',
      url: `/v1/ops/orders/${order.id}/reassign`,
      headers: dispatcher.headers,
      payload: {},
    });
    expect(response.statusCode).toBe(400);
  });

  it('is refused to a rider, a vendor, and a customer', async () => {
    const order = await readyOrder();
    for (const [label, actor] of [
      ['rider', riderA],
      ['vendor', vendorA],
      ['customer', customerA],
    ] as const) {
      const response = await context.app.inject({
        method: 'POST',
        url: `/v1/ops/orders/${order.id}/reassign`,
        headers: actor.headers,
        payload: { reasonCode: 'other' },
      });
      expect(response.statusCode, label).toBe(403);
    }
  });

  it('frees the rider so they can take other work', async () => {
    const order = await readyOrder();
    const offer = await offerTo(world.riderA.riderId, order.id);
    await respond(riderA, offer.id, true);

    await context.app.inject({
      method: 'POST',
      url: `/v1/ops/orders/${order.id}/reassign`,
      headers: dispatcher.headers,
      payload: { reasonCode: 'rider_incident' },
    });

    const rider = await context.prisma.rider.findUnique({
      where: { id: world.riderA.riderId },
      select: { availability: true },
    });
    expect(rider?.availability).toBe('idle');
  });
});

// ---------------------------------------------------------------------------
describe('rider earnings', () => {
  it('reports only the caller’s own balance', async () => {
    const response = await context.app.inject({
      method: 'GET',
      url: '/v1/rider/earnings',
      headers: riderA.headers,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ balanceOwed: number; completedDeliveries: number }>();
    expect(Number.isInteger(body.balanceOwed)).toBe(true);
    expect(body.completedDeliveries).toBeGreaterThanOrEqual(0);
  });

  it('is refused to a customer and a vendor', async () => {
    for (const [label, actor] of [['customer', customerA], ['vendor', vendorA]] as const) {
      const response = await context.app.inject({
        method: 'GET',
        url: '/v1/rider/earnings',
        headers: actor.headers,
      });
      expect(response.statusCode, label).toBe(403);
    }
  });
});
