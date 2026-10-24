/**
 * Refunds are never claimed before Paystack confirms them.
 *
 * V1 moves no money back automatically. What these tests hold:
 *   - cancelling a paid order records exactly what is owed, as
 *     `refund_pending_manual_review`, in the same transaction;
 *   - cancelling an order nobody paid for records no refund at all;
 *   - no response anywhere says `refunded` for money that has not moved.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { describeRefund, REFUND_PROCESS } from '@dash/domain/orders';
import { createTestContext, type TestContext } from './harness.js';
import { actAs, buildWorld, type Actor, type World } from './world.js';

let context: TestContext;
let world: World;
let customerA: Actor;
let finance: Actor;
let counter = 0;

beforeAll(async () => {
  vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
  context = await createTestContext();
  world = await buildWorld(context.prisma);
  customerA = await actAs(context, world.customerA.email);
  finance = await actAs(context, world.finance.email);
}, 180_000);

afterAll(async () => {
  await context?.close();
});

/** An order in a given state, optionally with a captured payment behind it. */
async function order(status: string, capturedAmount: number | null) {
  counter += 1;
  const created = await context.prisma.order.create({
    data: {
      code: `DASH-RF${counter}-${Date.now()}`,
      customerId: world.customerA.customerId,
      vendorId: world.vendorA.vendorId,
      branchId: world.vendorA.branchId,
      addressId: world.customerA.addressId,
      zoneId: world.zoneId,
      status,
      mode: 'delivery',
      itemsSubtotal: 400_000,
      total: 500_000,
      quoteBreakdown: '{}',
      pricingRuleVersion: 'test',
    },
  });
  if (capturedAmount !== null) {
    await context.prisma.payment.create({
      data: {
        orderId: created.id,
        provider: 'mock',
        providerReference: `${created.code}-pay`,
        amount: capturedAmount,
        method: 'card',
        status: 'captured',
        idempotencyKey: `rf_${created.id}`,
        capturedAt: new Date(),
      },
    });
  }
  return created;
}

const cancel = (orderId: string) =>
  context.app.inject({ method: 'POST', url: `/v1/orders/${orderId}/cancel`, headers: customerA.headers, payload: {} });

describe('customer cancellation', () => {
  it('records the full refund owed on a paid order as pending review — not refunded', async () => {
    const paid = await order('placed', 500_000);
    const response = await cancel(paid.id);
    expect(response.statusCode).toBe(200);

    const refund = response.json<{ refund: { status: string; amount: number; label: string } }>().refund;
    expect(refund).toMatchObject({ status: 'refund_pending_manual_review', amount: 500_000, label: 'Refund pending review' });
    expect(response.body).not.toMatch(/"refunded"\s*:\s*true/);

    const rows = await context.prisma.refund.findMany({ where: { payment: { orderId: paid.id } } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'refund_pending_manual_review', amount: 500_000 });
  });

  it('records 70% of what was captured once preparation has started', async () => {
    const preparing = await order('preparing', 500_000);
    const response = await cancel(preparing.id);
    expect(response.json<{ refund: { amount: number } }>().refund.amount).toBe(350_000);
    const row = await context.prisma.refund.findFirstOrThrow({ where: { payment: { orderId: preparing.id } } });
    expect(row.amount).toBe(350_000);
  });

  it('records nothing and says so when no payment was taken', async () => {
    const unpaid = await order('payment_pending', null);
    const response = await cancel(unpaid.id);
    expect(response.statusCode).toBe(200);
    expect(response.json<{ refund: { status: string; amount: number } }>().refund).toMatchObject({ status: 'no_payment_taken', amount: 0 });
    expect(await context.prisma.refund.count({ where: { payment: { orderId: unpaid.id } } })).toBe(0);
  });

  it('never promises money back before payment is confirmed', async () => {
    const unpaid = await order('payment_pending', null);
    const quote = await context.app.inject({ method: 'GET', url: `/v1/orders/${unpaid.id}`, headers: customerA.headers });
    const explanation = quote.json<{ cancellation: { explanation: string } }>().cancellation.explanation;
    expect(explanation).toMatch(/nothing has been charged/i);
    expect(explanation).not.toMatch(/refund/i);
  });
});

describe('finance approval', () => {
  it('books the refund but does not claim it was refunded', async () => {
    const paid = await order('delivered', 500_000);
    await context.prisma.session.updateMany({
      where: { identityId: world.finance.identityId, revokedAt: null },
      data: { steppedUpAt: new Date() },
    });
    const response = await context.app.inject({
      method: 'POST',
      url: `/v1/finance/orders/${paid.id}/refund`,
      headers: finance.headers,
      payload: { amount: 100_000, reason: 'Item arrived damaged' },
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json<{ status: string; refunded?: boolean }>();
    expect(body.status).toBe('refund_pending_manual_review');
    expect(body.refunded).toBeUndefined();
    const row = await context.prisma.refund.findFirstOrThrow({ where: { payment: { orderId: paid.id } } });
    expect(row.status).toBe('refund_pending_manual_review');
  });
});

describe('the words', () => {
  it('only ever says "Refunded" for a refund Paystack confirmed', () => {
    expect(describeRefund('refunded').label).toBe('Refunded');
    for (const state of ['refund_pending_manual_review', 'pending', 'anything-else']) {
      expect(describeRefund(state).label).not.toMatch(/^Refunded$/);
      expect(describeRefund(state).body).toBe(REFUND_PROCESS);
    }
  });
});
