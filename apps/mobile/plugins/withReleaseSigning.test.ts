/**
 * The release-signing plugin writes variable names, never secrets, and only
 * switches signing when every variable is present.
 */

import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { addSigning } = require('./withReleaseSigning.js') as { addSigning: (gradle: string) => string };

const TEMPLATE = `android {
    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            signingConfig signingConfigs.debug
            minifyEnabled enableMinifyInReleaseBuilds
        }
    }
}`;

describe('release signing', () => {
  const out = addSigning(TEMPLATE);

  it('adds an upload signing config that reads only environment variables', () => {
    expect(out).toContain('dashUpload {');
    for (const name of ['DASH_UPLOAD_STORE_FILE', 'DASH_UPLOAD_STORE_PASSWORD', 'DASH_UPLOAD_KEY_ALIAS', 'DASH_UPLOAD_KEY_PASSWORD']) {
      expect(out).toContain(`System.getenv('${name}')`);
    }
  });

  it('selects it for release only when every variable is set', () => {
    const release = out.slice(out.indexOf('release {'));
    expect(release).toMatch(/if \(System\.getenv\('DASH_UPLOAD_STORE_FILE'\) && .*DASH_UPLOAD_KEY_PASSWORD'\)\) \{\s*signingConfig signingConfigs\.dashUpload/);
    // The debug build type is untouched.
    const debug = out.slice(out.indexOf('buildTypes'), out.indexOf('release {'));
    expect(debug).not.toContain('dashUpload');
  });

  it('is idempotent', () => {
    expect(addSigning(out)).toBe(out);
  });

  it('refuses a build.gradle it does not recognise, rather than signing nothing silently', () => {
    expect(() => addSigning('android { }')).toThrow();
  });
});
