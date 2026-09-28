/**
 * Checkout through the real Paystack adapter, against a simulated Paystack.
 *
 * The adapter under test is `PaystackPaymentAdapter` itself — not the mock —
 * wired into a real API with its `fetch` pointed at an in-memory Paystack that
 * behaves like the documented one: initialisation returns a checkout URL,
 * nothing is paid until the "customer" pays, verification reports what
 * happened. No request leaves the process, so no card can be charged.
 *
 * What is being proven is the P0 money path:
 *   - an order is never placed because a checkout started or an app said so;
 *   - it is placed exactly once when the provider reports the right amount,
 *     whether the webhook or the returning app arrives first, or both at once;
 *   - a provider outage is never mistaken for a failure or a success;
 *   - an abandoned checkout can be retried without charging twice.
 */

import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PaystackPaymentAdapter } from '../adapters/paystack.js';
import { createTestContext, type TestContext } from './harness.js';
import { actAs, buildWorld, idempotencyKey, type Actor, type World } from './world.js';

const SECRET = ['sk', 'test', 'simulated'.repeat(5)].join('_');

/** An in-memory Paystack. `pay`, `decline` and `down` are the test's levers. */
class FakePaystack {
  readonly transactions = new Map<string, { amount: number; currency: string; status: string; id: number }>();
  down = false;
  initialisations = 0;
  private nextId = 1000;

  readonly fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (this.down) throw new TypeError('fetch failed');
    const path = String(input).replace('https://api.paystack.co', '');
    const answer = (status: number, json: unknown) => new Response(JSON.stringify(json), { status });

    if (path === '/transaction/initialize' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { reference: string; amount: number; currency: string; email: string };
      if (this.transactions.has(body.reference)) return answer(400, { status: false, message: 'Duplicate Transaction Reference' });
      if (!body.email.includes('@') || body.email.endsWith('.test.invalid')) return answer(400, { status: false, message: 'Invalid Email Address Passed' });
      this.initialisations += 1;
      this.transactions.set(body.reference, { amount: body.amount, currency: body.currency, status: 'abandoned', id: this.nextId++ });
      return answer(200, { status: true, data: { authorization_url: `https://checkout.paystack.com/${body.reference}`, reference: body.reference } });
    }

    const verify = /^\/transaction\/verify\/(.+)$/.exec(path);
    if (verify) {
      const reference = decodeURIComponent(verify[1]!);
      const tx = this.transactions.get(reference);
      if (!tx) return answer(400, { status: false, message: 'Transaction reference not found' });
      return answer(200, { status: true, data: { id: tx.id, reference, status: tx.status, amount: tx.amount, currency: tx.currency } });
    }
    return answer(404, { status: false, message: 'Not found' });
  }) as typeof fetch;

  /** The customer completes checkout — optionally for a different amount. */
  pay(reference: string, amount?: number): void {
    const tx = this.transactions.get(reference)!;
    tx.status = 'success';
    if (amount !== undefined) tx.amount = amount;
  }

  decline(reference: string): void {
    this.transactions.get(reference)!.status = 'failed';
  }

  /** A correctly signed `charge.success` webhook body for a reference. */
  webhook(reference: string): { raw: string; signature: string } {
    const tx = this.transactions.get(reference)!;
    const raw = JSON.stringify({
      event: 'charge.success',
      data: { id: tx.id, reference, status: tx.status, amount: tx.amount, currency: tx.currency },
    });
    return { raw, signature: createHmac('sha512', SECRET).update(raw).digest('hex') };
  }
}

const paystack = new FakePaystack();
let context: TestContext;
let world: World;
let customerA: Actor;
let customerB: Actor;

beforeAll(async () => {
  vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
  context = await createTestContext({}, { payments: new PaystackPaymentAdapter({ secretKey: SECRET, fetch: paystack.fetch }) });
  world = await buildWorld(context.prisma);
  customerA = await actAs(context, world.customerA.email);
  customerB = await actAs(context, world.customerB.email);
}, 180_000);

afterAll(async () => {
  await context?.close();
});

async function checkout(actor: Actor = customerA) {
  const response = await context.app.inject({
    method: 'POST',
    url: '/v1/orders',
    headers: { ...actor.headers, 'idempotency-key': idempotencyKey('paystack') },
    payload: {
      branchId: world.vendorA.branchId,
      items: [{ itemId: world.vendorA.itemId, quantity: 1, modifierIds: [world.vendorA.modifierId] }],
      mode: 'delivery',
      addressId: actor === customerA ? world.customerA.addressId : world.customerB.addressId,
      paymentMethod: 'card',
    },
  });
  return response;
}

async function placedCheckout() {
  const response = await checkout();
  expect(response.statusCode, response.body).toBe(200);
  const body = response.json<{ order: { id: string; code: string; total: number }; payment: { status: string; authorizationUrl: string } }>();
  return body;
}

