/**
 * Registering this phone for push: channels first, permission asked only
 * when it should be, the account's Notifications switch reported, a rotated
 * token replacing the old one, and signing out unregistering the phone.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  store: new Map<string, string>(),
  permission: { granted: false, canAskAgain: true },
  requested: { granted: true, canAskAgain: true },
  token: 'fcm-token-aaaaaaaaaaaaaaaa' as string | null,
  channels: [] as string[],
  asked: 0,
  request: vi.fn(),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => h.store.get(key) ?? null,
    setItem: async (key: string, value: string) => void h.store.set(key, value),
  },
}));
vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '0.1.0' } } }));
vi.mock('expo-notifications', () => ({
  AndroidImportance: { MAX: 7, HIGH: 6, DEFAULT: 5 },
  setNotificationChannelAsync: async (id: string) => void h.channels.push(id),
  getPermissionsAsync: async () => h.permission,
  requestPermissionsAsync: async () => {
    h.asked += 1;
    h.permission = h.requested;
    return h.requested;
  },
  getDevicePushTokenAsync: async () => {
    if (!h.token) throw new Error('Default FirebaseApp is not initialized');
    return { type: 'android', data: h.token };
  },
}));

import type { ApiClient } from '../../api/client';
import { PUSH_ASKED_KEY, PUSH_TOKEN_KEY, forgetPushRegistration, pushDataOf, syncPushRegistration } from './pushRegistration';

const api = { configured: true, request: h.request } as unknown as ApiClient;
const ME = 'identity_1';

beforeEach(() => {
  h.store.clear();
  h.permission = { granted: false, canAskAgain: true };
  h.requested = { granted: true, canAskAgain: true };
  h.token = 'fcm-token-aaaaaaaaaaaaaaaa';
  h.channels = [];
  h.asked = 0;
  h.request.mockReset();
  h.request.mockResolvedValue({ registered: true, deviceId: 'dev_1' });
});

const registrations = () => h.request.mock.calls.filter(([path, options]) => path === '/v1/devices' && options?.method === 'POST').map(([, options]) => options.body);

describe('registering after sign-in', () => {
  it('creates the channels, asks once, and registers with the switch on', async () => {
    expect(await syncPushRegistration(api, { identityId: ME })).toBe('registered');
    expect(h.channels).toEqual(['offers', 'orders', 'messages', 'account']);
    expect(h.asked).toBe(1);
    expect(registrations()).toEqual([{ pushToken: 'fcm-token-aaaaaaaaaaaaaaaa', platform: 'android', notifications: 'on', appVersion: '0.1.0' }]);
    expect(h.store.get(PUSH_ASKED_KEY)).toBe('yes');
  });

  it('does not ask again on its own after being refused', async () => {
    h.requested = { granted: false, canAskAgain: true };
    expect(await syncPushRegistration(api, { identityId: ME })).toBe('waiting');
    expect(await syncPushRegistration(api, { identityId: ME })).toBe('waiting');
    expect(h.asked).toBe(1);
    expect(registrations()).toEqual([]);

    // Turning the switch on is the person asking: Android is asked again.
    expect(await syncPushRegistration(api, { identityId: ME, userAsked: true })).toBe('waiting');
    expect(h.asked).toBe(2);
  });

  it('never asks someone who switched notifications off, but still reports the switch where permission exists', async () => {
    h.store.set(`dash.notifications.v1:${ME}`, 'off');
    expect(await syncPushRegistration(api, { identityId: ME })).toBe('waiting');
    expect(h.asked).toBe(0);

    h.permission = { granted: true, canAskAgain: true };
    expect(await syncPushRegistration(api, { identityId: ME })).toBe('registered');
    expect(registrations().at(-1)).toMatchObject({ notifications: 'off' });
  });

  it('names the token it replaces when the provider rotated it', async () => {
    h.permission = { granted: true, canAskAgain: true };
    await syncPushRegistration(api, { identityId: ME });
    h.token = 'fcm-token-bbbbbbbbbbbbbbbb';
    await syncPushRegistration(api, { identityId: ME });
    expect(registrations().at(-1)).toMatchObject({ pushToken: 'fcm-token-bbbbbbbbbbbbbbbb', replacesPushToken: 'fcm-token-aaaaaaaaaaaaaaaa' });
    expect(h.store.get(PUSH_TOKEN_KEY)).toBe('fcm-token-bbbbbbbbbbbbbbbb');

    // The same token again names nothing.
    await syncPushRegistration(api, { identityId: ME });
    expect(registrations().at(-1)).not.toHaveProperty('replacesPushToken');
  });

  it('carries on without push in a build with no Firebase configuration', async () => {
    h.permission = { granted: true, canAskAgain: true };
    h.token = null;
    expect(await syncPushRegistration(api, { identityId: ME })).toBe('unavailable');
    expect(registrations()).toEqual([]);
  });
});

describe('signing out', () => {
  it('unregisters the phone’s token, and never throws', async () => {
    h.store.set(PUSH_TOKEN_KEY, 'fcm-token-aaaaaaaaaaaaaaaa');
    await forgetPushRegistration(api);
    expect(h.request).toHaveBeenCalledWith('/v1/devices', { method: 'DELETE', body: { pushToken: 'fcm-token-aaaaaaaaaaaaaaaa' } });

    h.request.mockRejectedValueOnce(new Error('offline'));
    await expect(forgetPushRegistration(api)).resolves.toBeUndefined();
  });
});

describe('reading a push’s data', () => {
  it('finds it on the content, or on the FCM message when Android displayed it', () => {
    const shown = { request: { identifier: 'n1', content: { data: { type: 'order_chat', orderId: 'o' } }, trigger: null } };
    expect(pushDataOf(shown as never)).toEqual({ type: 'order_chat', orderId: 'o' });
    const fromTray = {
      request: { identifier: 'n2', content: { data: {} }, trigger: { type: 'push', remoteMessage: { data: { type: 'rider_offer', offerId: 'x' } } } },
    };
    expect(pushDataOf(fromTray as never)).toEqual({ type: 'rider_offer', offerId: 'x' });
  });
});
