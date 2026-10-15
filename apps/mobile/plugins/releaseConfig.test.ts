/**
 * The production gate. Every value that ends up in a Play upload must be
 * supplied and must pass; development and staging keep their defaults so
 * device testing needs no ceremony.
 */

import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { resolveReleaseConfig, resolveGoogleServicesFile, isPrivateHost, productionApiOrigin, DEFAULT_MAP_STYLE_URL } = require('./releaseConfig.js') as {
  resolveGoogleServicesFile: (variant: string, env: Record<string, string | undefined>, packageName: string) => string | null;
  resolveReleaseConfig: (
    variant: string,
    env: Record<string, string | undefined>,
  ) => { versionCode: number; versionName: string; apiUrl: string | null; mapStyleUrl: string };
  isPrivateHost: (hostname: string) => boolean;
  productionApiOrigin: (raw: unknown) => { value?: string; error?: string };
  DEFAULT_MAP_STYLE_URL: string;
};

const PRODUCTION = {
  EXPO_PUBLIC_API_URL: 'https://api.dashworldng.com',
  EXPO_PUBLIC_MAP_STYLE_URL: 'https://maps.dashworldng.com/styles/dash.json',
  DASH_VERSION_CODE: '12',
  DASH_VERSION_NAME: '1.0.0',
};

describe('production release configuration', () => {
  it('resolves a complete, valid configuration', () => {
    expect(resolveReleaseConfig('production', PRODUCTION)).toEqual({
      versionCode: 12,
      versionName: '1.0.0',
      apiUrl: 'https://api.dashworldng.com',
      mapStyleUrl: 'https://maps.dashworldng.com/styles/dash.json',
    });
  });

  it('normalises the API origin and drops a trailing slash', () => {
    expect(resolveReleaseConfig('production', { ...PRODUCTION, EXPO_PUBLIC_API_URL: ' https://api.dashworldng.com/ ' }).apiUrl).toBe(
      'https://api.dashworldng.com',
    );
  });

  it('refuses to default anything, and names every missing value at once', () => {
    let message = '';
    try {
      resolveReleaseConfig('production', {});
    } catch (error) {
      message = (error as Error).message;
    }
    for (const name of ['DASH_VERSION_CODE', 'DASH_VERSION_NAME', 'EXPO_PUBLIC_API_URL', 'EXPO_PUBLIC_MAP_STYLE_URL']) {
      expect(message).toContain(name);
    }
  });

  it.each([
    ['http://api.dashworldng.com', /https/],
    ['https://localhost:4000', /local or private/],
    ['https://10.0.2.2', /local or private/],
    ['https://192.168.1.20', /local or private/],
    ['https://api-staging.dashworldng.com', /non-production/],
    ['https://staging.api.dashworldng.com', /non-production/],
    ['https://dev.dashworldng.com', /non-production/],
    ['https://api.dashworldng.com/v1', /origin/],
    ['https://api.dashworldng.com?x=1', /origin/],
    ['https://user:secret@api.dashworldng.com', /credentials/],
    ['not a url', /valid URL/],
  ])('refuses the API origin %s', (url, reason) => {
    expect(() => resolveReleaseConfig('production', { ...PRODUCTION, EXPO_PUBLIC_API_URL: url })).toThrow(reason);
  });

  it('does not mistake an ordinary word for an environment name', () => {
    expect(productionApiOrigin('https://latest.dashworldng.com').value).toBe('https://latest.dashworldng.com');
    expect(productionApiOrigin('https://contest-api.dashworldng.com').value).toBe('https://contest-api.dashworldng.com');
  });

  it('requires an https map style on a public host', () => {
    expect(() => resolveReleaseConfig('production', { ...PRODUCTION, EXPO_PUBLIC_MAP_STYLE_URL: 'http://tiles.example.com/style.json' })).toThrow(
      /EXPO_PUBLIC_MAP_STYLE_URL must use https/,
    );
    expect(() => resolveReleaseConfig('production', { ...PRODUCTION, EXPO_PUBLIC_MAP_STYLE_URL: undefined })).toThrow(
      /EXPO_PUBLIC_MAP_STYLE_URL is required/,
    );
  });

  it.each(['0', '-1', '1.5', '12a', '2100000001'])('refuses the version code %s', (code) => {
    expect(() => resolveReleaseConfig('production', { ...PRODUCTION, DASH_VERSION_CODE: code })).toThrow(/DASH_VERSION_CODE/);
  });

  it.each(['1.0', 'v1.0.0', '1.0.0-beta', '01.0.0'])('refuses the version name %s', (name) => {
    expect(() => resolveReleaseConfig('production', { ...PRODUCTION, DASH_VERSION_NAME: name })).toThrow(/DASH_VERSION_NAME/);
  });
});

