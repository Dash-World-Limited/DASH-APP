import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const releaseCheck = process.argv.includes('--release');
const mobile = fileURLToPath(new URL('../', import.meta.url));
const cli = resolve(dirname(require.resolve('expo/package.json')), 'bin/cli');
// Evaluate the real Expo plugins, including their resulting Info.plist mods.
// This can run on Windows without pretending that an Xcode project was built.
const config = JSON.parse(execFileSync(process.execPath, [cli, 'config', '--type', 'introspect', '--json'], {
  cwd: mobile,
  env: { ...process.env, DASH_BUILD_PLATFORM: 'ios', ...(releaseCheck ? { DASH_REQUIRE_IOS_PUSH: '1' } : {}) },
  encoding: 'utf8',
  maxBuffer: 10 * 1024 * 1024,
}));
const plist = config._internal?.modResults?.ios?.infoPlist;
assert.ok(plist, 'Expo did not evaluate the iOS Info.plist mods');
const suffix = { development: '.dev', staging: '.staging', production: '' }[config.extra.variant];
assert.notEqual(suffix, undefined, 'Unknown build variant');
assert.equal(config.ios.bundleIdentifier, `com.dashworldng.dash${suffix}`);
assert.equal(config.ios.supportsTablet, false);
assert.equal(config.name, { development: 'DASH (dev)', staging: 'DASH (staging)', production: 'DASH' }[config.extra.variant]);
assert.match(config.version, /^\d+\.\d+\.\d+$/);
assert.equal(plist.CFBundleShortVersionString, config.version);
assert.equal(config.ios.buildNumber, String(config.android.versionCode));
assert.equal(plist.CFBundleVersion, config.ios.buildNumber);
assert.ok(plist.CFBundleURLTypes.some(type => type.CFBundleURLSchemes.includes('dash')));
assert.ok(plist.NSLocationWhenInUseUsageDescription.includes('DASH uses your location'));
for (const key of ['NSLocationAlwaysUsageDescription', 'NSLocationAlwaysAndWhenInUseUsageDescription', 'NSMotionUsageDescription', 'NSFaceIDUsageDescription']) {
  assert.equal(plist[key], undefined, `${key} should not be requested by the current app`);
}
assert.ok(!plist.UIBackgroundModes?.includes('location'), 'Background rider tracking has not been implemented');
assert.equal(plist.UILaunchStoryboardName, 'SplashScreen');
assert.equal(plist.UIUserInterfaceStyle, 'Automatic');
if (config.extra.variant === 'production') {
  assert.equal(plist.NSAppTransportSecurity?.NSAllowsArbitraryLoads, false);
  assert.equal(plist.NSAppTransportSecurity?.NSAllowsLocalNetworking, false);
}
for (const asset of [config.icon, config.plugins.find(p => Array.isArray(p) && p[0] === 'expo-splash-screen')?.[1]?.image]) {
  assert.ok(asset, 'Icon and splash must be explicitly configured');
  require('node:fs').accessSync(resolve(mobile, asset));
}
if (config.extra.iosPushConfigured) {
  const entitlements = config._internal.modResults.ios.entitlements;
  assert.ok(['development', 'production'].includes(entitlements['aps-environment']));
  assert.ok(config.ios.googleServicesFile, 'Configured iOS push must use the validated Apple client file');
  if (releaseCheck) assert.equal(entitlements['aps-environment'], 'production', 'TestFlight requires production APNs, including staging builds');
}
if (releaseCheck) assert.equal(config.extra.iosPushConfigured, true, 'Push integration must be configured before declaring a release candidate');
console.log(`iOS configuration verified: ${config.ios.bundleIdentifier}; foreground location, DASH scheme, splash and appearance.`);
