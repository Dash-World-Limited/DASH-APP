/**
 * The checks the production workflow runs on the AAB's own contents. Each is
 * shown passing on a clean input and failing on the specific defect it exists
 * to catch.
 */

import { describe, expect, it } from 'vitest';

import { appConfigProblems, bundleProblems, manifestPermissions, manifestProblems } from './release-verify';

const API = 'https://api.dashworldng.com';
const CLEAN_BUNDLE = `var __DEV__=false;testID:"customer-home-v2";testID:"rider-home-v2";const COMPILED_API_URL="${API}";
  /* the URL parser polyfill every bundle carries */ ("localhost"===n&&(n=""));`;

describe('bundleProblems', () => {
  it('accepts a release v2 bundle with the production API', () => {
    expect(bundleProblems(CLEAN_BUNDLE, { expectApi: API })).toEqual([]);
  });

  it('does not mistake the bare word "localhost" for a local address', () => {
    expect(bundleProblems(CLEAN_BUNDLE)).toEqual([]);
  });

  it.each([
    ['a development bundle', CLEAN_BUNDLE.replace('__DEV__=false', '__DEV__=true'), /release bundle/],
    ['a bundle that is not v2', CLEAN_BUNDLE.replace('rider-home-v2', 'rider-home'), /native v2 marker "rider-home-v2"/],
    ['react-native-screens', `${CLEAN_BUNDLE}RNSScreen`, /RNSScreen/],
    ['Expo Router', `${CLEAN_BUNDLE}require("expo-router")`, /expo-router/],
    ['a staging package id', `${CLEAN_BUNDLE}"com.dashworldng.dash.staging"`, /non-production package/],
    ['a localhost API', `${CLEAN_BUNDLE}"http://localhost:4000"`, /local address/],
    ['the Android emulator host', `${CLEAN_BUNDLE}"http://10.0.2.2:4000/v1"`, /local address/],
    ['an invented merchant', `${CLEAN_BUNDLE}"Urban Bites"`, /demo data: "Urban Bites"/],
    ['an invented order', `${CLEAN_BUNDLE}code:"DASH782910"`, /demo data: "DASH782910"/],
    ['a staging image', `${CLEAN_BUNDLE}"assets_staging_customer_avatar"`, /demo data: "assets_staging_"/],
  ])('refuses %s', (_label, bundle, reason) => {
    expect(bundleProblems(bundle, { expectApi: API }).join('\n')).toMatch(reason);
  });

  it('refuses a bundle without the production API origin', () => {
    expect(bundleProblems(CLEAN_BUNDLE, { expectApi: 'https://api.other.example' }).join('\n')).toMatch(/does not contain the production API origin/);
  });

  it('refuses a bundle carrying the staging API origin', () => {
    const bundle = `${CLEAN_BUNDLE}"https://staging-api.dashworldng.com"`;
    expect(bundleProblems(bundle, { expectApi: API, forbidApis: ['https://staging-api.dashworldng.com/'] }).join('\n')).toMatch(/forbidden API origin/);
  });

  it('accepts the address field’s placeholder street, which is not stored data', () => {
    expect(bundleProblems(`${CLEAN_BUNDLE}'12 Admiralty Way'`, { expectApi: API })).toEqual([]);
  });
});

const APP_CONFIG = JSON.stringify({
  version: '1.0.0',
  android: { package: 'com.dashworldng.dash', versionCode: 12 },
  extra: { variant: 'production', apiUrl: API, mapStyleUrl: 'https://maps.dashworldng.com/style.json' },
});
const EXPECTED = { packageName: 'com.dashworldng.dash', versionCode: 12, versionName: '1.0.0', expectApi: API };

