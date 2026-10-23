import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { resolveIosPushConfig, assertIosBuildInputs } = require('./iosReleaseConfig') as {
  resolveIosPushConfig: (variant: string, env: Record<string, string>, bundle: string) => { file: string; apnsEnvironment: string } | null;
  assertIosBuildInputs: (variant: string, release: { apiUrl: string | null; mapStyleUrl: string }, source: string) => void;
};
const plist = require('@expo/plist').default;
const dir = mkdtempSync(join(tmpdir(), 'dash-ios-config-'));
// Synthetic parser input only. Never bundled or used to initialize Firebase.
const fixture = (bundle = 'com.dashworldng.dash.staging', overrides = {}) => {
  const path = join(dir, `client-${Math.random()}.plist`);
  writeFileSync(path, plist.build({ BUNDLE_ID: bundle, PROJECT_ID: 'parser-test', GOOGLE_APP_ID: '1:123:ios:abc', GCM_SENDER_ID: '123', ...overrides }));
  return path;
};
describe('iOS Firebase environment isolation', () => {
  it.each(['development', 'staging', 'production'])('%s generates without owner Firebase material', variant => expect(resolveIosPushConfig(variant, {}, 'unused')).toBeNull());
  it('strict release verification stops at the real missing owner artifact', () => expect(() => resolveIosPushConfig('production', { DASH_REQUIRE_IOS_PUSH: '1' }, 'x')).toThrow('GOOGLE_SERVICE_INFO_PLIST'));
  it.each(['development', 'staging', 'production'])('accepts only the exact %s bundle', variant => {
    const bundle = `com.dashworldng.dash${variant === 'production' ? '' : variant === 'staging' ? '.staging' : '.dev'}`;
    const file = fixture(bundle);
    expect(resolveIosPushConfig(variant, { GOOGLE_SERVICE_INFO_PLIST: file, FIREBASE_PROJECT_ID: 'parser-test' }, bundle)?.file).toBe(file);
  });
  it('rejects a staging Apple client for production', () => expect(() => resolveIosPushConfig('production', { GOOGLE_SERVICE_INFO_PLIST: fixture(), FIREBASE_PROJECT_ID: 'parser-test' }, 'com.dashworldng.dash')).toThrow('BUNDLE_ID'));
  it.each(['', 'wrong-project'])('requires explicit matching project %s', project => expect(() => resolveIosPushConfig('staging', { GOOGLE_SERVICE_INFO_PLIST: fixture(), FIREBASE_PROJECT_ID: project }, 'com.dashworldng.dash.staging')).toThrow('FIREBASE_PROJECT_ID'));
  it('rejects malformed client data without printing its contents', () => expect(() => resolveIosPushConfig('staging', { GOOGLE_SERVICE_INFO_PLIST: fixture(undefined, { GOOGLE_APP_ID: 'private-input' }), FIREBASE_PROJECT_ID: 'parser-test' }, 'com.dashworldng.dash.staging')).toThrow('GOOGLE_APP_ID'));
  it('rejects missing files', () => expect(() => resolveIosPushConfig('staging', { GOOGLE_SERVICE_INFO_PLIST: join(dir, 'absent') }, 'x')).toThrow('readable XML'));
  it('requires production APNs for a production binary', () => expect(() => resolveIosPushConfig('production', { GOOGLE_SERVICE_INFO_PLIST: fixture('com.dashworldng.dash'), FIREBASE_PROJECT_ID: 'parser-test', DASH_APNS_ENVIRONMENT: 'development' }, 'com.dashworldng.dash')).toThrow('production APNs'));
  it('allows staging TestFlight to use production APNs', () => expect(resolveIosPushConfig('staging', { GOOGLE_SERVICE_INFO_PLIST: fixture(), FIREBASE_PROJECT_ID: 'parser-test', DASH_APNS_ENVIRONMENT: 'production' }, 'com.dashworldng.dash.staging')?.apnsEnvironment).toBe('production'));
});

describe('iOS compiled release input isolation', () => {
  const release = { apiUrl: 'https://api.dashworldng.com', mapStyleUrl: 'https://maps.dashworldng.com/style.json' };
  it.each(['null', '"https://api.dashworldng.com"'])('accepts unbaked or matching origin %s', value => expect(() => assertIosBuildInputs('production', release, `export const COMPILED_API_URL: string | null = ${value};`)).not.toThrow());
  it('rejects the previous staging CI workspace origin before native generation', () => expect(() => assertIosBuildInputs('production', release, 'export const COMPILED_API_URL: string | null = "https://staging.dashworldng.com";')).toThrow('compiled API origin differs'));
  it('rejects an unreadable compiled origin contract', () => expect(() => assertIosBuildInputs('production', release, 'unknown')).toThrow('Cannot verify'));
  it('rejects staging map configuration', () => expect(() => assertIosBuildInputs('production', { ...release, mapStyleUrl: 'https://maps.staging.dashworldng.com/style.json' }, 'export const COMPILED_API_URL: string | null = null;')).toThrow('production public host'));
});
