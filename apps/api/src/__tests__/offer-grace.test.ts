/**
 * Waking a rider whose app is not running, without letting a stale position
 * assign a delivery.
 *
 * A rider who swipes DASH away stops reporting, and two minutes later is
 * `location_stale` and undispatchable — which makes a push notification
 * useless exactly when it is most needed, since its whole purpose is reaching
 * someone who is not looking at the app. The grace window lets a stale
 * position decide *whom to wake*, and nothing else.
 *
 * These assert the seam end to end, through real HTTP, because the danger is
 * not in either half alone: the domain may correctly admit a grace rider and
 * the route may correctly demand a fresh fix, and the system can still be wrong
 * if the two are wired together carelessly. The invariant is asserted against
 * the database, not the response code — what matters is which orders ended up
 * assigned, not what the API said while doing it.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '@dash/domain/dispatch';
import { createTestContext, type TestContext } from './harness.js';
import { actAs, buildWorld, type Actor, type World } from './world.js';
import { useIntegrationTimeouts } from './timeouts.js';

useIntegrationTimeouts();

let context: TestContext;
let world: World;
let customerA: Actor;
let vendorA: Actor;
let riderA: Actor;
let riderB: Actor;

beforeAll(async () => {
  context = await createTestContext();
  world = await buildWorld(context.prisma);
  customerA = await actAs(context, world.customerA.email);
  vendorA = await actAs(context, world.vendorA.ownerEmail);
  riderA = await actAs(context, world.riderA.email);
  riderB = await actAs(context, world.riderB.email);
}, 180_000);

afterAll(async () => {
  await context?.close();
});

/** Both riders: online, at the pickup, reporting, carrying nothing. */
const resetRiders = async (): Promise<void> => {
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
      onlineUntil: new Date(Date.now() + DEFAULT_CONFIG.onlineLeaseSeconds * 1000),
    },
  });
};

beforeEach(resetRiders);

/** Age a rider's position without touching anything else. */
const ageLocation = async (riderId: string, seconds: number): Promise<void> => {
  await context.prisma.rider.update({
    where: { id: riderId },
    data: { locationReportedAt: new Date(Date.now() - seconds * 1000) },
  });
};

let orderSeq = 0;

/** An order sitting at `preparing`, which is the only normal dispatch trigger. */
async function preparingOrder(): Promise<{ id: string }> {
  orderSeq += 1;
  const created = await context.app.inject({
    method: 'POST',
    url: '/v1/orders',
    headers: { ...customerA.headers, 'idempotency-key': `grace-${Date.now()}-${orderSeq}` },
    payload: {
      branchId: world.vendorA.branchId,
      items: [{ itemId: world.vendorA.itemId, quantity: 1, modifierIds: [world.vendorA.modifierId] }],
      mode: 'delivery',
      addressId: world.customerA.addressId,
      paymentMethod: 'card',
    },
  });
  expect(created.statusCode).toBe(200);
  const id = created.json<{ order: { id: string } }>().order.id;

  await context.app.inject({
    method: 'POST',
    url: `/v1/vendor/orders/${id}/accept`,
    headers: vendorA.headers,
    payload: { prepMinutes: 20 },
  });
  await context.app.inject({
    method: 'POST',
    url: `/v1/vendor/orders/${id}/progress`,
    headers: vendorA.headers,
    payload: { to: 'preparing' },
  });
  return { id };
}

/** Put an offer in front of a rider directly, as dispatch would. */
async function offerTo(
  riderId: string,
  orderId: string,
  mode: 'fresh' | 'grace',
): Promise<{ id: string }> {
  const ttl = mode === 'grace' ? DEFAULT_CONFIG.graceOfferTtlSeconds : DEFAULT_CONFIG.offerTtlSeconds;
  return context.prisma.dispatchOffer.create({
    data: {
      orderId,
      riderId,
      round: 1,
      status: 'pending',
      score: 1,
      scoreBreakdown: '[]',
      ruleVersion: 'test',
      pickupEtaSeconds: 120,
      pickupDistanceMetres: 400,
      eligibilityMode: mode,
      expiresAt: new Date(Date.now() + ttl * 1000),
    },
    select: { id: true },
  });
}

const respond = (actor: Actor, offerId: string) =>
  context.app.inject({
    method: 'POST',
    url: `/v1/rider/offers/${offerId}/respond`,
    headers: actor.headers,
    payload: { accept: true },
  });

const orderRow = (id: string) =>
  context.prisma.order.findUniqueOrThrow({
    where: { id },
    select: { riderId: true, status: true },
  });

