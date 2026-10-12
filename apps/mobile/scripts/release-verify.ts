/**
 * Proves a production Android build is the one we mean to ship, from the
 * build's own outputs rather than from the configuration that produced it.
 *
 *     npx tsx apps/mobile/scripts/release-verify.ts \
 *       --bundle index.android.bundle \
 *       --app-config app.config.json \
 *       --manifest AndroidManifest.xml \
 *       --expect-api https://api.example.com \
 *       --forbid-api https://staging-api.example.com \
 *       --package com.dashworldng.dash --version-code 12 --version-name 1.0.0
 *
 * Every input is optional except --bundle; a check runs when its input is
 * given. In CI the three files come out of the signed AAB itself
 * (`base/assets/index.android.bundle`, `base/assets/app.config`, and
 * `bundletool dump manifest`), so what is verified is what Play receives.
 *
 * Exits 1 with every problem listed when anything fails, 0 otherwise. No
 * value checked here is a secret, and none is printed beyond what the build
 * already embeds.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Screen markers only the native v2 app carries. Their absence means some other app was bundled. */
export const V2_MARKERS = ['customer-home-v2', 'rider-home-v2'] as const;

/**
 * Strings that mean a native navigator came back. v2 owns one React root and
 * changes faces by state; the Android crash it fixed was a react-native-screens
 * fragment being re-parented on a face change.
 */
export const NAVIGATOR_MARKERS = ['RNSScreen', 'react-native-screens', 'expo-router', 'ExpoRouter'] as const;

/** Every non-production identifier the app has ever installed under. */
export const NON_PRODUCTION_PACKAGES = ['com.dashworldng.dash.staging', 'com.dashworldng.dash.dev'] as const;

/**
 * Invented businesses, people, places and orders from the fixtures and preview
 * modes the app used to ship. None of them is a real DASH merchant or
 * customer, so none may appear in a production bundle.
 */
export const DEMO_DATA = [
  'Urban Bites',
  "Mama's Kitchen",
  'Mama’s Kitchen',
  'Chop Corner',
  'TechWorld',
  'StyleHub',
  'HomeEssentials',
  'Wellspring Pharmacy',
  'CarePoint Pharmacy',
  'Fresh Basket',
  'Market Square Seller',
  'Second Life Tech',
  'Home Reset Finds',
  'Green Bowl',
  'Grill House',
  'The Daily Kitchen',
  'Emma A.',
  'Chevron Drive',
  'Chevron, Lekki',
  // The fixtures' full branch address. The bare street name is fine: checkout
  // uses it as the placeholder hint in the address field.
  '12 Admiralty Way, Lekki Phase 1',
  'Spicy Chicken Burger',
  'DASH782910',
  'DASH710842',
  'DASH692015',
  'preview-order',
  'preview-offer',
  'preview-delivery',
  'Interactive preview',
  'Interactive development preview',
  'Interactive checkout preview',
  'assets_staging_',
] as const;

/**
 * A URL aimed at this machine or an emulator's host. The bare word
 * "localhost" is not enough: the URL parser polyfill in every React Native
 * bundle contains it as a string it normalises. An origin is what matters.
 */
