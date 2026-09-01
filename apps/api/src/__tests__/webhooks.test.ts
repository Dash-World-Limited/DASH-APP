/**
 * Payment webhooks — integration tests.
 *
 * The webhook is the one place an unauthenticated request can move money, so it
 * gets the most adversarial treatment in the suite.
 *
 * The single most important property asserted here is that a hostile caller
 * learns nothing. Every rejection — bad signature, unknown event, unknown
 * payment, amount mismatch — returns the same bland `200 { received: true }`.
 * A 401 on a bad signature would tell someone probing that their signature was
 * the only thing wrong; a 404 on an unknown reference would turn the endpoint
 * into an oracle for which payment references exist.
 */

import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { kobo } from '@dash/domain/money';
import { createTestContext, type TestContext } from './harness.js';
import { buildWorld, type World } from './world.js';

let context: TestContext;
let world: World;

beforeAll(async () => {
  context = await createTestContext();
  world = await buildWorld(context.prisma);
});

afterAll(async () => {
  await context.close();
});

/**
 * Sign exactly the way `MockPaymentAdapter` verifies.
 *
 * Deliberately reimplemented rather than imported: if the adapter's scheme
 * changes, these tests should fail rather than silently follow it.
 */
function sign(rawBody: string): string {
  return createHash('sha256').update(`${rawBody}.mock-webhook-secret`).digest('hex');
}

function post(body: unknown, options: { signature?: string | null } = {}) {
  const raw = JSON.stringify(body);
  const signature = options.signature === undefined ? sign(raw) : options.signature;

  return context.app.inject({
    method: 'POST',
    url: '/v1/webhooks/payments',
    headers: {
      'content-type': 'application/json',
      ...(signature === null ? {} : { 'x-dash-signature': signature }),
    },
    payload: raw,
  });
}

let eventCounter = 0;
const nextEventId = (): string => {
  eventCounter += 1;
  return `evt_test_${Date.now()}_${eventCounter}`;
};

/**
 * An order sitting at `payment_pending` with a captured-amount payment row,
 * which is the state a real webhook arrives into.
 */
async function pendingOrder(
  amount = 500_000,
  /**
   * What the provider will report on `verify()`. Defaults to the recorded
   * amount; pass a different value to simulate the provider and our own record
   * disagreeing, which is the mismatch that actually matters.
   */
  providerAmount = amount,
): Promise<{
  orderId: string;
  reference: string;
  amount: number;
}> {
  const reference = `DASH-WH${eventCounter}-${Date.now()}`;

  const order = await context.prisma.order.create({
    data: {
      code: reference,
      customerId: world.customerA.customerId,
      vendorId: world.vendorA.vendorId,
      branchId: world.vendorA.branchId,
      addressId: world.customerA.addressId,
      zoneId: world.zoneId,
      status: 'payment_pending',
      mode: 'delivery',
      itemsSubtotal: amount,
      total: amount,
      quoteBreakdown: JSON.stringify({
        itemsSubtotal: amount,
        discountTotal: 0,
        deliveryFee: 0,
        serviceFee: 0,
        smallOrderFee: 0,
        surgeAmount: 0,
        tax: 0,
        tip: 0,
        walletCreditApplied: 0,
        total: amount,
        vendorFundedDiscount: 0,
        platformFundedDiscount: 0,
        vendorFundedItemDiscount: 0,
        platformFundedItemDiscount: 0,
        vendorFundedDeliveryDiscount: 0,
        platformFundedDeliveryDiscount: 0,
        lines: [],
        ruleVersion: 'test',
        currency: 'NGN',
        inputs: { surgeMultiplier: 1 },
      }),
      pricingRuleVersion: 'test',
      distanceMetres: 1000,
    },
    select: { id: true },
  });

  await context.prisma.payment.create({
    data: {
      orderId: order.id,
      provider: 'mock',
      providerReference: reference,
      amount,
      method: 'card',
      status: 'pending',
      idempotencyKey: `wh_${order.id}`,
    },
  });

  // The mock adapter resolves `verify()` from its in-memory record, so the
  // intent has to exist there too.
  await context.app.services.payments.initialize({
    amount: kobo(providerAmount),
    currency: 'NGN',
    reference,
    customerEmail: 'wh@dashapp.test',
    idempotencyKey: `wh_${order.id}`,
  });

  return { orderId: order.id, reference, amount };
}