describe('development and staging', () => {
  it('keep their defaults so a device build needs no ceremony', () => {
    expect(resolveReleaseConfig('staging', {})).toEqual({
      versionCode: 1,
      versionName: '0.1.0',
      apiUrl: null,
      mapStyleUrl: DEFAULT_MAP_STYLE_URL,
    });
  });

  it('still reject a malformed version code', () => {
    expect(() => resolveReleaseConfig('staging', { DASH_VERSION_CODE: 'abc' })).toThrow(/DASH_VERSION_CODE/);
  });
});

describe('private hosts', () => {
  it.each(['localhost', 'api.localhost', 'printer.local', '127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.0.10', '169.254.1.1', '100.64.0.1', '::1', 'fd00::1', 'fe80::1'])(
    'treats %s as private',
    (host) => expect(isPrivateHost(host)).toBe(true),
  );

  it.each(['api.dashworldng.com', 'fcbank.com', 'fdic.gov', '172.32.0.1', '8.8.8.8'])('treats %s as public', (host) => {
    expect(isPrivateHost(host)).toBe(false);
  });
});

describe('Firebase client configuration for push', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dash-gservices-'));
  const file = (name: string, packages: string[]) => {
    const path = join(dir, name);
    writeFileSync(
      path,
      JSON.stringify({
        project_info: { project_id: 'dash-test' },
        client: packages.map((package_name) => ({ client_info: { android_client_info: { package_name } }, api_key: [{ current_key: 'AIza-not-a-real-key' }] })),
      }),
    );
    return path;
  };

  it('is required for production, and optional for development and staging', () => {
    expect(() => resolveGoogleServicesFile('production', {}, 'com.dashworldng.dash')).toThrow(/GOOGLE_SERVICES_JSON is required/);
    expect(resolveGoogleServicesFile('staging', {}, 'com.dashworldng.dash.staging')).toBeNull();
    expect(resolveGoogleServicesFile('development', { GOOGLE_SERVICES_JSON: '  ' }, 'com.dashworldng.dash.dev')).toBeNull();
  });

  it('must register the package being built', () => {
    const all = file('all.json', ['com.dashworldng.dash', 'com.dashworldng.dash.staging']);
    expect(resolveGoogleServicesFile('production', { GOOGLE_SERVICES_JSON: all }, 'com.dashworldng.dash')).toBe(all);
    expect(resolveGoogleServicesFile('staging', { GOOGLE_SERVICES_JSON: all }, 'com.dashworldng.dash.staging')).toBe(all);

    const stagingOnly = file('staging.json', ['com.dashworldng.dash.staging']);
    expect(() => resolveGoogleServicesFile('production', { GOOGLE_SERVICES_JSON: stagingOnly }, 'com.dashworldng.dash')).toThrow(
      /no Android app for com\.dashworldng\.dash \(it has: com\.dashworldng\.dash\.staging\)/,
    );
  });

  it('refuses a missing or unreadable file, and never repeats the file’s keys', () => {
    expect(() => resolveGoogleServicesFile('staging', { GOOGLE_SERVICES_JSON: join(dir, 'absent.json') }, 'x')).toThrow(/not a readable JSON file/);
    const broken = join(dir, 'broken.json');
    writeFileSync(broken, '{ not json');
    expect(() => resolveGoogleServicesFile('staging', { GOOGLE_SERVICES_JSON: broken }, 'x')).toThrow(/not a readable JSON file/);

    let message = '';
    try {
      resolveGoogleServicesFile('production', { GOOGLE_SERVICES_JSON: file('other.json', ['com.example.other']) }, 'com.dashworldng.dash');
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toContain('AIza');
  });
});
