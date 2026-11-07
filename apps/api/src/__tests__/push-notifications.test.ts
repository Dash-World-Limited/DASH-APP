/**
 * Push notifications end to end: who is told what, when, and how often.
 *
 * Each test drives a real route (or the real transaction helper) and watches
 * what reaches the push provider. The provider is a spy, so these are claims
 * about what DASH hands to FCM: which tokens, which words, which identifiers —
 * and, as often, what it does not send.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PushDelivery, PushReceipt } from '@dash/domain/ports';

import { createTestContext, type TestContext } from './harness.js';
import { actAs, buildWorld, idempotencyKey, type Actor, type World } from './world.js';
import { useIntegrationTimeouts } from './timeouts.js';
import { recordOrderChange } from '../realtime/notify.js';
import { deliverPushIntent, enqueuePush, PUSH_NOTIFY } from '../push/notify.js';
import { sendToRider } from '../push/send.js';
import { riderOfferNotification } from '@dash/domain/push';
import { flushOutbox } from '../events/outbox.js';

useIntegrationTimeouts();

interface Sent {
  deviceTokens: readonly string[];
  title: string;
  body: string;
  data?: Readonly<Record<string, string>> | undefined;
  delivery?: PushDelivery | undefined;
}

let context: TestContext;
let world: World;
let customerA: Actor;
let customerB: Actor;
let riderA: Actor;
let vendorA: Actor;
let support: Actor;

let sent: Sent[] = [];
let nextReceipt: ((input: Sent) => PushReceipt | Promise<PushReceipt>) | null = null;

beforeAll(async () => {
  context = await createTestContext();
  world = await buildWorld(context.prisma);
  customerA = await actAs(context, world.customerA.email);
  customerB = await actAs(context, world.customerB.email);
  riderA = await actAs(context, world.riderA.email);
  vendorA = await actAs(context, world.vendorA.ownerEmail);
  support = await actAs(context, world.support.email);
}, 180_000);

afterAll(async () => {
  await context?.close();
});

beforeEach(() => {
  sent = [];
  nextReceipt = null;
  vi.spyOn(context.app.services.push, 'send').mockImplementation(async (input: Sent) => {
    sent.push(input);
    if (nextReceipt) {
      const make = nextReceipt;
      nextReceipt = null;
      return make(input);
    }
    return { accepted: true, providerMessageId: 'spy' };
  });
});

let counter = 0;
const token = (label: string): string => `fcm-${label}-${Date.now()}-${(counter += 1)}-${'t'.repeat(24)}`;

const register = (actor: Actor, body: Record<string, unknown>) =>
  context.app.inject({ method: 'POST', url: '/v1/devices', headers: actor.headers, payload: { platform: 'android', ...body } });

async function registered(actor: Actor, label: string, notifications?: 'on' | 'off'): Promise<string> {
  const value = token(label);
  const response = await register(actor, { pushToken: value, ...(notifications ? { notifications } : {}) });
  expect(response.statusCode).toBe(200);
  return value;
}

/** Pushes that reached a given phone. */
const to = (deviceToken: string) => sent.filter((push) => push.deviceTokens.includes(deviceToken));

/** Give the in-memory queue time to run whatever the outbox published. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

async function placeOrder(customer: Actor = customerA, who = world.customerA): Promise<string> {
  const response = await context.app.inject({
    method: 'POST',
    url: '/v1/orders',
    headers: { ...customer.headers, 'idempotency-key': idempotencyKey('push-order') },
    payload: {
      branchId: world.vendorA.branchId,
      items: [{ itemId: world.vendorA.itemId, quantity: 1, modifierIds: [world.vendorA.modifierId] }],
      mode: 'delivery',
      addressId: who.addressId,
      paymentMethod: 'card',
    },
  });
  expect(response.statusCode).toBe(200);
  return response.json<{ order: { id: string } }>().order.id;
}

/** An order with riderA on it, set up directly: assignment itself is dispatch's, and frozen. */
async function assignedOrder(customer: Actor = customerA, who = world.customerA): Promise<string> {
  const id = await placeOrder(customer, who);
  await context.prisma.order.update({ where: { id }, data: { riderId: world.riderA.riderId, status: 'rider_assigned', pushNotifiedStatus: 'rider_assigned' } });
  return id;
}

