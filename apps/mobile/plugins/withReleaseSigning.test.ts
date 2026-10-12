/**
 * The release-signing plugin writes variable names, never secrets. Outside
 * production it switches to the upload key only when every variable is
 * present; in production there is no fallback at all.
 */

import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { addSigning } = require('./withReleaseSigning.js') as { addSigning: (gradle: string, options?: { production?: boolean }) => string };

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

describe('production release signing', () => {
  const out = addSigning(TEMPLATE, { production: true });
  const release = out.slice(out.indexOf('release {'));

  it('points the release build at the upload key unconditionally', () => {
    // The last signingConfig assignment in the block is the one Gradle uses.
    const assignments = [...release.matchAll(/signingConfig\s+signingConfigs\.(\w+)/g)].map((match) => match[1]);
    expect(assignments.at(-1)).toBe('dashUpload');
    expect(release).not.toMatch(/if \(System\.getenv\('DASH_UPLOAD_STORE_FILE'\) &&[^{]*\{\s*signingConfig/);
  });

  it('stops the build, naming what is missing, instead of falling back to debug signing', () => {
    expect(release).toContain('throw new GradleException');
    expect(release).toContain('Debug signing is never used for production');
    for (const name of ['DASH_UPLOAD_STORE_FILE', 'DASH_UPLOAD_STORE_PASSWORD', 'DASH_UPLOAD_KEY_ALIAS', 'DASH_UPLOAD_KEY_PASSWORD']) {
      expect(release).toContain(`'${name}'`);
    }
  });

  it('refuses a keystore path that is not a file', () => {
    expect(release).toMatch(/file\(System\.getenv\('DASH_UPLOAD_STORE_FILE'\)\)\.isFile\(\)/);
  });

  it('writes no secret value into build.gradle: every credential is read from the environment', () => {
    const block = out.slice(out.indexOf('dashUpload {'), out.indexOf('debug {'));
    for (const field of ['storeFile', 'storePassword', 'keyAlias', 'keyPassword']) {
      expect(block).toMatch(new RegExp(`${field}\\s+(file\\(storeFilePath\\)|System\\.getenv\\()`));
    }
    expect(block).not.toMatch(/(storePassword|keyPassword|keyAlias)\s+['"]/);
  });

  it('leaves the debug build type alone', () => {
    const debug = out.slice(out.indexOf('buildTypes'), out.indexOf('release {'));
    expect(debug).not.toContain('dashUpload');
    expect(debug).not.toContain('GradleException');
  });
});
