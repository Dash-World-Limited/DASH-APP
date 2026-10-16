/**
 * The phone's push registration calls: the token, the account's switch, the
 * token it replaces — and never anything naming an account.
 */

import { describe, expect, it } from 'vitest';

import type { ApiClient, RequestOptions } from '../api/client';
import { describeTestNotification, registerDevice, sendTestNotification, unregisterDevice } from './devices';

function fakeClient(answer: unknown) {
  const calls: { path: string; options: RequestOptions }[] = [];
  const api = {
    configured: true,
    request: async (path: string, options: RequestOptions = {}) => {
      calls.push({ path, options });
      return answer;
    },
  } as unknown as ApiClient;
  return { api, calls };
}

describe('device registration calls', () => {
  it('registers the token with the switch and what it replaces, and nothing about the account', async () => {
    const { api, calls } = fakeClient({ registered: true, deviceId: 'dev_1' });
    await registerDevice(api, { pushToken: 'fcm-token-new', platform: 'android', notifications: 'off', appVersion: '0.1.0', replacesPushToken: 'fcm-token-old' });
    expect(calls).toEqual([
      {
        path: '/v1/devices',
        options: { method: 'POST', body: { pushToken: 'fcm-token-new', platform: 'android', notifications: 'off', appVersion: '0.1.0', replacesPushToken: 'fcm-token-old' } },
      },
    ]);
    expect(JSON.stringify(calls)).not.toMatch(/identity|customerId|riderId/);
  });

  it('unregisters by token', async () => {
    const { api, calls } = fakeClient({ revoked: true });
    expect(await unregisterDevice(api, 'fcm-token-new')).toEqual({ revoked: true });
    expect(calls).toEqual([{ path: '/v1/devices', options: { method: 'DELETE', body: { pushToken: 'fcm-token-new' } } }]);
  });
});

describe('test notifications', () => {
  it('asks for one to this account’s own phones, with a delay, naming nobody', async () => {
    const { api, calls } = fakeClient({ queued: true, devices: 1, delaySeconds: 10, provider: 'fcm', live: true });
    await sendTestNotification(api, 10);
    expect(calls).toEqual([{ path: '/v1/devices/test', options: { method: 'POST', body: { delaySeconds: 10 } } }]);
  });

  it('tells the tester honestly what to expect', () => {
    expect(describeTestNotification({ queued: true, devices: 1, delaySeconds: 10, provider: 'fcm', live: true })).toEqual({
      text: 'A test notification will arrive in about 10 seconds. Lock the phone or close DASH now to see it arrive in the background.',
      problem: false,
    });
    // A service that only logs pushes must not claim one is coming.
    expect(describeTestNotification({ queued: true, devices: 1, delaySeconds: 10, provider: 'console', live: false })).toMatchObject({
      problem: true,
      text: expect.stringContaining('not connected to Firebase'),
    });
    expect(describeTestNotification({ queued: false, devices: 1, provider: 'fcm', live: true, sent: true }).problem).toBe(false);
    expect(
      describeTestNotification({ queued: false, devices: 1, provider: 'fcm', live: true, sent: false, reason: '0 of 1 delivered — messaging/third-party-auth-error ×1' }),
    ).toEqual({ text: 'Firebase did not deliver the test notification (0 of 1 delivered — messaging/third-party-auth-error ×1).', problem: true });
  });
});
