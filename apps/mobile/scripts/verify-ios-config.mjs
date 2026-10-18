import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const mobile = fileURLToPath(new URL('../', import.meta.url));
const cli = resolve(dirname(require.resolve('expo/package.json')), 'bin/cli');
// Evaluate the real Expo plugins, including their resulting Info.plist mods.
// This can run on Windows without pretending that an Xcode project was built.
const config = JSON.parse(execFileSync(process.execPath, [cli, 'config', '--type', 'introspect', '--json'], {
  cwd: mobile,
  encoding: 'utf8',
  maxBuffer: 10 * 1024 * 1024,
}));
const plist = config._internal?.modResults?.ios?.infoPlist;
assert.ok(plist, 'Expo did not evaluate the iOS Info.plist mods');
const suffix = { development: '.dev', staging: '.staging', production: '' }[config.extra.variant];
assert.notEqual(suffix, undefined, 'Unknown build variant');
assert.equal(config.ios.bundleIdentifier, `com.dashworldng.dash${suffix}`);
assert.equal(config.ios.supportsTablet, false);
assert.ok(plist.CFBundleURLTypes.some(type => type.CFBundleURLSchemes.includes('dash')));
assert.ok(plist.NSLocationWhenInUseUsageDescription.includes('DASH uses your location'));
for (const key of ['NSLocationAlwaysUsageDescription', 'NSLocationAlwaysAndWhenInUseUsageDescription', 'NSMotionUsageDescription', 'NSFaceIDUsageDescription']) {
  assert.equal(plist[key], undefined, `${key} should not be requested by the current app`);
}
assert.ok(!plist.UIBackgroundModes?.includes('location'), 'Background rider tracking has not been implemented');
assert.equal(plist.UILaunchStoryboardName, 'SplashScreen');
assert.equal(plist.UIUserInterfaceStyle, 'Automatic');
console.log(`iOS configuration verified: ${config.ios.bundleIdentifier}; foreground location, DASH scheme, splash and appearance.`);