/** The transition helper every route uses: change the status, announce it. */
async function transition(orderId: string, status: string) {
  await context.prisma.$transaction(async (tx) => {
    await tx.order.update({ where: { id: orderId }, data: { status } });
    await recordOrderChange(tx, orderId);
  });
  await flushOutbox(context.prisma, context.app.services.queue);
}

const pushRows = async (orderId: string) =>
  (await context.prisma.outboxEvent.findMany({ where: { name: PUSH_NOTIFY }, select: { payload: true } })).filter(
    (row) => (JSON.parse(row.payload) as { orderId?: string }).orderId === orderId,
  );

// ---------------------------------------------------------------------------
describe('registering a phone', () => {
  it('keeps the phone’s Notifications switch, and never resets it by omission', async () => {
    const phone = await registered(customerA, 'switch', 'off');
    const read = () => context.prisma.device.findUniqueOrThrow({ where: { pushToken: phone }, select: { pushEnabled: true } });
    expect((await read()).pushEnabled).toBe(false);

    // A client that does not send the field (an older build, the web) changes nothing.
    await register(customerA, { pushToken: phone });
    expect((await read()).pushEnabled).toBe(false);

    await register(customerA, { pushToken: phone, notifications: 'on' });
    expect((await read()).pushEnabled).toBe(true);
  });

  it('starts a phone that changes hands at the default, not the previous owner’s choice', async () => {
    const phone = await registered(customerA, 'handover', 'off');
    await register(customerB, { pushToken: phone });
    const device = await context.prisma.device.findUniqueOrThrow({ where: { pushToken: phone }, select: { identityId: true, pushEnabled: true } });
    expect(device).toEqual({ identityId: world.customerB.identityId, pushEnabled: true });
  });

  it('retires the old token when the provider rotates it — but only the caller’s own', async () => {
    const before = await registered(customerA, 'before-rotation');
    const after = token('after-rotation');
    expect((await register(customerA, { pushToken: after, replacesPushToken: before })).statusCode).toBe(200);
    expect(await context.prisma.device.count({ where: { pushToken: before } })).toBe(0);
    expect(await context.prisma.device.count({ where: { pushToken: after, identityId: world.customerA.identityId } })).toBe(1);

    const ridersPhone = await registered(riderA, 'not-yours');
    await register(customerA, { pushToken: token('attempt'), replacesPushToken: ridersPhone });
    expect(await context.prisma.device.count({ where: { pushToken: ridersPhone, identityId: world.riderA.identityId } })).toBe(1);
  });

  it('links the session, so signing out silences the phone', async () => {
    const leaving = await actAs(context, world.customerB.email);
    const phone = await registered(leaving, 'logout');
    const logout = await context.app.inject({ method: 'POST', url: '/v1/auth/logout', headers: leaving.headers });
    expect(logout.statusCode).toBeLessThan(300);
    expect(await context.prisma.device.count({ where: { pushToken: phone } })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('order updates', () => {
  it('tells the customer when the shop accepts — identifiers only, on the orders channel', async () => {
    const phone = await registered(customerA, 'accepted');
    const riderPhone = await registered(riderA, 'accepted-rider');
    const orderId = await placeOrder();

    const accept = await context.app.inject({
      method: 'POST',
      url: `/v1/vendor/orders/${orderId}/accept`,
      headers: vendorA.headers,
      payload: { prepMinutes: 15 },
    });
    expect(accept.statusCode).toBe(200);

    await vi.waitFor(() => expect(to(phone)).toHaveLength(1));
    const push = to(phone)[0]!;
    expect(push.title).toBe('Order accepted');
    expect(push.data).toEqual({ type: 'order_update', audience: 'customer', orderId, status: 'accepted' });
    expect(push.delivery).toMatchObject({ channelId: 'orders', collapseKey: `order_${orderId}` });
    expect(to(riderPhone).filter((entry) => entry.data?.['orderId'] === orderId)).toEqual([]);
  });

  it('follows the delivery with the moments that matter, and only those', async () => {
    const phone = await registered(customerA, 'journey');
    const orderId = await assignedOrder();

    for (const step of ['rider_arrived', 'picked_up', 'en_route', 'arrived']) {
      const response = await context.app.inject({
        method: 'POST',
        url: `/v1/rider/deliveries/${orderId}/progress`,
        headers: riderA.headers,
        payload: { to: step },
      });
      expect(response.statusCode, step).toBe(200);
      await settle();
    }

    const titles = to(phone)
      .filter((push) => push.data?.['orderId'] === orderId)
      .map((push) => push.title);
    expect(titles).toEqual(['Order picked up', 'Your rider has arrived']);
  });

  it('writes no push when an order is announced without its status changing — as every dispatch round does', async () => {
    const orderId = await placeOrder();
    await context.prisma.$transaction((tx) => recordOrderChange(tx, orderId));
    await context.prisma.$transaction((tx) => recordOrderChange(tx, orderId));
    expect(await pushRows(orderId)).toHaveLength(0);

    await transition(orderId, 'accepted');
    expect(await pushRows(orderId)).toHaveLength(1);

    // Two more announcements at the same status: still one push owed.
    await context.prisma.$transaction((tx) => recordOrderChange(tx, orderId));
    await context.prisma.$transaction((tx) => recordOrderChange(tx, orderId));
    expect(await pushRows(orderId)).toHaveLength(1);
  });

  it('tells the rider carrying an order that it was cancelled even with notifications off, and the customer too', async () => {
    const customerPhone = await registered(customerA, 'cancel-customer');
    const riderPhone = await registered(riderA, 'cancel-rider', 'off');
    const orderId = await assignedOrder();

    await transition(orderId, 'cancelled');
    await vi.waitFor(() => expect(to(riderPhone)).toHaveLength(1));
    await vi.waitFor(() => expect(to(customerPhone)).toHaveLength(1));

    // Each side hears its own words, on its own phone, for its own face.
    expect(to(riderPhone)[0]).toMatchObject({ title: 'Delivery cancelled', data: { audience: 'rider', orderId, status: 'cancelled' } });
    expect(to(customerPhone)[0]).toMatchObject({ title: 'Order cancelled', data: { audience: 'customer', orderId } });
    expect(to(riderPhone)[0]!.deviceTokens).not.toContain(customerPhone);
  });

  it('sends a customer who switched notifications off nothing about their order', async () => {
    const phone = await registered(customerB, 'quiet', 'off');
    const orderId = await placeOrder(customerB, world.customerB);
    await transition(orderId, 'accepted');
    await settle();
    expect(to(phone)).toEqual([]);
  });

  it('drops an update a newer one has overtaken, but not one followed only by quiet steps', async () => {
    const phone = await registered(customerA, 'overtaken');
    const orderId = await assignedOrder();
    await context.prisma.order.update({ where: { id: orderId }, data: { status: 'arrived' } });
    const overtaken = await deliverPushIntent(context.prisma, context.app.services.push, {
      kind: 'order_update',
      orderId,
      status: 'picked_up',
      revision: 9001,
      riderId: world.riderA.riderId,
    });
    expect(overtaken.dropped).toBe('superseded');

    await context.prisma.order.update({ where: { id: orderId }, data: { status: 'en_route' } });
    const stillNews = await deliverPushIntent(context.prisma, context.app.services.push, {
      kind: 'order_update',
      orderId,
      status: 'picked_up',
      revision: 9002,
      riderId: world.riderA.riderId,
    });
    expect(stillNews.results[0]?.sent).toBe(true);
    expect(to(phone).map((push) => push.title)).toEqual(['Order picked up']);
  });
});

// ---------------------------------------------------------------------------
describe('messages', () => {
  it('tells the other side of an order chat that a message arrived — never what it says', async () => {
    const customerPhone = await registered(customerA, 'chat-customer');
    const riderPhone = await registered(riderA, 'chat-rider');
    const orderId = await assignedOrder();

    const fromCustomer = await context.app.inject({
      method: 'POST',
      url: `/v1/orders/${orderId}/chat/messages`,
      headers: customerA.headers,
      payload: { body: 'The gate code is 4417, blue door' },
    });
    expect(fromCustomer.statusCode).toBe(201);
    await vi.waitFor(() => expect(to(riderPhone)).toHaveLength(1));
    expect(to(riderPhone)[0]).toMatchObject({
      title: 'New message from your customer',
      data: { type: 'order_chat', audience: 'rider', orderId },
      delivery: { channelId: 'messages', collapseKey: `chat_${orderId}` },
    });
    expect(JSON.stringify(sent)).not.toMatch(/4417|gate|blue door/i);
    expect(to(customerPhone)).toEqual([]);

    await context.app.inject({
      method: 'POST',
      url: `/v1/orders/${orderId}/chat/messages`,
      headers: riderA.headers,
      payload: { body: 'Outside now' },
    });
    await vi.waitFor(() => expect(to(customerPhone)).toHaveLength(1));
    expect(to(customerPhone)[0]).toMatchObject({ title: 'New message from your rider', data: { audience: 'customer', orderId } });
  });

  it('tells a customer and a rider that DASH Support replied, in the role they wrote as', async () => {
    const customerPhone = await registered(customerA, 'support-customer');
    const riderPhone = await registered(riderA, 'support-rider');

    for (const [actor, as] of [[customerA, 'customer'], [riderA, 'rider']] as const) {
      const wrote = await context.app.inject({ method: 'POST', url: '/v1/support/chat/messages', headers: actor.headers, payload: { as, body: 'Help please' } });
      expect(wrote.statusCode).toBe(200);
    }
    const inbox = (await context.app.inject({ method: 'GET', url: '/v1/admin/support/conversations', headers: support.headers })).json<{
      conversations: Array<{ id: string; audience: string; account: { identityId: string } | null }>;
    }>();
    const customerCase = inbox.conversations.find((entry) => entry.audience === 'customer' && entry.account?.identityId === world.customerA.identityId)!;
    const riderCase = inbox.conversations.find((entry) => entry.audience === 'rider' && entry.account?.identityId === world.riderA.identityId)!;
    // Writing to the team pushes nobody.
    await settle();
    expect(sent).toEqual([]);

    for (const conversation of [customerCase, riderCase]) {
      const replied = await context.app.inject({
        method: 'POST',
        url: `/v1/admin/support/conversations/${conversation.id}/messages`,
        headers: support.headers,
        payload: { body: 'Your refund reference is RF-77812' },
      });
      expect(replied.statusCode).toBe(200);
    }

    await vi.waitFor(() => expect(to(customerPhone)).toHaveLength(1));
    await vi.waitFor(() => expect(to(riderPhone)).toHaveLength(1));
    expect(to(customerPhone)[0]).toMatchObject({ title: 'DASH Support replied', data: { type: 'support_reply', audience: 'customer', conversationId: customerCase.id } });
    expect(to(riderPhone)[0]).toMatchObject({ data: { audience: 'rider', conversationId: riderCase.id } });
    expect(JSON.stringify(sent)).not.toContain('RF-77812');
  });

  it('never announces an internal support note', async () => {
    const phone = await registered(customerA, 'internal-note');
    const supportCase = await context.prisma.supportCase.findFirstOrThrow({ where: { category: 'in_app_chat', customerId: world.customerA.customerId } });
    const note = await context.prisma.supportAction.create({
      data: { caseId: supportCase.id, actorId: world.support.identityId, kind: 'note', body: 'Customer seems upset', isInternal: true },
    });
    const report = await deliverPushIntent(context.prisma, context.app.services.push, { kind: 'support_reply', actionId: note.id });
    expect(report.dropped).toBe('not_found');
    expect(to(phone)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe('payments', () => {
  it('tells the customer, without an amount, that a refund went back or an unpaid order was closed', async () => {
    const phone = await registered(customerA, 'payments');
    const orderId = await placeOrder();

    await context.prisma.$transaction(async (tx) => {
      await enqueuePush(tx, { kind: 'payment_update', orderId, outcome: 'refund_completed', refundId: `refund_${orderId}` });
      await enqueuePush(tx, { kind: 'payment_update', orderId, outcome: 'payment_not_completed' });
    });
    await flushOutbox(context.prisma, context.app.services.queue);

    await vi.waitFor(() => expect(to(phone)).toHaveLength(2));
    expect(to(phone).map((push) => push.title).sort()).toEqual(['Order cancelled', 'Refund completed']);
    expect(to(phone).every((push) => push.delivery?.channelId === 'account' && push.data?.['audience'] === 'customer')).toBe(true);
    expect(JSON.stringify(to(phone))).not.toMatch(/₦|NGN|\d{3,}\.\d{2}/);
  });
});

// ---------------------------------------------------------------------------
describe('exactly once', () => {
  it('sends one push however many times the same event is delivered', async () => {
    const phone = await registered(customerA, 'twice');
    const orderId = await placeOrder();
    const intent = { kind: 'payment_update', orderId, outcome: 'refund_completed', refundId: `once_${orderId}` } as const;

    const first = await deliverPushIntent(context.prisma, context.app.services.push, intent);
    const second = await deliverPushIntent(context.prisma, context.app.services.push, intent);
    expect(first.results[0]?.sent).toBe(true);
    expect(second.results[0]?.skipped).toBe('duplicate');
    expect(to(phone)).toHaveLength(1);
  });

  it('retries a send the provider refused, without having sent it twice', async () => {
    const phone = await registered(customerA, 'retry');
    const orderId = await placeOrder();
    const intent = { kind: 'payment_update', orderId, outcome: 'refund_completed', refundId: `retry_${orderId}` } as const;

    nextReceipt = () => ({ accepted: false, providerMessageId: undefined, failureReason: 'all 1 sends failed', invalidTokens: [] });
    await expect(deliverPushIntent(context.prisma, context.app.services.push, intent)).rejects.toThrow(/not delivered/);

    const retried = await deliverPushIntent(context.prisma, context.app.services.push, intent);
    expect(retried.results[0]?.sent).toBe(true);
    expect(to(phone)).toHaveLength(2); // one refused, one delivered
    expect((await deliverPushIntent(context.prisma, context.app.services.push, intent)).results[0]?.skipped).toBe('duplicate');
  });

  it('sends one offer push per offer, and reaches a rider who switched notifications off', async () => {
    const phone = await registered(riderA, 'offer', 'off');
    const message = riderOfferNotification({ offerId: 'offer_once', expiresAt: new Date(Date.now() + 30_000) });
    const first = await sendToRider(context.prisma, context.app.services.push, { riderId: world.riderA.riderId, message, dedupeKey: 'rider_offer:offer_once' });
    const second = await sendToRider(context.prisma, context.app.services.push, { riderId: world.riderA.riderId, message, dedupeKey: 'rider_offer:offer_once' });
    expect(first.sent).toBe(true);
    expect(second.skipped).toBe('duplicate');
    expect(to(phone)).toHaveLength(1);
    expect(to(phone)[0]!.delivery).toMatchObject({ channelId: 'offers', collapseKey: 'offer_once' });
  });

  it('forgets a token the provider reports dead, and does not retry it', async () => {
    const phone = await registered(customerA, 'dead');
    const orderId = await placeOrder();
    nextReceipt = (input) => ({ accepted: false, providerMessageId: undefined, invalidTokens: [...input.deviceTokens] });
    // Every other phone customer A registered above is dead too in this answer.
    const report = await deliverPushIntent(context.prisma, context.app.services.push, {
      kind: 'payment_update',
      orderId,
      outcome: 'refund_completed',
      refundId: `dead_${orderId}`,
    });
    expect(report.results[0]?.invalidTokensCleared).toBeGreaterThanOrEqual(1);
    expect(await context.prisma.device.count({ where: { pushToken: phone } })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('accounts that should hear nothing', () => {
  it('a suspended or deleted account is not contacted', async () => {
    const phone = await registered(customerB, 'inactive');
    const orderId = await placeOrder(customerB, world.customerB);
    for (const status of ['suspended', 'deleted']) {
      await context.prisma.identity.update({ where: { id: world.customerB.identityId }, data: { status } });
      const report = await deliverPushIntent(context.prisma, context.app.services.push, {
        kind: 'payment_update',
        orderId,
        outcome: 'refund_completed',
        refundId: `inactive_${status}_${orderId}`,
      });
      expect(report.results[0]?.skipped).toBe('inactive_account');
    }
    await context.prisma.identity.update({ where: { id: world.customerB.identityId }, data: { status: 'active' } });
    expect(to(phone)).toEqual([]);
  });

  it('a phone that signed out gets nothing more', async () => {
    const leaving = await actAs(context, world.customerA.email);
    const phone = await registered(leaving, 'after-logout');
    await context.app.inject({ method: 'POST', url: '/v1/auth/logout', headers: leaving.headers });
    const orderId = await placeOrder();
    await transition(orderId, 'accepted');
    await settle();
    expect(to(phone)).toEqual([]);
  });
});
