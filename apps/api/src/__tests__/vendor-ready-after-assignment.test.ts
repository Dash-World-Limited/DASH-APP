/**
 * The vendor can say the food is ready after a rider has already accepted.
 *
 * Regression, found by the end-to-end run against a live API: dispatch starts
 * at `preparing`, so a rider usually accepts while the kitchen is cooking and
 * the order becomes `rider_assigned`. The vendor's "ready" was then refused
 * ("A vendor cannot change an order that is rider_assigned"), so the button
 * failed for most orders and the kitchen's signal was lost.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestContext, type TestContext } from './harness.js';
import { actAs, buildWorld, type Actor, type World } from './world.js';

let context: TestContext;
let world: World;
let vendorA: Actor;
let vendorB: Actor;
let counter = 0;

beforeAll(async () => {
  vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
  context = await createTestContext();
  world = await buildWorld(context.prisma);
  vendorA = await actAs(context, world.vendorA.ownerEmail);
  vendorB = await actAs(context, world.vendorB.ownerEmail);
}, 180_000);

afterAll(async () => {
  await context?.close();
});

async function orderIn(status: string) {
  counter += 1;
  return context.prisma.order.create({
    data: {
      code: `DASH-RDY${counter}-${Date.now()}`,
      customerId: world.customerA.customerId,
      vendorId: world.vendorA.vendorId,
      branchId: world.vendorA.branchId,
      addressId: world.customerA.addressId,
      zoneId: world.zoneId,
      riderId: status === 'rider_assigned' || status === 'rider_arrived' ? world.riderA.riderId : null,
      status,
      mode: 'delivery',
      itemsSubtotal: 100_000,
      total: 100_000,
      quoteBreakdown: '{}',
      pricingRuleVersion: 'test',
    },
  });
}

const markReady = (orderId: string, actor: Actor = vendorA) =>
  context.app.inject({ method: 'POST', url: `/v1/vendor/orders/${orderId}/progress`, headers: actor.headers, payload: { to: 'ready' } });

describe('the pickup code', () => {
  // Regression: the code was generated at checkout, stored only as a hash and
  // never given to anyone, so "Verify pickup code" could never succeed.
  let rider: Actor;
  beforeAll(async () => {
    rider = await actAs(context, world.riderA.email);
  });

  const verify = (orderId: string, code: string, actor: Actor = vendorA) =>
    context.app.inject({ method: 'POST', url: `/v1/vendor/orders/${orderId}/verify-pickup`, headers: actor.headers, payload: { code } });

  it('is shown to the assigned rider, and the vendor can verify it', async () => {
    const order = await orderIn('rider_assigned');
    const delivery = await context.app.inject({ method: 'GET', url: `/v1/rider/deliveries/${order.id}`, headers: rider.headers });
    const code = delivery.json<{ delivery: { pickupCode: string | null } }>().delivery.pickupCode;
    expect(code).toMatch(/^\d{4}$/);

    expect((await verify(order.id, code!)).statusCode).toBe(200);
    const wrong = String((Number(code) + 1) % 10_000).padStart(4, '0');
    expect((await verify(order.id, wrong)).statusCode).toBe(400);
  });

  it('is not shown once the order is picked up', async () => {
    const order = await orderIn('rider_assigned');
    await context.prisma.order.update({ where: { id: order.id }, data: { status: 'picked_up' } });
    const delivery = await context.app.inject({ method: 'GET', url: `/v1/rider/deliveries/${order.id}`, headers: rider.headers });
    expect(delivery.json<{ delivery: { pickupCode: string | null } }>().delivery.pickupCode).toBeNull();
  });

  it('cannot be verified by another vendor, even with the right code', async () => {
    const order = await orderIn('rider_assigned');
    const code = (await context.app.inject({ method: 'GET', url: `/v1/rider/deliveries/${order.id}`, headers: rider.headers }))
      .json<{ delivery: { pickupCode: string } }>().delivery.pickupCode;
    expect((await verify(order.id, code, vendorB)).statusCode).toBe(404);
  });
});

describe('food ready after a rider accepted', () => {
  it.each(['rider_assigned', 'rider_arrived'])('records readyAt and leaves the rider’s status (%s)', async (status) => {
    const order = await orderIn(status);
    const response = await markReady(order.id);
    expect(response.statusCode, response.body).toBe(200);

    const after = await context.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe(status);
    expect(after.readyAt).not.toBeNull();

    // The console can see it, so it can stop offering the button.
    const list = await context.app.inject({ method: 'GET', url: '/v1/vendor/orders?status=active', headers: vendorA.headers });
    const listed = list.json<{ orders: { id: string; readyAt: string | null }[] }>().orders.find((row) => row.id === order.id);
    expect(listed?.readyAt).toBeTruthy();
  });

  it('is recorded once: a second tap changes nothing', async () => {
    const order = await orderIn('rider_assigned');
    await markReady(order.id);
    const first = (await context.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).readyAt;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await markReady(order.id)).statusCode).toBe(200);
    const second = (await context.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).readyAt;
    expect(second?.getTime()).toBe(first?.getTime());
  });

  it('is still refused to another vendor, without revealing the order', async () => {
    const order = await orderIn('rider_assigned');
    const response = await markReady(order.id, vendorB);
    expect(response.statusCode).toBe(404);
    expect((await context.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).readyAt).toBeNull();
  });

  it('does not let "ready" skip preparation', async () => {
    const order = await orderIn('accepted');
    expect((await markReady(order.id)).statusCode).toBe(409);
  });
});
