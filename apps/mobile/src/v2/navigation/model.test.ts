import { describe, expect, it } from 'vitest';

import {
  createNavigationState,
  currentRoute,
  goBack,
  navigate,
  selectTab,
  switchFace,
} from './model';

describe('native-v2 navigation model', () => {
  it('starts each face at its own home', () => {
    expect(currentRoute(createNavigationState('customer')).name).toBe('customer.home');
    expect(currentRoute(createNavigationState('rider')).name).toBe('rider.home');
  });

  it('pushes details and returns without reusing a route object', () => {
    const start = createNavigationState('customer');
    const detail = navigate(start, { name: 'customer.category', params: { id: 'food' } });
    expect(currentRoute(detail).params).toEqual({ id: 'food' });
    expect(goBack(detail)).toEqual(start);
  });

  it('supports the complete customer shopping path on one JS stack', () => {
    let state = createNavigationState('customer');
    state = navigate(state, { name: 'customer.category', params: { id: 'food' } });
    state = navigate(state, { name: 'customer.store', params: { category: 'food', id: 'urban-bites' } });
    state = navigate(state, { name: 'customer.product', params: { category: 'food', store: 'urban-bites', id: 'jollof-chicken' } });
    state = navigate(state, { name: 'customer.cart', params: { product: 'jollof-chicken' } });
    state = navigate(state, { name: 'customer.checkout' });
    state = navigate(state, { name: 'customer.track-order', params: { id: 'preview-order-active' } });
    expect(state.stack.map((route) => route.name)).toEqual([
      'customer.home',
      'customer.category',
      'customer.store',
      'customer.product',
      'customer.cart',
      'customer.checkout',
      'customer.track-order',
    ]);
  });

  it('supports the rider offer, route and completion path on one JS stack', () => {
    let state = createNavigationState('rider');
    state = navigate(state, { name: 'rider.online' });
    state = navigate(state, { name: 'rider.offer' });
    state = navigate(state, { name: 'rider.delivery' });
    state = navigate(state, { name: 'rider.route' });
    state = navigate(state, { name: 'rider.complete' });
    expect(state.stack.map((route) => route.name)).toEqual([
      'rider.home',
      'rider.online',
      'rider.offer',
      'rider.delivery',
      'rider.route',
      'rider.complete',
    ]);
  });

  it('selecting a tab resets the face stack', () => {
    const state = navigate(createNavigationState('customer'), { name: 'customer.account' });
    expect(selectTab(state, { name: 'customer.orders' }).stack).toEqual([{ name: 'customer.orders' }]);
  });

  it('switching faces discards the previous tree', () => {
    const customer = navigate(createNavigationState('customer'), { name: 'customer.account' });
    const rider = switchFace(customer, 'rider');
    expect(rider).toEqual({ face: 'rider', stack: [{ name: 'rider.home' }] });
    expect(switchFace(rider, 'customer')).toEqual({ face: 'customer', stack: [{ name: 'customer.home' }] });
  });

  it('refuses cross-face navigation', () => {
    expect(() => navigate(createNavigationState('customer'), { name: 'rider.home' })).toThrow(/customer face/);
  });
});
