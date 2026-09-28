/**
 * The two navigations are product decisions read off the approved boards.
 * These hold them there, and prove every tab lands on a real screen.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { CUSTOMER_TABS, HIDDEN_CUSTOMER_ROUTES, RIDER_TABS } from './tabs';

const app = fileURLToPath(new URL('../../app', import.meta.url));

describe('Customer navigation', () => {
  it('is the Customer board without Wallet: Home, Orders, Support', () => {
    // The board shows a Wallet tab, but V1 has no wallet balance, top-up or
    // wallet payment. Offering the tab would present it as working.
    expect(CUSTOMER_TABS.map((t) => t.label)).toEqual(['Home', 'Orders', 'Support']);
  });

  it('keeps the wallet route registered but hidden', () => {
    expect(HIDDEN_CUSTOMER_ROUTES).toContain('wallet');
    expect(CUSTOMER_TABS.map((t) => t.route)).not.toContain('wallet');
  });

  it('reaches the profile from Home, not from a tab', () => {
    // The board puts the profile behind the avatar in the Home header.
    expect(CUSTOMER_TABS.map((t) => t.label)).not.toContain('Account');
    expect(existsSync(join(app, '(customer)', 'account.tsx'))).toBe(true);
  });
});

describe('Rider navigation', () => {
  it('is the Rider board: Home, Earnings, Orders, Inbox, Profile', () => {
    expect(RIDER_TABS.map((t) => t.label)).toEqual(['Home', 'Earnings', 'Orders', 'Inbox', 'Profile']);
  });
});

describe('both', () => {
  it('never make switching faces a tab', () => {
    // Customer and Rider are one account; switching lives in the profile.
    for (const tab of [...CUSTOMER_TABS, ...RIDER_TABS]) expect(tab.label).not.toMatch(/rider|customer|switch/i);
  });

  it('send every tab to a screen that exists', () => {
    const file = (group: string, route: string): string =>
      route.startsWith('(') ? join(app, group, '(tabs)', route, 'index.tsx') : join(app, group, '(tabs)', `${route}.tsx`);
    for (const tab of CUSTOMER_TABS) expect(existsSync(file('(customer)', tab.route)), tab.route).toBe(true);
    for (const tab of RIDER_TABS) expect(existsSync(file('rider', tab.route)), tab.route).toBe(true);
  });

  it('give every tab a distinct outline and filled glyph', () => {
    // The active tab fills in, as drawn; a tab with the same glyph for both
    // gives no visual "you are here" beyond colour.
    for (const tab of [...CUSTOMER_TABS, ...RIDER_TABS].filter((t) => t.label !== 'Support')) {
      expect(tab.icon, tab.label).not.toBe(tab.activeIcon);
    }
  });
});
