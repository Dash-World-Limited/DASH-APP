// @vitest-environment jsdom
/**
 * The push hook in the running app: it registers for whoever is signed in,
 * re-registers when the token rotates or the switch changes, opens the right
 * screen for a tapped push — including the tap that launched a closed app,
 * held until the account is known — and decides what shows while open.
 */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  session: { state: 'authenticated', viewer: { identity: { id: 'identity_1' }, customerId: 'cus_1', riderId: null, riderStatus: null } as unknown },
  sync: vi.fn(),
  lastResponse: null as unknown,
  responseListeners: new Set<(response: unknown) => void>(),
  tokenListeners: new Set<() => void>(),
  appStateListeners: new Set<(state: string) => void>(),
  handler: null as null | { handleNotification: (notification: unknown) => Promise<{ shouldShowBanner: boolean }> },
}));

vi.mock('expo-notifications', () => ({
  DEFAULT_ACTION_IDENTIFIER: 'expo.modules.notifications.actions.DEFAULT',
  setNotificationHandler: (handler: typeof h.handler) => {
    h.handler = handler;
  },
  addPushTokenListener: (listener: () => void) => {
    h.tokenListeners.add(listener);
    return { remove: () => h.tokenListeners.delete(listener) };
  },
  getLastNotificationResponseAsync: async () => h.lastResponse,
  clearLastNotificationResponseAsync: async () => {
    h.lastResponse = null;
  },
  addNotificationResponseReceivedListener: (listener: (response: unknown) => void) => {
    h.responseListeners.add(listener);
    return { remove: () => h.responseListeners.delete(listener) };
  },
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  AppState: {
    addEventListener: (_type: string, listener: (state: string) => void) => {
      h.appStateListeners.add(listener);
      return { remove: () => h.appStateListeners.delete(listener) };
    },
  },
}));
vi.mock('../../api', () => ({ api: { configured: true, request: vi.fn() } }));
vi.mock('../auth/AppSessionProvider', () => ({ useAppSession: () => h.session }));
vi.mock('./pushRegistration', () => ({
  syncPushRegistration: (...args: unknown[]) => h.sync(...args),
  pushDataOf: (notification: { request: { content: { data: unknown } } }) => notification.request.content.data,
}));

import { pushPreferenceChanged } from './preferenceSignal';
import { usePushNotifications } from './usePushNotifications';
import type { PushTarget } from '../../features/pushNotifications';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let opened: PushTarget[] = [];
let current = { face: 'customer' as const, route: { name: 'customer.home' } as never };

function Probe() {
  usePushNotifications({ current, onOpen: (target) => opened.push(target) });
  return null;
}

const render = async () => {
  root = createRoot(document.createElement('div'));
  await act(async () => root!.render(createElement(Probe)));
};
const rerender = async () => act(async () => root!.render(createElement(Probe)));

let tapCounter = 0;
const tap = (data: Record<string, string>) => ({
  actionIdentifier: 'expo.modules.notifications.actions.DEFAULT',
  notification: { request: { identifier: `tap_${(tapCounter += 1)}`, content: { data } } },
});

beforeEach(() => {
  h.session = { state: 'authenticated', viewer: { identity: { id: 'identity_1' }, customerId: 'cus_1', riderId: null, riderStatus: null } };
  h.sync.mockReset();
  h.sync.mockResolvedValue('registered');
  h.lastResponse = null;
  h.responseListeners.clear();
  h.tokenListeners.clear();
  h.appStateListeners.clear();
  opened = [];
  current = { face: 'customer', route: { name: 'customer.home' } as never };
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
});

describe('registration', () => {
  it('registers for the signed-in account, and again when the token rotates or the switch changes', async () => {
    await render();
    expect(h.sync).toHaveBeenCalledWith(expect.anything(), { identityId: 'identity_1', userAsked: false });

    await act(async () => h.tokenListeners.forEach((listener) => listener()));
    await act(async () => pushPreferenceChanged(true));
    expect(h.sync).toHaveBeenCalledTimes(3);
    expect(h.sync).toHaveBeenLastCalledWith(expect.anything(), { identityId: 'identity_1', userAsked: true });
  });

  it('does not re-register on every return to the app once registered', async () => {
    await render();
    await act(async () => h.appStateListeners.forEach((listener) => listener('active')));
    expect(h.sync).toHaveBeenCalledTimes(1);
  });

  it('registers nothing for a signed-out phone', async () => {
    h.session = { state: 'unauthenticated', viewer: null };
    await render();
    expect(h.sync).not.toHaveBeenCalled();
  });
});

describe('a tapped push', () => {
  it('opens its screen', async () => {
    await render();
    await act(async () => h.responseListeners.forEach((listener) => listener(tap({ type: 'order_chat', audience: 'customer', orderId: 'ord_1' }))));
    expect(opened).toEqual([
      { face: 'customer', routes: [{ name: 'customer.track-order', params: { id: 'ord_1' } }, { name: 'customer.chat', params: { id: 'ord_1' } }] },
    ]);
  });

  it('that launched the app waits for the account, then opens once', async () => {
    h.session = { state: 'restoring', viewer: null };
    h.lastResponse = tap({ type: 'support_reply', audience: 'customer', conversationId: 'case_1' });
    await render();
    expect(opened).toEqual([]);

    h.session = { state: 'authenticated', viewer: { identity: { id: 'identity_1' }, customerId: 'cus_1', riderId: null, riderStatus: null } };
    await rerender();
    await rerender();
    expect(opened).toEqual([{ face: 'customer', routes: [{ name: 'customer.support-chat' }] }]);
  });

  it('opens nothing when nobody is signed in, or for a side of the app the account does not have', async () => {
    h.session = { state: 'unauthenticated', viewer: null };
    h.lastResponse = tap({ type: 'order_update', audience: 'customer', orderId: 'ord_1' });
    await render();
    expect(opened).toEqual([]);

    await act(async () => root!.unmount());
    h.session = { state: 'authenticated', viewer: { identity: { id: 'identity_1' }, customerId: 'cus_1', riderId: null, riderStatus: null } };
    await render();
    await act(async () => h.responseListeners.forEach((listener) => listener(tap({ type: 'rider_offer', offerId: 'off_1' }))));
    expect(opened).toEqual([]);
  });
});

describe('while the app is open', () => {
  it('shows a push unless the screen in front already shows it', async () => {
    current = { face: 'customer', route: { name: 'customer.chat', params: { id: 'ord_1' } } as never };
    await render();
    const arrive = (data: Record<string, string>) => h.handler!.handleNotification({ request: { identifier: 'x', content: { data } } });
    expect((await arrive({ type: 'order_chat', audience: 'customer', orderId: 'ord_1' })).shouldShowBanner).toBe(false);
    expect((await arrive({ type: 'order_chat', audience: 'customer', orderId: 'ord_2' })).shouldShowBanner).toBe(true);
  });
});
