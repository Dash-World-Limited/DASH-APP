/**
 * Order lifecycle integration tests.
 *
 * The customer half of the journey: quote, checkout, read, list, cancel — plus
 * every way a hostile or careless client can get it wrong.
 *
 * The authorization assertions here are the point. A passing 200 proves the
 * happy path; the 404s prove the platform is safe to run.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './harness.js';
import { actAs, buildWorld, idempotencyKey, type Actor, type World } from './world.js';

let context: TestContext;
let world: World;
let customerA: Actor;
let customerB: Actor;
let vendorA: Actor;
let riderA: Actor;
let support: Actor;

beforeAll(async () => {
  context = await createTestContext();
  world = await buildWorld(context.prisma);
  customerA = await actAs(context, world.customerA.email);
  customerB = await actAs(context, world.customerB.email);
  vendorA = await actAs(context, world.vendorA.ownerEmail);
  riderA = await actAs(context, world.riderA.email);
  support = await actAs(context, world.support.email);
}, 180_000);

afterAll(async () => {
  await context?.close();
});

/** A valid basket for vendor A, satisfying the required modifier group. */
function basket(overrides: Record<string, unknown> = {}) {
  return {
    branchId: world.vendorA.branchId,
    items: [
      { itemId: world.vendorA.itemId, quantity: 1, modifierIds: [world.vendorA.modifierId] },
    ],
    mode: 'delivery',
    addressId: world.customerA.addressId,
    ...overrides,
  };
}

async function placeOrder(
  actor: Actor = customerA,
  overrides: Record<string, unknown> = {},
): Promise<{ id: string; code: string; total: number; deliveryPin: string }> {
  const response = await context.app.inject({
    method: 'POST',
    url: '/v1/orders',
    headers: { ...actor.headers, 'idempotency-key': idempotencyKey('order') },
    payload: { ...basket(overrides), paymentMethod: 'card' },
  });
  if (response.statusCode !== 200) {
    throw new Error(`placeOrder failed: ${response.statusCode} ${response.body}`);
  }
  const body = response.json<{
    order: { id: string; code: string; total: number };
    deliveryPin: string;
  }>();
  return { ...body.order, deliveryPin: body.deliveryPin };
}

