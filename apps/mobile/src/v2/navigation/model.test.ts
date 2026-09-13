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