const captureEvent = (reference: string, amount: number, overrides: Record<string, unknown> = {}) => ({
  id: nextEventId(),
  type: 'charge.success',
  reference,
  status: 'captured',
  amount,
  ...overrides,
});

describe('signature verification', () => {
  it('accepts a correctly signed event', async () => {
    const order = await pendingOrder();
    const response = await post(captureEvent(order.reference, order.amount));

    expect(response.statusCode).toBe(200);
    expect(response.json<{ processed?: boolean }>().processed).toBe(true);
  });

  it('answers 200 and does nothing when the signature is missing', async () => {
    const order = await pendingOrder();
    const response = await post(captureEvent(order.reference, order.amount), { signature: null });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ processed?: boolean }>().processed).toBeUndefined();

    const after = await context.prisma.order.findUniqueOrThrow({ where: { id: order.orderId } });
    expect(after.status).toBe('payment_pending');
  });

  it('answers 200 and does nothing when the signature is wrong', async () => {
    const order = await pendingOrder();
    const response = await post(captureEvent(order.reference, order.amount), {
      signature: 'a'.repeat(64),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ processed?: boolean }>().processed).toBeUndefined();

    const after = await context.prisma.order.findUniqueOrThrow({ where: { id: order.orderId } });
    expect(after.status).toBe('payment_pending');
  });

  it('rejects a body tampered with after signing', async () => {
    const order = await pendingOrder();

    // Sign an honest body, then send a different one.
    const honest = JSON.stringify(captureEvent(order.reference, order.amount));
    const tampered = JSON.stringify(captureEvent(order.reference, 999_999_999));

    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/webhooks/payments',
      headers: { 'content-type': 'application/json', 'x-dash-signature': sign(honest) },
      payload: tampered,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ processed?: boolean }>().processed).toBeUndefined();

    const after = await context.prisma.order.findUniqueOrThrow({ where: { id: order.orderId } });
    expect(after.status).toBe('payment_pending');
  });

  it('gives a hostile caller the same answer at every rejection stage', async () => {
    // A missing signature, a wrong signature, an unknown reference, and a
    // mismatched amount must all look alike from outside. Anything else is an
    // oracle for working out what to change next.
    const order = await pendingOrder();

    const responses = [
      await post(captureEvent(order.reference, order.amount), { signature: null }),
      await post(captureEvent(order.reference, order.amount), { signature: 'b'.repeat(64) }),
      await post(captureEvent('DASH-NOT-A-REAL-REFERENCE', 1000)),
      await post({ id: nextEventId(), type: 'charge.success', reference: 'x' }),
    ];

    for (const response of responses) {
      expect(response.statusCode).toBe(200);
      expect(response.body).toBe(JSON.stringify({ received: true }));
    }
  });

  it('does not leak which verification stage failed', async () => {
    const response = await post({ nonsense: true }, { signature: 'c'.repeat(64) });

    for (const leak of ['signature', 'invalid', 'mismatch', 'unknown', 'stack', 'prisma']) {
      expect(response.body.toLowerCase(), `leaked "${leak}"`).not.toContain(leak);
    }
  });
});

