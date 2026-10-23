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
  platform: { OS: 'android' },
  tokenReads: 0,
  clearedResponses: 0,
  clearFails: false,
  iosConfigured: false,
  iosToken: 'unit-ios-fcm-registration-token' as string | null,
  iosPending: null as Promise<string | null> | null,
}));

vi.mock('./iosFcm', () => ({ iosPushConfigured: () => h.iosConfigured, iosFcmToken: async () => h.iosConfigured ? (h.iosPending ?? h.iosToken) : null }));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => h.store.get(key) ?? null,
    setItem: async (key: string, value: string) => void h.store.set(key, value),
  },
}));
vi.mock('react-native', () => ({ Platform: h.platform }));
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '0.1.0', android: { package: 'com.dashworldng.dash.staging' }, ios: { bundleIdentifier: 'com.dashworldng.dash.staging' } } } }));
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
    h.tokenReads += 1;
    if (!h.token) throw new Error('Default FirebaseApp is not initialized');
    return { type: 'android', data: h.token };
  },
  clearLastNotificationResponseAsync: async () => {
    h.clearedResponses += 1;
    if (h.clearFails) throw new Error('Native response cache unavailable');
  },
}));

import type { ApiClient } from '../../api/client';
import { notificationTarget, readPushData, showInForeground } from '../../features/pushNotifications';
import { PUSH_ASKED_KEY, PUSH_TOKEN_KEY, deviceToken, forgetPushRegistration, pushDataOf, syncPushRegistration } from './pushRegistration';

const api = { configured: true, request: h.request } as unknown as ApiClient;
const ME = 'identity_1';

