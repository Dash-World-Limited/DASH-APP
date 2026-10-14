/**
 * Where the phone is, for a delivery address.
 *
 * Foreground only, asked for at the moment it is needed: when the customer
 * saves an address, and on the customer home screen when no delivery location
 * has been chosen yet (once per app session, never on a resume). A refusal is
 * an answer the screen explains, with a way to recover (the system settings),
 * not an error; and the app never guesses a position it was not given.
 */

import * as Location from 'expo-location';
import { Linking } from 'react-native';

import type { GeocodedPlace } from './delivery';

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

// ---------------------------------------------------------------------------
// Where the customer is, as an address: the home screen's location line
// ---------------------------------------------------------------------------

export type PlaceResult =
  | { ok: true; latitude: number; longitude: number; accuracyMetres: number | null; place: GeocodedPlace | null }
  | { ok: false; reason: 'denied' | 'unavailable'; canAskAgain: boolean; message: string };

/** A position fix that never arrives must not hold the screen on "Finding…". */
export const PLACE_FIX_TIMEOUT_MS = 20_000;
const GEOCODE_TIMEOUT_MS = 10_000;

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * When the system permission dialog may open:
 *
 * - `never`: only read the permission.
 * - `first-time`: only if this customer has never been asked. Someone who
 *   already said no is not asked again unprompted.
 * - `always`: whenever Android can still ask. This is the customer tapping
 *   "Allow location".
 */
export type PermissionAsk = 'never' | 'first-time' | 'always';

/**
 * The phone's position and the place it is in.
 *
 * Reads the permission first, which shows nothing. Every request pauses and
 * resumes the app, so callers ask on purpose and never from a resume. The
 * place may be null when the geocoder has no address for the spot; the
 * position is still good.
 */
export async function detectCurrentPlace({ ask }: { ask: PermissionAsk }): Promise<PlaceResult> {
  let permission: Location.LocationPermissionResponse;
  try {
    permission = await Location.getForegroundPermissionsAsync();
    const mayAsk = ask === 'always' || (ask === 'first-time' && permission.status === 'undetermined');
    if (permission.status !== 'granted' && mayAsk && permission.canAskAgain) {
      permission = await Location.requestForegroundPermissionsAsync();
    }
  } catch {
    return { ok: false, reason: 'unavailable', canAskAgain: true, message: 'Location is not available on this device.' };
  }
  if (permission.status !== 'granted') {
    return {
      ok: false,
      reason: 'denied',
      canAskAgain: permission.canAskAgain,
      message: permission.canAskAgain
        ? 'Allow DASH to use your location to find your delivery address.'
        : 'Location is turned off for DASH. Turn it on in Settings, or choose a saved address.',
    };
  }

  let latitude: number;
  let longitude: number;
  let accuracyMetres: number | null;
  try {
    const position = await withTimeout(
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
      PLACE_FIX_TIMEOUT_MS,
    );
    latitude = position.coords.latitude;
    longitude = position.coords.longitude;
    accuracyMetres = position.coords.accuracy ?? null;
  } catch {
    return {
      ok: false,
      reason: 'unavailable',
      canAskAgain: true,
      message: 'Your location could not be found just now. Check that location is on and try again.',
    };
  }

  let place: GeocodedPlace | null = null;
  try {
    const places = await withTimeout(Location.reverseGeocodeAsync({ latitude, longitude }), GEOCODE_TIMEOUT_MS);
    place = places[0] ?? null;
  } catch {
    place = null;
  }
  return { ok: true, latitude, longitude, accuracyMetres, place };
}
