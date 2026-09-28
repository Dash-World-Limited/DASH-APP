/**
 * A refund becomes "refunded" only when Paystack confirms it.
 *
 * The real `PaystackPaymentAdapter`, a real API and database, and an in-memory
 * Paystack with transactions *and* refunds — the refunds a person makes in
 * the Paystack dashboard. No request leaves the process.
 *
 * What is being proven:
 *   - a person cannot declare a refund done; they link Paystack's refund id and
 *     Paystack's answer decides — processed, for this payment, for exactly the
 *     recorded amount, in naira;
 *   - a refund for another payment, another amount or another currency is
 *     refused and changes nothing;
 *   - one Paystack refund can never settle two refunds of ours, and a second
 *     Paystack refund cannot be linked while the first is still in flight;
 *   - "could not ask Paystack" changes nothing;
 *   - the webhook and reconciliation finish a refund that was still processing;
 *   - the customer sees "Refunded" only after all that, and never a provider id;
 *   - confirming moves no money in the ledger — it was booked at approval.
 */

import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PaystackPaymentAdapter } from '../adapters/paystack.js';
import { runPaymentReconciliation } from '../jobs/payment-reconciliation.js';
import { createTestContext, type TestContext } from './harness.js';
import { actAs, buildWorld, type Actor, type World } from './world.js';

const SECRET = ['sk', 'test', 'refundsimulated'.repeat(3)].join('_');

/** An in-memory Paystack: transactions, and refunds made "in the dashboard". */
class FakePaystack {
  readonly transactions = new Map<string, { id: number; amount: number; currency: string; status: string }>();
  readonly refunds = new Map<number, { transaction: number; amount: number; currency: string; status: string }>();
  readonly paths: string[] = [];
  down = false;
  private nextId = 7000;
  private barrier: { waiting: number; size: number; release: () => void; released: Promise<void> } | null = null;

  /**
   * Hold refund lookups until `size` of them have arrived, then answer all at
   * once — so concurrent confirmations all read the refund before any writes.
   */
  holdRefundLookups(size: number): void {
    let release = () => {};
    const released = new Promise<void>((resolve) => (release = resolve));
    this.barrier = { waiting: 0, size, release, released };
  }

  readonly fetch = (async (input: string | URL | Request) => {
    if (this.down) throw new TypeError('fetch failed');
    const path = String(input).replace('https://api.paystack.co', '');
    this.paths.push(path);
    if (this.barrier && path.startsWith('/refund/')) {
      const barrier = this.barrier;
      barrier.waiting += 1;
      if (barrier.waiting >= barrier.size) {
        this.barrier = null;
        barrier.release();
      }
      await barrier.released;
    }
    const answer = (status: number, json: unknown) => new Response(JSON.stringify(json), { status });

    const verify = /^\/transaction\/verify\/(.+)$/.exec(path);
    if (verify) {
      const reference = decodeURIComponent(verify[1]!);
      const tx = this.transactions.get(reference);
      if (!tx) return answer(400, { status: false, message: 'Transaction reference not found' });
      return answer(200, { status: true, data: { ...tx, reference } });
    }

    const refund = /^\/refund\/(\d+)$/.exec(path);
    if (refund) {
      const id = Number(refund[1]);
      const found = this.refunds.get(id);
      if (!found) return answer(404, { status: false, message: 'Refund not found' });
      return answer(200, { status: true, message: 'Refund retrieved', data: { id, ...found } });
    }
    return answer(404, { status: false, message: 'Not found' });
  }) as typeof fetch;

  captured(reference: string, amount: number): void {
    this.transactions.set(reference, { id: this.nextId++, amount, currency: 'NGN', status: 'success' });
  }

  /** What a person does in the Paystack dashboard. Returns the refund id. */
  refundInDashboard(reference: string, amount: number, status = 'pending', currency = 'NGN'): number {
    const id = this.nextId++;
    this.refunds.set(id, { transaction: this.transactions.get(reference)!.id, amount, currency, status });
    return id;
  }

  settle(id: number, status: 'processed' | 'failed'): void {
    this.refunds.get(id)!.status = status;
  }

