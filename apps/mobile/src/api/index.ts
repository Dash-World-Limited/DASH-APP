/**
 * The app's API client, wired to the device.
 *
 * `client.ts` and `session.ts` take their dependencies as arguments so they can
 * be tested; this file is the one place those arguments are the real things —
 * the configured server, the platform `fetch`, and SecureStore for the CSRF
 * value.
 */

import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import { COMPILED_API_URL } from './buildConfig';
import { createApiClient, normaliseBaseUrl } from './client';
import { createSession, type CsrfStore } from './session';

const CSRF_KEY = 'dash.csrf.v1';

const secureStore: CsrfStore = {
  get: () => SecureStore.getItemAsync(CSRF_KEY),
  set: (value) => (value ? SecureStore.setItemAsync(CSRF_KEY, value) : SecureStore.deleteItemAsync(CSRF_KEY)),
};

/**
 * The browser build (design review, not the product) has no secure store. On
 * the web the CSRF value is script-readable by design (the web client reads
 * it from a non-HttpOnly cookie), so local storage holds it there. The refresh
 * token is an HttpOnly cookie on every platform and never reaches this code.
 */
const webStore: CsrfStore = {
  get: async () => {
    try {
      return globalThis.localStorage?.getItem(CSRF_KEY) ?? null;
    } catch {
      return null;
    }
  },
  set: async (value) => {
    try {
      if (value) globalThis.localStorage?.setItem(CSRF_KEY, value);
      else globalThis.localStorage?.removeItem(CSRF_KEY);
    } catch {
      // Private mode or blocked storage: the session simply will not survive a reload.
    }
  },
};

export const session = createSession(Platform.OS === 'web' ? webStore : secureStore);

const extra = (Constants.expoConfig?.extra ?? {}) as { apiUrl?: unknown; variant?: unknown; mapsConfigured?: unknown };

export const api = createApiClient({
  // The app config's value on a device. The web build's manifest carries the
  // key but not the string (it arrives as `{}`), so fall back to the same
  // variable, which Expo inlines into every bundle at build time.
  baseUrl:
    normaliseBaseUrl(COMPILED_API_URL) ??
    normaliseBaseUrl(extra.apiUrl) ??
    normaliseBaseUrl(process.env.EXPO_PUBLIC_API_URL),
  fetch: (input, init) => fetch(input, init),
  session,
});

export const buildVariant: 'development' | 'staging' | 'production' =
  extra.variant === 'staging' || extra.variant === 'production' ? extra.variant : 'development';

/** True when this build carries a Google Maps key, so Android can draw a map. */
export const mapsConfigured = extra.mapsConfigured === true;

export { ApiError } from './errors';
export type { SessionState } from './session';
