import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
const require = createRequire(import.meta.url);
afterEach(() => vi.unstubAllEnvs());
function config(file: string) {
  vi.stubEnv('GOOGLE_SERVICE_INFO_PLIST', file);
  delete require.cache[require.resolve('../react-native.config.js')];
  return require('../react-native.config.js');
}
describe('iOS FCM native dependency isolation', () => {
  it.each(['', '/owner-supplied/client.plist'])('never changes Android autolinking (file=%s)', file => {
    for (const dependency of Object.values(config(file).dependencies) as { platforms: { android: unknown } }[]) expect(dependency.platforms.android).toBeNull();
  });
  it('keeps the credential-free iOS native baseline free of Firebase pods', () => {
    for (const dependency of Object.values(config('').dependencies) as { platforms: { ios: unknown } }[]) expect(dependency.platforms.ios).toBeNull();
  });
  it('lets the iOS SDK autolink when an owner client is supplied (validated separately by app config)', () => {
    for (const dependency of Object.values(config('/owner-supplied/client.plist').dependencies) as { platforms: { ios?: unknown } }[]) expect(dependency.platforms).not.toHaveProperty('ios');
  });
});