  /** A correctly signed `refund.*` webhook. */
  refundWebhook(id: number, reference: string, event = 'refund.processed'): { raw: string; signature: string } {
    const refund = this.refunds.get(id)!;
    const raw = JSON.stringify({
      event,
      data: { id, transaction_reference: reference, status: refund.status, amount: refund.amount, currency: refund.currency },
    });
    return { raw, signature: createHmac('sha512', SECRET).update(raw).digest('hex') };
  }
}

const paystack = new FakePaystack();
let context: TestContext;
let world: World;
let customerA: Actor;
let finance: Actor;
let counter = 0;

beforeAll(async () => {
  vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
  context = await createTestContext({}, { payments: new PaystackPaymentAdapter({ secretKey: SECRET, fetch: paystack.fetch }) });
  world = await buildWorld(context.prisma);
  customerA = await actAs(context, world.customerA.email);
  finance = await actAs(context, world.finance.email);
  await stepUp();
}, 180_000);

afterAll(async () => {
  await context?.close();
});

async function stepUp(): Promise<void> {
  await context.prisma.session.updateMany({
    where: { identityId: world.finance.identityId, revokedAt: null },
    data: { steppedUpAt: new Date() },
  });
}

/**
 * A cancelled order with a captured Paystack payment and refunds owed on it,
 * as a cancellation or a finance approval leaves them.
 */
async function owed(amounts: number[], options: { captured?: number; provider?: string } = {}) {
  counter += 1;
  const captured = options.captured ?? 500_000;
  const order = await context.prisma.order.create({
    data: {
      code: `DASH-RC${counter}-${Date.now()}`,
      customerId: world.customerA.customerId,
      vendorId: world.vendorA.vendorId,
      branchId: world.vendorA.branchId,
      addressId: world.customerA.addressId,
      zoneId: world.zoneId,
      status: 'cancelled',
      mode: 'delivery',
      itemsSubtotal: 400_000,
      total: captured,
      quoteBreakdown: '{}',
      pricingRuleVersion: 'test',
    },
  });
  const reference = `${order.code}-pay`;
  const payment = await context.prisma.payment.create({
    data: {
      orderId: order.id,
      provider: options.provider ?? 'paystack',
      providerReference: reference,
      amount: captured,
      method: 'card',
      status: 'captured',
      idempotencyKey: `rc_${order.id}`,
      capturedAt: new Date(),
    },
  });
  paystack.captured(reference, captured);
  const refunds = [];
  for (const [index, amount] of amounts.entries()) {
    refunds.push(
      await context.prisma.refund.create({
        data: {
          paymentId: payment.id,
          amount,
          reason: 'Customer cancelled',
          status: 'refund_pending_manual_review',
          idempotencyKey: `rc_${order.id}_${index}`,
          requestedBy: world.finance.identityId,
        },
      }),
    );
  }
  return { order, reference, refunds };
}

const confirm = (refundId: string, refundReference?: string | number, actor: Actor = finance) =>
  context.app.inject({
    method: 'POST',
    url: `/v1/finance/refunds/${refundId}/confirm`,
    headers: actor.headers,
    payload: refundReference === undefined ? {} : { refundReference: String(refundReference) },
  });

const row = (id: string) => context.prisma.refund.findUniqueOrThrow({ where: { id } });

const orderAsCustomer = async (orderId: string) => {
  const response = await context.app.inject({ method: 'GET', url: `/v1/orders/${orderId}`, headers: customerA.headers });
  expect(response.statusCode).toBe(200);
  return response;
};

