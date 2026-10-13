/**
 * Whether someone wants DASH notifications on this phone.
 *
 * Kept on the device, per account, in the same storage as the Appearance
 * choice. Notifications are delivered to a device: the server's `/v1/devices`
 * registration is the thing push will be sent to, so when push is switched on
 * this preference decides whether this phone registers its token at all —
 * on registers, off revokes it. A server-side copy would be a second answer
 * to a question only the phone can act on.
 *
 * Setting it never asks Android for the notification permission. That prompt
 * belongs to the moment push is actually turned on, once, not to opening a
 * settings screen.
 *
 * Pure apart from the injected store, so it is tested directly.
 */

export const NOTIFICATION_PREFERENCE_KEY = 'dash.notifications.v1';

/** On until someone turns it off: order and delivery updates are why people install DASH. */
export const DEFAULT_NOTIFICATIONS_ENABLED = true;

/** One key per signed-in account, so two people sharing a phone do not share a choice. */
export function notificationPreferenceKey(identityId: string | null | undefined): string {
  return identityId ? `${NOTIFICATION_PREFERENCE_KEY}:${identityId}` : NOTIFICATION_PREFERENCE_KEY;
}

/** Anything but an explicit `off` reads as the default, never as a crash or an accidental off. */
export function parseNotificationPreference(raw: unknown): boolean {
  if (raw === 'off') return false;
  if (raw === 'on') return true;
  return DEFAULT_NOTIFICATIONS_ENABLED;
}

export function serialiseNotificationPreference(enabled: boolean): 'on' | 'off' {
  return enabled ? 'on' : 'off';
}

export interface PreferenceStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export async function readNotificationPreference(store: PreferenceStore, identityId: string | null | undefined): Promise<boolean> {
  return parseNotificationPreference(await store.getItem(notificationPreferenceKey(identityId)));
}

export async function writeNotificationPreference(
  store: PreferenceStore,
  identityId: string | null | undefined,
  enabled: boolean,
): Promise<void> {
  await store.setItem(notificationPreferenceKey(identityId), serialiseNotificationPreference(enabled));
}
