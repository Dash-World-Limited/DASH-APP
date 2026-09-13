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

import { createApiClient, normaliseBaseUrl } from './client';
import { createSession } from './session';

const CSRF_KEY = 'dash.csrf.v1';

export const session = createSession({
  get: () => SecureStore.getItemAsync(CSRF_KEY),
  set: (value) => (value ? SecureStore.setItemAsync(CSRF_KEY, value) : SecureStore.deleteItemAsync(CSRF_KEY)),
});

const extra = (Constants.expoConfig?.extra ?? {}) as { apiUrl?: unknown; variant?: unknown; mapsConfigured?: unknown };

export const api = createApiClient({
  baseUrl: normaliseBaseUrl(extra.apiUrl),
  fetch: (input, init) => fetch(input, init),
  session,
});

export const buildVariant: 'development' | 'staging' | 'production' =
  extra.variant === 'staging' || extra.variant === 'production' ? extra.variant : 'development';

/** True when this build carries a Google Maps key, so Android can draw a map. */
export const mapsConfigured = extra.mapsConfigured === true;

export { ApiError } from './errors';
export type { SessionState } from './session';
