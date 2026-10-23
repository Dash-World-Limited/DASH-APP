const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { URL } = require('node:url');
const plist = require('@expo/plist').default;
const { productionApiOrigin } = require('./releaseConfig');

/** A real owner-supplied Apple client, never a generated placeholder. */
function resolveIosPushConfig(variant, env, bundleIdentifier) {
  const raw = env.GOOGLE_SERVICE_INFO_PLIST?.trim();
  if (!raw) {
    if (env.DASH_REQUIRE_IOS_PUSH === '1') throw new Error('GOOGLE_SERVICE_INFO_PLIST is required for iOS push release verification.');
    return null;
  }
  const file = resolve(raw);
  let client;
  try { client = plist.parse(readFileSync(file, 'utf8')); }
  catch { throw new Error('GOOGLE_SERVICE_INFO_PLIST must name a readable XML Apple Firebase client plist.'); }
  if (client.BUNDLE_ID !== bundleIdentifier) throw new Error(`Apple Firebase client BUNDLE_ID must match ${bundleIdentifier}.`);
  const project = env.FIREBASE_PROJECT_ID?.trim();
  if (!project || client.PROJECT_ID !== project) throw new Error('FIREBASE_PROJECT_ID must explicitly match the Apple Firebase client project for this environment.');
  if (typeof client.GOOGLE_APP_ID !== 'string' || !/^1:\d+:ios:[a-f\d]+$/i.test(client.GOOGLE_APP_ID) || typeof client.GCM_SENDER_ID !== 'string' || !/^\d+$/.test(client.GCM_SENDER_ID)) {
    throw new Error('Apple Firebase client must contain a valid GOOGLE_APP_ID and GCM_SENDER_ID.');
  }
  const apnsEnvironment = env.DASH_APNS_ENVIRONMENT?.trim() || (variant === 'production' ? 'production' : 'development');
  if (!['development', 'production'].includes(apnsEnvironment)) throw new Error('DASH_APNS_ENVIRONMENT must be development or production.');
  if (variant === 'production' && apnsEnvironment !== 'production') throw new Error('Production iOS builds require the production APNs environment.');
  return { file, apnsEnvironment };
}

/** CI may bake an origin into buildConfig.ts; a later variant must not inherit it. */
function assertIosBuildInputs(variant, release, source) {
  const match = /export const COMPILED_API_URL:\s*string\s*\|\s*null\s*=\s*(null|"[^"\r\n]*")\s*;/.exec(source);
  if (!match) throw new Error('Cannot verify the compiled API origin in src/api/buildConfig.ts.');
  const compiled = JSON.parse(match[1]);
  if (compiled !== null && compiled !== release.apiUrl) throw new Error('The compiled API origin differs from this iOS variant. Restore buildConfig.ts or compile this variant explicitly.');
  if (variant === 'production') {
    const checked = productionApiOrigin(new URL(release.mapStyleUrl).origin);
    if (checked.error) throw new Error('Production iOS map style must use a production public host.');
  }
}

module.exports = { resolveIosPushConfig, assertIosBuildInputs };
