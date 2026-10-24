/**
 * Where the phone is, for a delivery address.
 *
 * Foreground only, asked for at the moment it is needed — when the customer
 * taps "Use my current location" — never at launch. A refusal is an answer
 * the screen explains, with a way to recover (the system settings), not an
 * error; and the app never guesses a position it was not given.
 */

import * as Location from 'expo-location';
import { Linking } from 'react-native';

export type LocationResult =
  | { ok: true; latitude: number; longitude: number; accuracyMetres: number | null }
  | { ok: false; reason: 'denied' | 'unavailable'; canAskAgain: boolean; message: string };

export async function currentLocation(): Promise<LocationResult> {
  let permission: Location.LocationPermissionResponse;
  try {
    permission = await Location.requestForegroundPermissionsAsync();
  } catch {
    return { ok: false, reason: 'unavailable', canAskAgain: true, message: 'Location is not available on this device.' };
  }
  if (permission.status !== 'granted') {
    return {
      ok: false,
      reason: 'denied',
      canAskAgain: permission.canAskAgain,
      message: permission.canAskAgain
        ? 'DASH needs your location to find your address. You can allow it and try again.'
        : 'Location is turned off for DASH. Turn it on in Settings to use your current location.',
    };
  }
  try {
    const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
    return {
      ok: true,
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
      accuracyMetres: position.coords.accuracy ?? null,
    };
  } catch {
    return {
      ok: false,
      reason: 'unavailable',
      canAskAgain: true,
      message: 'Your location could not be found just now. Check that location is on and try again.',
    };
  }
}

/** The system settings page for this app, where a permanent refusal is undone. */
export function openAppSettings(): void {
  void Linking.openSettings().catch(() => undefined);
}