const LOOPBACK_URL = /\b(?:https?|wss?):\/\/(?:localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|10\.0\.2\.2|10\.0\.3\.2|0\.0\.0\.0|\[::1\])(?=[:/'"`]|$)/i;

/**
 * Permissions a production DASH build may request, each with its reason. A
 * new one fails the build until someone decides it belongs — and declares it
 * in Play's Data Safety form.
 */
export function allowedPermissions(packageName: string): Readonly<Record<string, string>> {
  return {
    'android.permission.INTERNET': 'every API, image and map request',
    'android.permission.ACCESS_NETWORK_STATE': 'expo-image and MapLibre check connectivity before fetching',
    'android.permission.ACCESS_COARSE_LOCATION': 'delivery addresses and a rider’s position while online (foreground only)',
    'android.permission.ACCESS_FINE_LOCATION': 'delivery addresses and a rider’s position while online (foreground only)',
    [`${packageName}.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`]:
      'AndroidX’s own signature permission protecting the app’s non-exported receivers; grants nothing to other apps',
  };
}

export interface BundleExpectations {
  expectApi?: string | null;
  forbidApis?: readonly string[];
}

export function bundleProblems(bundle: string, expected: BundleExpectations = {}): string[] {
  const problems: string[] = [];
  if (!/__DEV__\s*=\s*false/.test(bundle)) problems.push('The bundle is not a release bundle (__DEV__ is not false).');
  for (const marker of V2_MARKERS) {
    if (!bundle.includes(marker)) problems.push(`The bundle does not carry the native v2 marker "${marker}".`);
  }
  for (const marker of NAVIGATOR_MARKERS) {
    if (bundle.includes(marker)) problems.push(`The bundle contains "${marker}": a native navigator is back.`);
  }
  for (const id of NON_PRODUCTION_PACKAGES) {
    if (bundle.includes(id)) problems.push(`The bundle mentions the non-production package "${id}".`);
  }
  for (const text of DEMO_DATA) {
    if (bundle.includes(text)) problems.push(`The bundle contains invented demo data: "${text}".`);
  }
  const loopback = LOOPBACK_URL.exec(bundle);
  if (loopback) problems.push(`The bundle contains a local address: "${loopback[0]}".`);
  if (expected.expectApi && !bundle.includes(expected.expectApi)) {
    problems.push(`The bundle does not contain the production API origin ${expected.expectApi}.`);
  }
  for (const forbidden of expected.forbidApis ?? []) {
    const origin = forbidden.trim().replace(/\/+$/, '');
    if (origin && bundle.includes(origin)) problems.push(`The bundle contains a forbidden API origin: ${origin}.`);
  }
  return problems;
}

export interface ReleaseExpectations {
  packageName?: string;
  versionCode?: number;
  versionName?: string;
  expectApi?: string | null;
}

/**
 * The Expo config embedded in the build (`assets/app.config`), which is what
 * expo-constants hands the app at runtime — the variant and the API origin
 * the running app will actually see.
 */
export function appConfigProblems(raw: string, expected: ReleaseExpectations): string[] {
  let config: {
    version?: unknown;
    android?: { package?: unknown; versionCode?: unknown };
    extra?: { variant?: unknown; apiUrl?: unknown; mapStyleUrl?: unknown };
  };
  try {
    config = JSON.parse(raw);
  } catch {
    return ['The embedded app.config is not valid JSON.'];
  }
  const problems: string[] = [];
  if (config.extra?.variant !== 'production') problems.push(`The embedded app config is variant "${String(config.extra?.variant)}", not production.`);
  if (expected.packageName && config.android?.package !== expected.packageName) {
    problems.push(`The embedded app config names package "${String(config.android?.package)}", not ${expected.packageName}.`);
  }
  if (expected.versionCode !== undefined && config.android?.versionCode !== expected.versionCode) {
    problems.push(`The embedded app config has versionCode ${String(config.android?.versionCode)}, not ${expected.versionCode}.`);
  }
  if (expected.versionName && config.version !== expected.versionName) {
    problems.push(`The embedded app config has version "${String(config.version)}", not ${expected.versionName}.`);
  }
  if (expected.expectApi && config.extra?.apiUrl !== expected.expectApi) {
    problems.push(`The embedded app config points at "${String(config.extra?.apiUrl)}", not ${expected.expectApi}.`);
  }
  if (typeof config.extra?.mapStyleUrl !== 'string' || !config.extra.mapStyleUrl.startsWith('https://')) {
    problems.push('The embedded app config has no https MapLibre style.');
  }
  return problems;
}

const attribute = (xml: string, name: string): string | null => {
  const match = new RegExp(`\\b${name.replace(':', '\\:')}\\s*=\\s*"([^"]*)"`).exec(xml);
  return match?.[1] ?? null;
};

/** `uses-permission` names in a manifest, skipping any marked for removal. */
export function manifestPermissions(xml: string): string[] {
  const names = new Set<string>();
  for (const match of xml.matchAll(/<uses-permission(?:-sdk-23)?\b([^>]*)>/g)) {
    const attrs = match[1] ?? '';
    if (/tools:node\s*=\s*"remove"/.test(attrs)) continue;
    const name = /android:name\s*=\s*"([^"]+)"/.exec(attrs)?.[1];
    if (name) names.add(name);
  }
  return [...names].sort();
}

