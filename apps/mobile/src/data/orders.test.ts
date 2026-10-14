/**
 * Ordering from the app: what it sends, and what it tells the customer.
 *
 * The rules under test are the ones that keep money on the server: the app
 * sends choices and never a price, every checkout carries an idempotency key,
 * and only the server's word — never the checkout page — says a payment
 * went through.
 */

import { describe, expect, it } from 'vitest';

import type { ApiClient, RequestOptions } from '../api/client';
import { EMPTY_CART, cartReducer } from '../features/cart';
import {
  basketFromCart,
  describeOutcome,
  newIdempotencyKey,
  createAddress,
  placeOrder,
  quoteRows,
  rateRider,
  refundTone,
  updateAddress,
  verifyPayment,
  type PaymentOutcome,
  type Quote,
} from './orders';

function fakeClient(answer: unknown = {}) {
  const calls: { path: string; options: RequestOptions }[] = [];
  const api: ApiClient = {
    configured: true,
    request: async <T,>(path: string, options: RequestOptions = {}) => {
      calls.push({ path, options });
      return answer as T;
    },
    restore: async () => 'authenticated',
    signOut: async () => undefined,
  };
  return { api, calls };
}

const cart = cartReducer(
  cartReducer(EMPTY_CART, { type: 'add', merchantSlug: 'mama-put', productId: 'item-1', quantity: 2, options: { size: 'mod-large', extra: '' } }),
  { type: 'add', merchantSlug: 'mama-put', productId: 'item-2', quantity: 1 },
);

describe('the basket sent to the server', () => {
  it('is item ids, quantities and modifier ids — never a price', () => {
    const basket = basketFromCart(cart);
    expect(basket).toEqual([
      { itemId: 'item-1', quantity: 2, modifierIds: ['mod-large'] },
      { itemId: 'item-2', quantity: 1, modifierIds: [] },
    ]);
    const serialised = JSON.stringify(basket);
    for (const money of ['price', 'total', 'fee', 'amount']) expect(serialised).not.toContain(money);
  });

  it('drops the "None" choice of an optional group', () => {
    expect(basketFromCart(cart)[0]?.modifierIds).not.toContain('');
  });
});

describe('checkout', () => {
  it('pays by card, sends the idempotency key, and sends no amount', async () => {
    const { api, calls } = fakeClient({ order: { id: 'o1' }, payment: { status: 'pending', authorizationUrl: 'https://checkout.paystack.com/x' }, deliveryPin: '1234' });
    await placeOrder(api, { branchId: 'b1', cart, addressId: 'a1', idempotencyKey: 'key-1' });

    const call = calls[0]!;
    expect(call.path).toBe('/v1/orders');
    expect(call.options.method).toBe('POST');
    expect(call.options.headers).toEqual({ 'Idempotency-Key': 'key-1' });
    expect(call.options.body).toMatchObject({ branchId: 'b1', addressId: 'a1', paymentMethod: 'card', mode: 'delivery' });
    expect(JSON.stringify(call.options.body)).not.toMatch(/total|amount|price/);
  });

  it('makes a different key for every attempt', () => {
    const keys = new Set(Array.from({ length: 50 }, () => newIdempotencyKey()));
    expect(keys.size).toBe(50);
  });

  it('asks the server — not the checkout page — whether the payment went through', async () => {
    const { api, calls } = fakeClient({ payment: { outcome: 'captured' }, order: { id: 'o/1', status: 'placed' } });
    await verifyPayment(api, 'o/1');
    expect(calls[0]).toMatchObject({ path: '/v1/orders/o%2F1/payment/verify', options: { method: 'POST' } });
  });
});

describe('what the customer is told', () => {
  const outcomes: PaymentOutcome[] = [
    'captured',
    'pending',
    'failed',
    'refunded',
    'amount_mismatch',
    'captured_for_closed_order',
    'order_closed',
    'unknown_payment',
  ];

  it('calls only a captured payment a success', () => {
    for (const outcome of outcomes) {
      expect(describeOutcome(outcome).tone === 'success', outcome).toBe(outcome === 'captured');
    }
  });

  it('never tells someone to pay again when the money may already be taken', () => {
    expect(describeOutcome('amount_mismatch').canRetry).toBe(false);
    expect(describeOutcome('captured_for_closed_order').canRetry).toBe(false);
    expect(describeOutcome('order_closed').canRetry).toBe(false);
    expect(describeOutcome('captured').canRetry).toBe(false);
  });

  it('shows a refund as done only once it is confirmed', () => {
    expect(refundTone('refunded')).toBe('success');
    for (const status of ['refund_pending_manual_review', 'refund_processing', 'pending', 'anything_new']) {
      expect(refundTone(status), status).toBe('accent');
    }
    expect(refundTone('refund_failed')).toBe('danger');
  });
});

describe('the receipt', () => {
  const quote: Quote = {
    itemsSubtotal: 500_000 as never,
    discountTotal: 0 as never,
    deliveryFee: 60_000 as never,
    serviceFee: 15_000 as never,
    smallOrderFee: 0 as never,
    surgeAmount: 0 as never,
    tax: 0 as never,
    tip: 0 as never,
    total: 575_000 as never,
  };

  it('lists the charges the server applied and hides the zero ones', () => {
    expect(quoteRows(quote).map((row) => row.label)).toEqual(['Items', 'Delivery fee', 'Service fee']);
  });

  it('shows a discount as a deduction', () => {
    const rows = quoteRows({ ...quote, discountTotal: 10_000 as never });
    expect(rows.find((row) => row.label === 'Discount')).toMatchObject({ amount: 10_000, negative: true });
  });
});

describe('rating the rider', () => {
  it('sends only the stars and a trimmed comment, never a rider', async () => {
    const { api, calls } = fakeClient({ rating: { rating: 5, comment: 'Lovely', createdAt: '2026-10-14T10:00:00Z' } });
    const rating = await rateRider(api, 'order 1', { rating: 5, comment: '  Lovely  ' });
    expect(rating.rating).toBe(5);
    expect(calls).toEqual([{ path: '/v1/orders/order%201/rider-rating', options: { method: 'POST', body: { rating: 5, comment: 'Lovely' } } }]);
  });

  it('leaves out a blank comment', async () => {
    const { api, calls } = fakeClient({ rating: { rating: 2, comment: null, createdAt: '2026-10-14T10:00:00Z' } });
    await rateRider(api, 'o1', { rating: 2, comment: '   ' });
    expect(calls[0]?.options.body).toEqual({ rating: 2 });
  });
});

describe('confirming the home screen delivery location', () => {
  it('saves the found position with the corrected words, as the default', async () => {
    const { api, calls } = fakeClient({ address: { id: 'a9' } });
    await createAddress(api, { line1: '4 Nnebisi Road, Asaba', contactPhone: '+2348031234567', latitude: 6.2, longitude: 6.7, isDefault: true });
    expect(calls[0]).toEqual({
      path: '/v1/addresses',
      options: { method: 'POST', body: { line1: '4 Nnebisi Road, Asaba', contactPhone: '+2348031234567', latitude: 6.2, longitude: 6.7, isDefault: true } },
    });
  });

  it('chooses a saved address by making it the default', async () => {
    const { api, calls } = fakeClient({});
    await updateAddress(api, 'a2', { isDefault: true });
    expect(calls[0]).toEqual({ path: '/v1/addresses/a2', options: { method: 'PATCH', body: { isDefault: true } } });
  });
});
