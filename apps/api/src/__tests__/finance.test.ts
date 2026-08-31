/**
 * Finance and ledger integration tests.
 *
 * These assert on financial *invariants*, not HTTP status codes. A 200 from a
 * refund endpoint proves nothing; what matters is whether the money moved once,
 * whether it balances, and whether a second click moves it again.
 *
 * The core invariant, asserted repeatedly below: every ledger transaction's
 * entries sum to exactly zero, and no operation ever leaves a partial posting.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './harness.js';
import { actAs, buildWorld, idempotencyKey, type Actor, type World } from './world.js';

let context: TestContext;
let world: World;
let customerA: Actor;
let vendorA: Actor;
let riderA: Actor;
let finance: Actor;
let support: Actor;
let admin: Actor;
let dispatcher: Actor;

beforeAll(async () => {
  context = await createTestContext();
  world = await buildWorld(context.prisma);
  customerA = await actAs(context, world.customerA.email);
  vendorA = await actAs(context, world.vendorA.ownerEmail);
  riderA = await actAs(context, world.riderA.email);
  finance = await actAs(context, world.finance.email);
  support = await actAs(context, world.support.email);
  admin = await actAs(context, world.admin.email);
  dispatcher = await actAs(context, world.dispatcher.email);
}, 180_000);

afterAll(async () => {
  await context?.close();
});

/**
 * Every ledger transaction must sum to zero. Called after anything that touches
 * money, because a single unbalanced transaction means money was created or
 * destroyed.
 */
async function expectLedgerBalanced(): Promise<void> {
  const entries = await context.prisma.ledgerEntry.findMany({
    select: { amount: true, transactionId: true },
  });

  const sums = new Map<string, number>();
  for (const entry of entries) {
    sums.set(entry.transactionId, (sums.get(entry.transactionId) ?? 0) + entry.amount);
  }

  const unbalanced = [...sums.entries()].filter(([, sum]) => sum !== 0);
  expect(unbalanced, `unbalanced transactions: ${JSON.stringify(unbalanced)}`).toEqual([]);
}

/** Sum of signed entries for one account, as the ledger stores them. */
async function rawBalance(accountKind: string, ownerId?: string | null): Promise<number> {
  const result = await context.prisma.ledgerEntry.aggregate({
    where: { accountKind, ownerId: ownerId ?? null },
    _sum: { amount: true },
  });
  return result._sum.amount ?? 0;
}

async function placeOrder(): Promise<{ id: string; total: number }> {
  const response = await context.app.inject({
    method: 'POST',
    url: '/v1/orders',
    headers: { ...customerA.headers, 'idempotency-key': idempotencyKey('forder') },
    payload: {
      branchId: world.vendorA.branchId,
      items: [{ itemId: world.vendorA.itemId, quantity: 1, modifierIds: [world.vendorA.modifierId] }],
      mode: 'delivery',
      addressId: world.customerA.addressId,
      paymentMethod: 'card',
    },
  });
  if (response.statusCode !== 200) {
    throw new Error(`placeOrder failed: ${response.statusCode} ${response.body}`);
  }
  return response.json<{ order: { id: string; total: number } }>().order;
}

/** Step up so a finance actor may approve money-moving actions. */
async function stepUp(actor: Actor, identityId: string): Promise<void> {
  await context.prisma.session.updateMany({
    where: { identityId, revokedAt: null },
    data: { steppedUpAt: new Date() },
  });
  // The access token carries a stale `sua`, but `authenticate()` rebuilds the
  // actor from the database on every request, so the fresh step-up applies.
  void actor;
}