describe('confirming a refund', () => {
  it('marks it refunded when Paystack reports it processed, for this payment and amount', async () => {
    const { order, reference, refunds } = await owed([500_000]);
    const ledgerBefore = await context.prisma.ledgerTransaction.count();
    const id = paystack.refundInDashboard(reference, 500_000, 'processed');

    const response = await confirm(refunds[0]!.id, id);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ status: 'refunded', label: 'Refunded', providerStatus: 'processed', changed: true });

    const stored = await row(refunds[0]!.id);
    expect(stored).toMatchObject({ status: 'refunded', providerReference: `paystack_refund_${id}`, providerStatus: 'processed' });
    expect(stored.refundedAt).toBeInstanceOf(Date);

    // The ledger was booked when the refund was approved; confirming moves nothing.
    expect(await context.prisma.ledgerTransaction.count()).toBe(ledgerBefore);

    const audit = await context.prisma.auditLog.findMany({ where: { resourceId: refunds[0]!.id, action: 'payment.refund.confirmed' } });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.identityId).toBe(world.finance.identityId);

    // The customer now sees it — in Paystack's terms, with no provider id.
    const detail = await orderAsCustomer(order.id);
    expect(detail.json<{ order: { refunds: { status: string; label: string; amount: number }[] } }>().order.refunds).toEqual([
      expect.objectContaining({ status: 'refunded', label: 'Refunded', amount: 500_000 }),
    ]);
    expect(detail.body).not.toContain('paystack_refund_');
    expect(detail.body).not.toContain(reference);
  });

  it('is a harmless repeat for the same Paystack refund, and refused for a different one', async () => {
    const { reference, refunds } = await owed([500_000]);
    const id = paystack.refundInDashboard(reference, 500_000, 'processed');
    expect((await confirm(refunds[0]!.id, id)).statusCode).toBe(200);

    const again = await confirm(refunds[0]!.id, id);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ status: 'refunded', changed: false });
    expect(
      await context.prisma.auditLog.count({ where: { resourceId: refunds[0]!.id, action: 'payment.refund.confirmed' } }),
    ).toBe(1);

    const other = paystack.refundInDashboard(reference, 500_000, 'processed');
    expect((await confirm(refunds[0]!.id, other)).statusCode).toBe(409);
    expect((await row(refunds[0]!.id)).providerReference).toBe(`paystack_refund_${id}`);
  });

  it('refuses a Paystack refund for a different payment, and changes nothing', async () => {
    const mine = await owed([500_000]);
    const someoneElses = await owed([500_000]);
    const id = paystack.refundInDashboard(someoneElses.reference, 500_000, 'processed');

    const response = await confirm(mine.refunds[0]!.id, id);
    expect(response.statusCode).toBe(422);
    expect(await row(mine.refunds[0]!.id)).toMatchObject({
      status: 'refund_pending_manual_review',
      providerReference: null,
      refundedAt: null,
    });
    expect(
      await context.prisma.auditLog.count({
        where: { resourceId: mine.refunds[0]!.id, action: 'payment.refund.confirmation_refused' },
      }),
    ).toBe(1);
  });

  it('refuses a different amount or currency, and a refund id Paystack does not know', async () => {
    const { reference, refunds } = await owed([200_000]);
    const tooLittle = paystack.refundInDashboard(reference, 199_999, 'processed');
    const tooMuch = paystack.refundInDashboard(reference, 500_000, 'processed');
    const dollars = paystack.refundInDashboard(reference, 200_000, 'processed', 'USD');

    for (const id of [tooLittle, tooMuch, dollars, 999_999_999]) {
      const response = await confirm(refunds[0]!.id, id);
      expect(response.statusCode, String(id)).toBe(422);
    }
    expect(await row(refunds[0]!.id)).toMatchObject({ status: 'refund_pending_manual_review', providerReference: null });
  });

  it('never sends anything but a refund id to Paystack', async () => {
    const { refunds } = await owed([100_000]);
    const before = paystack.paths.length;
    for (const hostile of ['../transaction/export', '1/../../customer', '1?perPage=1000']) {
      expect((await confirm(refunds[0]!.id, hostile)).statusCode, hostile).toBe(400);
    }
    // Letters pass the shape check but never reach Paystack.
    expect((await confirm(refunds[0]!.id, 'abc')).statusCode).toBe(422);
    expect(paystack.paths.slice(before).some((path) => path.startsWith('/refund'))).toBe(false);
  });

  it('refuses a payment that was not taken through Paystack', async () => {
    const { reference, refunds } = await owed([100_000], { provider: 'mock' });
    const id = paystack.refundInDashboard(reference, 100_000, 'processed');
    expect((await confirm(refunds[0]!.id, id)).statusCode).toBe(422);
    expect((await row(refunds[0]!.id)).status).toBe('refund_pending_manual_review');
  });

  it('changes nothing when Paystack cannot be asked', async () => {
    const { reference, refunds } = await owed([500_000]);
    const id = paystack.refundInDashboard(reference, 500_000, 'processed');
    paystack.down = true;
    try {
      const response = await confirm(refunds[0]!.id, id);
      expect(response.statusCode).toBe(503);
    } finally {
      paystack.down = false;
    }
    expect(await row(refunds[0]!.id)).toMatchObject({ status: 'refund_pending_manual_review', providerReference: null });
  });
});

