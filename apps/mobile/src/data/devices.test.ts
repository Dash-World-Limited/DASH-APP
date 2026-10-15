/**
 * The phone's push registration calls: the token, the account's switch, the
 * token it replaces — and never anything naming an account.
 */

import { describe, expect, it } from 'vitest';

import type { ApiClient, RequestOptions } from '../api/client';
import { registerDevice, unregisterDevice } from './devices';

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
