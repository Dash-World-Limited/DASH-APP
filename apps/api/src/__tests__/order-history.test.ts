/**
 * Order history keeps showing what was bought and where it went.
 *
 * An order is placed; then the customer edits and removes the saved address,
 * the vendor renames itself, and the product is renamed and repriced. The
 * customer's receipt, the rider's delivery history and the staff record must
 * all still show the order exactly as it was placed — and only to the people
 * entitled to see it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './harness.js';
import { actAs, buildWorld, idempotencyKey, type Actor, type World } from './world.js';

let context: TestContext;
let world: World;
let customerA: Actor;
let customerB: Actor;
let riderA: Actor;
let riderB: Actor;
let support: Actor;

let orderId: string;
let orderCode: string;
let addressId: string;
const ORIGINAL = { line1: '7 Snapshot Avenue', landmark: 'By the blue gate' };
let originalItemName: string;
let originalUnitPrice: number;
let originalVendorName: string;

beforeAll(async () => {
  context = await createTestContext();
  world = await buildWorld(context.prisma);
  customerA = await actAs(context, world.customerA.email);
  customerB = await actAs(context, world.customerB.email);
  riderA = await actAs(context, world.riderA.email);
  riderB = await actAs(context, world.riderB.email);
  support = await actAs(context, world.support.email);

  // An address of its own, so editing it touches nothing else in the world.
  const home = await context.prisma.address.findUniqueOrThrow({ where: { id: world.customerA.addressId } });
  addressId = (
    await context.prisma.address.create({
      data: {
        customerId: world.customerA.customerId,
        label: 'Home',
        line1: ORIGINAL.line1,
        landmark: ORIGINAL.landmark,
        contactPhone: world.customerA.phone,
        latitude: home.latitude,
        longitude: home.longitude,
      },
    })
  ).id;

  const item = await context.prisma.menuItem.findUniqueOrThrow({ where: { id: world.vendorA.itemId } });
  originalItemName = item.name;
  originalVendorName = (await context.prisma.vendor.findUniqueOrThrow({ where: { id: world.vendorA.vendorId } })).name;

  const placed = await context.app.inject({
    method: 'POST',
    url: '/v1/orders',
    headers: { ...customerA.headers, 'idempotency-key': idempotencyKey('history') },
    payload: {
      branchId: world.vendorA.branchId,
      items: [{ itemId: world.vendorA.itemId, quantity: 2, modifierIds: [world.vendorA.modifierId] }],
      mode: 'delivery',
      addressId,
      paymentMethod: 'card',
    },
  });
  expect(placed.statusCode).toBe(200);
  ({ id: orderId, code: orderCode } = placed.json<{ order: { id: string; code: string } }>().order);
  originalUnitPrice = (await context.prisma.orderItem.findFirstOrThrow({ where: { orderId } })).priceSnapshot;

  await context.prisma.order.update({
    where: { id: orderId },
    data: { status: 'delivered', riderId: world.riderA.riderId, deliveredAt: new Date(), pickedUpAt: new Date() },
  });

  // Everything the order pointed at now changes.
  const edited = await context.app.inject({
    method: 'PATCH',
    url: `/v1/addresses/${addressId}`,
    headers: customerA.headers,
    payload: { line1: '99 Somewhere Else Road', landmark: 'New landmark' },
  });
  expect(edited.statusCode).toBe(200);
  expect((await context.app.inject({ method: 'DELETE', url: `/v1/addresses/${addressId}`, headers: customerA.headers })).statusCode).toBe(200);
  await context.prisma.vendor.update({ where: { id: world.vendorA.vendorId }, data: { name: 'Renamed Vendor Ltd' } });
  await context.prisma.menuItem.update({ where: { id: world.vendorA.itemId }, data: { name: 'Renamed Dish', price: item.price + 77_700 } });
}, 180_000);

afterAll(async () => {
  await context?.close();
});

describe('what the order froze at placement', () => {
  it('stores the address and seller as they were', async () => {
    const order = await context.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.vendorNameSnapshot).toBe(originalVendorName);
    expect(JSON.parse(order.deliveryAddressSnapshot!)).toMatchObject({ label: 'Home', ...ORIGINAL, contactPhone: world.customerA.phone });
  });
});

describe('the customer’s receipt', () => {
  it('shows the original address, seller and items after everything changed', async () => {
    const response = await context.app.inject({ method: 'GET', url: `/v1/orders/${orderId}`, headers: customerA.headers });
    expect(response.statusCode).toBe(200);
    const order = response.json<{
      order: { vendor: { name: string }; address: { line1: string; landmark: string }; items: Array<{ nameSnapshot: string; priceSnapshot: number; quantity: number }> };
    }>().order;
    expect(order.vendor.name).toBe(originalVendorName);
    expect(order.address).toMatchObject(ORIGINAL);
    expect(order.items).toEqual([expect.objectContaining({ nameSnapshot: originalItemName, priceSnapshot: originalUnitPrice, quantity: 2 })]);
    expect(response.body).not.toContain('Somewhere Else');
    expect(response.body).not.toContain('Renamed');
  });

  it('lists the order under the seller it was bought from', async () => {
    const response = await context.app.inject({ method: 'GET', url: '/v1/orders?status=past', headers: customerA.headers });
    const listed = response.json<{ orders: Array<{ id: string; vendor: { name: string }; items: Array<{ nameSnapshot: string }> }> }>().orders;
    const mine = listed.find((order) => order.id === orderId);
    expect(mine?.vendor.name).toBe(originalVendorName);
    expect(mine?.items[0]?.nameSnapshot).toBe(originalItemName);
  });

  it('falls back to the saved address for an order from before snapshots', async () => {
    const legacy = await context.app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: { ...customerA.headers, 'idempotency-key': idempotencyKey('legacy') },
      payload: {
        branchId: world.vendorA.branchId,
        items: [{ itemId: world.vendorA.itemId, quantity: 1, modifierIds: [world.vendorA.modifierId] }],
        mode: 'delivery',
        addressId: world.customerA.addressId,
        paymentMethod: 'card',
      },
    });
    const id = legacy.json<{ order: { id: string } }>().order.id;
    await context.prisma.order.update({ where: { id }, data: { deliveryAddressSnapshot: null, vendorNameSnapshot: null } });
    const saved = await context.prisma.address.findUniqueOrThrow({ where: { id: world.customerA.addressId } });
    const order = (await context.app.inject({ method: 'GET', url: `/v1/orders/${id}`, headers: customerA.headers })).json<{
      order: { address: { line1: string }; vendor: { name: string } };
    }>().order;
    expect(order.address.line1).toBe(saved.line1);
    expect(order.vendor.name).toBe('Renamed Vendor Ltd');
  });
});

describe('the rider’s delivery history', () => {
  it('shows the delivering rider exactly what they delivered', async () => {
    const response = await context.app.inject({ method: 'GET', url: `/v1/rider/history/${orderId}`, headers: riderA.headers });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      delivery: {
        id: orderId,
        code: orderCode,
        status: 'delivered',
        vendorName: originalVendorName,
        deliveryAddress: ORIGINAL,
        items: [{ name: originalItemName, quantity: 2 }],
      },
    });
    // The customer's number is not repeated once the job is over.
    expect(response.body).not.toContain(world.customerA.phone);
  });

  it('is invisible to any other rider, to customers, and before delivery', async () => {
    expect((await context.app.inject({ method: 'GET', url: `/v1/rider/history/${orderId}`, headers: riderB.headers })).statusCode).toBe(404);
    expect((await context.app.inject({ method: 'GET', url: `/v1/rider/history/${orderId}`, headers: customerA.headers })).statusCode).toBe(403);
    expect((await context.app.inject({ method: 'GET', url: `/v1/rider/history/${orderId}` })).statusCode).toBe(401);

    await context.prisma.order.update({ where: { id: orderId }, data: { status: 'en_route' } });
    expect((await context.app.inject({ method: 'GET', url: `/v1/rider/history/${orderId}`, headers: riderA.headers })).statusCode).toBe(404);
    await context.prisma.order.update({ where: { id: orderId }, data: { status: 'delivered' } });
  });
});

describe('the staff record', () => {
  it('shows the full order as placed, by code or by id', async () => {
    for (const ref of [orderCode, orderCode.toLowerCase(), orderId]) {
      const response = await context.app.inject({ method: 'GET', url: `/v1/admin/orders/${ref}`, headers: support.headers });
      expect(response.statusCode).toBe(200);
      const order = response.json<{
        order: {
          code: string;
          vendor: { name: string; currentName: string };
          customer: { id: string };
          rider: { id: string } | null;
          deliveryAddress: { line1: string };
          deliveryAddressFrozen: boolean;
          items: Array<{ name: string; unitPrice: number; quantity: number; lineTotal: number; currentName: string | null; stillListed: boolean }>;
          totals: { total: number };
          timestamps: { deliveredAt: string | null };
        };
      }>().order;
      expect(order.code).toBe(orderCode);
      expect(order.vendor).toMatchObject({ name: originalVendorName, currentName: 'Renamed Vendor Ltd' });
      expect(order.customer.id).toBe(world.customerA.customerId);
      expect(order.rider?.id).toBe(world.riderA.riderId);
      expect(order.deliveryAddress).toMatchObject(ORIGINAL);
      expect(order.deliveryAddressFrozen).toBe(true);
      expect(order.items).toEqual([
        expect.objectContaining({ name: originalItemName, unitPrice: originalUnitPrice, quantity: 2, currentName: 'Renamed Dish', stillListed: true }),
      ]);
      expect(order.totals.total).toBeGreaterThan(0);
      expect(order.timestamps.deliveredAt).not.toBeNull();
    }
  });

  it('is refused to customers, riders and anonymous callers, and 404s an unknown order', async () => {
    for (const actor of [customerA, customerB, riderA]) {
      expect((await context.app.inject({ method: 'GET', url: `/v1/admin/orders/${orderCode}`, headers: actor.headers })).statusCode).toBe(403);
    }
    expect((await context.app.inject({ method: 'GET', url: `/v1/admin/orders/${orderCode}` })).statusCode).toBe(401);
    expect((await context.app.inject({ method: 'GET', url: '/v1/admin/orders/DASH-NOPE00', headers: support.headers })).statusCode).toBe(404);
  });
});
