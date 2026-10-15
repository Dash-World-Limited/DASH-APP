/**
 * Build-time values for the native app, and the rules a production build must
 * meet before it is allowed to exist.
 *
 * Development and staging stay forgiving: a missing version code is 1, a
 * missing map style is OpenFreeMap's street style, and a missing API origin
 * makes an honest "not connected" client. Production is the opposite. Every
 * value that ends up inside a Play upload must be supplied explicitly and must
 * pass the checks here, or `app.config.ts` throws and no native project, no
 * bundle and no AAB can be produced from it. Nothing is defaulted, because a
 * default in a production build is a value nobody chose.
 *
 * Plain CommonJS on purpose: `app.config.ts` loads it through Expo's config
 * loader, and the tests load it with `require`, so it needs no build step.
 */

const { URL } = require('node:url');

const DEFAULT_VERSION_NAME = '0.1.0';
const DEFAULT_MAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
const MAX_VERSION_CODE = 2_100_000_000;
const VERSION_NAME = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
/**
 * Hostname labels that name a non-production environment. Matched as whole
 * labels — split on dots and hyphens — so `api-staging.example.com` is refused
 * and `latest.example.com` is not.
 */
const NON_PRODUCTION_LABELS = new Set(['staging', 'stage', 'stg', 'dev', 'development', 'sandbox', 'test', 'testing', 'qa', 'uat', 'preview']);

/** Hosts that can only ever mean "this machine" or a private network. */
function isPrivateHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (host.includes(':')) {
    // An IPv6 literal: loopback, unique-local (fc00::/7) or link-local.
    return host === '::1' || host === '::' || /^f[cd][0-9a-f]{0,2}:/.test(host) || /^fe[89ab][0-9a-f]?:/.test(host);
  }
  if (host === '0.0.0.0') return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!ipv4) return false;
  const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

/** An https URL on a public host, or a reason it is not. */
function publicHttpsUrl(raw, label) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return { error: `${label} is required for a production build.` };
  let url;
  try {
    url = new URL(value);
  } catch {
    return { error: `${label} is not a valid URL.` };
  }
  if (url.protocol !== 'https:') return { error: `${label} must use https:// in a production build.` };
  if (url.username || url.password) return { error: `${label} must not carry credentials.` };
  if (isPrivateHost(url.hostname)) return { error: `${label} points at a local or private address (${url.hostname}).` };
  return { url };
}

/**
 * The API origin a production build talks to.
 *
 * An origin, not an endpoint: the client appends `/v1/...` itself, so a path,
 * query or fragment here would silently break every request. A hostname that
 * names a non-production environment is refused outright — shipping the
 * staging API to Play is the mistake this whole gate exists to make
 * impossible.
 */
function productionApiOrigin(raw) {
  const checked = publicHttpsUrl(raw, 'EXPO_PUBLIC_API_URL');
  if (checked.error) return checked;
  const { url } = checked;
  if ((url.pathname && url.pathname !== '/') || url.search || url.hash) {
    return { error: 'EXPO_PUBLIC_API_URL must be an origin such as https://api.example.com, with no path, query or fragment.' };
  }
  const labels = url.hostname.toLowerCase().split(/[.-]/);
  const nonProduction = labels.find((label) => NON_PRODUCTION_LABELS.has(label));
  if (nonProduction) {
    return { error: `EXPO_PUBLIC_API_URL looks like a non-production host (${url.hostname}: "${nonProduction}").` };
  }
  return { value: url.origin };
}

function versionCodeFrom(raw, required) {
  if (raw === undefined || String(raw).trim() === '') {
    return required ? { error: 'DASH_VERSION_CODE is required for a production build, and must be higher than every code already uploaded to Play.' } : { value: 1 };
  }
  const text = String(raw).trim();
  const value = Number(text);
  if (!/^\d+$/.test(text) || !Number.isInteger(value) || value < 1 || value > MAX_VERSION_CODE) {
    return { error: `DASH_VERSION_CODE must be a positive integer up to ${MAX_VERSION_CODE} — got "${text}".` };
  }
  return { value };
}

