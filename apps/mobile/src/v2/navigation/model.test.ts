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

  /**
   * The four release-critical screens ported from the old app. Two of them
   * are Play requirements, so the thing worth pinning is that each is
   * reachable from Account and that backing out returns there rather than
   * dropping to Home.
   */
  it('reaches account, legal, deletion and rider apply, and comes back', () => {
    const account = navigate(createNavigationState('customer'), { name: 'customer.account' });
    for (const route of [
      { name: 'customer.register' } as const,
      { name: 'customer.delete-account' } as const,
      { name: 'customer.rider-apply' } as const,
      { name: 'customer.legal', params: { slug: 'privacy-policy' } } as const,
      { name: 'customer.legal', params: { slug: 'terms-of-service' } } as const,
    ]) {
      const pushed = navigate(account, route);
      expect(currentRoute(pushed).name).toBe(route.name);
      expect(goBack(pushed)).toEqual(account);
    }
  });

  it('opens every customer profile and settings screen from Account, and comes back', () => {
    const account = navigate(createNavigationState('customer'), { name: 'customer.account' });
    for (const name of ['customer.personal-details', 'customer.addresses', 'customer.notification-settings', 'customer.help'] as const) {
      const pushed = navigate(account, { name });
      expect(currentRoute(pushed).name).toBe(name);
      expect(goBack(pushed)).toEqual(account);
    }
    // The notification inbox links to the same settings screen.
    const inbox = navigate(createNavigationState('customer'), { name: 'customer.notifications' });
    expect(currentRoute(navigate(inbox, { name: 'customer.notification-settings' })).name).toBe('customer.notification-settings');
  });

  it('opens every rider profile and settings screen from Profile, and comes back', () => {
    const profile = selectTab(createNavigationState('rider'), { name: 'rider.profile' });
    for (const route of [
      { name: 'rider.personal-details' } as const,
      { name: 'rider.notification-settings' } as const,
      { name: 'rider.help' } as const,
      { name: 'rider.legal', params: { slug: 'terms-of-service' } } as const,
      { name: 'rider.legal', params: { slug: 'privacy-policy' } } as const,
    ]) {
      const pushed = navigate(profile, route);
      expect(currentRoute(pushed)).toEqual(route);
      expect(goBack(pushed)).toEqual(profile);
    }
  });

  it('keeps each face’s settings screens on that face', () => {
    expect(() => navigate(createNavigationState('rider'), { name: 'customer.personal-details' })).toThrow();
    expect(() => navigate(createNavigationState('customer'), { name: 'rider.help' })).toThrow();
  });

  it('opens the rider bank account from Profile, and keeps it on the rider face', () => {
    const profile = selectTab(createNavigationState('rider'), { name: 'rider.profile' });
    const bank = navigate(profile, { name: 'rider.bank-account' });
    expect(currentRoute(bank).name).toBe('rider.bank-account');
    expect(goBack(bank)).toEqual(profile);
    expect(() => navigate(createNavigationState('customer'), { name: 'rider.bank-account' })).toThrow();
  });

  it('opens the delivery location from the home screen and returns home', () => {
    const home = createNavigationState('customer');
    const location = navigate(home, { name: 'customer.delivery-location' });
    expect(currentRoute(location).name).toBe('customer.delivery-location');
    expect(goBack(location)).toEqual(home);
    expect(() => navigate(createNavigationState('rider'), { name: 'customer.delivery-location' })).toThrow();
  });

  it('opens a legal document from inside registration and returns to it', () => {
    const register = navigate(navigate(createNavigationState('customer'), { name: 'customer.account' }), { name: 'customer.register' });
    const legal = navigate(register, { name: 'customer.legal', params: { slug: 'terms-of-service' } });
    expect(currentRoute(legal).params).toEqual({ slug: 'terms-of-service' });
    expect(goBack(legal)).toEqual(register);
  });
});
