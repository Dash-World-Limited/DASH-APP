/**
 * Native project configuration for the DASH Customer and Rider app.
 *
 * Expo development builds, not Expo Go: DASH needs native modules Expo Go does
 * not carry in production form (maps with our own key, background location
 * later, FCM), so the app is built as its own binary from the first day and
 * `expo start --dev-client` serves JavaScript to that binary.
 *
 * The native `android/` and `ios/` projects are generated from this file by
 * `expo prebuild` and are not committed — this file is the single source of
 * truth for identifiers, permissions and plugins, which is what keeps a
 * permission from being added in Gradle and forgotten in review.
 *
 * ## Variants
 *
 * `APP_VARIANT` selects development, staging or production. Each installs as
 * a separate app with its own identifier, so a tester can hold a staging build
 * and a development build side by side without one overwriting the other.
 *
 * The identifier root is `com.dashworldng.dash`, from the company domain
 * dashworldng.com. It is permanent once a production build is published to a
 * store, so it is flagged for director confirmation before that happens; the
 * development and staging suffixes can change freely.
 */

import type { ConfigContext, ExpoConfig } from 'expo/config';

type Variant = 'development' | 'staging' | 'production';

const variant: Variant = (() => {
  const value = process.env.APP_VARIANT ?? 'development';
  if (value === 'development' || value === 'staging' || value === 'production') return value;
  throw new Error(`APP_VARIANT must be development, staging or production — got "${value}".`);
})();

const IDENTIFIER_ROOT = 'com.dashworldng.dash';

const identity: Record<Variant, { name: string; id: string }> = {
  development: { name: 'DASH (dev)', id: `${IDENTIFIER_ROOT}.dev` },
  staging: { name: 'DASH (staging)', id: `${IDENTIFIER_ROOT}.staging` },
  production: { name: 'DASH', id: IDENTIFIER_ROOT },
};

/**
 * Android maps need a Google Maps key compiled into the binary. None exists
 * yet. Without one the map view renders an empty surface, so the app reads
 * `mapsConfigured` and shows a designed "map unavailable in this build" state
 * instead of a grey rectangle pretending to be a map. iOS uses Apple Maps and
 * needs no key.
 */
const googleMapsApiKey = process.env.GOOGLE_MAPS_ANDROID_API_KEY;

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: identity[variant].name,
  slug: 'dash',
  scheme: 'dash',
  version: '0.1.0',
  orientation: 'portrait',
  // The app decides, not the OS: Light is the default, and a person can choose
  // Dark or follow the system under Appearance. `automatic` lets the native
  // root follow whichever the app has resolved.
  userInterfaceStyle: 'automatic',
  // The New Architecture is the only architecture from SDK 57; there is no flag.
  backgroundColor: '#F8F7F2',
  ios: {
    bundleIdentifier: identity[variant].id,
    supportsTablet: false,
    infoPlist: {
      NSLocationWhenInUseUsageDescription:
        'DASH uses your location to show sellers near you and, for riders, to offer deliveries you can reach.',
    },
  },
  android: {
    package: identity[variant].id,
    // Edge-to-edge is mandatory from Expo SDK 57 / Android 15 — there is no
    // switch; `Screen` owns the insets instead.
    // Foreground location only. Background location for an Online rider needs
    // a foreground service and its own Play policy declaration; it arrives with
    // that milestone and is not requested here in the meantime.
    permissions: ['ACCESS_COARSE_LOCATION', 'ACCESS_FINE_LOCATION'],
    // Least privilege. The Expo template brings these in by default; the app
    // uses none of them. SYSTEM_ALERT_WINDOW (draw over other apps) is one Play
    // reviews closely — debug builds keep their own copy in the debug
    // manifest for the developer menu, and a build-type manifest outranks
    // main, so only release builds lose it. Found by reading the generated
    // manifest after the first prebuild.
    blockedPermissions: [
      'android.permission.ACCESS_BACKGROUND_LOCATION',
      'android.permission.SYSTEM_ALERT_WINDOW',
      'android.permission.READ_EXTERNAL_STORAGE',
      'android.permission.WRITE_EXTERNAL_STORAGE',
    ],
    ...(googleMapsApiKey ? { config: { googleMaps: { apiKey: googleMapsApiKey } } } : {}),
  },
  web: {
    // Web output exists for design review only — the product is the native
    // app. See README.
    bundler: 'metro',
    output: 'single',
  },
  plugins: [
    'expo-router',
    'expo-status-bar',
    'expo-font',
    'expo-image',
    'expo-secure-store',
    [
      'expo-location',
      {
        locationWhenInUsePermission:
          'DASH uses your location to show sellers near you and, for riders, to offer deliveries you can reach.',
        isAndroidBackgroundLocationEnabled: false,
      },
    ],
  ],
  extra: {
    variant,
    // The API the app talks to. Never defaulted to localhost: on a phone that
    // is the phone. Missing means the app shows staging fixtures and says so.
    apiUrl: process.env.EXPO_PUBLIC_API_URL ?? null,
    mapsConfigured: Boolean(googleMapsApiKey),
  },
});
