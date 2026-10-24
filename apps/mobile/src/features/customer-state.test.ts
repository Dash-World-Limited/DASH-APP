/**
 * The customer's cart and what the plus on a product may do.
 *
 * The cart's two load-bearing rules are the ones the server also holds: it
 * never holds a price (so it cannot decide what anyone pays), and it holds one
 * merchant (because an order has one vendor).
 */

import { describe, expect, it } from 'vitest';

import { EMPTY_CART, MAX_LINE_QUANTITY, cartReducer, itemCount, lineKey, parseStoredCart, refusalFor, type CartState } from './cart';
import { quickAddPlan } from './quickAdd';

const add = (state: CartState, productId: string, quantity = 1, options?: Record<string, string>, merchantSlug = 'techworld'): CartState =>
  cartReducer(state, { type: 'add', merchantSlug, productId, quantity, options });

describe('a cart line', () => {
  it('is the product plus its options, whatever order the options arrived in', () => {
    expect(lineKey('p', { storage: '256gb', colour: 'natural' })).toBe(lineKey('p', { colour: 'natural', storage: '256gb' }));
    expect(lineKey('p', { storage: '256gb' })).not.toBe(lineKey('p', { storage: '512gb' }));
  });

  it('holds no price, fee or total — those come from the quote', () => {
    const cart = add(EMPTY_CART, 'iphone', 1, { storage: '256gb' });
    const keys = Object.keys(cart.lines[0] ?? {});
    for (const money of ['price', 'unitPrice', 'total', 'fee', 'amount']) expect(keys).not.toContain(money);
  });
});

describe('adding', () => {
  it('merges the same product with the same options into one line', () => {
    const cart = add(add(EMPTY_CART, 'iphone', 1, { storage: '256gb' }), 'iphone', 2, { storage: '256gb' });
    expect(cart.lines).toHaveLength(1);
    expect(itemCount(cart)).toBe(3);
  });

  it('keeps different options apart', () => {
    const cart = add(add(EMPTY_CART, 'iphone', 1, { storage: '256gb' }), 'iphone', 1, { storage: '512gb' });
    expect(cart.lines).toHaveLength(2);
  });

  it('caps a line rather than letting a stuck button order a warehouse', () => {
    let cart = EMPTY_CART;
    for (let i = 0; i < 50; i++) cart = add(cart, 'airpods');
    expect(itemCount(cart)).toBe(MAX_LINE_QUANTITY);
  });

  it('ignores a quantity that is not a positive number', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(add(EMPTY_CART, 'airpods', bad), String(bad)).toBe(EMPTY_CART);
    }
  });
});

describe('one merchant per cart', () => {
  it('refuses a second shop and leaves the cart exactly as it was', () => {
    const cart = add(EMPTY_CART, 'iphone');
    expect(refusalFor(cart, 'stylehub')).toBe('different_merchant');
    expect(add(cart, 'jacket', 1, undefined, 'stylehub')).toBe(cart);
  });

  it('starts a new cart only when the customer chooses to', () => {
    const cart = cartReducer(add(EMPTY_CART, 'iphone'), { type: 'replaceWith', merchantSlug: 'stylehub', productId: 'jacket', quantity: 1 });
    expect(cart.merchantSlug).toBe('stylehub');
    expect(cart.lines.map((l) => l.productId)).toEqual(['jacket']);
  });

  it('forgets the merchant once the cart is empty', () => {
    const cart = add(EMPTY_CART, 'iphone');
    const emptied = cartReducer(cart, { type: 'remove', key: cart.lines[0]!.key });
    expect(emptied).toEqual(EMPTY_CART);
    expect(refusalFor(emptied, 'stylehub')).toBeNull();
  });
});

describe('quantity', () => {
  it('removes a line set to zero', () => {
    const cart = add(EMPTY_CART, 'iphone');
    expect(cartReducer(cart, { type: 'setQuantity', key: cart.lines[0]!.key, quantity: 0 })).toEqual(EMPTY_CART);
  });

  it('clamps an edited quantity to the cap', () => {
    const cart = add(EMPTY_CART, 'iphone');
    const next = cartReducer(cart, { type: 'setQuantity', key: cart.lines[0]!.key, quantity: 500 });
    expect(next.lines[0]!.quantity).toBe(MAX_LINE_QUANTITY);
  });
});

describe('the plus on a product card', () => {
  const group = (id: string, count: number) => ({
    id,
    label: id,
    kind: 'chip' as const,
    options: Array.from({ length: count }, (_, i) => ({ id: `${id}-${i}`, label: `${id} ${i}` })),
  });

  it('opens the product when there is a real choice to make', () => {
    // Adding would choose for the customer, and in a real catalogue the choice
    // changes the price.
    expect(quickAddPlan({ optionGroups: [group('storage', 3)] })).toEqual({ kind: 'choose' });
  });

  it('adds directly when there is nothing to choose', () => {
    expect(quickAddPlan({ optionGroups: [] })).toEqual({ kind: 'add', options: {} });
    expect(quickAddPlan({ optionGroups: [group('colour', 1)] })).toEqual({ kind: 'add', options: { colour: 'colour-0' } });
  });
});

describe('a cart restored from the phone', () => {
  it('comes back as the same choices', () => {
    const cart = add(add(EMPTY_CART, 'iphone', 2, { storage: '256gb' }), 'case', 1);
    expect(parseStoredCart(JSON.stringify(cart))).toEqual(cart);
  });

  it('carries no price, whatever was stored', () => {
    const stored = JSON.stringify({ merchantSlug: 'techworld', lines: [{ productId: 'iphone', quantity: 1, price: 1, total: 1 }] });
    const restored = parseStoredCart(stored)!;
    expect(Object.keys(restored.lines[0]!)).not.toContain('price');
    expect(Object.keys(restored.lines[0]!)).not.toContain('total');
  });

  it('is discarded, not repaired, when anything is malformed', () => {
    for (const raw of [
      'not json',
      '{}',
      JSON.stringify({ merchantSlug: 'x', lines: [] }),
      JSON.stringify({ merchantSlug: 'x', lines: [{ productId: 'p', quantity: 0 }] }),
      JSON.stringify({ merchantSlug: 'x', lines: [{ productId: 'p', quantity: 1, options: { size: 3 } }] }),
      JSON.stringify({ merchantSlug: 'x', lines: [{ quantity: 1 }] }),
    ]) {
      expect(parseStoredCart(raw), raw).toBeNull();
    }
  });

  it('re-clamps a stored quantity', () => {
    const restored = parseStoredCart(JSON.stringify({ merchantSlug: 'x', lines: [{ productId: 'p', quantity: 999 }] }))!;
    expect(restored.lines[0]!.quantity).toBe(MAX_LINE_QUANTITY);
  });
});