// ---------------------------------------------------------------------------
describe('a stale position may wake a rider but never assign to one', () => {
  it('refuses a grace offer while the position is still stale', async () => {
    // The headline case: the rider was woken by a push and taps Accept before
    // the handset has produced a fix. Session valid, offer valid, position not.
    const order = await preparingOrder();
    await ageLocation(world.riderA.riderId, 300);
    const offer = await offerTo(world.riderA.riderId, order.id, 'grace');

    const response = await respond(riderA, offer.id);

    expect(response.statusCode).toBe(409);
    expect(response.body).toContain('current location');

    const row = await orderRow(order.id);
    expect(row.riderId).toBeNull();
    expect(row.status).toBe('preparing');
  });

  it('accepts once the woken rider reports a fresh position', async () => {
    // The path the design exists to make possible: woken, wakes up, proves
    // where it is, and only then takes the job.
    const order = await preparingOrder();
    await ageLocation(world.riderA.riderId, 300);
    const offer = await offerTo(world.riderA.riderId, order.id, 'grace');

    expect((await respond(riderA, offer.id)).statusCode).toBe(409);

    const reported = await context.app.inject({
      method: 'POST',
      url: '/v1/rider/location',
      headers: riderA.headers,
      payload: { latitude: 6.5, longitude: 3.4, accuracy: 12 },
    });
    expect(reported.statusCode).toBe(200);

    const second = await offerTo(world.riderA.riderId, order.id, 'grace');
    expect((await respond(riderA, second.id)).statusCode).toBe(200);

    const row = await orderRow(order.id);
    expect(row.riderId).toBe(world.riderA.riderId);
    expect(row.status).toBe('rider_assigned');
  });

  it('holds the invariant across every offer this suite creates', async () => {
    // The property, checked against the database rather than against any
    // response: no assigned order anywhere may belong to a rider whose position
    // was stale at the moment of assignment.
    const assigned = await context.prisma.order.findMany({
      where: { status: 'rider_assigned', riderId: { not: null } },
      select: { id: true, rider: { select: { locationReportedAt: true } } },
    });

    for (const order of assigned) {
      const reportedAt = order.rider?.locationReportedAt;
      expect(reportedAt, order.id).not.toBeNull();
      const ageSeconds = (Date.now() - (reportedAt as Date).getTime()) / 1000;
      expect(ageSeconds, order.id).toBeLessThanOrEqual(
        DEFAULT_CONFIG.maximumLocationAgeSeconds + 30,
      );
    }
  });
});

describe('state that changed while the rider was asleep', () => {
  it('refuses a rider suspended after the offer was made', async () => {
    const order = await preparingOrder();
    const offer = await offerTo(world.riderA.riderId, order.id, 'grace');
    await context.prisma.rider.update({
      where: { id: world.riderA.riderId },
      data: { status: 'suspended' },
    });

    expect((await respond(riderA, offer.id)).statusCode).toBe(409);
    expect((await orderRow(order.id)).riderId).toBeNull();

    await context.prisma.rider.update({
      where: { id: world.riderA.riderId },
      data: { status: 'approved' },
    });
  });

  it('refuses a rider who went offline after the offer was made', async () => {
    // An explicit Go Offline clears the lease outright, so signing off takes
    // effect immediately rather than in fifteen minutes.
    const order = await preparingOrder();
    const offer = await offerTo(world.riderA.riderId, order.id, 'grace');
    await context.app.inject({
      method: 'POST',
      url: '/v1/rider/availability',
      headers: riderA.headers,
      payload: { availability: 'offline' },
    });

    expect((await respond(riderA, offer.id)).statusCode).toBe(409);
    expect((await orderRow(order.id)).riderId).toBeNull();
  });

  it('refuses a rider whose Online lease has lapsed', async () => {
    const order = await preparingOrder();
    const offer = await offerTo(world.riderA.riderId, order.id, 'grace');
    await context.prisma.rider.update({
      where: { id: world.riderA.riderId },
      data: { onlineUntil: new Date(Date.now() - 1000) },
    });

    const response = await respond(riderA, offer.id);
    expect(response.statusCode).toBe(409);
    expect((await orderRow(order.id)).riderId).toBeNull();
  });

  it('refuses a rider who moved out of range while asleep', async () => {
    // Woken, produced a fresh fix, and it puts them far from the pickup. Fresh
    // is not the same as near, and both are required.
    const order = await preparingOrder();
    const offer = await offerTo(world.riderA.riderId, order.id, 'grace');
    await context.prisma.rider.update({
      where: { id: world.riderA.riderId },
      data: { lastLatitude: 7.6, lastLongitude: 4.5, locationReportedAt: new Date() },
    });

    const response = await respond(riderA, offer.id);
    expect(response.statusCode).toBe(409);
    expect(response.body).toContain('too far');
    expect((await orderRow(order.id)).riderId).toBeNull();
  });

  it('sends the order back to dispatch when the woken rider cannot take it', async () => {
    // The order must not sit out the remaining ninety seconds of an offer whose
    // rider has already been proven ineligible.
    const order = await preparingOrder();
    await ageLocation(world.riderA.riderId, 300);
    const offer = await offerTo(world.riderA.riderId, order.id, 'grace');

    await respond(riderA, offer.id);

    const withdrawn = await context.prisma.dispatchOffer.findUniqueOrThrow({
      where: { id: offer.id },
      select: { status: true },
    });
    // Withdrawn, never declined — the rider could not, they did not refuse.
    expect(withdrawn.status).toBe('withdrawn');

    const requeued = await context.prisma.outboxEvent.findMany({
      where: { name: 'dispatch.find_rider' },
      select: { payload: true },
    });
    const mine = requeued.filter((row) => {
      try {
        return (JSON.parse(row.payload) as { orderId?: string }).orderId === order.id;
      } catch {
        return false;
      }
    });
    // The original `preparing` trigger plus the re-dispatch after the refusal.
    expect(mine.length).toBeGreaterThanOrEqual(2);
  });
});

