/**
 * Customer wallet and order-chat integration.
 *
 * These cover the two security boundaries that matter most:
 * wallet figures come only from the server ledger, and an order conversation
 * can be seen only by that order's customer and assigned rider.
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

beforeAll(async () => {
  context = await createTestContext();
  world = await buildWorld(context.prisma);
  customerA = await actAs(context, world.customerA.email);
  customerB = await actAs(context, world.customerB.email);
  riderA = await actAs(context, world.riderA.email);
  riderB = await actAs(context, world.riderB.email);
  support = await actAs(context, world.support.email);
}, 180_000);

afterAll(async () => {
  await context?.close();
});

function basket() {
  return {
    branchId: world.vendorA.branchId,
    items: [{ itemId: world.vendorA.itemId, quantity: 1, modifierIds: [world.vendorA.modifierId] }],
    mode: 'delivery',
    addressId: world.customerA.addressId,
    paymentMethod: 'card',
  };
}

async function orderForChat(): Promise<string> {
  const response = await context.app.inject({
    method: 'POST',
    url: '/v1/orders',
    headers: { ...customerA.headers, 'idempotency-key': idempotencyKey('chat-order') },
    payload: basket(),
  });
  expect(response.statusCode).toBe(200);
  const id = response.json<{ order: { id: string } }>().order.id;

  await context.prisma.order.update({
    where: { id },
    data: { riderId: world.riderA.riderId, status: 'rider_assigned' },
  });
  return id;
}

describe('customer wallet', () => {
  it('starts at zero and requires a customer permission', async () => {
    const own = await context.app.inject({
      method: 'GET',
      url: '/v1/wallet',
      headers: customerA.headers,
    });
    expect(own.statusCode).toBe(200);
    expect(own.json()).toMatchObject({ currency: 'NGN', balance: 0, transactions: [] });

    const staff = await context.app.inject({
      method: 'GET',
      url: '/v1/wallet',
      headers: support.headers,
    });
    expect(staff.statusCode).toBe(403);

    const anonymous = await context.app.inject({ method: 'GET', url: '/v1/wallet' });
    expect(anonymous.statusCode).toBe(401);
  });

  it('reports the ledger balance, not a client-maintained number', async () => {
    await context.prisma.ledgerTransaction.create({
      data: {
        kind: 'promotion_credit',
        idempotencyKey: idempotencyKey('wallet-credit'),
        referenceType: 'test',
        referenceId: world.customerA.customerId,
        actorId: world.admin.identityId,
        note: 'Test wallet credit',
        occurredAt: new Date(),
        entries: {
          create: [
            {
              accountKind: 'customer_wallet',
              ownerId: world.customerA.customerId,
              amount: -25_000,
              memo: 'DASH credit',
            },
            {
              accountKind: 'platform_revenue',
              ownerId: null,
              amount: 25_000,
              memo: 'DASH credit funding',
            },
          ],
        },
      },
    });

    const response = await context.app.inject({
      method: 'GET',
      url: '/v1/wallet',
      headers: customerA.headers,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ balance: number; transactions: Array<{ amount: number; kind: string }> }>();
    expect(body.balance).toBe(25_000);
    expect(body.transactions[0]).toMatchObject({ amount: 25_000, kind: 'promotion_credit' });

    const other = await context.app.inject({
      method: 'GET',
      url: '/v1/wallet',
      headers: customerB.headers,
    });
    expect(other.statusCode).toBe(200);
    expect(other.json<{ balance: number }>().balance).toBe(0);
  });
});

describe('customer ↔ rider order chat', () => {
  it('allows only the order customer and assigned rider to exchange messages', async () => {
    const orderId = await orderForChat();

    const outsiderCustomer = await context.app.inject({
      method: 'GET',
      url: `/v1/orders/${orderId}/chat`,
      headers: customerB.headers,
    });
    expect(outsiderCustomer.statusCode).toBe(404);

    const outsiderRider = await context.app.inject({
      method: 'GET',
      url: `/v1/orders/${orderId}/chat`,
      headers: riderB.headers,
    });
    expect(outsiderRider.statusCode).toBe(404);

    const riderMessage = await context.app.inject({
      method: 'POST',
      url: `/v1/orders/${orderId}/chat/messages`,
      headers: riderA.headers,
      payload: { body: 'I am at the restaurant.' },
    });
    expect(riderMessage.statusCode).toBe(201);
    expect(riderMessage.json()).toMatchObject({ senderRole: 'rider', mine: true });

    const customerView = await context.app.inject({
      method: 'GET',
      url: `/v1/orders/${orderId}/chat`,
      headers: customerA.headers,
    });
    expect(customerView.statusCode).toBe(200);
    expect(customerView.json<{ messages: Array<{ body: string; mine: boolean }> }>().messages[0]).toMatchObject({
      body: 'I am at the restaurant.',
      mine: false,
    });

    const customerReply = await context.app.inject({
      method: 'POST',
      url: `/v1/orders/${orderId}/chat/messages`,
      headers: customerA.headers,
      payload: { body: 'Thanks, please message when you leave.' },
    });
    expect(customerReply.statusCode).toBe(201);
    expect(customerReply.json()).toMatchObject({ senderRole: 'customer', mine: true });

    const riderView = await context.app.inject({
      method: 'GET',
      url: `/v1/orders/${orderId}/chat`,
      headers: riderA.headers,
    });
    const messages = riderView.json<{ messages: Array<{ body: string; mine: boolean }> }>().messages;
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ body: 'I am at the restaurant.', mine: true });
    expect(messages[1]).toMatchObject({ body: 'Thanks, please message when you leave.', mine: false });
  });

  it('does not create chat before a rider is assigned', async () => {
    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: { ...customerA.headers, 'idempotency-key': idempotencyKey('unassigned-chat') },
      payload: basket(),
    });
    const orderId = response.json<{ order: { id: string } }>().order.id;

    const chat = await context.app.inject({
      method: 'GET',
      url: `/v1/orders/${orderId}/chat`,
      headers: customerA.headers,
    });
    expect(chat.statusCode).toBe(422);
    expect(await context.prisma.orderConversation.count({ where: { orderId } })).toBe(0);
  });

  it('makes a completed delivery conversation read-only', async () => {
    const orderId = await orderForChat();
    await context.prisma.order.update({ where: { id: orderId }, data: { status: 'delivered' } });

    const response = await context.app.inject({
      method: 'POST',
      url: `/v1/orders/${orderId}/chat/messages`,
      headers: customerA.headers,
      payload: { body: 'Late message' },
    });
    expect(response.statusCode).toBe(409);
  });
});