function versionNameFrom(raw, required) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) {
    return required ? { error: 'DASH_VERSION_NAME is required for a production build (MAJOR.MINOR.PATCH, e.g. 1.0.0).' } : { value: DEFAULT_VERSION_NAME };
  }
  if (!VERSION_NAME.test(text)) return { error: `DASH_VERSION_NAME must be MAJOR.MINOR.PATCH — got "${text}".` };
  return { value: text };
}

/**
 * Resolve every release value for `variant` from `env`.
 *
 * Returns the values, or throws one error listing every problem at once, so a
 * misconfigured production build is fixed in one pass rather than one
 * variable per failed run.
 */
function resolveReleaseConfig(variant, env) {
  const production = variant === 'production';
  const problems = [];
  const take = (result) => {
    if (result.error) problems.push(result.error);
    return result.value;
  };

  const versionCode = take(versionCodeFrom(env.DASH_VERSION_CODE, production));
  const versionName = take(versionNameFrom(env.DASH_VERSION_NAME, production));

  let apiUrl;
  let mapStyleUrl;
  if (production) {
    apiUrl = take(productionApiOrigin(env.EXPO_PUBLIC_API_URL));
    const style = publicHttpsUrl(env.EXPO_PUBLIC_MAP_STYLE_URL, 'EXPO_PUBLIC_MAP_STYLE_URL');
    mapStyleUrl = take(style.error ? style : { value: style.url.href });
  } else {
    apiUrl = typeof env.EXPO_PUBLIC_API_URL === 'string' && env.EXPO_PUBLIC_API_URL.trim() ? env.EXPO_PUBLIC_API_URL.trim() : null;
    mapStyleUrl = (typeof env.EXPO_PUBLIC_MAP_STYLE_URL === 'string' && env.EXPO_PUBLIC_MAP_STYLE_URL.trim()) || DEFAULT_MAP_STYLE_URL;
  }

  if (problems.length > 0) {
    throw new Error(`The ${variant} build is not configured:\n  - ${problems.join('\n  - ')}`);
  }
  return { versionCode, versionName, apiUrl, mapStyleUrl };
}

/**
 * Firebase's Android client configuration, `google-services.json`, which the
 * app needs to receive push notifications (FCM).
 *
 * Supplied at build time through `GOOGLE_SERVICES_JSON`, a path to the file
 * downloaded from the Firebase console, and never committed. It is the public
 * client configuration — it ships inside every APK — not the server's
 * credential, which stays on the API host. It must register an Android app
 * for exactly the package being built, or FCM would hand the build no token.
 *
 * Optional for development and staging: a build without it runs, and simply
 * has no push. Required for production, where a store build that cannot be
 * notified is a broken release. Errors name package ids only, never the
 * file's keys.
 */
function resolveGoogleServicesFile(variant, env, packageName) {
  const raw = typeof env.GOOGLE_SERVICES_JSON === 'string' ? env.GOOGLE_SERVICES_JSON.trim() : '';
  if (!raw) {
    if (variant === 'production') {
      throw new Error(
        'The production build is not configured:\n  - GOOGLE_SERVICES_JSON is required: the path to google-services.json from the Firebase console. Without it the app cannot receive push notifications.',
      );
    }
    return null;
  }
  const file = require('node:path').resolve(raw);
  let parsed;
  try {
    parsed = JSON.parse(require('node:fs').readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`GOOGLE_SERVICES_JSON (${raw}) is not a readable JSON file.`);
  }
  const clients = Array.isArray(parsed && parsed.client) ? parsed.client : [];
  const packages = clients
    .map((client) => client && client.client_info && client.client_info.android_client_info && client.client_info.android_client_info.package_name)
    .filter((name) => typeof name === 'string');
  if (!packages.includes(packageName)) {
    throw new Error(
      `google-services.json has no Android app for ${packageName} (it has: ${packages.join(', ') || 'none'}). Add ${packageName} to the Firebase project and download the file again.`,
    );
  }
  return file;
}

module.exports = {
  DEFAULT_MAP_STYLE_URL,
  DEFAULT_VERSION_NAME,
  isPrivateHost,
  productionApiOrigin,
  resolveGoogleServicesFile,
  resolveReleaseConfig,
};
