/**
 * Batch 2 delivery experience: calling the assigned rider, and rating the
 * rider who delivered.
 *
 * The rider's phone number reaches only the order's own customer, only while
 * that rider is assigned and working the order, and always the number of the
 * rider the order names. A rating is accepted only for a delivered order,
 * only from its customer, only once, and always against the order's own rider.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './harness.js';
import { actAs, buildWorld, idempotencyKey, type Actor, type World } from './world.js';

let context: TestContext;
let world: World;
let customerA: Actor;
let customerB: Actor;
let riderA: Actor;

beforeAll(async () => {
  context = await createTestContext();
  world = await buildWorld(context.prisma);
  customerA = await actAs(context, world.customerA.email);
  customerB = await actAs(context, world.customerB.email);
  riderA = await actAs(context, world.riderA.email);
}, 180_000);

afterAll(async () => {
  await context?.close();
});

async function placeOrder(label: string): Promise<string> {
  const response = await context.app.inject({
    method: 'POST',
    url: '/v1/orders',
    headers: { ...customerA.headers, 'idempotency-key': idempotencyKey(label) },
    payload: {
      branchId: world.vendorA.branchId,
      items: [{ itemId: world.vendorA.itemId, quantity: 1, modifierIds: [world.vendorA.modifierId] }],
      mode: 'delivery',
      addressId: world.customerA.addressId,
      paymentMethod: 'card',
    },
  });
  expect(response.statusCode).toBe(200);
  return response.json<{ order: { id: string } }>().order.id;
}

async function setOrder(id: string, data: { status: string; riderId?: string | null; deliveredAt?: Date | null }) {
  await context.prisma.order.update({ where: { id }, data });
}

interface DetailBody {
  order: {
    rider: { name: string | null; phone: string | null } | null;
    riderRating: { riderName: string | null; canRate: boolean; rating: { rating: number; comment: string | null } | null } | null;
  };
}

async function detail(id: string, actor: Actor = customerA) {
  return context.app.inject({ method: 'GET', url: `/v1/orders/${id}`, headers: actor.headers });
}

async function rate(id: string, payload: unknown, actor: Actor = customerA) {
  return context.app.inject({ method: 'POST', url: `/v1/orders/${id}/rider-rating`, headers: actor.headers, payload: payload as object });
}

describe('calling the assigned rider', () => {
  it('shares no rider and no number before a rider is assigned', async () => {
    const id = await placeOrder('call-before');
    await setOrder(id, { status: 'ready' });
    const body = (await detail(id)).json<DetailBody>();
    expect(body.order.rider).toBeNull();
    expect(JSON.stringify(body)).not.toContain(world.riderA.phone);
  });

  it('gives the customer the assigned rider’s own number while they work the order', async () => {
    const id = await placeOrder('call-active');
    for (const status of ['rider_assigned', 'rider_arrived', 'picked_up', 'en_route', 'arrived']) {
      await setOrder(id, { status, riderId: world.riderA.riderId });
      const response = await detail(id);
      expect(response.statusCode).toBe(200);
      expect(response.json<DetailBody>().order.rider?.phone).toBe(world.riderA.phone);
    }
  });

  it('follows the order to whichever rider it names', async () => {
    const id = await placeOrder('call-reassigned');
    await setOrder(id, { status: 'rider_assigned', riderId: world.riderB.riderId });
    const body = (await detail(id)).json<DetailBody>();
    expect(body.order.rider?.phone).toBe(world.riderB.phone);
    expect(JSON.stringify(body)).not.toContain(world.riderA.phone);
  });

  it('stops sharing the number once the delivery is over', async () => {
    const id = await placeOrder('call-after');
    await setOrder(id, { status: 'delivered', riderId: world.riderA.riderId, deliveredAt: new Date() });
    const body = (await detail(id)).json<DetailBody>();
    expect(body.order.rider).toBeNull();
    expect(JSON.stringify(body)).not.toContain(world.riderA.phone);

    const cancelled = await placeOrder('call-cancelled');
    await setOrder(cancelled, { status: 'cancelled', riderId: world.riderA.riderId });
    expect(JSON.stringify((await detail(cancelled)).json())).not.toContain(world.riderA.phone);
  });

  it('never gives the number to another customer', async () => {
    const id = await placeOrder('call-other');
    await setOrder(id, { status: 'en_route', riderId: world.riderA.riderId });
    const response = await detail(id, customerB);
    expect([403, 404]).toContain(response.statusCode);
    expect(response.body).not.toContain(world.riderA.phone);
  });
});

describe('rating the rider who delivered', () => {
  it('refuses an order that has not been delivered', async () => {
    const id = await placeOrder('rate-active');
    await setOrder(id, { status: 'en_route', riderId: world.riderA.riderId });
    const response = await rate(id, { rating: 5 });
    expect(response.statusCode).toBe(409);
    expect((await detail(id)).json<DetailBody>().order.riderRating).toBeNull();

    const cancelled = await placeOrder('rate-cancelled');
    await setOrder(cancelled, { status: 'cancelled', riderId: world.riderA.riderId });
    expect((await rate(cancelled, { rating: 5 })).statusCode).toBe(409);
    expect(await context.prisma.review.count({ where: { orderId: { in: [id, cancelled] } } })).toBe(0);
  });

  it('refuses a delivered order no rider carried', async () => {
    const id = await placeOrder('rate-no-rider');
    await setOrder(id, { status: 'delivered', riderId: null, deliveredAt: new Date() });
    expect((await rate(id, { rating: 4 })).statusCode).toBe(409);
    expect((await detail(id)).json<DetailBody>().order.riderRating).toBeNull();
  });

  it('records one rating against the exact rider and order', async () => {
    const id = await placeOrder('rate-ok');
    await setOrder(id, { status: 'delivered', riderId: world.riderA.riderId, deliveredAt: new Date() });

    const before = (await detail(id)).json<DetailBody>().order.riderRating;
    expect(before).toMatchObject({ canRate: true, rating: null });

    const response = await rate(id, { rating: 4, comment: '  Quick and polite.  ' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ rating: { rating: 4, comment: 'Quick and polite.' } });

    const stored = await context.prisma.review.findMany({ where: { orderId: id } });
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      subject: 'rider',
      riderId: world.riderA.riderId,
      customerId: world.customerA.customerId,
      vendorId: null,
      rating: 4,
    });

    const after = (await detail(id)).json<DetailBody>().order.riderRating;
    expect(after).toMatchObject({ canRate: false, rating: { rating: 4, comment: 'Quick and polite.' } });

    const again = await rate(id, { rating: 1 });
    expect(again.statusCode).toBe(409);
    expect(await context.prisma.review.count({ where: { orderId: id } })).toBe(1);
  });

  it('lets two taps at once record only one rating', async () => {
    const id = await placeOrder('rate-race');
    await setOrder(id, { status: 'delivered', riderId: world.riderA.riderId, deliveredAt: new Date() });
    const results = await Promise.all([rate(id, { rating: 5 }), rate(id, { rating: 5 })]);
    expect(results.map((result) => result.statusCode).sort()).toEqual([200, 409]);
    expect(await context.prisma.review.count({ where: { orderId: id } })).toBe(1);
  });

  it('accepts a rating without a comment', async () => {
    const id = await placeOrder('rate-no-comment');
    await setOrder(id, { status: 'delivered', riderId: world.riderA.riderId, deliveredAt: new Date() });
    const response = await rate(id, { rating: 3, comment: '   ' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ rating: { rating: 3, comment: null } });
  });

  it('never lets the client choose the rider, or send a bad score', async () => {
    const id = await placeOrder('rate-invalid');
    await setOrder(id, { status: 'delivered', riderId: world.riderA.riderId, deliveredAt: new Date() });
    for (const payload of [
      { rating: 5, riderId: world.riderB.riderId },
      { rating: 0 },
      { rating: 6 },
      { rating: 4.5 },
      { rating: '5' },
      {},
      { rating: 5, comment: 'x'.repeat(501) },
    ]) {
      expect((await rate(id, payload)).statusCode).toBe(400);
    }
    expect(await context.prisma.review.count({ where: { orderId: id } })).toBe(0);
  });

  it('refuses everyone but the order’s customer', async () => {
    const id = await placeOrder('rate-others');
    await setOrder(id, { status: 'delivered', riderId: world.riderA.riderId, deliveredAt: new Date() });

    expect([403, 404]).toContain((await rate(id, { rating: 1 }, customerB)).statusCode);
    expect([403, 404]).toContain((await rate(id, { rating: 5 }, riderA)).statusCode);
    const anonymous = await context.app.inject({ method: 'POST', url: `/v1/orders/${id}/rider-rating`, payload: { rating: 5 } });
    expect(anonymous.statusCode).toBe(401);
    expect((await rate('no-such-order', { rating: 5 })).statusCode).toBe(404);
    expect(await context.prisma.review.count({ where: { orderId: id } })).toBe(0);
  });
});

describe('confirming the home screen delivery location', () => {
  it('saves the found position as the only default, and orders use it', async () => {
    const existing = await context.prisma.address.findUniqueOrThrow({ where: { id: world.customerA.addressId } });
    const created = await context.app.inject({
      method: 'POST',
      url: '/v1/addresses',
      headers: customerB.headers,
      payload: {
        line1: 'Corrected street name, near the found spot',
        contactPhone: world.customerB.phone,
        latitude: existing.latitude,
        longitude: existing.longitude,
        isDefault: true,
      },
    });
    expect(created.statusCode).toBe(200);
    const id = created.json<{ address: { id: string } }>().address.id;

    const listed = await context.app.inject({ method: 'GET', url: '/v1/addresses', headers: customerB.headers });
    const addresses = listed.json<{ addresses: Array<{ id: string; isDefault: boolean; latitude: number; longitude: number }> }>().addresses;
    expect(addresses.filter((address) => address.isDefault).map((address) => address.id)).toEqual([id]);
    expect(addresses[0]).toMatchObject({ id, latitude: existing.latitude, longitude: existing.longitude });

    const quote = await context.app.inject({
      method: 'POST',
      url: '/v1/orders/quote',
      headers: customerB.headers,
      payload: {
        branchId: world.vendorA.branchId,
        items: [{ itemId: world.vendorA.itemId, quantity: 1, modifierIds: [world.vendorA.modifierId] }],
        mode: 'delivery',
        addressId: id,
      },
    });
    expect(quote.statusCode).toBe(200);
  });

  it('cannot be saved against another customer’s address list', async () => {
    const response = await context.app.inject({
      method: 'PATCH',
      url: `/v1/addresses/${world.customerA.addressId}`,
      headers: customerB.headers,
      payload: { isDefault: true },
    });
    expect(response.statusCode).toBe(404);
  });
});