describe('one Paystack refund, one refund of ours', () => {
  it('never lets the same Paystack refund settle two refunds', async () => {
    // Two partial refunds of the same amount on one payment — the case where a
    // careless link would otherwise go through.
    const { reference, refunds } = await owed([100_000, 100_000]);
    const id = paystack.refundInDashboard(reference, 100_000, 'processed');

    expect((await confirm(refunds[0]!.id, id)).statusCode).toBe(200);
    const second = await confirm(refunds[1]!.id, id);
    expect(second.statusCode).toBe(409);
    expect(await row(refunds[1]!.id)).toMatchObject({ status: 'refund_pending_manual_review', providerReference: null });
  });

  it('settles exactly once when two people confirm the same refund at the same moment', async () => {
    const { reference, refunds } = await owed([500_000]);
    const id = paystack.refundInDashboard(reference, 500_000, 'processed');

    // All three read the refund as still owed before any of them writes.
    paystack.holdRefundLookups(3);
    const answers = await Promise.all([confirm(refunds[0]!.id, id), confirm(refunds[0]!.id, id), confirm(refunds[0]!.id, id)]);
    expect(answers.map((answer) => answer.statusCode).sort()).toEqual([200, 409, 409]);

    expect((await row(refunds[0]!.id)).status).toBe('refunded');
    expect(
      await context.prisma.auditLog.count({ where: { resourceId: refunds[0]!.id, action: 'payment.refund.confirmed' } }),
    ).toBe(1);
  });

  it('will not link a second Paystack refund while the first is still processing — only after it fails', async () => {
    const { order, reference, refunds } = await owed([500_000]);
    const first = paystack.refundInDashboard(reference, 500_000, 'processing');

    const linked = await confirm(refunds[0]!.id, first);
    expect(linked.json()).toMatchObject({ status: 'refund_processing', label: 'Refund on its way' });
    // Processing is not refunded, and the customer is told exactly that.
    const detail = await orderAsCustomer(order.id);
    expect(detail.json<{ order: { refunds: { label: string }[] } }>().order.refunds[0]!.label).toBe('Refund on its way');

    const second = paystack.refundInDashboard(reference, 500_000, 'processed');
    expect((await confirm(refunds[0]!.id, second)).statusCode).toBe(409);

    // The first fails at Paystack; a re-check (no id needed) records that.
    paystack.settle(first, 'failed');
    const failed = await confirm(refunds[0]!.id);
    expect(failed.json()).toMatchObject({ status: 'refund_failed' });

    // Now the second attempt can be linked, and it is the one that counts.
    const retried = await confirm(refunds[0]!.id, second);
    expect(retried.json()).toMatchObject({ status: 'refunded' });
    expect((await row(refunds[0]!.id)).providerReference).toBe(`paystack_refund_${second}`);
  });
});

