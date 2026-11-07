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
  /** This build's application id; a DASH service accepts only its own builds. */
  appId?: string;
  appVersion?: string;
  replacesPushToken?: string;
}

export interface TestNotificationResult {
  /** True when the push was queued to arrive after `delaySeconds`. */
  queued: boolean;
  devices: number;
  /** `fcm` when the service sends real notifications; `console` when it only logs them. */
  provider: string;
  live: boolean;
  delaySeconds?: number;
  sent?: boolean;
  skipped?: string;
  /** Firebase's error codes when it refused the send. */
  reason?: string;
}

export function registerDevice(api: ApiClient, input: DeviceRegistration): Promise<{ registered: boolean; deviceId: string }> {
  return api.request('/v1/devices', { method: 'POST', body: { ...input } });
}

export function unregisterDevice(api: ApiClient, pushToken: string): Promise<{ revoked: boolean }> {
  return api.request('/v1/devices', { method: 'DELETE', body: { pushToken } });
}

/** Ask DASH to send a test notification to this account's own phones. */
export function sendTestNotification(api: ApiClient, delaySeconds: number): Promise<TestNotificationResult> {
  return api.request('/v1/devices/test', { method: 'POST', body: { delaySeconds } });
}

/** What to tell the tester about a test notification request. */
export function describeTestNotification(result: TestNotificationResult): { text: string; problem: boolean } {
  if (!result.live) {
    return {
      text: 'This DASH service is not connected to Firebase yet, so no notification will arrive. It only records that one would have been sent.',
      problem: true,
    };
  }
  if (result.queued) {
    const seconds = result.delaySeconds ?? 0;
    return {
      text: `A test notification will arrive in about ${seconds} seconds. Lock the phone or close DASH now to see it arrive in the background.`,
      problem: false,
    };
  }
  if (result.sent) return { text: 'Test notification sent. It should appear in a moment.', problem: false };
  if (result.reason) return { text: `Firebase did not deliver the test notification (${result.reason}).`, problem: true };
  return { text: 'The test notification was not sent.', problem: true };
}
