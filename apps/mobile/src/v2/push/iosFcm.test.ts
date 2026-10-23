import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ os: 'ios', enabled: true, apns: 'unit-apns', token: 'unit-fcm-registration-token', registered: false, fail: false, tokenReads: 0, registrations: 0, listeners: new Set<() => void>() }));
vi.mock('react-native', () => ({ Platform: { get OS() { return h.os; } } }));
vi.mock('expo-constants', () => ({ default: { get expoConfig() { return { extra: { iosPushConfigured: h.enabled } }; } } }));
vi.mock('@react-native-firebase/messaging', () => ({
  getMessaging: () => { if (h.fail) throw new Error('No native default Firebase app'); return { isDeviceRegisteredForRemoteMessages: h.registered }; },
  registerDeviceForRemoteMessages: async () => { h.registrations++; },
  getAPNSToken: async () => h.apns,
  getToken: async () => { h.tokenReads++; return h.token; },
  onTokenRefresh: (_: unknown, listener: () => void) => { h.listeners.add(listener); return () => { h.listeners.delete(listener); }; },
}));
import { iosFcmToken, iosPushConfigured, onIosFcmTokenRefresh } from './iosFcm';

beforeEach(() => { h.os = 'ios'; h.enabled = true; h.apns = 'unit-apns'; h.token = 'unit-fcm-registration-token'; h.registered = false; h.fail = false; h.tokenReads = 0; h.registrations = 0; h.listeners.clear(); });
const flush = async () => { await new Promise(resolve => setTimeout(resolve, 0)); };
describe('iOS-only native FCM bridge (unit substitutes; no delivery claim)', () => {
  it('returns FCM only after APNs device registration', async () => { expect(await iosFcmToken()).toBe(h.token); expect(h.registrations).toBe(1); expect(h.tokenReads).toBe(1); });
  it('never sends an APNs token as FCM when APNs registration is absent', async () => { h.apns = ''; expect(await iosFcmToken()).toBeNull(); expect(h.tokenReads).toBe(0); });
  it('does not register twice when the native device is already registered', async () => { h.registered = true; expect(await iosFcmToken()).toBe(h.token); expect(h.registrations).toBe(0); });
  it('fails closed without native Firebase configuration', async () => { h.fail = true; await expect(iosFcmToken()).resolves.toBeNull(); });
  it('rejects invalid token values', async () => { h.token = ''; expect(await iosFcmToken()).toBeNull(); });
  it('never starts Firebase in an unconfigured iOS simulator build', async () => { h.enabled = false; expect(iosPushConfigured()).toBe(false); expect(await iosFcmToken()).toBeNull(); expect(h.registrations).toBe(0); });
  it.each(['android', 'web'])('leaves %s native token behavior untouched', async os => { h.os = os; expect(await iosFcmToken()).toBeNull(); const stop = onIosFcmTokenRefresh(vi.fn()); await flush(); expect(h.listeners.size).toBe(0); expect(h.tokenReads).toBe(0); stop(); });
  it('subscribes to FCM refresh and removes the subscription at logout/unmount', async () => { const listener = vi.fn(); const stop = onIosFcmTokenRefresh(listener); await flush(); for (const cb of h.listeners) cb(); expect(listener).toHaveBeenCalledOnce(); stop(); expect(h.listeners.size).toBe(0); });
  it('does not attach a late token subscription after logout', async () => { const stop = onIosFcmTokenRefresh(vi.fn()); stop(); await flush(); expect(h.listeners.size).toBe(0); });
});