describe('replay protection', () => {
  it('processes an event id exactly once', async () => {
    const order = await pendingOrder();
    const event = captureEvent(order.reference, order.amount);

    const first = await post(event);
    expect(first.json<{ processed?: boolean }>().processed).toBe(true);

    const second = await post(event);
    expect(second.statusCode).toBe(200);
    expect(second.json<{ duplicate?: boolean }>().duplicate).toBe(true);
    expect(second.json<{ processed?: boolean }>().processed).toBeUndefined();
  });

  it('does not double the financial effect on replay', async () => {
    const order = await pendingOrder();
    const event = captureEvent(order.reference, order.amount);

    await post(event);
    const afterFirst = await context.prisma.ledgerTransaction.count({
      where: { referenceId: order.orderId },
    });

    await post(event);
    await post(event);

    const afterReplays = await context.prisma.ledgerTransaction.count({
      where: { referenceId: order.orderId },
    });

    expect(afterFirst).toBe(1);
    expect(afterReplays).toBe(1);
  });

  it('survives concurrent delivery of the same event', async () => {
    // Providers retry aggressively and can deliver twice at once. The unique
    // constraint on (provider, eventId) is what makes this safe, not luck.
    const order = await pendingOrder();
    const event = captureEvent(order.reference, order.amount);

    const results = await Promise.all([post(event), post(event), post(event), post(event)]);

    for (const response of results) {
      expect(response.statusCode).toBe(200);
    }

    const processed = results.filter(
      (r) => r.json<{ processed?: boolean }>().processed === true,
    );
    expect(processed).toHaveLength(1);

    expect(
      await context.prisma.ledgerTransaction.count({ where: { referenceId: order.orderId } }),
    ).toBe(1);
  });

  it('stores the event for later inspection', async () => {
    const order = await pendingOrder();
    const event = captureEvent(order.reference, order.amount);
    await post(event);

    const stored = await context.prisma.paymentWebhook.findFirst({
      where: { eventId: event.id },
    });

    expect(stored).not.toBeNull();
    expect(stored!.signatureValid).toBe(true);
    expect(stored!.processedAt).not.toBeNull();
  });

  it('records a distinct event id for the same payment as a separate event', async () => {
    // Webhook idempotency (event id) and financial idempotency (order state)
    // are different mechanisms. A second event for an already-placed order is
    // accepted as new, and must still not move money twice.
    const order = await pendingOrder();

    await post(captureEvent(order.reference, order.amount));
    const second = await post(captureEvent(order.reference, order.amount));

    expect(second.json<{ duplicate?: boolean }>().duplicate).toBeUndefined();
    expect(
      await context.prisma.ledgerTransaction.count({ where: { referenceId: order.orderId } }),
    ).toBe(1);
  });
});

describe('amount and reference integrity', () => {
  it('ignores the amount claimed in the body — the provider is authoritative', async () => {
    // The body is attacker-influenced even when correctly signed, so the route
    // re-asks the provider rather than believing it. A tampered body amount is
    // therefore simply irrelevant, which is a stronger property than comparing
    // the two and rejecting.
    const order = await pendingOrder(500_000);
    const response = await post(captureEvent(order.reference, 1));

    expect(response.json<{ processed?: boolean }>().processed).toBe(true);

    const entries = await context.prisma.ledgerEntry.findMany({
      where: { transaction: { referenceId: order.orderId }, accountKind: 'platform_cash' },
    });
    // Booked at the real amount, not the one the body asked for.
    expect(entries[0]?.amount).toBe(500_000);
  });

  it('refuses when the provider disagrees with the payment record', async () => {
    // The mismatch that matters: our row says one thing, the provider says
    // another. Fulfilling on that would mean shipping food for the wrong money.
    const order = await pendingOrder(500_000, 100_000);
    const response = await post(captureEvent(order.reference, 500_000));

    expect(response.statusCode).toBe(200);
    expect(response.json<{ processed?: boolean }>().processed).toBeUndefined();

    const after = await context.prisma.order.findUniqueOrThrow({ where: { id: order.orderId } });
    expect(after.status).toBe('payment_pending');
    expect(
      await context.prisma.ledgerTransaction.count({ where: { referenceId: order.orderId } }),
    ).toBe(0);
  });

  it('records why a mismatched event was refused', async () => {
    const order = await pendingOrder(500_000, 250_000);
    const event = captureEvent(order.reference, 500_000);
    await post(event);

    const stored = await context.prisma.paymentWebhook.findFirstOrThrow({
      where: { eventId: event.id },
    });
    expect(stored.processingError).toBe('amount_mismatch');
    expect(stored.processedAt).toBeNull();
  });

  it('ignores an event for a payment reference it has never seen', async () => {
    const response = await post(captureEvent('DASH-GHOST-REFERENCE', 100));

    expect(response.statusCode).toBe(200);
    expect(response.json<{ processed?: boolean }>().processed).toBeUndefined();
  });

  it('leaves no partial state when it refuses', async () => {
    const order = await pendingOrder(500_000, 42);
    await post(captureEvent(order.reference, 500_000));

    const after = await context.prisma.order.findUniqueOrThrow({
      where: { id: order.orderId },
      select: { status: true, placedAt: true },
    });
    const payment = await context.prisma.payment.findFirstOrThrow({
      where: { orderId: order.orderId },
    });

    // Nothing advanced: not the order, not the payment, not the ledger.
    expect(after.status).toBe('payment_pending');
    expect(after.placedAt).toBeNull();
    expect(payment.status).toBe('pending');
    expect(
      await context.prisma.ledgerEntry.count({
        where: { transaction: { referenceId: order.orderId } },
      }),
    ).toBe(0);
  });
});