describe('appConfigProblems', () => {
  it('accepts the production config', () => {
    expect(appConfigProblems(APP_CONFIG, EXPECTED)).toEqual([]);
  });

  it('refuses a staging config, a wrong version and a missing style', () => {
    const staging = JSON.stringify({
      version: '0.1.0',
      android: { package: 'com.dashworldng.dash.staging', versionCode: 1 },
      extra: { variant: 'staging', apiUrl: 'https://staging.example', mapStyleUrl: null },
    });
    const problems = appConfigProblems(staging, EXPECTED).join('\n');
    for (const reason of [/variant "staging"/, /package/, /versionCode 1/, /version "0\.1\.0"/, /points at/, /MapLibre style/]) {
      expect(problems).toMatch(reason);
    }
  });

  it('refuses something that is not JSON', () => {
    expect(appConfigProblems('nope', EXPECTED)).toEqual(['The embedded app.config is not valid JSON.']);
  });
});

const manifest = (permissions: string[], application = '') => `<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="com.dashworldng.dash" android:versionCode="12" android:versionName="1.0.0">
  ${permissions.map((name) => `<uses-permission android:name="${name}"/>`).join('\n  ')}
  <application android:label="DASH" ${application}></application>
</manifest>`;

const ALLOWED = [
  'android.permission.INTERNET',
  'android.permission.ACCESS_NETWORK_STATE',
  'android.permission.ACCESS_COARSE_LOCATION',
  'android.permission.ACCESS_FINE_LOCATION',
  // Push notifications (expo-notifications and Firebase Cloud Messaging).
  'android.permission.POST_NOTIFICATIONS',
  'android.permission.WAKE_LOCK',
  'com.google.android.c2dm.permission.RECEIVE',
  'com.dashworldng.dash.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION',
];

describe('manifestProblems', () => {
  it('accepts the reviewed permissions', () => {
    expect(manifestProblems(manifest(ALLOWED), EXPECTED)).toEqual([]);
  });

  it.each([
    'android.permission.ACCESS_BACKGROUND_LOCATION',
    'android.permission.SYSTEM_ALERT_WINDOW',
    'android.permission.RECORD_AUDIO',
    'android.permission.CAMERA',
    'android.permission.READ_EXTERNAL_STORAGE',
    // Blocked in app.config.ts: DASH schedules no local notifications and
    // nothing vibrates on its own.
    'android.permission.RECEIVE_BOOT_COMPLETED',
    'android.permission.VIBRATE',
    // Advertising id, which Firebase Analytics would add; DASH does not use it.
    'com.google.android.gms.permission.AD_ID',
    'com.dashworldng.dash.staging.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION',
  ])('refuses the unreviewed permission %s', (permission) => {
    expect(manifestProblems(manifest([...ALLOWED, permission]), EXPECTED).join('\n')).toContain(`unreviewed permission: ${permission}`);
  });

  it('ignores a permission the manifest removes', () => {
    const xml = manifest(ALLOWED).replace(
      '<application',
      '<uses-permission android:name="android.permission.SYSTEM_ALERT_WINDOW" tools:node="remove"/>\n  <application',
    );
    expect(manifestPermissions(xml)).not.toContain('android.permission.SYSTEM_ALERT_WINDOW');
    expect(manifestProblems(xml, EXPECTED)).toEqual([]);
  });

  it('refuses a debuggable build and cleartext traffic', () => {
    const problems = manifestProblems(manifest(ALLOWED, 'android:debuggable="true" android:usesCleartextTraffic="true"'), EXPECTED).join('\n');
    expect(problems).toMatch(/debuggable/);
    expect(problems).toMatch(/cleartext/);
  });

  it('refuses the wrong package or version', () => {
    const xml = manifest(ALLOWED).replace('package="com.dashworldng.dash"', 'package="com.dashworldng.dash.staging"').replace('"12"', '"11"');
    const problems = manifestProblems(xml, EXPECTED).join('\n');
    expect(problems).toMatch(/package is "com\.dashworldng\.dash\.staging"/);
    expect(problems).toMatch(/versionCode is "11"/);
  });
});
