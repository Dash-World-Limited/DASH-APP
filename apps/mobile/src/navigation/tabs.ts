/**
 * The two bottom navigations, as data.
 *
 * Both are read straight off the approved boards and are a product decision,
 * not a layout detail: a returning customer knows where Orders is by position.
 * They live here, not inside the layout files, so a test can hold them to the
 * boards and a change to either is a visible, reviewable diff.
 *
 * Customer (Customer board, screens 1-2): Home · Orders · Wallet · Support.
 * The profile is reached from the avatar in the Home header, which is where the
 * board puts it — there is no Account tab.
 *
 * Rider (Rider board, screens 1-2 and 9-10): Home · Earnings · Orders · Inbox ·
 * Profile. Appearance lives in Profile & Settings on both.
 *
 * Switching between Customer and Rider is a property of the account, not a
 * place to go, so it is never a tab.
 */

import type { IconName } from '../ui/Icon';

export interface TabDefinition {
  /** The Expo Router file or group name inside the (tabs) folder. */
  route: string;
  label: string;
  icon: IconName;
  activeIcon: IconName;
}

export const CUSTOMER_TABS: readonly TabDefinition[] = [
  // `(home)` is a stack: Shops and the service screens push inside the Home
  // tab, keeping the tab bar, exactly as the Shops board shows.
  { route: '(home)', label: 'Home', icon: 'home-outline', activeIcon: 'home' },
  { route: 'orders', label: 'Orders', icon: 'receipt-text-outline', activeIcon: 'receipt-text' },
  // No Wallet tab. There is no wallet balance, top-up or wallet payment in V1,
  // and a tab promising one would present it as working. The route file stays
  // and is registered hidden (see the tabs layout) for when it is built.
  { route: 'support', label: 'Support', icon: 'headset', activeIcon: 'headset' },
];

/** Routes inside the customer tabs that exist but are not offered in V1. */
export const HIDDEN_CUSTOMER_ROUTES: readonly string[] = ['wallet'];

export const RIDER_TABS: readonly TabDefinition[] = [
  // Also a stack: going Online pushes the Looking-for-orders screen inside the
  // Home tab, which the Rider board shows with the tab bar still in place.
  { route: '(home)', label: 'Home', icon: 'home-outline', activeIcon: 'home' },
  { route: 'earnings', label: 'Earnings', icon: 'briefcase-outline', activeIcon: 'briefcase' },
  { route: 'orders', label: 'Orders', icon: 'clipboard-text-outline', activeIcon: 'clipboard-text' },
  { route: 'inbox', label: 'Inbox', icon: 'inbox-outline', activeIcon: 'inbox' },
  { route: 'profile', label: 'Profile', icon: 'account-outline', activeIcon: 'account' },
];