describe('malformed input', () => {
  it('survives a body that is not JSON', async () => {
    const raw = 'this is not json';
    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/webhooks/payments',
      headers: { 'content-type': 'application/json', 'x-dash-signature': sign(raw) },
      payload: raw,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ processed?: boolean }>().processed).toBeUndefined();
  });

  it('survives an empty body', async () => {
    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/webhooks/payments',
      headers: { 'content-type': 'application/json', 'x-dash-signature': sign('') },
      payload: '',
    });

    expect(response.statusCode).toBe(200);
  });

  it('ignores an event missing its required fields', async () => {
    for (const body of [
      { type: 'charge.success', reference: 'x' },
      { id: nextEventId(), reference: 'x' },
      { id: nextEventId(), type: 'charge.success' },
      {},
    ]) {
      const response = await post(body);
      expect(response.statusCode).toBe(200);
      expect(response.json<{ processed?: boolean }>().processed).toBeUndefined();
    }
  });

  it('ignores an unknown event type for an unknown reference', async () => {
    const response = await post({
      id: nextEventId(),
      type: 'charge.dispute.opened',
      reference: 'DASH-UNKNOWN',
      status: 'captured',
      amount: 100,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ processed?: boolean }>().processed).toBeUndefined();
  });
});

describe('what the webhook records', () => {
  beforeEach(async () => {
    await context.prisma.auditLog.deleteMany({});
  });

  it('never stores a signature or secret alongside the event', async () => {
    const order = await pendingOrder();
    const event = captureEvent(order.reference, order.amount);
    const signature = sign(JSON.stringify(event));

    await post(event);

    const stored = await context.prisma.paymentWebhook.findFirstOrThrow({
      where: { eventId: event.id },
    });
    const serialised = JSON.stringify(stored);

    expect(serialised).not.toContain(signature);
    expect(serialised).not.toContain('mock-webhook-secret');
  });

  it('caps how much of the payload it retains', async () => {
    const order = await pendingOrder();
    const event = captureEvent(order.reference, order.amount, {
      padding: 'x'.repeat(60_000),
    });

    const response = await post(event);
    expect(response.statusCode).toBe(200);

    const stored = await context.prisma.paymentWebhook.findFirst({
      where: { eventId: event.id },
    });
    if (stored) {
      // Bounded so a hostile provider cannot fill the database one event at a
      // time.
      expect(stored.rawPayload.length).toBeLessThanOrEqual(20_000);
    }
  });
});

describe('authorization', () => {
  it('needs no credentials — the signature IS the credential', async () => {
    const order = await pendingOrder();
    const response = await post(captureEvent(order.reference, order.amount));

    expect(response.statusCode).toBe(200);
    expect(response.json<{ processed?: boolean }>().processed).toBe(true);
  });

  it('is not a way for a signed-in customer to place their own order', async () => {
    // Signing is the only thing that matters here; being authenticated as the
    // customer neither helps nor is required. This asserts the endpoint has not
    // grown an accidental second path.
    const order = await pendingOrder();

    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/webhooks/payments',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer definitely-not-a-real-token',
      },
      payload: JSON.stringify(captureEvent(order.reference, order.amount)),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ processed?: boolean }>().processed).toBeUndefined();
  });
});