const orderStatus = async (id: string) => (await context.prisma.order.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;
const ledgerCount = (id: string) => context.prisma.ledgerTransaction.count({ where: { referenceId: id } });

function verify(orderId: string, actor: Actor = customerA) {
  return context.app.inject({ method: 'POST', url: `/v1/orders/${orderId}/payment/verify`, headers: actor.headers });
}

function postWebhook(body: { raw: string; signature: string }) {
  return context.app.inject({
    method: 'POST',
    url: '/v1/webhooks/payments',
    headers: { 'content-type': 'application/json', 'x-paystack-signature': body.signature },
    payload: body.raw,
  });
}

describe('checkout', () => {
  it('starts a Paystack checkout and places nothing', async () => {
    const { order, payment } = await placedCheckout();
    expect(payment.status).toBe('pending');
    expect(payment.authorizationUrl).toMatch(/^https:\/\/checkout\.paystack\.com\//);
    expect(await orderStatus(order.id)).toBe('payment_pending');
    expect(await ledgerCount(order.id)).toBe(0);
  });

  it('sends Paystack the amount computed on the server, and the customer’s proved email', async () => {
    const { order } = await placedCheckout();
    const tx = paystack.transactions.get(order.code)!;
    expect(tx.amount).toBe(order.total);
    expect(tx.currency).toBe('NGN');
  });

  it('refuses cash and wallet, which do not exist yet, before creating anything', async () => {
    const before = paystack.initialisations;
    const ordersBefore = await context.prisma.order.count();
    for (const paymentMethod of ['cash', 'wallet']) {
      const response = await context.app.inject({
        method: 'POST',
        url: '/v1/orders',
        headers: { ...customerA.headers, 'idempotency-key': idempotencyKey('method') },
        payload: {
          branchId: world.vendorA.branchId,
          items: [{ itemId: world.vendorA.itemId, quantity: 1, modifierIds: [world.vendorA.modifierId] }],
          mode: 'delivery',
          addressId: world.customerA.addressId,
          paymentMethod,
        },
      });
      expect(response.statusCode, paymentMethod).toBe(422);
    }
    expect(paystack.initialisations).toBe(before);
    expect(await context.prisma.order.count()).toBe(ordersBefore);
  });

  it('returns the order to a basket, and charges nothing, when Paystack is unreachable', async () => {
    paystack.down = true;
    try {
      const response = await checkout();
      expect(response.statusCode).toBe(503);
    } finally {
      paystack.down = false;
    }
    const latest = await context.prisma.order.findFirstOrThrow({ where: { customerId: world.customerA.customerId }, orderBy: { createdAt: 'desc' } });
    expect(latest.status).toBe('draft');
  });
});

describe('the app returning from checkout', () => {
  it('does not place an order the customer has not paid for', async () => {
    const { order } = await placedCheckout();
    const response = await verify(order.id);
    expect(response.statusCode).toBe(200);
    expect(response.json<{ payment: { outcome: string } }>().payment.outcome).toBe('pending');
    expect(await orderStatus(order.id)).toBe('payment_pending');
  });

  it('places the order once Paystack reports the payment', async () => {
    const { order } = await placedCheckout();
    paystack.pay(order.code);
    const response = await verify(order.id);
    expect(response.json<{ payment: { outcome: string }; order: { status: string } }>()).toMatchObject({
      payment: { outcome: 'captured' },
      order: { status: 'placed' },
    });
    expect(await ledgerCount(order.id)).toBe(1);
  });

  it('refuses when Paystack captured a different amount', async () => {
    const { order } = await placedCheckout();
    paystack.pay(order.code, 100);
    const response = await verify(order.id);
    expect(response.json<{ payment: { outcome: string } }>().payment.outcome).toBe('amount_mismatch');
    expect(await orderStatus(order.id)).toBe('payment_pending');
    expect(await ledgerCount(order.id)).toBe(0);
  });

  it('reports a decline without placing anything', async () => {
    const { order } = await placedCheckout();
    paystack.decline(order.code);
    expect((await verify(order.id)).json<{ payment: { outcome: string } }>().payment.outcome).toBe('failed');
    expect(await orderStatus(order.id)).toBe('payment_pending');
  });

  it('answers 503 — not "failed" — when Paystack cannot be asked', async () => {
    const { order } = await placedCheckout();
    paystack.pay(order.code);
    paystack.down = true;
    try {
      expect((await verify(order.id)).statusCode).toBe(503);
    } finally {
      paystack.down = false;
    }
    const payment = await context.prisma.payment.findFirstOrThrow({ where: { orderId: order.id } });
    expect(payment.status).toBe('pending');
    // And once Paystack is back, the same call settles it.
    expect((await verify(order.id)).json<{ order: { status: string } }>().order.status).toBe('placed');
  });

  it('will not let one customer check another customer’s payment', async () => {
    const { order } = await placedCheckout();
    expect((await verify(order.id, customerB)).statusCode).toBe(404);
  });
});

describe('webhook and app together', () => {
  it('places the order exactly once when the webhook arrives first', async () => {
    const { order } = await placedCheckout();
    paystack.pay(order.code);
    expect((await postWebhook(paystack.webhook(order.code))).statusCode).toBe(200);
    expect((await verify(order.id)).json<{ payment: { outcome: string } }>().payment.outcome).toBe('captured');
    expect(await ledgerCount(order.id)).toBe(1);
  });

  it('places the order exactly once when both arrive at the same moment', async () => {
    const { order } = await placedCheckout();
    paystack.pay(order.code);
    const hook = paystack.webhook(order.code);
    const results = await Promise.all([postWebhook(hook), verify(order.id), verify(order.id), postWebhook(hook)]);
    for (const response of results) expect(response.statusCode).toBeLessThan(500);
    expect(await orderStatus(order.id)).toBe('placed');
    expect(await ledgerCount(order.id)).toBe(1);
    expect(await context.prisma.orderStatusEvent.count({ where: { orderId: order.id, toStatus: 'placed' } })).toBe(1);
  });

  it('refuses a webhook signed with anything but the secret key', async () => {
    const { order } = await placedCheckout();
    paystack.pay(order.code);
    const hook = paystack.webhook(order.code);
    const forged = { raw: hook.raw, signature: createHmac('sha512', 'not-the-key').update(hook.raw).digest('hex') };
    const response = await postWebhook(forged);
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(JSON.stringify({ received: true }));
    expect(await orderStatus(order.id)).toBe('payment_pending');
  });

  it('processes a webhook again after Paystack was unreachable the first time', async () => {
    // The earlier behaviour recorded the event before settling it, so the
    // provider's retry was treated as a duplicate and the payment was never
    // confirmed. Regression test for that.
    const { order } = await placedCheckout();
    paystack.pay(order.code);
    const hook = paystack.webhook(order.code);

    paystack.down = true;
    try {
      expect((await postWebhook(hook)).statusCode).toBe(503);
    } finally {
      paystack.down = false;
    }
    expect(await orderStatus(order.id)).toBe('payment_pending');

    const retry = await postWebhook(hook);
    expect(retry.json<{ processed?: boolean }>().processed).toBe(true);
    expect(await orderStatus(order.id)).toBe('placed');

    // And a third delivery is now a plain duplicate.
    expect((await postWebhook(hook)).json<{ duplicate?: boolean }>().duplicate).toBe(true);
  });
});

describe('retrying payment', () => {
  it('hands back the same checkout while the first is still open', async () => {
    const { order, payment } = await placedCheckout();
    const before = paystack.initialisations;
    const response = await context.app.inject({ method: 'POST', url: `/v1/orders/${order.id}/payment/retry`, headers: customerA.headers });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ payment: { authorizationUrl: string } }>().payment.authorizationUrl).toBe(payment.authorizationUrl);
    expect(paystack.initialisations).toBe(before);
  });

  it('starts a fresh checkout with a new reference after a decline, for the stored total', async () => {
    const { order } = await placedCheckout();
    paystack.decline(order.code);
    const response = await context.app.inject({
      method: 'POST',
      url: `/v1/orders/${order.id}/payment/retry`,
      headers: customerA.headers,
      // A client-supplied amount is ignored: there is nowhere for it to go.
      payload: { amount: 1 },
    });
    expect(response.statusCode, response.body).toBe(200);
    const retried = paystack.transactions.get(`${order.code}-P2`);
    expect(retried?.amount).toBe(order.total);

    paystack.pay(`${order.code}-P2`);
    expect((await verify(order.id)).json<{ order: { status: string } }>().order.status).toBe('placed');
    expect(await ledgerCount(order.id)).toBe(1);
  });

  it('does not start a second checkout for a payment that has in fact gone through', async () => {
    const { order } = await placedCheckout();
    paystack.pay(order.code);
    const before = paystack.initialisations;
    const response = await context.app.inject({ method: 'POST', url: `/v1/orders/${order.id}/payment/retry`, headers: customerA.headers });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ payment: { status: string } }>().payment.status).toBe('captured');
    expect(paystack.initialisations).toBe(before);
    expect(await orderStatus(order.id)).toBe('placed');
  });

  it('refuses to retry someone else’s order', async () => {
    const { order } = await placedCheckout();
    const response = await context.app.inject({ method: 'POST', url: `/v1/orders/${order.id}/payment/retry`, headers: customerB.headers });
    expect(response.statusCode).toBe(404);
  });
});
