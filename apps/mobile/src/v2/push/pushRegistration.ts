/**
 * This phone and DASH's push notifications: Android's channels and
 * permission, the FCM token, and telling the server about both.
 *
 * ## The token
 *
 * The native FCM registration token (`getDevicePushTokenAsync`), sent straight
 * to DASH's API, which delivers through Firebase Cloud Messaging with its own
 * server credentials. No Expo push service sits in between, and no Firebase
 * credential is in the app: the only Firebase file in the build is the
 * public client configuration (`google-services.json`), supplied at build
 * time and never committed. A build without it simply has no token, and the
 * app carries on without push.
 *
 * ## When it registers
 *
 * After sign-in, on every return to the foreground (throttled), whenever FCM
 * rotates the token, and when the Notifications switch changes. Each time it
 * reports the switch for this account, so the server can honour it, and the
 * token this phone held before, so a rotated-out token stops being sent to.
 * Registration is idempotent on the server; repeating it changes nothing.
 *
 * ## Permission
 *
 * Asked once, on DASH's own initiative, after sign-in — and again only when
 * the person turns the switch on. Never for someone who has switched DASH
 * notifications off (see `permissionStep`). Android 12 and older grant it
 * without asking.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { PUSH_CHANNELS, type PushChannel } from '@dash/domain/push';

import type { ApiClient } from '../../api/client';
import { registerDevice, unregisterDevice } from '../../data/devices';
import { readNotificationPreference } from '../../features/notificationPreference';
import { permissionStep } from '../../features/pushNotifications';

/** The token this phone last registered, so a rotation can name what it replaces. */
export const PUSH_TOKEN_KEY = 'dash.push.token.v1';
/** Whether DASH has already asked for the permission once, unprompted. */
export const PUSH_ASKED_KEY = 'dash.push.asked.v1';

const IMPORTANCE: Record<PushChannel['importance'], Notifications.AndroidImportance> = {
  max: Notifications.AndroidImportance.MAX,
  high: Notifications.AndroidImportance.HIGH,
  default: Notifications.AndroidImportance.DEFAULT,
};

const supported = (): boolean => Platform.OS === 'android' || Platform.OS === 'ios';

/**
 * Android's notification channels. Created before anything else: Android 13
 * will not show the permission prompt for an app with no channel, and a push
 * naming a channel that does not exist falls back to a generic one.
 * Idempotent — re-creating a channel keeps whatever the person changed.
 */
export async function ensureChannels(): Promise<void> {
  if (Platform.OS !== 'android') return;
  for (const channel of PUSH_CHANNELS) {
    await Notifications.setNotificationChannelAsync(channel.id, {
      name: channel.name,
      description: channel.description,
      importance: IMPORTANCE[channel.importance],
    });
  }
}

/** The FCM token, or null when this build cannot have one (no Firebase config). */
export async function deviceToken(): Promise<string | null> {
  // Expo returns an APNs token on iOS. DASH currently sends through FCM,
  // which requires an FCM registration token, even for Apple devices.
  // Do not register an undeliverable APNs token or wait for APNs in a simulator.
  if (Platform.OS !== 'android') return null;
  try {
    const token = await Notifications.getDevicePushTokenAsync();
    return typeof token.data === 'string' && token.data.length >= 16 ? token.data : null;
  } catch {
    return null;
  }
}

export type SyncOutcome = 'registered' | 'waiting' | 'unavailable';

/**
 * Bring the server up to date with this phone, for the signed-in account.
 * `userAsked` when the person has just turned the switch on, which is the
 * one moment DASH asks for permission a second time.
 */