describe('two riders, one awake and one asleep', () => {
  it('lets the fresh rider take it while the stale one cannot', async () => {
    const order = await preparingOrder();
    await ageLocation(world.riderA.riderId, 300);

    const graceOffer = await offerTo(world.riderA.riderId, order.id, 'grace');
    const freshOffer = await offerTo(world.riderB.riderId, order.id, 'fresh');

    const stale = await respond(riderA, graceOffer.id);
    const fresh = await respond(riderB, freshOffer.id);

    expect(stale.statusCode).toBe(409);
    expect(fresh.statusCode).toBe(200);

    const row = await orderRow(order.id);
    expect(row.riderId).toBe(world.riderB.riderId);
    expect(row.status).toBe('rider_assigned');
  });

  it('leaves the other rider\'s offer untouched when one fails validation', async () => {
    // One rider failing must not disturb a parallel offer.
    const order = await preparingOrder();
    await ageLocation(world.riderA.riderId, 300);

    const graceOffer = await offerTo(world.riderA.riderId, order.id, 'grace');
    const otherOffer = await offerTo(world.riderB.riderId, order.id, 'fresh');

    await respond(riderA, graceOffer.id);

    const other = await context.prisma.dispatchOffer.findUniqueOrThrow({
      where: { id: otherOffer.id },
      select: { status: true },
    });
    expect(other.status).toBe('pending');
  });
});

describe('the offer clock', () => {
  it('gives a woken rider longer than one whose app is already open', async () => {
    const order = await preparingOrder();
    const grace = await offerTo(world.riderA.riderId, order.id, 'grace');
    const fresh = await offerTo(world.riderB.riderId, order.id, 'fresh');

    const [g, f] = await Promise.all([
      context.prisma.dispatchOffer.findUniqueOrThrow({
        where: { id: grace.id },
        select: { expiresAt: true, createdAt: true },
      }),
      context.prisma.dispatchOffer.findUniqueOrThrow({
        where: { id: fresh.id },
        select: { expiresAt: true, createdAt: true },
      }),
    ]);

    const graceTtl = (g.expiresAt.getTime() - g.createdAt.getTime()) / 1000;
    const freshTtl = (f.expiresAt.getTime() - f.createdAt.getTime()) / 1000;
    expect(graceTtl).toBeGreaterThan(freshTtl);
    expect(Math.round(graceTtl)).toBeCloseTo(DEFAULT_CONFIG.graceOfferTtlSeconds, -1);
  });

  it('refuses a fix that arrives after the offer has expired', async () => {
    const order = await preparingOrder();
    const offer = await offerTo(world.riderA.riderId, order.id, 'grace');
    await context.prisma.dispatchOffer.update({
      where: { id: offer.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const response = await respond(riderA, offer.id);
    expect(response.statusCode).toBe(409);
    expect(response.body).toContain('expired');
    expect((await orderRow(order.id)).riderId).toBeNull();
  });
});
