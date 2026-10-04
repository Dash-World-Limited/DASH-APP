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

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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

/**
 * Release deliveries left assigned by earlier tests.
 *
 * Acceptance now enforces vehicle capacity, which dispatch always enforced but
 * the accept path never re-checked. These tests share one database and rarely
 * complete the trips they start, so a fixture rider accumulated assignments
 * until the fourth accept in the file was refused as `at_capacity` — a real
 * rule, correctly applied, to a rider who in reality would have finished those
 * deliveries hours ago.
 *
 * Cancelled rather than delivered: fabricating completed deliveries would move
 * earnings and completion counts that other tests assert on, whereas a
 * cancelled order is simply no longer active.
 */
beforeEach(async () => {
  await context.prisma.order.updateMany({
    where: {
      riderId: { in: [world.riderA.riderId, world.riderB.riderId] },
      status: { in: ['rider_assigned', 'rider_arrived', 'picked_up', 'en_route', 'arrived'] },
    },
    data: { status: 'cancelled' },
  });
  // And keep them reporting.
  //
  // `buildWorld` stamps a position once, but acceptance requires one no older
  // than 120s and this file takes minutes to run — so by the later tests a
  // fixture rider was `location_stale` and could not accept anything. A real
  // online rider reports every twenty seconds; this is the fixture equivalent,
  // and without it the suite would be asserting against a rider who has
  // effectively gone dark.
  await context.prisma.rider.updateMany({
    where: { id: { in: [world.riderA.riderId, world.riderB.riderId] } },
    data: {
      availability: 'idle',
      // Back to the fixture's own position, not just a fresh timestamp. The
      // location-reporting tests deliberately move riders around — teleports,
      // returns from elsewhere — and acceptance now re-measures distance to the
      // pickup against wherever the rider actually is. Refreshing the clock
      // without the coordinates leaves a rider who is provably present and
      // provably in the wrong city.
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

  it('keeps accepting positions once the rider is on a delivery', async () => {
    // `on_delivery` is a state the rider cannot select — the server sets it on
    // assignment. The offline rule must refuse `offline` and nothing else: a
    // delivery in progress is when the customer is actively watching the rider
    // approach, and it is the worst possible moment to stop knowing where they
    // are. Freshness and the plausibility check are untouched by this.
    await baseline(6.5, 3.4);
    await context.prisma.rider.update({
      where: { id: world.riderA.riderId },
      data: { availability: 'on_delivery' },
    });

    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/rider/location',
      headers: riderA.headers,
      payload: { latitude: 6.5013, longitude: 3.4004, accuracy: 10 },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ accepted: boolean }>().accepted).toBe(true);

    // Put the rider back, because the server rightly refuses to let a rider go
    // offline mid-delivery and the following tests need to be able to.
    await context.prisma.rider.update({
      where: { id: world.riderA.riderId },
      data: { availability: 'idle' },
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
describe('preparing is the only trigger for normal dispatch', () => {
  /**
   * Which transition sends a rider, and which deliberately do not.
   *
   * This started as a regression test for a queue-key collision: checkout and
   * vendor-accept both enqueued `dispatch.find_rider` under the same key, so
   * the queue — which remembers keys for ever, because that is what makes
   * at-least-once delivery safe — silently discarded the second one.
   *
   * The rule it guards has since changed, and the reason is worth keeping. A
   * rider is now sent when the vendor moves the order into `preparing`, and at
   * no other point in the normal path. Checkout is before the vendor has
   * agreed to make the order at all. Accepting is agreement without
   * commitment — a vendor may accept several orders and start them in whatever
   * sequence suits the kitchen, and a rider dispatched on accept waits at a
   * counter for food that is fourth in line. `ready` is too late: the food is
   * already sitting there while a rider is still being found.
   *
   * So the assertions below are as much about the transitions that must stay
   * silent as the one that must fire.
   */
  async function placedOrder(tag: string): Promise<string> {
    const created = await context.app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: { ...customerA.headers, 'idempotency-key': idempotencyKey(tag) },
      payload: {
        branchId: world.vendorA.branchId,
        items: [
          { itemId: world.vendorA.itemId, quantity: 1, modifierIds: [world.vendorA.modifierId] },
        ],
        mode: 'delivery',
        addressId: world.customerA.addressId,
        paymentMethod: 'card',
      },
    });
    expect(created.statusCode).toBe(200);
    return created.json<{ order: { id: string } }>().order.id;
  }

  /**
   * The dispatch intents recorded for exactly this order.
   *
   * Matched by parsing the payload rather than by a substring search over it.
   * `contains` would also match a payload that merely mentions this order id
   * somewhere else, and an assertion that something did *not* happen is only
   * as trustworthy as its ability to see everything that did.
   */
  const dispatchJobs = async (orderId: string): Promise<string[]> => {
    const rows = await context.prisma.outboxEvent.findMany({
      where: { name: 'dispatch.find_rider' },
      select: { idempotencyKey: true, payload: true },
    });
    return rows
      .filter((row) => {
        try {
          return (JSON.parse(row.payload) as { orderId?: string }).orderId === orderId;
        } catch {
          return false;
        }
      })
      .map((row) => row.idempotencyKey ?? '');
  };

  /** Take an order to `accepted`, the state `preparing` is legal from. */
  const acceptedOrder = async (tag: string): Promise<string> => {
    const orderId = await placedOrder(tag);
    const accepted = await context.app.inject({
      method: 'POST',
      url: `/v1/vendor/orders/${orderId}/accept`,
      headers: vendorA.headers,
      payload: { prepMinutes: 20 },
    });
    expect(accepted.statusCode).toBe(200);
    return orderId;
  };

  it('does not dispatch when the order is merely placed', async () => {
    const orderId = await placedOrder('dtrig1');
    expect(await dispatchJobs(orderId)).toEqual([]);
  });

  it('does not dispatch when the vendor only accepts', async () => {
    const orderId = await placedOrder('dtrig2');

    const accepted = await context.app.inject({
      method: 'POST',
      url: `/v1/vendor/orders/${orderId}/accept`,
      headers: vendorA.headers,
      payload: { prepMinutes: 20 },
    });
    expect(accepted.statusCode).toBe(200);

    // Accepting is agreement, not commitment. No rider is sent yet.
    expect(await dispatchJobs(orderId)).toEqual([]);
  });

  it('dispatches exactly once when the vendor starts preparing', async () => {
    const orderId = await placedOrder('dtrig3');

    await context.app.inject({
      method: 'POST',
      url: `/v1/vendor/orders/${orderId}/accept`,
      headers: vendorA.headers,
      payload: { prepMinutes: 20 },
    });

    const preparing = await context.app.inject({
      method: 'POST',
      url: `/v1/vendor/orders/${orderId}/progress`,
      headers: vendorA.headers,
      payload: { to: 'preparing' },
    });
    expect(preparing.statusCode).toBe(200);

    expect(await dispatchJobs(orderId)).toEqual([`dispatch_${orderId}_preparing`]);
  });

  it('does not dispatch again when the order becomes ready', async () => {
    const orderId = await placedOrder('dtrig4');

    for (const step of [
      { url: `/v1/vendor/orders/${orderId}/accept`, payload: { prepMinutes: 20 } },
      { url: `/v1/vendor/orders/${orderId}/progress`, payload: { to: 'preparing' } },
      { url: `/v1/vendor/orders/${orderId}/progress`, payload: { to: 'ready' } },
    ]) {
      const response = await context.app.inject({
        method: 'POST',
        url: step.url,
        headers: vendorA.headers,
        payload: step.payload,
      });
      expect(response.statusCode).toBe(200);
    }

    // Still the single job from `preparing` — `ready` adds nothing.
    expect(await dispatchJobs(orderId)).toEqual([`dispatch_${orderId}_preparing`]);
  });

  it('records one dispatch intent when two Preparing transitions race', async () => {
    // The sequential case is guarded by the state machine, but `assertTransition`
    // runs on an order read *before* the transaction opens. Two requests can
    // therefore both read `accepted`, both judge the transition legal, and both
    // proceed — and `OutboxEvent.idempotencyKey` is deliberately not unique, so
    // the database will not stop a second intent being written.
    //
    // One intent means one round of offers. Two would mean a rider being
    // offered work that another rider may already be riding to collect.
    const orderId = await acceptedOrder('dtrig6');

    const startPreparing = () =>
      context.app.inject({
        method: 'POST',
        url: `/v1/vendor/orders/${orderId}/progress`,
        headers: vendorA.headers,
        payload: { to: 'preparing' },
      });

    const responses = await Promise.all([startPreparing(), startPreparing()]);

    // At least one must succeed — a race must not lose the transition entirely.
    expect(responses.some((response) => response.statusCode === 200)).toBe(true);

    // The assertion that matters: exactly one intent, carrying exactly the key
    // this transition owns, associated with exactly this order.
    const keys = await dispatchJobs(orderId);
    expect(keys).toEqual([`dispatch_${orderId}_preparing`]);
  });

  it('cannot be made to dispatch twice by repeating the transition', async () => {
    // A double-tapped button, or a retried request. The state machine refuses
    // `preparing -> preparing`, and the idempotency key would stop the queue
    // running a redelivered publication twice even if it did not.
    const orderId = await placedOrder('dtrig5');

    await context.app.inject({
      method: 'POST',
      url: `/v1/vendor/orders/${orderId}/accept`,
      headers: vendorA.headers,
      payload: { prepMinutes: 20 },
    });

    const first = await context.app.inject({
      method: 'POST',
      url: `/v1/vendor/orders/${orderId}/progress`,
      headers: vendorA.headers,
      payload: { to: 'preparing' },
    });
    expect(first.statusCode).toBe(200);

    const second = await context.app.inject({
      method: 'POST',
      url: `/v1/vendor/orders/${orderId}/progress`,
      headers: vendorA.headers,
      payload: { to: 'preparing' },
    });
    expect(second.statusCode).toBeGreaterThanOrEqual(400);

    const keys = await dispatchJobs(orderId);
    expect(keys).toEqual([`dispatch_${orderId}_preparing`]);
    expect(new Set(keys).size).toBe(keys.length);
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
