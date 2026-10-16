/**
 * Native project configuration for the DASH Customer and Rider app.
 *
 * Expo development builds, not Expo Go: DASH needs native modules Expo Go does
 * not carry in production form (MapLibre, background location later, FCM),
 * so the app is built as its own binary from the first day and
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

// eslint-disable-next-line @typescript-eslint/no-require-imports -- plain CommonJS so Expo's config loader and the tests can both load it without a build step
const { resolveReleaseConfig, resolveGoogleServicesFile } = require('./plugins/releaseConfig') as {
  resolveReleaseConfig: (
    variant: string,
    env: NodeJS.ProcessEnv,
  ) => { versionCode: number; versionName: string; apiUrl: string | null; mapStyleUrl: string };
  resolveGoogleServicesFile: (variant: string, env: NodeJS.ProcessEnv, packageName: string) => string | null;
};

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
 * Every value that varies per build, resolved and checked in one place
 * (plugins/releaseConfig.js).
 *
 * - MapLibre style: development and staging fall back to OpenFreeMap's
 *   street-level Liberty style so device testing shows real roads without an
 *   API key. Production must name its own reviewed style through
 *   EXPO_PUBLIC_MAP_STYLE_URL.
 * - versionCode (DASH_VERSION_CODE): must increase with every bundle uploaded
 *   to Play. Development and staging default to 1.
 * - versionName (DASH_VERSION_NAME): what Play and the device show.
 *   Development and staging default to 0.1.0.
 * - API origin (EXPO_PUBLIC_API_URL): optional outside production, where a
 *   missing value makes an honest "not connected" client.
 *
 * For production every one of them is required and checked — https, a public
 * host, no staging hostname, a real version — and this file throws before any
 * native project or bundle can be generated from a configuration that fails.
 */
const release = resolveReleaseConfig(variant, process.env);

/**
 * Firebase's Android client configuration for push notifications, from
 * `GOOGLE_SERVICES_JSON` (a path; the file is never committed). Required for
 * production; development and staging build without it and have no push.
 * See docs/release/PUSH_NOTIFICATIONS.md.
 */
const googleServicesFile = resolveGoogleServicesFile(variant, process.env, identity[variant].id);

/**
 * The launcher icon and splash: the measured DASH wordmark in its approved
 * graphite and bronze on the Light ground, generated from the wordmark
 * geometry by `npm run brand:assets` (apps/mobile/scripts/brand-assets.ts),
 * never edited by hand. One light splash for every phone: Light is the app's
 * default, and the dark version of the mark is not yet approved.
 */
const BRAND_GROUND = '#F8F7F2';
/**
 * The splash mark's width in dp. expo-splash-screen centres it in a 288 dp
 * canvas that Android 12+ crops to a 192 dp circle; at 176 dp wide the
 * mark's corners stay inside that circle.
 */
export const SPLASH_MARK_WIDTH_DP = 176;

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: identity[variant].name,
  slug: 'dash',
  scheme: 'dash',
  version: release.versionName,
  orientation: 'portrait',
  icon: './assets/brand/icon.png',
  // The app decides, not the OS: Light is the default, and a person can choose
  // Dark or follow the system under Appearance. `automatic` lets the native
  // root follow whichever the app has resolved.
  userInterfaceStyle: 'automatic',
  // The New Architecture is the only architecture from SDK 57; there is no flag.
  backgroundColor: BRAND_GROUND,
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
    versionCode: release.versionCode,
    // Keep focused inputs visible when Android opens the software keyboard.
    // Chat and other bottom-anchored forms must resize with the IME instead of
    // being panned underneath it.
    softwareKeyboardLayoutMode: 'resize',
    ...(googleServicesFile ? { googleServicesFile } : {}),
    adaptiveIcon: {
      foregroundImage: './assets/brand/adaptive-icon.png',
      // Android 13 themed icons recolour this silhouette.
      monochromeImage: './assets/brand/adaptive-icon-monochrome.png',
      backgroundColor: BRAND_GROUND,
    },
    // Edge-to-edge is mandatory from Expo SDK 57 / Android 15 — there is no
    // switch; `Screen` owns the insets instead.
    // Foreground location only. Background location for an Online rider needs
    // a foreground service and its own Play policy declaration; it arrives with
    // that milestone and is not requested here in the meantime.
    // POST_NOTIFICATIONS: Android 13+ asks before an app may show
    // notifications. DASH asks once after sign-in, and never for someone who
    // has switched its notifications off (src/features/pushNotifications).
    permissions: ['ACCESS_COARSE_LOCATION', 'ACCESS_FINE_LOCATION', 'POST_NOTIFICATIONS'],
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
      // Found in the merged manifest of the first full build (28 September),
      // brought in by libraries, used by nothing in the app: no biometric
      // prompt (SecureStore is not used with requireAuthentication), no
      // foreground service (background location is off), nothing that starts
      // at boot. Each one is a question in Play review and the Data Safety
      // form, so each is blocked until a feature genuinely needs it.
      'android.permission.USE_BIOMETRIC',
      'android.permission.USE_FINGERPRINT',
      'android.permission.FOREGROUND_SERVICE',
      'android.permission.RECEIVE_BOOT_COMPLETED',
      // Expo's base manifest lists VIBRATE under "optional permissions, remove
      // whatever you do not need". Nothing in the app vibrates (there is no
      // haptics module and no Vibration call), so it goes until a feature does.
      // Notifications still buzz: on Android 8+ the system vibrates for a
      // channel, which needs no permission of the app's own.
      'android.permission.VIBRATE',
    ],
  },
  web: {
    // Web output exists for design review only — the product is the native
    // app. See README.
    bundler: 'metro',
    output: 'single',
  },
  plugins: [
    '@maplibre/maplibre-react-native',
    'expo-status-bar',
    'expo-font',
    'expo-image',
    'expo-secure-store',
    // Push notifications through FCM. The status-bar icon is the wordmark's
    // silhouette (npm run brand:assets); Android tints it with `color`.
    // RECEIVE_BOOT_COMPLETED, which the module requests to re-schedule local
    // notifications after a reboot, stays blocked above: DASH schedules none,
    // and FCM delivery does not need it.
    [
      'expo-notifications',
      {
        icon: './assets/brand/notification-icon.png',
        color: '#A67834',
        defaultChannel: 'orders',
      },
    ],
    [
      'expo-splash-screen',
      {
        image: './assets/brand/splash-icon.png',
        imageWidth: SPLASH_MARK_WIDTH_DP,
        resizeMode: 'contain',
        backgroundColor: BRAND_GROUND,
      },
    ],
    [
      'expo-location',
      {
        locationWhenInUsePermission:
          'DASH uses your location to show sellers near you and, for riders, to offer deliveries you can reach.',
        isAndroidBackgroundLocationEnabled: false,
      },
    ],
    // Signs release builds with the Play upload key when DASH_UPLOAD_* is set
    // in the build environment; see docs/release/SIGNING.md.
    './plugins/withReleaseSigning',
  ],
  extra: {
    variant,
    // The API the app talks to. Never defaulted to localhost: on a phone that
    // is the phone. Missing (outside production) means the app says it is not
    // connected; it has no fixtures to fall back on.
    apiUrl: release.apiUrl,
    mapStyleUrl: release.mapStyleUrl,
  },
});