beforeEach(() => {
  h.store.clear();
  h.platform.OS = 'android';
  h.iosConfigured = false;
  h.iosPending = null;
  h.iosToken = 'unit-ios-fcm-registration-token';
  h.tokenReads = 0;
  h.clearedResponses = 0;
  h.clearFails = false;
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
  it('cannot register or cache a late FCM token after its account signs out', async () => {
    h.platform.OS = 'ios'; h.iosConfigured = true; h.permission = { granted: true, canAskAgain: true };
    let current = true;
    let finish!: (token: string) => void;
    h.iosPending = new Promise(resolve => { finish = resolve; });
    const pending = syncPushRegistration(api, { identityId: ME, isCurrent: () => current });
    await new Promise(resolve => setTimeout(resolve, 0));
    current = false; finish('unit-late-fcm-registration-token');
    await pending;
    expect(h.request).not.toHaveBeenCalled(); expect(h.store.has(PUSH_TOKEN_KEY)).toBe(false);
  });
  it('uses the real iOS-provider path with ios platform and exact bundle identity', async () => {
    h.platform.OS = 'ios'; h.iosConfigured = true;
    expect(await syncPushRegistration(api, { identityId: ME })).toBe('registered');
    expect(h.asked).toBe(1); expect(h.channels).toEqual([]); expect(h.tokenReads).toBe(0);
    expect(registrations()).toEqual([{ pushToken: h.iosToken, platform: 'ios', notifications: 'on', appId: 'com.dashworldng.dash.staging', appVersion: '0.1.0' }]);
  });
  it('replaces an old iOS FCM token and reports the account preference', async () => {
    h.platform.OS = 'ios'; h.iosConfigured = true; h.permission = { granted: true, canAskAgain: true };
    h.store.set(PUSH_TOKEN_KEY, 'unit-old-fcm-registration-token'); h.store.set(`dash.notifications.v1:${ME}`, 'off');
    await syncPushRegistration(api, { identityId: ME });
    expect(h.asked).toBe(0); expect(registrations().at(-1)).toMatchObject({ platform: 'ios', notifications: 'off', replacesPushToken: 'unit-old-fcm-registration-token' });
  });
  it('does not register when the configured iOS provider has no deliverable token', async () => {
    h.platform.OS = 'ios'; h.iosConfigured = true; h.iosToken = null;
    expect(await syncPushRegistration(api, { identityId: ME })).toBe('unavailable'); expect(h.request).not.toHaveBeenCalled();
  });
  it('does not prompt iOS or send an APNs token to the FCM backend', async () => {
    h.platform.OS = 'ios';
    h.token = 'a'.repeat(64);
    expect(await syncPushRegistration(api, { identityId: ME, userAsked: true })).toBe('unavailable');
    expect(await deviceToken()).toBeNull();
    expect(h.tokenReads).toBe(0);
    expect(h.asked).toBe(0);
    expect(h.channels).toEqual([]);
    expect(h.store.has(PUSH_ASKED_KEY)).toBe(false);
    expect(h.request).not.toHaveBeenCalled();
  });

  it('creates the channels, asks once, and registers with the switch on', async () => {
    expect(await syncPushRegistration(api, { identityId: ME })).toBe('registered');
    expect(h.channels).toEqual(['offers', 'orders', 'messages', 'account']);
    expect(h.asked).toBe(1);
    // The build's own application id goes with it: the staging service
    // accepts only the staging build.
    expect(registrations()).toEqual([
      { pushToken: 'fcm-token-aaaaaaaaaaaaaaaa', platform: 'android', notifications: 'on', appId: 'com.dashworldng.dash.staging', appVersion: '0.1.0' },
    ]);
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
  it('clears an iOS cached notification tap even without an API or registered token', async () => {
    h.platform.OS = 'ios';
    await forgetPushRegistration({ configured: false } as ApiClient);
    expect(h.clearedResponses).toBe(1);
    expect(h.request).not.toHaveBeenCalled();
  });

  it('still unregisters an iOS stored token if clearing the tap cache fails', async () => {
    h.platform.OS = 'ios';
    h.clearFails = true;
    h.store.set(PUSH_TOKEN_KEY, 'fcm-token-aaaaaaaaaaaaaaaa');
    await expect(forgetPushRegistration(api)).resolves.toBeUndefined();
    expect(h.clearedResponses).toBe(1);
    expect(h.request).toHaveBeenCalledWith('/v1/devices', { method: 'DELETE', body: { pushToken: 'fcm-token-aaaaaaaaaaaaaaaa' } });
  });

  it('unregisters the phone’s token, and never throws', async () => {
    h.store.set(PUSH_TOKEN_KEY, 'fcm-token-aaaaaaaaaaaaaaaa');
    await forgetPushRegistration(api);
    expect(h.clearedResponses).toBe(0); // Android cleanup contract is unchanged.
    expect(h.request).toHaveBeenCalledWith('/v1/devices', { method: 'DELETE', body: { pushToken: 'fcm-token-aaaaaaaaaaaaaaaa' } });

    h.request.mockRejectedValueOnce(new Error('offline'));
    await expect(forgetPushRegistration(api)).resolves.toBeUndefined();
  });
});

describe('reading a push’s data', () => {
  it.each(['order_update', 'order_chat', 'payment_update'])('reads iOS FCM %s identifiers from Expo’s raw APNs trigger payload', (type) => {
    h.platform.OS = 'ios';
    // Expo SDK 57 NotificationRecords.swift exposes remote userInfo as
    // trigger.payload; content.data only reads userInfo["body"]. FCM sends
    // DASH's custom data at the top level, without that Expo-service wrapper.
    const payload = { aps: { alert: { title: 'DASH update', body: 'Open DASH' } }, type, audience: 'customer', orderId: 'ios_order' };
    const notification = { request: { identifier: 'ios_fcm', content: { data: null }, trigger: { type: 'push', payload } } };
    const data = readPushData(pushDataOf(notification as never));
    expect(data).toEqual({ type, audience: 'customer', orderId: 'ios_order' });
    expect(notificationTarget(data, { customerId: 'customer', riderStatus: null })?.face).toBe('customer');
  });

  it('reads iOS Rider payloads and keeps the role gate', () => {
    h.platform.OS = 'ios';
    const notification = { request: { identifier: 'ios_offer', content: { data: {} }, trigger: { type: 'push', payload: { type: 'rider_offer', offerId: 'ios_offer' } } } };
    const data = readPushData(pushDataOf(notification as never));
    expect(notificationTarget(data, { customerId: 'customer', riderStatus: null })).toBeNull();
    expect(notificationTarget(data, { customerId: 'customer', riderStatus: 'approved' })?.face).toBe('rider');
  });

  it('applies existing foreground suppression to raw iOS FCM payloads', () => {
    h.platform.OS = 'ios';
    const notification = { request: { content: { data: null }, trigger: { type: 'push', payload: { type: 'order_chat', audience: 'customer', orderId: 'ios_chat' } } } };
    const data = readPushData(pushDataOf(notification as never));
    expect(showInForeground(data, { face: 'customer', route: { name: 'customer.chat', params: { id: 'ios_chat' } } })).toBe(false);
    expect(showInForeground(data, { face: 'customer', route: { name: 'customer.home' } })).toBe(true);
  });

  it('does not interpret a local iOS trigger or malformed payload as a DASH push', () => {
    h.platform.OS = 'ios';
    const data = { type: 'rider_offer', offerId: 'local' };
    expect(readPushData(pushDataOf({ request: { content: { data: null }, trigger: { type: 'timeInterval', payload: data } } } as never))).toBeNull();
    expect(readPushData(pushDataOf({ request: { content: { data: null }, trigger: { type: 'push', payload: { aps: { alert: 'Other message' } } } } } as never))).toBeNull();
  });

  it('keeps Android remote-message data ahead of an iOS-shaped payload', () => {
    const data = { type: 'rider_offer', offerId: 'android_offer' };
    const notification = { request: { content: { data: {} }, trigger: { type: 'push', remoteMessage: { data }, payload: { type: 'rider_offer', offerId: 'ios_offer' } } } };
    expect(pushDataOf(notification as never)).toEqual(data);
  });
  it('finds it on the content, or on the FCM message when Android displayed it', () => {
    const shown = { request: { identifier: 'n1', content: { data: { type: 'order_chat', orderId: 'o' } }, trigger: null } };
    expect(pushDataOf(shown as never)).toEqual({ type: 'order_chat', orderId: 'o' });
    const fromTray = {
      request: { identifier: 'n2', content: { data: {} }, trigger: { type: 'push', remoteMessage: { data: { type: 'rider_offer', offerId: 'x' } } } },
    };
    expect(pushDataOf(fromTray as never)).toEqual({ type: 'rider_offer', offerId: 'x' });
  });
});