export async function syncPushRegistration(
  api: ApiClient,
  input: { identityId: string; userAsked?: boolean },
): Promise<SyncOutcome> {
  // iOS needs an FCM client integration (or a separate APNs backend) first.
  // Until then, do not ask for permission for a service this build cannot use.
  if (Platform.OS !== 'android' || !api.configured) return 'unavailable';
  await ensureChannels();

  const enabled = await readNotificationPreference(AsyncStorage, input.identityId);
  let permission = await Notifications.getPermissionsAsync();
  const askedBefore = (await AsyncStorage.getItem(PUSH_ASKED_KEY)) === 'yes';
  const step = permissionStep({
    granted: permission.granted,
    canAskAgain: permission.canAskAgain,
    enabled,
    askedBefore,
    userAsked: input.userAsked === true,
  });
  if (step === 'wait') return 'waiting';
  if (step === 'ask') {
    await AsyncStorage.setItem(PUSH_ASKED_KEY, 'yes');
    permission = await Notifications.requestPermissionsAsync();
    if (!permission.granted) return 'waiting';
  }

  const token = await deviceToken();
  if (!token) return 'unavailable';

  const previous = await AsyncStorage.getItem(PUSH_TOKEN_KEY);
  const appId = buildAppId();
  await registerDevice(api, {
    pushToken: token,
    platform: 'android',
    notifications: enabled ? 'on' : 'off',
    ...(appId ? { appId } : {}),
    ...(Constants.expoConfig?.version ? { appVersion: Constants.expoConfig.version } : {}),
    ...(previous && previous !== token ? { replacesPushToken: previous } : {}),
  });
  await AsyncStorage.setItem(PUSH_TOKEN_KEY, token);
  return 'registered';
}

/**
 * This build's application id — `com.dashworldng.dash.staging` for a staging
 * APK — from the app configuration compiled into it. The server accepts only
 * its own builds, so a staging build can never be registered with the
 * production service, or the reverse.
 */
export function buildAppId(): string | null {
  const config = Constants.expoConfig;
  const id = Platform.OS === 'ios' ? config?.ios?.bundleIdentifier : config?.android?.package;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/**
 * Stop this phone receiving the signed-in account's pushes. Called before
 * signing out, while the session can still say whose phone it is; the server
 * also silences the phone when the session ends. Never throws: signing out
 * must not depend on it.
 */
export async function forgetPushRegistration(api: ApiClient): Promise<void> {
  try {
    // A tap cached before sign-out must not be replayed into the next iOS
    // account. This cleanup is independent of whether FCM is configured.
    if (Platform.OS === 'ios') await Notifications.clearLastNotificationResponseAsync();
  } catch {
    // A native cache failure must not skip server-side token revocation.
  }
  try {
    if (!supported() || !api.configured) return;
    const token = await AsyncStorage.getItem(PUSH_TOKEN_KEY);
    if (token) await unregisterDevice(api, token);
  } catch {
    // The server's own logout handling is the backstop.
  }
}

/** Android's answer, for the settings screen. */
export async function notificationPermission(): Promise<{ granted: boolean; canAskAgain: boolean }> {
  if (!supported()) return { granted: false, canAskAgain: false };
  const permission = await Notifications.getPermissionsAsync();
  return { granted: permission.granted, canAskAgain: permission.canAskAgain };
}

/** The identifiers a DASH push carries in Expo's platform-specific records. */
export function pushDataOf(notification: Notifications.Notification): unknown {
  const content = notification.request.content.data as Record<string, unknown> | null | undefined;
  if (content && typeof content['type'] === 'string') return content;
  // A message FCM displayed itself (the app was closed) arrives with its data
  // on the remote message rather than the content.
  const trigger = notification.request.trigger as {
    type?: string;
    remoteMessage?: { data?: Record<string, string> };
    payload?: unknown;
  } | null;
  // Expo iOS serializes remote content.data from userInfo["body"], the Expo
  // push-service envelope. DASH sends directly through FCM, whose identifiers
  // are top-level APNs userInfo, exposed by Expo as trigger.payload instead.
  // The caller still validates these identifiers with readPushData.
  if (Platform.OS === 'ios' && trigger?.type === 'push') return trigger.payload ?? content ?? null;
  return trigger?.remoteMessage?.data ?? content ?? null;
}
