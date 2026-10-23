/** Native FCM token bridge only. Expo still owns notification presentation/taps. */
import Constants from 'expo-constants';
import { Platform } from 'react-native';

export function iosPushConfigured(): boolean {
  return Platform.OS === 'ios' && Constants.expoConfig?.extra?.iosPushConfigured === true;
}

export async function iosFcmToken(): Promise<string | null> {
  if (!iosPushConfigured()) return null;
  try {
    // Do not import/initialize Firebase in Android or unconfigured builds.
    const fcm = await import('@react-native-firebase/messaging');
    const messaging = fcm.getMessaging();
    if (!messaging.isDeviceRegisteredForRemoteMessages) await fcm.registerDeviceForRemoteMessages(messaging);
    // An APNs registration is required before FCM can map this Apple device.
    // Never pass the APNs token itself to DASH's FCM sender.
    if (!await fcm.getAPNSToken(messaging)) return null;
    const token = await fcm.getToken(messaging);
    return typeof token === 'string' && token.length >= 16 ? token : null;
  } catch {
    return null; // Missing provisioning/APNs/native setup must not break DASH.
  }
}

/** Expo's token listener reports APNs rotation, not FCM token refresh. */
export function onIosFcmTokenRefresh(listener: () => void): () => void {
  let alive = true;
  let unsubscribe: (() => void) | undefined;
  if (iosPushConfigured()) {
    void import('@react-native-firebase/messaging').then(fcm => {
      if (alive) unsubscribe = fcm.onTokenRefresh(fcm.getMessaging(), () => { if (alive) listener(); });
    }).catch(() => undefined);
  }
  return () => { alive = false; unsubscribe?.(); };
}
