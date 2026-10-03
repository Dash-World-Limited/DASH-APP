/**
 * Vendor workflow integration tests.
 *
 * The vendor console is the surface where a competitor's data is one guessed id
 * away, so the cross-tenant probes here matter more than the happy path.
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
let vendorB: Actor;
let riderA: Actor;
let dispatcher: Actor;

beforeAll(async () => {
  context = await createTestContext();
  world = await buildWorld(context.prisma);
  customerA = await actAs(context, world.customerA.email);
  vendorA = await actAs(context, world.vendorA.ownerEmail);
  vendorB = await actAs(context, world.vendorB.ownerEmail);
  riderA = await actAs(context, world.riderA.email);
  dispatcher = await actAs(context, world.dispatcher.email);
}, 180_000);

afterAll(async () => {
  await context?.close();
});

async function placeOrder(vendor: 'A' | 'B' = 'A'): Promise<{ id: string; code: string }> {
  const target = vendor === 'A' ? world.vendorA : world.vendorB;
  const response = await context.app.inject({
    method: 'POST',
    url: '/v1/orders',
    headers: { ...customerA.headers, 'idempotency-key': idempotencyKey('vorder') },
    payload: {
      branchId: target.branchId,
      items: [{ itemId: target.itemId, quantity: 1, modifierIds: [target.modifierId] }],
      mode: 'delivery',
      addressId: world.customerA.addressId,
      paymentMethod: 'card',
    },
  });
  if (response.statusCode !== 200) {
    throw new Error(`placeOrder failed: ${response.statusCode} ${response.body}`);
  }
  return response.json<{ order: { id: string; code: string } }>().order;
}

const accept = (actor: Actor, orderId: string, prepMinutes = 20) =>
  context.app.inject({
    method: 'POST',
    url: `/v1/vendor/orders/${orderId}/accept`,
    headers: actor.headers,
    payload: { prepMinutes },
  });

const progress = (actor: Actor, orderId: string, to: string) =>
  context.app.inject({
    method: 'POST',
    url: `/v1/vendor/orders/${orderId}/progress`,
    headers: actor.headers,
    payload: { to },
  });

// ---------------------------------------------------------------------------
describe('order queue visibility', () => {
  it('shows the vendor only their own orders', async () => {
    const mine = await placeOrder('A');
    const theirs = await placeOrder('B');

    const response = await context.app.inject({
      method: 'GET',
      url: '/v1/vendor/orders?status=incoming',
      headers: vendorA.headers,
    });

    expect(response.statusCode).toBe(200);
    const { orders } = response.json<{ orders: { id: string }[] }>();
    expect(orders.some((order) => order.id === mine.id)).toBe(true);
    expect(orders.some((order) => order.id === theirs.id)).toBe(false);
  });

  it('never exposes the customer phone number or full address', async () => {
    await placeOrder('A');

    const response = await context.app.inject({
      method: 'GET',
      url: '/v1/vendor/orders?status=incoming',
      headers: vendorA.headers,
    });

    // The rider needs these; the kitchen does not.
    expect(response.body).not.toContain(world.customerA.phone);
    expect(response.body).not.toContain('Customer Road');
  });

  it('is refused to a customer, a rider, and a dispatcher', async () => {
    for (const [label, actor] of [
      ['customer', customerA],
      ['rider', riderA],
      ['dispatcher', dispatcher],
    ] as const) {
      const response = await context.app.inject({
        method: 'GET',
        url: '/v1/vendor/orders',
        headers: actor.headers,
      });
      expect(response.statusCode, label).toBe(403);
    }
  });
});

// ---------------------------------------------------------------------------
describe('accept and reject', () => {
  it('accepts a placed order and records the prep estimate', async () => {
    const order = await placeOrder('A');
    const response = await accept(vendorA, order.id, 25);

    expect(response.statusCode).toBe(200);
    expect(response.json<{ accepted: boolean }>().accepted).toBe(true);

    const row = await context.prisma.order.findUnique({
      where: { id: order.id },
      select: { status: true, acceptedAt: true, estimatedReadyAt: true },
    });
    expect(row?.status).toBe('accepted');
    expect(row?.acceptedAt).not.toBeNull();
    expect(row?.estimatedReadyAt).not.toBeNull();
  });

  it('refuses to accept the same order twice', async () => {
    const order = await placeOrder('A');
    expect((await accept(vendorA, order.id)).statusCode).toBe(200);
    expect((await accept(vendorA, order.id)).statusCode).toBe(409);
  });

  it('rejects with a mandatory reason code and queues a refund', async () => {
    const order = await placeOrder('A');

    const response = await context.app.inject({
      method: 'POST',
      url: `/v1/vendor/orders/${order.id}/reject`,
      headers: vendorA.headers,
      payload: { reasonCode: 'out_of_stock' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ rejected: boolean; refundQueued: boolean }>()).toMatchObject({
      rejected: true,
      refundQueued: true,
    });

    const event = await context.prisma.orderStatusEvent.findFirst({
      where: { orderId: order.id, toStatus: 'rejected' },
      select: { reasonCode: true, actorType: true },
    });
    expect(event?.reasonCode).toBe('out_of_stock');
    expect(event?.actorType).toBe('vendor');
  });

  it('refuses a rejection with no reason code', async () => {
    const order = await placeOrder('A');
    const response = await context.app.inject({
      method: 'POST',
      url: `/v1/vendor/orders/${order.id}/reject`,
      headers: vendorA.headers,
      payload: {},
    });
    expect(response.statusCode).toBe(400);
  });

  it('refuses an invented reason code', async () => {
    const order = await placeOrder('A');
    const response = await context.app.inject({
      method: 'POST',
      url: `/v1/vendor/orders/${order.id}/reject`,
      headers: vendorA.headers,
      payload: { reasonCode: 'because-i-said-so' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('cannot reject an order it already accepted and prepared', async () => {
    const order = await placeOrder('A');
    await accept(vendorA, order.id);
    await progress(vendorA, order.id, 'preparing');
    await progress(vendorA, order.id, 'ready');

    const response = await context.app.inject({
      method: 'POST',
      url: `/v1/vendor/orders/${order.id}/reject`,
      headers: vendorA.headers,
      payload: { reasonCode: 'too_busy' },
    });
    expect(response.statusCode).toBe(409);
  });
});

// ---------------------------------------------------------------------------
describe('fulfilment transitions', () => {
  it('walks accepted -> preparing -> ready', async () => {
    const order = await placeOrder('A');
    await accept(vendorA, order.id);

    expect((await progress(vendorA, order.id, 'preparing')).statusCode).toBe(200);
    expect((await progress(vendorA, order.id, 'ready')).statusCode).toBe(200);

    const row = await context.prisma.order.findUnique({
      where: { id: order.id },
      select: { status: true, readyAt: true },
    });
    expect(row?.status).toBe('ready');
    expect(row?.readyAt).not.toBeNull();
  });

  it('refuses to skip preparing', async () => {
    const order = await placeOrder('A');
    await accept(vendorA, order.id);

    const response = await progress(vendorA, order.id, 'ready');
    expect(response.statusCode).toBe(409);
  });

  it('refuses to prepare an order it has not accepted', async () => {
    const order = await placeOrder('A');
    const response = await progress(vendorA, order.id, 'preparing');
    expect(response.statusCode).toBe(409);
  });

  it('refuses to repeat a transition', async () => {
    const order = await placeOrder('A');
    await accept(vendorA, order.id);
    expect((await progress(vendorA, order.id, 'preparing')).statusCode).toBe(200);
    expect((await progress(vendorA, order.id, 'preparing')).statusCode).toBe(409);
  });

  it('refuses a transition target outside the vendor’s vocabulary', async () => {
    const order = await placeOrder('A');
    await accept(vendorA, order.id);

    // `delivered` is a rider transition. A vendor must not be able to name it.
    const response = await progress(vendorA, order.id, 'delivered');
    expect(response.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
describe('cross-vendor access (BOLA)', () => {
  it("cannot accept another vendor's order", async () => {
    const order = await placeOrder('A');

    const response = await accept(vendorB, order.id);
    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: { message: string } }>().error.message).toBe('Not found.');

    // And the order is untouched.
    const row = await context.prisma.order.findUnique({
      where: { id: order.id },
      select: { status: true },
    });
    expect(row?.status).toBe('placed');
  });

  it("cannot reject another vendor's order", async () => {
    const order = await placeOrder('A');
    const response = await context.app.inject({
      method: 'POST',
      url: `/v1/vendor/orders/${order.id}/reject`,
      headers: vendorB.headers,
      payload: { reasonCode: 'too_busy' },
    });
    expect(response.statusCode).toBe(404);
  });

  it("cannot progress another vendor's order", async () => {
    const order = await placeOrder('A');
    await accept(vendorA, order.id);

    const response = await progress(vendorB, order.id, 'preparing');
    expect(response.statusCode).toBe(404);

    const row = await context.prisma.order.findUnique({
      where: { id: order.id },
      select: { status: true },
    });
    expect(row?.status).toBe('accepted');
  });

  it("cannot verify another vendor's pickup code", async () => {
    const order = await placeOrder('A');
    const response = await context.app.inject({
      method: 'POST',
      url: `/v1/vendor/orders/${order.id}/verify-pickup`,
      headers: vendorB.headers,
      payload: { code: '1234' },
    });
    expect(response.statusCode).toBe(404);
  });

  it("cannot change another vendor's branch state", async () => {
    const response = await context.app.inject({
      method: 'PATCH',
      url: `/v1/vendor/branch/${world.vendorA.branchId}/state`,
      headers: vendorB.headers,
      payload: { state: 'closed' },
    });
    expect(response.statusCode).toBe(404);

    const branch = await context.prisma.branch.findUnique({
      where: { id: world.vendorA.branchId },
      select: { state: true },
    });
    expect(branch?.state).toBe('open');
  });

  it("cannot change another vendor's item availability", async () => {
    const response = await context.app.inject({
      method: 'PATCH',
      url: `/v1/vendor/items/${world.vendorA.itemId}/availability`,
      headers: vendorB.headers,
      payload: { isAvailable: false },
    });
    expect(response.statusCode).toBe(404);

    const item = await context.prisma.menuItem.findUnique({
      where: { id: world.vendorA.itemId },
      select: { isAvailable: true },
    });
    expect(item?.isAvailable).toBe(true);
  });

  it('returns the same 404 for a nonexistent order as for a foreign one', async () => {
    const foreign = await placeOrder('A');

    const missing = await accept(vendorB, 'no-such-order-id');
    const notMine = await accept(vendorB, foreign.id);

    expect(missing.statusCode).toBe(404);
    expect(notMine.statusCode).toBe(404);
    expect(missing.json<{ error: { message: string } }>().error.message).toBe(
      notMine.json<{ error: { message: string } }>().error.message,
    );
  });
});

// ---------------------------------------------------------------------------
describe('rider-only and customer-only actions are refused to a vendor', () => {
  it('cannot mark a delivery complete', async () => {
    const order = await placeOrder('A');
    const response = await context.app.inject({
      method: 'POST',
      url: `/v1/rider/deliveries/${order.id}/complete`,
      headers: vendorA.headers,
      payload: { pin: '1234' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('cannot set rider availability', async () => {
    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/rider/availability',
      headers: vendorA.headers,
      payload: { availability: 'idle' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('cannot reassign an order', async () => {
    const order = await placeOrder('A');
    const response = await context.app.inject({
      method: 'POST',
      url: `/v1/ops/orders/${order.id}/reassign`,
      headers: vendorA.headers,
      payload: { reasonCode: 'other' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('cannot approve a refund', async () => {
    const order = await placeOrder('A');
    const response = await context.app.inject({
      method: 'POST',
      url: `/v1/finance/orders/${order.id}/refund`,
      headers: vendorA.headers,
      payload: { amount: 100, reason: 'trying it on' },
    });
    expect(response.statusCode).toBe(403);
  });
});

// ---------------------------------------------------------------------------
describe('branch and catalogue management', () => {
  it('opens, busies, and closes its own branch', async () => {
    for (const state of ['busy', 'closed', 'open'] as const) {
      const response = await context.app.inject({
        method: 'PATCH',
        url: `/v1/vendor/branch/${world.vendorA.branchId}/state`,
        headers: vendorA.headers,
        payload: { state, busyExtraMinutes: state === 'busy' ? 15 : 0 },
      });
      expect(response.statusCode, state).toBe(200);
    }
  });

  it('refuses an invented branch state', async () => {
    const response = await context.app.inject({
      method: 'PATCH',
      url: `/v1/vendor/branch/${world.vendorA.branchId}/state`,
      headers: vendorA.headers,
      payload: { state: 'on_fire' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('blocks ordering from a closed branch', async () => {
    await context.app.inject({
      method: 'PATCH',
      url: `/v1/vendor/branch/${world.vendorA.branchId}/state`,
      headers: vendorA.headers,
      payload: { state: 'closed' },
    });

    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/orders/quote',
      headers: customerA.headers,
      payload: {
        branchId: world.vendorA.branchId,
        items: [{ itemId: world.vendorA.itemId, quantity: 1, modifierIds: [world.vendorA.modifierId] }],
        mode: 'delivery',
        addressId: world.customerA.addressId,
      },
    });
    expect(response.statusCode).toBe(422);

    // Reopen so later tests are unaffected.
    await context.app.inject({
      method: 'PATCH',
      url: `/v1/vendor/branch/${world.vendorA.branchId}/state`,
      headers: vendorA.headers,
      payload: { state: 'open' },
    });
  });

  it('blocks ordering an item it has marked unavailable', async () => {
    await context.app.inject({
      method: 'PATCH',
      url: `/v1/vendor/items/${world.vendorA.itemId}/availability`,
      headers: vendorA.headers,
      payload: { isAvailable: false },
    });

    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/orders/quote',
      headers: customerA.headers,
      payload: {
        branchId: world.vendorA.branchId,
        items: [{ itemId: world.vendorA.itemId, quantity: 1, modifierIds: [world.vendorA.modifierId] }],
        mode: 'delivery',
        addressId: world.customerA.addressId,
      },
    });
    expect(response.statusCode).toBe(422);

    await context.app.inject({
      method: 'PATCH',
      url: `/v1/vendor/items/${world.vendorA.itemId}/availability`,
      headers: vendorA.headers,
      payload: { isAvailable: true },
    });
  });
});

// ---------------------------------------------------------------------------
describe('suspended vendor', () => {
  it('disappears from ordering the moment it is suspended', async () => {
    // Status is a real column with a real effect: `priceBasket` requires
    // `status === 'approved'`. This proves suspension is not cosmetic.
    await context.prisma.vendor.update({
      where: { id: world.vendorB.vendorId },
      data: { status: 'suspended' },
    });

    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/orders/quote',
      headers: customerA.headers,
      payload: {
        branchId: world.vendorB.branchId,
        items: [{ itemId: world.vendorB.itemId, quantity: 1, modifierIds: [world.vendorB.modifierId] }],
        mode: 'delivery',
        addressId: world.customerA.addressId,
      },
    });
    expect(response.statusCode).toBe(404);

    await context.prisma.vendor.update({
      where: { id: world.vendorB.vendorId },
      data: { status: 'approved' },
    });
  });
});

// ---------------------------------------------------------------------------
describe('reports', () => {
  it('reports only the caller’s own vendor figures', async () => {
    const response = await context.app.inject({
      method: 'GET',
      url: '/v1/vendor/reports/summary?days=30',
      headers: vendorA.headers,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ orders: { total: number }; itemsRevenue: number }>();
    expect(body.orders.total).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(body.itemsRevenue)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('dashboard and catalogue editor', () => {
  it('returns only the signed-in vendor dashboard data', async () => {
    const response = await context.app.inject({
      method: 'GET',
      url: '/v1/vendor/dashboard',
      headers: vendorA.headers,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{
      vendor: {
        id: string;
        branches: { id: string }[];
        categories: { items: { id: string }[] }[];
      };
    }>();
    expect(body.vendor.id).toBe(world.vendorA.vendorId);
    expect(body.vendor.branches.some((branch) => branch.id === world.vendorA.branchId)).toBe(true);
    expect(
      body.vendor.categories.flatMap((category) => category.items).some((item) => item.id === world.vendorA.itemId),
    ).toBe(true);
    expect(
      body.vendor.categories.flatMap((category) => category.items).some((item) => item.id === world.vendorB.itemId),
    ).toBe(false);
  });

  it('does not expose the dashboard to non-vendor actors', async () => {
    for (const [label, actor] of [
      ['customer', customerA],
      ['rider', riderA],
      ['dispatcher', dispatcher],
    ] as const) {
      const response = await context.app.inject({
        method: 'GET',
        url: '/v1/vendor/dashboard',
        headers: actor.headers,
      });
      expect(response.statusCode, label).toBe(403);
    }
  });

  it('creates and edits a product inside the caller’s catalogue', async () => {
    const category = await context.prisma.menuItem.findUniqueOrThrow({
      where: { id: world.vendorA.itemId },
      select: { categoryId: true },
    });

    const created = await context.app.inject({
      method: 'POST',
      url: '/v1/vendor/items',
      headers: vendorA.headers,
      payload: {
        categoryId: category.categoryId,
        name: 'Vendor dashboard test item',
        description: 'Created through the vendor catalogue contract.',
        price: 325_000,
        prepMinutes: 12,
        quantity: 8,
      },
    });
    expect(created.statusCode).toBe(200);
    const item = created.json<{ item: { id: string; name: string; price: number } }>().item;
    expect(item).toMatchObject({ name: 'Vendor dashboard test item', price: 325_000 });

    const changed = await context.app.inject({
      method: 'PATCH',
      url: `/v1/vendor/items/${item.id}`,
      headers: vendorA.headers,
      payload: { name: 'Edited dashboard item', price: 350_000 },
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json<{ item: { name: string; price: number } }>().item).toMatchObject({
      name: 'Edited dashboard item',
      price: 350_000,
    });
  });

  it('creates real product options that customer checkout can quote', async () => {
    const category = await context.prisma.menuItem.findUniqueOrThrow({
      where: { id: world.vendorA.itemId },
      select: { categoryId: true },
    });

    const created = await context.app.inject({
      method: 'POST',
      url: '/v1/vendor/items',
      headers: vendorA.headers,
      payload: {
        categoryId: category.categoryId,
        name: 'Rice with protein choice',
        price: 250_000,
        prepMinutes: 10,
      },
    });
    expect(created.statusCode).toBe(200);
    const itemId = created.json<{ item: { id: string } }>().item.id;

    const choices = await context.app.inject({
      method: 'PUT',
      url: `/v1/vendor/items/${itemId}/modifiers`,
      headers: vendorA.headers,
      payload: {
        groups: [
          {
            name: 'Choose your protein',
            minSelect: 1,
            maxSelect: 1,
            options: [
              { name: 'Beef', priceDelta: 100_000 },
              { name: 'Chicken', priceDelta: 150_000 },
            ],
          },
        ],
      },
    });
    expect(choices.statusCode).toBe(200);
    const group = choices.json<{
      groups: {
        id: string;
        name: string;
        options: { id: string; name: string }[];
      }[];
    }>().groups[0];
    expect(group?.name).toBe('Choose your protein');
    const beef = group?.options.find((option) => option.name === 'Beef');
    expect(beef?.id).toBeTruthy();

    const quote = await context.app.inject({
      method: 'POST',
      url: '/v1/orders/quote',
      headers: customerA.headers,
      payload: {
        branchId: world.vendorA.branchId,
        items: [{ itemId, quantity: 1, modifierIds: [beef!.id] }],
        mode: 'delivery',
        addressId: world.customerA.addressId,
      },
    });
    expect(quote.statusCode).toBe(200);

    const dashboard = await context.app.inject({
      method: 'GET',
      url: '/v1/vendor/dashboard',
      headers: vendorA.headers,
    });
    expect(dashboard.statusCode).toBe(200);
    const dashboardItems = dashboard.json<{
      vendor: {
        categories: {
          items: {
            id: string;
            modifierGroups: { name: string; options: { name: string }[] }[];
          }[];
        }[];
      };
    }>().vendor.categories.flatMap((entry) => entry.items);
    const saved = dashboardItems.find((entry) => entry.id === itemId);
    expect(saved?.modifierGroups[0]?.options.map((option) => option.name)).toEqual(['Beef', 'Chicken']);
  });

  it('cannot replace another vendor’s product options', async () => {
    const response = await context.app.inject({
      method: 'PUT',
      url: `/v1/vendor/items/${world.vendorB.itemId}/modifiers`,
      headers: vendorA.headers,
      payload: {
        groups: [
          {
            name: 'Not yours',
            minSelect: 0,
            maxSelect: 1,
            options: [{ name: 'Nope', priceDelta: 0 }],
          },
        ],
      },
    });
    expect(response.statusCode).toBe(404);
  });

  it('sanitises and attaches a real product image', async () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==',
      'base64',
    );

    const response = await context.app.inject({
      method: 'PUT',
      url: `/v1/vendor/items/${world.vendorA.itemId}/image`,
      headers: {
        ...vendorA.headers,
        'content-type': 'image/png',
      },
      payload: png,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ image: { key: string; url: string } }>();
    expect(body.image.key).toMatch(/^vendor-products\/[0-9a-f]{48}$/);
    expect(body.image.url).toContain('/v1/files/');

    const saved = await context.prisma.menuItem.findUniqueOrThrow({
      where: { id: world.vendorA.itemId },
      select: { imageKey: true },
    });
    expect(saved.imageKey).toBe(body.image.key);
  });

  it('rejects image-shaped hostile bytes before storage', async () => {
    const fakePng = Buffer.concat([
      Buffer.from('89504e470d0a1a0a', 'hex'),
      Buffer.from('<script>alert(1)</script>'),
    ]);

    const response = await context.app.inject({
      method: 'PUT',
      url: `/v1/vendor/items/${world.vendorA.itemId}/image`,
      headers: {
        ...vendorA.headers,
        'content-type': 'image/png',
      },
      payload: fakePng,
    });

    expect(response.statusCode).toBe(400);
  });

  it('cannot upload an image to another vendor’s product', async () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==',
      'base64',
    );
    const response = await context.app.inject({
      method: 'PUT',
      url: `/v1/vendor/items/${world.vendorB.itemId}/image`,
      headers: {
        ...vendorA.headers,
        'content-type': 'image/png',
      },
      payload: png,
    });
    expect(response.statusCode).toBe(404);
  });

  it('cannot add a product to another vendor’s category', async () => {
    const foreign = await context.prisma.menuItem.findUniqueOrThrow({
      where: { id: world.vendorB.itemId },
      select: { categoryId: true },
    });
    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/vendor/items',
      headers: vendorA.headers,
      payload: {
        categoryId: foreign.categoryId,
        name: 'Cross-tenant item',
        price: 100_000,
      },
    });
    expect(response.statusCode).toBe(404);
  });

  it('cannot edit another vendor’s product', async () => {
    const response = await context.app.inject({
      method: 'PATCH',
      url: `/v1/vendor/items/${world.vendorB.itemId}`,
      headers: vendorA.headers,
      payload: { name: 'Not yours' },
    });
    expect(response.statusCode).toBe(404);
  });
});