// ---------------------------------------------------------------------------
describe('order capture posts a balanced, complete transaction', () => {
  it('creates a capture whose entries sum to zero', async () => {
    const order = await placeOrder();

    const transaction = await context.prisma.ledgerTransaction.findFirst({
      where: { referenceType: 'order', referenceId: order.id, kind: 'order_payment_captured' },
      include: { entries: true },
    });

    expect(transaction).not.toBeNull();
    const sum = transaction!.entries.reduce((total, entry) => total + entry.amount, 0);
    expect(sum).toBe(0);
  });

  it('records what is owed to the vendor and reserved for a rider', async () => {
    const order = await placeOrder();

    const transaction = await context.prisma.ledgerTransaction.findFirst({
      where: { referenceType: 'order', referenceId: order.id, kind: 'order_payment_captured' },
      include: { entries: true },
    });

    const kinds = transaction!.entries.map((entry) => entry.accountKind);
    expect(kinds).toContain('platform_cash');
    expect(kinds).toContain('vendor_payable');
    expect(kinds).toContain('rider_payable');

    // Rider pay is reserved before a rider exists, against an unowned balance.
    const riderEntry = transaction!.entries.find((entry) => entry.accountKind === 'rider_payable');
    expect(riderEntry?.ownerId).toBeNull();
  });

  it('records cash equal to what the customer was charged', async () => {
    const order = await placeOrder();

    const transaction = await context.prisma.ledgerTransaction.findFirst({
      where: { referenceType: 'order', referenceId: order.id, kind: 'order_payment_captured' },
      include: { entries: true },
    });

    const cash = transaction!.entries.find((entry) => entry.accountKind === 'platform_cash');
    expect(cash?.amount).toBe(order.total);
  });

  it('posts exactly one capture per order, even across a replayed checkout', async () => {
    const key = idempotencyKey('dedupe');
    const send = () =>
      context.app.inject({
        method: 'POST',
        url: '/v1/orders',
        headers: { ...customerA.headers, 'idempotency-key': key },
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

    const first = await send();
    await send();
    const orderId = first.json<{ order: { id: string } }>().order.id;

    const captures = await context.prisma.ledgerTransaction.count({
      where: { referenceType: 'order', referenceId: orderId, kind: 'order_payment_captured' },
    });
    expect(captures).toBe(1);
    await expectLedgerBalanced();
  });

  it('creates no financial effect when the order is rejected before payment', async () => {
    // A quote is not an order. Nothing should be posted.
    const before = await context.prisma.ledgerTransaction.count();

    await context.app.inject({
      method: 'POST',
      url: '/v1/orders/quote',
      headers: customerA.headers,
      payload: {
        branchId: world.vendorA.branchId,
        items: [
          { itemId: world.vendorA.itemId, quantity: 1, modifierIds: [world.vendorA.modifierId] },
        ],
        mode: 'delivery',
        addressId: world.customerA.addressId,
      },
    });

    expect(await context.prisma.ledgerTransaction.count()).toBe(before);
  });

  it('creates no financial effect from a rejected (invalid) checkout', async () => {
    const before = await context.prisma.ledgerTransaction.count();

    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: { ...customerA.headers, 'idempotency-key': idempotencyKey('bad') },
      payload: {
        branchId: world.vendorA.branchId,
        // Required modifier group unsatisfied — this must fail before payment.
        items: [{ itemId: world.vendorA.itemId, quantity: 1, modifierIds: [] }],
        mode: 'delivery',
        addressId: world.customerA.addressId,
        paymentMethod: 'card',
      },
    });

    expect(response.statusCode).toBe(422);
    expect(await context.prisma.ledgerTransaction.count()).toBe(before);
    await expectLedgerBalanced();
  });
});