// ---------------------------------------------------------------------------
describe('quote', () => {
  it('prices a valid basket', async () => {
    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/orders/quote',
      headers: customerA.headers,
      payload: basket(),
    });

    expect(response.statusCode).toBe(200);
    const { quote } = response.json<{ quote: { total: number; lines: unknown[] } }>();
    // 3000 item + 1000 modifier = 4000, plus delivery and service fee.
    expect(quote.total).toBeGreaterThan(400_000);
    expect(quote.lines.length).toBeGreaterThan(1);
  });

  it('ignores a client-supplied price', async () => {
    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/orders/quote',
      headers: customerA.headers,
      payload: { ...basket(), itemsSubtotal: 1, total: 1, price: 1 },
    });

    const { quote } = response.json<{ quote: { itemsSubtotal: number } }>();
    expect(quote.itemsSubtotal).toBe(400_000);
  });

  it('rejects a basket whose required modifier group is unsatisfied', async () => {
    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/orders/quote',
      headers: customerA.headers,
      payload: basket({
        items: [{ itemId: world.vendorA.itemId, quantity: 1, modifierIds: [] }],
      }),
    });
    expect(response.statusCode).toBe(422);
  });

  it("rejects a modifier belonging to another vendor's item", async () => {
    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/orders/quote',
      headers: customerA.headers,
      payload: basket({
        items: [
          { itemId: world.vendorA.itemId, quantity: 1, modifierIds: [world.vendorB.modifierId] },
        ],
      }),
    });
    expect(response.statusCode).toBe(422);
  });

  it("rejects an item from a different vendor than the branch", async () => {
    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/orders/quote',
      headers: customerA.headers,
      payload: basket({
        items: [{ itemId: world.vendorB.itemId, quantity: 1, modifierIds: [] }],
      }),
    });
    expect(response.statusCode).toBe(422);
  });

  it('rejects malformed input', async () => {
    const cases = [
      { label: 'negative quantity', payload: basket({ items: [{ itemId: world.vendorA.itemId, quantity: -1, modifierIds: [] }] }) },
      { label: 'zero quantity', payload: basket({ items: [{ itemId: world.vendorA.itemId, quantity: 0, modifierIds: [] }] }) },
      { label: 'empty basket', payload: basket({ items: [] }) },
      { label: 'missing branch', payload: { ...basket(), branchId: undefined } },
      { label: 'negative tip', payload: basket({ tip: -100 }) },
    ];

    for (const testCase of cases) {
      const response = await context.app.inject({
        method: 'POST',
        url: '/v1/orders/quote',
        headers: customerA.headers,
        payload: testCase.payload,
      });
      expect(response.statusCode, testCase.label).toBe(400);
    }
  });

  it('rejects a nonexistent branch as not found', async () => {
    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/orders/quote',
      headers: customerA.headers,
      payload: basket({ branchId: 'no-such-branch' }),
    });
    expect(response.statusCode).toBe(404);
  });

  // --- BOLA ----------------------------------------------------------------
  it("refuses to price a delivery to another customer's address", async () => {
    // Otherwise the fee itself leaks roughly where a stranger lives.
    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/orders/quote',
      headers: customerA.headers,
      payload: basket({ addressId: world.customerB.addressId }),
    });
    expect(response.statusCode).toBe(404);
  });

  it('is refused to a vendor, a rider, and support', async () => {
    for (const [label, actor] of [
      ['vendor', vendorA],
      ['rider', riderA],
      ['support', support],
    ] as const) {
      const response = await context.app.inject({
        method: 'POST',
        url: '/v1/orders/quote',
        headers: actor.headers,
        payload: basket(),
      });
      expect(response.statusCode, label).toBe(403);
    }
  });

  it('is refused without authentication', async () => {
    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/orders/quote',
      payload: basket(),
    });
    expect(response.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
describe('create order', () => {
  it('places an order and returns a delivery PIN once', async () => {
    const order = await placeOrder();
    expect(order.id).toBeTruthy();
    expect(order.code).toMatch(/^DASH-/);
    expect(order.deliveryPin).toMatch(/^\d{4}$/);
  });

  it('reaches "placed" after the mock payment captures', async () => {
    const order = await placeOrder();
    const row = await context.prisma.order.findUnique({
      where: { id: order.id },
      select: { status: true },
    });
    expect(row?.status).toBe('placed');
  });

  it('requires an Idempotency-Key', async () => {
    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: customerA.headers,
      payload: { ...basket(), paymentMethod: 'card' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('returns the original order when the key is replayed', async () => {
    const key = idempotencyKey('replay');
    const send = () =>
      context.app.inject({
        method: 'POST',
        url: '/v1/orders',
        headers: { ...customerA.headers, 'idempotency-key': key },
        payload: { ...basket(), paymentMethod: 'card' },
      });

    const first = await send();
    const second = await send();

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json<{ order: { id: string } }>().order.id).toBe(
      first.json<{ order: { id: string } }>().order.id,
    );

    // And only one order actually exists for that key.
    const count = await context.prisma.order.count({
      where: { code: first.json<{ order: { code: string } }>().order.code },
    });
    expect(count).toBe(1);
  });

  it("never lets one customer order to another customer's address", async () => {
    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: { ...customerA.headers, 'idempotency-key': idempotencyKey('bola') },
      payload: { ...basket({ addressId: world.customerB.addressId }), paymentMethod: 'card' },
    });
    expect(response.statusCode).toBe(404);
  });

  it('is refused to non-customers', async () => {
    for (const [label, actor] of [['vendor', vendorA], ['rider', riderA]] as const) {
      const response = await context.app.inject({
        method: 'POST',
        url: '/v1/orders',
        headers: { ...actor.headers, 'idempotency-key': idempotencyKey('deny') },
        payload: { ...basket(), paymentMethod: 'card' },
      });
      expect(response.statusCode, label).toBe(403);
    }
  });
});

// ---------------------------------------------------------------------------
describe('read own order', () => {
  it('returns the order with an explained receipt', async () => {
    const order = await placeOrder();
    const response = await context.app.inject({
      method: 'GET',
      url: `/v1/orders/${order.id}`,
      headers: customerA.headers,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{
      order: { code: string; quoteBreakdown: { lines: unknown[] } };
      cancellation: { allowed: boolean };
    }>();
    expect(body.order.code).toBe(order.code);
    expect(body.order.quoteBreakdown.lines.length).toBeGreaterThan(1);
    expect(body.cancellation.allowed).toBe(true);
  });

  it('never echoes the delivery PIN back', async () => {
    const order = await placeOrder();
    const response = await context.app.inject({
      method: 'GET',
      url: `/v1/orders/${order.id}`,
      headers: customerA.headers,
    });
    expect(response.body).not.toContain(order.deliveryPin);
  });

  // --- BOLA ----------------------------------------------------------------
  it("refuses another customer's order, as Not found", async () => {
    const order = await placeOrder(customerA);

    const response = await context.app.inject({
      method: 'GET',
      url: `/v1/orders/${order.id}`,
      headers: customerB.headers,
    });

    expect(response.statusCode).toBe(404);
    // Indistinguishable from a nonexistent order, so probing reveals nothing.
    expect(response.json<{ error: { message: string } }>().error.message).toBe('Not found.');
  });

  it('returns the same 404 for a nonexistent order', async () => {
    const response = await context.app.inject({
      method: 'GET',
      url: '/v1/orders/no-such-order',
      headers: customerA.headers,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: { message: string } }>().error.message).toBe('Not found.');
  });

  it('is refused to a vendor and a rider', async () => {
    const order = await placeOrder();
    for (const [label, actor] of [['vendor', vendorA], ['rider', riderA]] as const) {
      const response = await context.app.inject({
        method: 'GET',
        url: `/v1/orders/${order.id}`,
        headers: actor.headers,
      });
      expect([403, 404], label).toContain(response.statusCode);
    }
  });
});

// ---------------------------------------------------------------------------
describe('list own orders', () => {
  it('returns only the caller’s own orders', async () => {
    const mine = await placeOrder(customerA);
    await placeOrder(customerB, { addressId: world.customerB.addressId });

    const response = await context.app.inject({
      method: 'GET',
      url: '/v1/orders',
      headers: customerA.headers,
    });

    expect(response.statusCode).toBe(200);
    const { orders } = response.json<{ orders: { id: string }[] }>();
    expect(orders.some((order) => order.id === mine.id)).toBe(true);

    // Every returned order must belong to customer A.
    const ids = orders.map((order) => order.id);
    const foreign = await context.prisma.order.count({
      where: { id: { in: ids }, customerId: { not: world.customerA.customerId } },
    });
    expect(foreign).toBe(0);
  });

  it('cannot be widened by a query parameter', async () => {
    // A customerId in the query string must be ignored, not honoured.
    const response = await context.app.inject({
      method: 'GET',
      url: `/v1/orders?customerId=${world.customerB.customerId}&limit=50`,
      headers: customerA.headers,
    });

    const { orders } = response.json<{ orders: { id: string }[] }>();
    const ids = orders.map((order) => order.id);
    if (ids.length > 0) {
      const foreign = await context.prisma.order.count({
        where: { id: { in: ids }, customerId: { not: world.customerA.customerId } },
      });
      expect(foreign).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
describe('cancellation', () => {
  it('cancels a freshly placed order with a full refund entitlement', async () => {
    const order = await placeOrder();

    const response = await context.app.inject({
      method: 'POST',
      url: `/v1/orders/${order.id}/cancel`,
      headers: customerA.headers,
      payload: { reason: 'changed my mind' },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ cancelled: boolean; refund: { basisPoints: number } }>();
    expect(body.cancelled).toBe(true);
    expect(body.refund.basisPoints).toBe(10_000);

    const row = await context.prisma.order.findUnique({
      where: { id: order.id },
      select: { status: true, cancelledAt: true },
    });
    expect(row?.status).toBe('cancelled');
    expect(row?.cancelledAt).not.toBeNull();
  });

  it('refuses to cancel twice', async () => {
    const order = await placeOrder();
    const send = () =>
      context.app.inject({
        method: 'POST',
        url: `/v1/orders/${order.id}/cancel`,
        headers: customerA.headers,
        payload: {},
      });

    expect((await send()).statusCode).toBe(200);
    const second = await send();
    expect(second.statusCode).toBe(409);
  });

  it('charges a fee once the vendor is preparing', async () => {
    const order = await placeOrder();

    await context.app.inject({
      method: 'POST',
      url: `/v1/vendor/orders/${order.id}/accept`,
      headers: vendorA.headers,
      payload: { prepMinutes: 20 },
    });
    await context.app.inject({
      method: 'POST',
      url: `/v1/vendor/orders/${order.id}/progress`,
      headers: vendorA.headers,
      payload: { to: 'preparing' },
    });

    const response = await context.app.inject({
      method: 'POST',
      url: `/v1/orders/${order.id}/cancel`,
      headers: customerA.headers,
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ refund: { basisPoints: number } }>();
    // 30% to the vendor, 70% back to the customer.
    expect(body.refund.basisPoints).toBe(7_000);
  });

  // --- BOLA ----------------------------------------------------------------
  it("refuses to cancel another customer's order", async () => {
    const order = await placeOrder(customerA);

    const response = await context.app.inject({
      method: 'POST',
      url: `/v1/orders/${order.id}/cancel`,
      headers: customerB.headers,
      payload: {},
    });

    expect(response.statusCode).toBe(404);

    // And the order is untouched.
    const row = await context.prisma.order.findUnique({
      where: { id: order.id },
      select: { status: true },
    });
    expect(row?.status).toBe('placed');
  });

  it('is refused to a vendor and a rider', async () => {
    const order = await placeOrder();
    for (const [label, actor] of [['vendor', vendorA], ['rider', riderA]] as const) {
      const response = await context.app.inject({
        method: 'POST',
        url: `/v1/orders/${order.id}/cancel`,
        headers: actor.headers,
        payload: {},
      });
      expect([403, 404], label).toContain(response.statusCode);
    }
  });
});

// ---------------------------------------------------------------------------
describe('addresses', () => {
  it('lists only the caller’s own addresses', async () => {
    const response = await context.app.inject({
      method: 'GET',
      url: '/v1/addresses',
      headers: customerA.headers,
    });

    expect(response.statusCode).toBe(200);
    const { addresses } = response.json<{ addresses: { id: string }[] }>();
    expect(addresses.some((address) => address.id === world.customerA.addressId)).toBe(true);
    expect(addresses.some((address) => address.id === world.customerB.addressId)).toBe(false);
  });

  it('refuses an address outside every service zone', async () => {
    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/addresses',
      headers: customerA.headers,
      payload: {
        line1: 'Somewhere in the Atlantic',
        contactPhone: '+2347000000999',
        latitude: 0.5,
        longitude: -20.5,
      },
    });
    expect(response.statusCode).toBe(422);
  });

  it('rejects a malformed phone number', async () => {
    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/addresses',
      headers: customerA.headers,
      payload: {
        line1: 'Test Road',
        contactPhone: 'not-a-phone',
        latitude: 6.5,
        longitude: 3.4,
      },
    });
    expect(response.statusCode).toBe(400);
  });
});
