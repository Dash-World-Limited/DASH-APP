/**
 * The production gate. Every value that ends up in a Play upload must be
 * supplied and must pass; development and staging keep their defaults so
 * device testing needs no ceremony.
 */

import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { resolveReleaseConfig, isPrivateHost, productionApiOrigin, DEFAULT_MAP_STYLE_URL } = require('./releaseConfig.js') as {
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