// ---------------------------------------------------------------------------
describe('ledger integrity endpoint', () => {
  it('reports a balanced ledger', async () => {
    await placeOrder();

    const response = await context.app.inject({
      method: 'GET',
      url: '/v1/finance/ledger/integrity',
      headers: finance.headers,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ balanced: boolean; totalDriftKobo: number }>();
    expect(body.balanced).toBe(true);
    expect(body.totalDriftKobo).toBe(0);
  });

  it('is refused to a customer, vendor, rider, and dispatcher', async () => {
    for (const [label, actor] of [
      ['customer', customerA],
      ['vendor', vendorA],
      ['rider', riderA],
      ['dispatcher', dispatcher],
    ] as const) {
      const response = await context.app.inject({
        method: 'GET',
        url: '/v1/finance/ledger/integrity',
        headers: actor.headers,
      });
      expect(response.statusCode, label).toBe(403);
    }
  });
});

// ---------------------------------------------------------------------------
describe('the ledger is append-only', () => {
  it('exposes no endpoint that edits or deletes a ledger entry', async () => {
    const entry = await context.prisma.ledgerEntry.findFirst({ select: { id: true } });
    expect(entry).not.toBeNull();

    // There is deliberately no route for these. If one is ever added, this
    // fails and forces the author to justify it.
    for (const [method, url] of [
      ['PATCH', `/v1/finance/ledger/entries/${entry!.id}`],
      ['DELETE', `/v1/finance/ledger/entries/${entry!.id}`],
      ['PATCH', `/v1/finance/ledger/transactions/${entry!.id}`],
      ['DELETE', `/v1/finance/ledger/transactions/${entry!.id}`],
    ] as const) {
      const response = await context.app.inject({
        method,
        url,
        headers: admin.headers,
        payload: { amount: 1 },
      });
      expect(response.statusCode, `${method} ${url}`).toBe(404);
    }
  });

  it('keeps entries immutable across a corrective refund', async () => {
    const order = await placeOrder();

    const capture = await context.prisma.ledgerTransaction.findFirst({
      where: { referenceType: 'order', referenceId: order.id, kind: 'order_payment_captured' },
      include: { entries: { orderBy: { id: 'asc' } } },
    });
    const before = capture!.entries.map((entry) => `${entry.accountKind}:${entry.amount}`);

    await stepUp(finance, world.finance.identityId);
    await context.app.inject({
      method: 'POST',
      url: `/v1/finance/orders/${order.id}/refund`,
      headers: finance.headers,
      payload: { amount: 1000, reason: 'partial goodwill refund' },
    });

    const after = await context.prisma.ledgerTransaction.findUnique({
      where: { id: capture!.id },
      include: { entries: { orderBy: { id: 'asc' } } },
    });

    // The original capture is untouched; the refund is a new transaction.
    expect(after!.entries.map((entry) => `${entry.accountKind}:${entry.amount}`)).toEqual(before);
    await expectLedgerBalanced();
  });
});

// ---------------------------------------------------------------------------
describe('refund authorization', () => {
  it('is refused to a customer, vendor, rider, support agent, and dispatcher', async () => {
    const order = await placeOrder();

    for (const [label, actor] of [
      ['customer', customerA],
      ['vendor', vendorA],
      ['rider', riderA],
      ['support', support],
      ['dispatcher', dispatcher],
    ] as const) {
      const response = await context.app.inject({
        method: 'POST',
        url: `/v1/finance/orders/${order.id}/refund`,
        headers: actor.headers,
        payload: { amount: 100, reason: 'attempting an unauthorized refund' },
      });
      expect(response.statusCode, label).toBe(403);
    }

    // Nothing was posted.
    const refunds = await context.prisma.ledgerTransaction.count({
      where: { referenceId: order.id, kind: 'order_refund' },
    });
    expect(refunds).toBe(0);
  });

  it('requires step-up even for finance', async () => {
    const order = await placeOrder();

    // Explicitly clear any step-up.
    await context.prisma.session.updateMany({
      where: { identityId: world.finance.identityId },
      data: { steppedUpAt: null },
    });

    const response = await context.app.inject({
      method: 'POST',
      url: `/v1/finance/orders/${order.id}/refund`,
      headers: finance.headers,
      payload: { amount: 100, reason: 'no step-up yet' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('step_up_required');
  });

  it('refuses a refund larger than the captured amount', async () => {
    const order = await placeOrder();
    await stepUp(finance, world.finance.identityId);

    const response = await context.app.inject({
      method: 'POST',
      url: `/v1/finance/orders/${order.id}/refund`,
      headers: finance.headers,
      payload: { amount: order.total + 1, reason: 'too much' },
    });

    expect(response.statusCode).toBe(422);
    await expectLedgerBalanced();
  });

  it('refuses a refund on an order with no captured payment', async () => {
    // A cancelled-before-payment order has nothing to give back.
    const order = await context.prisma.order.findFirst({
      where: { payments: { none: { status: 'captured' } } },
      select: { id: true },
    });
    if (!order) return;

    await stepUp(finance, world.finance.identityId);
    const response = await context.app.inject({
      method: 'POST',
      url: `/v1/finance/orders/${order.id}/refund`,
      headers: finance.headers,
      payload: { amount: 100, reason: 'nothing to refund' },
    });
    expect(response.statusCode).toBe(409);
  });
});

// ---------------------------------------------------------------------------
describe('refunds cannot be duplicated', () => {
  it('does not post twice when the identical refund is repeated', async () => {
    const order = await placeOrder();
    await stepUp(finance, world.finance.identityId);

    const send = () =>
      context.app.inject({
        method: 'POST',
        url: `/v1/finance/orders/${order.id}/refund`,
        headers: finance.headers,
        payload: { amount: 5000, reason: 'duplicate click' },
      });

    await send();
    await send();

    const postings = await context.prisma.ledgerTransaction.count({
      where: { referenceId: order.id, kind: 'order_refund' },
    });
    expect(postings).toBe(1);
    await expectLedgerBalanced();
  });

  it('never refunds more than was captured, however the calls are split', async () => {
    // The invariant that actually matters. A per-call ceiling is not enough:
    // several calls each under the ceiling can exceed it in aggregate.
    const order = await placeOrder();
    await stepUp(finance, world.finance.identityId);

    // Deliberately DIFFERENT amounts. Repeating one amount produces one
    // idempotency key and dedupes, which would let this test pass without ever
    // exercising the cumulative cap.
    const third = Math.floor(order.total / 3);

    const first = await context.app.inject({
      method: 'POST',
      url: `/v1/finance/orders/${order.id}/refund`,
      headers: finance.headers,
      payload: { amount: third, reason: 'first slice' },
    });
    const second = await context.app.inject({
      method: 'POST',
      url: `/v1/finance/orders/${order.id}/refund`,
      headers: finance.headers,
      payload: { amount: third + 1, reason: 'second slice' },
    });
    // These two already account for most of the payment. A third of the same
    // size must be refused, not posted.
    const third_call = await context.app.inject({
      method: 'POST',
      url: `/v1/finance/orders/${order.id}/refund`,
      headers: finance.headers,
      payload: { amount: third + 2, reason: 'third slice' },
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(third_call.statusCode).toBe(422);

    const refundTransactions = await context.prisma.ledgerTransaction.findMany({
      where: { referenceId: order.id, kind: 'order_refund' },
      include: { entries: true },
    });

    // Total returned to the customer across every refund posting.
    const returned = refundTransactions
      .flatMap((transaction) => transaction.entries)
      .filter(
        (entry) =>
          entry.accountKind === 'platform_cash' || entry.accountKind === 'customer_wallet',
      )
      .reduce((total, entry) => total + Math.abs(entry.amount), 0);

    expect(returned).toBeLessThanOrEqual(order.total);
    await expectLedgerBalanced();
  });

  it('cannot refund the same amount twice by changing only the destination', async () => {
    // Same money, two routes out. If the idempotency key includes the
    // destination, these look like different operations and both post.
    const order = await placeOrder();
    await stepUp(finance, world.finance.identityId);

    await context.app.inject({
      method: 'POST',
      url: `/v1/finance/orders/${order.id}/refund`,
      headers: finance.headers,
      payload: { amount: order.total, destination: 'payment_method', reason: 'full refund' },
    });
    await context.app.inject({
      method: 'POST',
      url: `/v1/finance/orders/${order.id}/refund`,
      headers: finance.headers,
      payload: { amount: order.total, destination: 'wallet', reason: 'and again, to wallet' },
    });

    const refundTransactions = await context.prisma.ledgerTransaction.findMany({
      where: { referenceId: order.id, kind: 'order_refund' },
      include: { entries: true },
    });

    const returned = refundTransactions
      .flatMap((transaction) => transaction.entries)
      .filter(
        (entry) =>
          entry.accountKind === 'platform_cash' || entry.accountKind === 'customer_wallet',
      )
      .reduce((total, entry) => total + Math.abs(entry.amount), 0);

    expect(returned).toBeLessThanOrEqual(order.total);
    await expectLedgerBalanced();
  });
});

// ---------------------------------------------------------------------------
describe('support compensation', () => {
  async function caseFor(customerId: string): Promise<string> {
    const supportCase = await context.prisma.supportCase.create({
      data: {
        code: `CASE-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        customerId,
        subject: 'Test case',
        category: 'refund',
        priority: 'normal',
        status: 'open',
      },
      select: { id: true },
    });
    return supportCase.id;
  }

  it('credits the customer wallet and balances', async () => {
    const caseId = await caseFor(world.customerA.customerId);
    await stepUp(support, world.support.identityId);

    const before = await rawBalance('customer_wallet', world.customerA.customerId);

    const response = await context.app.inject({
      method: 'POST',
      url: `/v1/support/cases/${caseId}/compensate`,
      headers: support.headers,
      payload: { amount: 50_000, reason: 'late delivery goodwill' },
    });

    expect(response.statusCode).toBe(200);
    const after = await rawBalance('customer_wallet', world.customerA.customerId);
    // A wallet is a liability: a credit is stored negative.
    expect(after).toBe(before - 50_000);
    await expectLedgerBalanced();
  });

  it('does not credit twice when the same compensation is submitted twice', async () => {
    const caseId = await caseFor(world.customerA.customerId);
    await stepUp(support, world.support.identityId);

    const send = () =>
      context.app.inject({
        method: 'POST',
        url: `/v1/support/cases/${caseId}/compensate`,
        headers: support.headers,
        payload: { amount: 25_000, reason: 'double-clicked the button' },
      });

    const before = await rawBalance('customer_wallet', world.customerA.customerId);
    await send();
    await send();
    const after = await rawBalance('customer_wallet', world.customerA.customerId);

    // One compensation, not two.
    expect(before - after).toBe(25_000);
    await expectLedgerBalanced();
  });

  it('requires step-up', async () => {
    const caseId = await caseFor(world.customerA.customerId);
    await context.prisma.session.updateMany({
      where: { identityId: world.support.identityId },
      data: { steppedUpAt: null },
    });

    const response = await context.app.inject({
      method: 'POST',
      url: `/v1/support/cases/${caseId}/compensate`,
      headers: support.headers,
      payload: { amount: 1000, reason: 'no step-up' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('is refused to a customer, vendor, rider, and finance analyst', async () => {
    const caseId = await caseFor(world.customerA.customerId);

    for (const [label, actor] of [
      ['customer', customerA],
      ['vendor', vendorA],
      ['rider', riderA],
      ['finance', finance],
    ] as const) {
      const response = await context.app.inject({
        method: 'POST',
        url: `/v1/support/cases/${caseId}/compensate`,
        headers: actor.headers,
        payload: { amount: 1000, reason: 'not mine to give' },
      });
      expect(response.statusCode, label).toBe(403);
    }
  });

  it('caps a single compensation', async () => {
    const caseId = await caseFor(world.customerA.customerId);
    await stepUp(support, world.support.identityId);

    const response = await context.app.inject({
      method: 'POST',
      url: `/v1/support/cases/${caseId}/compensate`,
      headers: support.headers,
      payload: { amount: 99_999_999, reason: 'draining the account' },
    });
    expect(response.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
describe('rider pay', () => {
  it('leaves the reservation unowned until a delivery actually completes', async () => {
    await placeOrder();

    // Rider pay is reserved at capture against an unowned balance, so no
    // specific rider is owed anything yet.
    const unowned = await rawBalance('rider_payable', null);
    expect(unowned).toBeLessThan(0);
  });

  it('assigns the reservation to the rider who completed the delivery', async () => {
    // Walk a full order through to delivery.
    const created = await context.app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: { ...customerA.headers, 'idempotency-key': idempotencyKey('pay') },
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
    const body = created.json<{ order: { id: string }; deliveryPin: string }>();
    const orderId = body.order.id;

    for (const payload of [{ prepMinutes: 1 }]) {
      await context.app.inject({
        method: 'POST',
        url: `/v1/vendor/orders/${orderId}/accept`,
        headers: vendorA.headers,
        payload,
      });
    }
    for (const to of ['preparing', 'ready']) {
      await context.app.inject({
        method: 'POST',
        url: `/v1/vendor/orders/${orderId}/progress`,
        headers: vendorA.headers,
        payload: { to },
      });
    }

    const offer = await context.prisma.dispatchOffer.create({
      data: {
        orderId,
        riderId: world.riderA.riderId,
        round: 1,
        status: 'pending',
        score: 50,
        scoreBreakdown: '[]',
        ruleVersion: 'test',
        pickupEtaSeconds: 300,
        pickupDistanceMetres: 1200,
        expiresAt: new Date(Date.now() + 60_000),
      },
      select: { id: true },
    });

    await context.app.inject({
      method: 'POST',
      url: `/v1/rider/offers/${offer.id}/respond`,
      headers: riderA.headers,
      payload: { accept: true },
    });
    for (const to of ['rider_arrived', 'picked_up', 'en_route']) {
      await context.app.inject({
        method: 'POST',
        url: `/v1/rider/deliveries/${orderId}/progress`,
        headers: riderA.headers,
        payload: { to },
      });
    }

    const beforeOwned = await rawBalance('rider_payable', world.riderA.riderId);

    const completed = await context.app.inject({
      method: 'POST',
      url: `/v1/rider/deliveries/${orderId}/complete`,
      headers: riderA.headers,
      payload: { pin: body.deliveryPin },
    });
    expect(completed.statusCode).toBe(200);

    const afterOwned = await rawBalance('rider_payable', world.riderA.riderId);
    // A liability credit is negative, so the rider is now owed money.
    expect(afterOwned).toBeLessThan(beforeOwned);

    await expectLedgerBalanced();
  });

  it('does not pay twice when completion is attempted again', async () => {
    const created = await context.app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: { ...customerA.headers, 'idempotency-key': idempotencyKey('pay2') },
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
    const body = created.json<{ order: { id: string }; deliveryPin: string }>();
    const orderId = body.order.id;

    await context.app.inject({
      method: 'POST',
      url: `/v1/vendor/orders/${orderId}/accept`,
      headers: vendorA.headers,
      payload: { prepMinutes: 1 },
    });
    for (const to of ['preparing', 'ready']) {
      await context.app.inject({
        method: 'POST',
        url: `/v1/vendor/orders/${orderId}/progress`,
        headers: vendorA.headers,
        payload: { to },
      });
    }

    const offer = await context.prisma.dispatchOffer.create({
      data: {
        orderId,
        riderId: world.riderB.riderId,
        round: 1,
        status: 'pending',
        score: 50,
        scoreBreakdown: '[]',
        ruleVersion: 'test',
        pickupEtaSeconds: 300,
        pickupDistanceMetres: 1200,
        expiresAt: new Date(Date.now() + 60_000),
      },
      select: { id: true },
    });

    const riderB = await actAs(context, world.riderB.email);
    await context.app.inject({
      method: 'POST',
      url: `/v1/rider/offers/${offer.id}/respond`,
      headers: riderB.headers,
      payload: { accept: true },
    });
    for (const to of ['rider_arrived', 'picked_up', 'en_route']) {
      await context.app.inject({
        method: 'POST',
        url: `/v1/rider/deliveries/${orderId}/progress`,
        headers: riderB.headers,
        payload: { to },
      });
    }

    await context.app.inject({
      method: 'POST',
      url: `/v1/rider/deliveries/${orderId}/complete`,
      headers: riderB.headers,
      payload: { pin: body.deliveryPin },
    });
    const afterFirst = await rawBalance('rider_payable', world.riderB.riderId);

    // Second completion must be refused by the state machine, and must not pay.
    const second = await context.app.inject({
      method: 'POST',
      url: `/v1/rider/deliveries/${orderId}/complete`,
      headers: riderB.headers,
      payload: { pin: body.deliveryPin },
    });
    expect(second.statusCode).toBe(409);

    const afterSecond = await rawBalance('rider_payable', world.riderB.riderId);
    expect(afterSecond).toBe(afterFirst);

    const assignments = await context.prisma.ledgerTransaction.count({
      where: { referenceId: orderId, kind: 'order_settlement' },
    });
    expect(assignments).toBe(1);

    await expectLedgerBalanced();
  });

  it('generates no pay from an order that never reached delivery', async () => {
    const order = await placeOrder();

    const settlements = await context.prisma.ledgerTransaction.count({
      where: { referenceId: order.id, kind: 'order_settlement' },
    });
    expect(settlements).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('the ledger reconciles overall', () => {
  it('has no unbalanced transaction anywhere after the whole suite', async () => {
    await expectLedgerBalanced();
  });

  it('agrees with the integrity endpoint', async () => {
    const response = await context.app.inject({
      method: 'GET',
      url: '/v1/finance/ledger/integrity',
      headers: finance.headers,
    });

    const body = response.json<{
      balanced: boolean;
      totalDriftKobo: number;
      transactionsChecked: number;
    }>();
    expect(body.balanced).toBe(true);
    expect(body.totalDriftKobo).toBe(0);
    expect(body.transactionsChecked).toBeGreaterThan(0);
  });
});
