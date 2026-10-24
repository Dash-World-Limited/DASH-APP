/**
 * Write `capacitor.config.json` for an internal Android test build.
 *
 * ## Why a WebView shell rather than a native rewrite
 *
 * The product is the Next.js client in `apps/web`, and it is the thing under
 * test. Rebuilding those screens natively would be a second application
 * wearing the same name: every projection rule, every realtime subscription,
 * and all of the session handling would have a second implementation free to
 * disagree with the first. A shell keeps exactly one client.
 *
 * ## Why it loads from a server instead of bundling the pages
 *
 * Capacitor normally ships a static export inside the APK. This app cannot be
 * exported that way without changing its routing: `/browse/[slug]` and
 * `/orders/[id]` are dynamic segments over ids that only exist at runtime, and
 * Next's static export requires `generateStaticParams` for them. Rewriting
 * those routes to suit the wrapper would be redesigning the product to fit its
 * packaging.
 *
 * So this build points the WebView at the development web server — which a
 * test build needs running anyway, since the API is what it is testing
 * against. The bundled `www/` is not the app: it is the page shown when that
 * server cannot be reached, wired up through `errorPath` so an unreachable
 * backend explains itself instead of showing a browser error.
 *
 * A store build would need the bundled-assets route, and therefore a routing
 * decision. That is deliberately out of scope for a first test APK.
 *
 * ## Host configuration
 *
 * `DASH_MOBILE_HOST` is the development machine's address on the network the
 * phone is joined to. It has no default on purpose: a build that quietly
 * pointed at `localhost` would install fine, resolve to the *phone*, and fail
 * with a network error that says nothing about the cause.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const host = process.env['DASH_MOBILE_HOST'];
if (!host) {
  throw new Error(
    'DASH_MOBILE_HOST is required — set it to the development machine\'s address on the ' +
      'network the phone is joined to, e.g. DASH_MOBILE_HOST=10.0.0.5. ' +
      '"localhost" resolves to the phone itself and cannot work.',
  );
}
if (host === 'localhost' || host.startsWith('127.')) {
  throw new Error(
    `DASH_MOBILE_HOST is "${host}", which on a phone means the phone itself. ` +
      "Use the development machine's address on the shared network.",
  );
}

const webPort = process.env['DASH_MOBILE_WEB_PORT'] ?? '3000';
const apiPort = process.env['DASH_MOBILE_API_PORT'] ?? '4000';
const serverUrl = `http://${host}:${webPort}`;

const config = {
  appId: 'ng.dashapp.test',
  appName: 'DASH APP (test)',
  webDir: 'www',
  server: {
    // `url` is what gets the Capacitor bridge onto the remote page.
    //
    // This was removed in favour of `allowNavigation` so the app could boot
    // from a bundled launcher and never show a blank screen. That worked for
    // the blank screen and silently broke something more important: the web
    // client stopped being able to tell it was running inside the shell, so it
    // fell back to `navigator.geolocation`, which Chromium refuses outright on
    // an insecure origin. The rider could never report a position.
    //
    // The mechanism, from Capacitor's own source:
    //
    //   allowNavigation -> authorities.addAll(appAllowNavigationConfig)
    //                      registers "<host>"        (no port)
    //   server.url      -> authorities.add(url.getAuthority())
    //                      registers "<host>:<port>" (with port)
    //
    // `WebViewLocalServer.register()` hands that straight to
    // `UriMatcher.addURI(scheme, authority, path, handler)`, and a UriMatcher
    // compares the authority exactly — port included. Without the port the
    // request never matches, `shouldInterceptRequest` returns null, and
    // `handleProxyRequest` — the only place `jsInjector` runs — is skipped.
    // No injection means no `window.Capacitor` on the page.
    url: serverUrl,

    // Kept alongside: it costs nothing and registers the bare host too.
    allowNavigation: [host],

    // The bundled launcher doubles as the error page. `getErrorUrl()` builds
    // `scheme://hostname/errorPath`, so with an http scheme it resolves to
    // http://localhost/index.html — an authority that IS registered, served
    // from the APK. The launcher probes the server before redirecting, so an
    // unreachable backend lands on its error state rather than a blank screen
    // or a redirect loop.
    androidScheme: 'http',
    errorPath: 'index.html',
  },
};

writeFileSync(join(root, 'capacitor.config.json'), `${JSON.stringify(config, null, 2)}\n`);

// Readable from the fallback page, so a tester can see which host the build
// was pointed at without unpacking the APK.
mkdirSync(join(root, 'www'), { recursive: true });
writeFileSync(
  join(root, 'www', 'target.json'),
  `${JSON.stringify({ serverUrl, apiUrl: `http://${host}:${apiPort}`, builtAt: new Date().toISOString() }, null, 2)}\n`,
);

console.warn(`capacitor.config.json written — WebView target ${serverUrl}`);
console.warn(`the web client must be built with NEXT_PUBLIC_API_URL=http://${host}:${apiPort}`);