describe('finishing a refund that was still processing', () => {
  it('completes it from a signed refund webhook — by asking Paystack, not trusting the body', async () => {
    const { reference, refunds } = await owed([500_000]);
    const id = paystack.refundInDashboard(reference, 500_000, 'pending');
    expect((await confirm(refunds[0]!.id, id)).json()).toMatchObject({ status: 'refund_processing' });

    const deliver = (body: { raw: string; signature: string }) =>
      context.app.inject({
        method: 'POST',
        url: '/v1/webhooks/payments',
        headers: { 'content-type': 'application/json', 'x-paystack-signature': body.signature },
        payload: body.raw,
      });

    // An event whose body says "processed" while Paystack itself still says
    // pending changes nothing: the body is never the evidence.
    const early = JSON.parse(paystack.refundWebhook(id, reference, 'refund.pending').raw) as { data: { status: string } };
    early.data.status = 'processed';
    const earlyRaw = JSON.stringify(early);
    const response = await deliver({ raw: earlyRaw, signature: createHmac('sha512', SECRET).update(earlyRaw).digest('hex') });
    expect(response.json()).toMatchObject({ processed: true });
    expect((await row(refunds[0]!.id)).status).toBe('refund_processing');

    // Paystack processes it, and its own event arrives.
    paystack.settle(id, 'processed');
    expect((await deliver(paystack.refundWebhook(id, reference, 'refund.processed'))).statusCode).toBe(200);
    expect(await row(refunds[0]!.id)).toMatchObject({ status: 'refunded', providerStatus: 'processed' });

    // Neither event raised a closed-order alarm: the refund was already recorded.
    const payment = await context.prisma.payment.findUniqueOrThrow({ where: { providerReference: reference } });
    expect(
      await context.prisma.auditLog.count({ where: { action: 'payment.captured_for_closed_order', resourceId: payment.id } }),
    ).toBe(0);
  });

  it('completes it from reconciliation when no webhook ever arrives', async () => {
    const { reference, refunds } = await owed([500_000]);
    const id = paystack.refundInDashboard(reference, 500_000, 'pending');
    await confirm(refunds[0]!.id, id);
    paystack.settle(id, 'processed');

    const later = new Date(Date.now() + 60 * 60_000);
    const report = await runPaymentReconciliation({ prisma: context.prisma, payments: context.app.services.payments }, { dryRun: false, now: later });
    expect(report.refunds.refunded).toBeGreaterThanOrEqual(1);
    expect((await row(refunds[0]!.id)).status).toBe('refunded');
  });

  it('flags a refund Paystack reports failed for a person', async () => {
    const { reference, refunds } = await owed([500_000]);
    const id = paystack.refundInDashboard(reference, 500_000, 'pending');
    await confirm(refunds[0]!.id, id);
    paystack.settle(id, 'failed');

    const later = new Date(Date.now() + 2 * 60 * 60_000);
    const report = await runPaymentReconciliation({ prisma: context.prisma, payments: context.app.services.payments }, { dryRun: false, now: later });
    expect(report.refunds.failed).toBeGreaterThanOrEqual(1);
    expect((await row(refunds[0]!.id)).status).toBe('refund_failed');
  });
});

describe('who can do this', () => {
  it('refuses a customer, and a finance session that has not stepped up', async () => {
    const { reference, refunds } = await owed([500_000]);
    const id = paystack.refundInDashboard(reference, 500_000, 'processed');

    expect((await confirm(refunds[0]!.id, id, customerA)).statusCode).toBe(403);

    await context.prisma.session.updateMany({
      where: { identityId: world.finance.identityId, revokedAt: null },
      data: { steppedUpAt: null },
    });
    try {
      expect((await confirm(refunds[0]!.id, id)).statusCode).not.toBe(200);
    } finally {
      await stepUp();
    }
    expect((await row(refunds[0]!.id)).status).toBe('refund_pending_manual_review');
  });

  it('lists what is still owed for finance, with the reference to find in Paystack', async () => {
    const { order, reference, refunds } = await owed([123_400]);
    const response = await context.app.inject({ method: 'GET', url: '/v1/finance/refunds', headers: finance.headers });
    expect(response.statusCode).toBe(200);
    const listed = response.json<{ refunds: { id: string; paymentReference: string; status: string; order: { id: string } }[] }>().refunds;
    expect(listed.find((refund) => refund.id === refunds[0]!.id)).toMatchObject({
      paymentReference: reference,
      status: 'refund_pending_manual_review',
      order: { id: order.id },
    });
    // "Open" leaves out what is already refunded.
    expect(listed.every((refund) => refund.status !== 'refunded')).toBe(true);

    const asCustomer = await context.app.inject({ method: 'GET', url: '/v1/finance/refunds', headers: customerA.headers });
    expect(asCustomer.statusCode).toBe(403);
  });
});
