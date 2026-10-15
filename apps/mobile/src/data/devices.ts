/**
 * Telling DASH which phone to send pushes to, and stopping.
 *
 * The server takes the account from the session, never from here; this only
 * names the phone's push token, its Notifications switch, and — when the push
 * provider has rotated the token — the token it replaces, so the old one stops
 * being sent to straight away.
 */

import type { ApiClient } from '../api/client';

export interface DeviceRegistration {
  pushToken: string;
  platform: 'android' | 'ios';
  notifications: 'on' | 'off';
  appVersion?: string;
  replacesPushToken?: string;
}

export function registerDevice(api: ApiClient, input: DeviceRegistration): Promise<{ registered: boolean; deviceId: string }> {
  return api.request('/v1/devices', { method: 'POST', body: { ...input } });
}

export function unregisterDevice(api: ApiClient, pushToken: string): Promise<{ revoked: boolean }> {
  return api.request('/v1/devices', { method: 'DELETE', body: { pushToken } });
}