/**
 * The final merged manifest, as `bundletool dump manifest` prints it: the
 * package, the version, nothing debuggable, no cleartext traffic, and only
 * the permissions this app has a reason for.
 */
export function manifestProblems(xml: string, expected: ReleaseExpectations): string[] {
  const problems: string[] = [];
  const manifestTag = /<manifest\b[^>]*>/.exec(xml)?.[0] ?? '';
  const applicationTag = /<application\b[^>]*>/.exec(xml)?.[0] ?? '';
  const packageName = attribute(manifestTag, 'package');
  if (expected.packageName && packageName !== expected.packageName) {
    problems.push(`The manifest package is "${String(packageName)}", not ${expected.packageName}.`);
  }
  if (expected.versionCode !== undefined && attribute(manifestTag, 'android:versionCode') !== String(expected.versionCode)) {
    problems.push(`The manifest versionCode is "${String(attribute(manifestTag, 'android:versionCode'))}", not ${expected.versionCode}.`);
  }
  if (expected.versionName && attribute(manifestTag, 'android:versionName') !== expected.versionName) {
    problems.push(`The manifest versionName is "${String(attribute(manifestTag, 'android:versionName'))}", not ${expected.versionName}.`);
  }
  if (attribute(applicationTag, 'android:debuggable') === 'true') problems.push('The manifest is debuggable.');
  if (attribute(applicationTag, 'android:usesCleartextTraffic') === 'true') problems.push('The manifest allows cleartext (http) traffic.');

  const allowed = allowedPermissions(packageName ?? expected.packageName ?? '');
  for (const permission of manifestPermissions(xml)) {
    if (!(permission in allowed)) problems.push(`The manifest requests an unreviewed permission: ${permission}.`);
  }
  return problems;
}

function argument(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function main(args: readonly string[]): number {
  const bundlePath = argument(args, '--bundle');
  if (!bundlePath) {
    console.error('release-verify: --bundle is required.');
    return 2;
  }
  const versionCodeText = argument(args, '--version-code');
  const expected: ReleaseExpectations & BundleExpectations = {
    packageName: argument(args, '--package'),
    versionCode: versionCodeText === undefined ? undefined : Number(versionCodeText),
    versionName: argument(args, '--version-name'),
    expectApi: argument(args, '--expect-api')?.replace(/\/+$/, '') ?? null,
    forbidApis: args.flatMap((value, index) => (args[index - 1] === '--forbid-api' && value ? [value] : [])),
  };

  const problems = bundleProblems(readFileSync(bundlePath, 'utf8'), expected);
  const appConfigPath = argument(args, '--app-config');
  if (appConfigPath) problems.push(...appConfigProblems(readFileSync(appConfigPath, 'utf8'), expected));
  const manifestPath = argument(args, '--manifest');
  if (manifestPath) {
    const xml = readFileSync(manifestPath, 'utf8');
    problems.push(...manifestProblems(xml, expected));
    process.stdout.write(`Permissions requested: ${manifestPermissions(xml).join(', ') || '(none)'}\n`);
  }

  if (problems.length > 0) {
    console.error(`Release verification failed:\n  - ${problems.join('\n  - ')}`);
    return 1;
  }
  const checked = ['bundle', appConfigPath ? 'embedded app config' : null, manifestPath ? 'merged manifest' : null].filter(Boolean);
  process.stdout.write(`Release verification passed (${checked.join(', ')}).\n`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv.slice(2)));
}
