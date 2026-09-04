# DASH APP — Android test shell

An internal debug APK for testing DASH APP on a real handset. **Not a release
artefact, not a store build.** Debug-signed, pointed at a development machine.

## What this is, and what it is not

The product is the Next.js client in `apps/web`. This wraps it in a WebView so
it can be installed on a phone. It is deliberately thin: rebuilding those
screens natively would create a second client, and every field-projection rule
and realtime subscription would then have two implementations free to disagree.

**The APK does not contain the app.** It points the WebView at the development
web server over the network. The assets bundled in `www/` are only the page
shown when that server cannot be reached, wired through Capacitor's `errorPath`
so an unreachable backend explains itself instead of showing a browser error.

The reason is `output: 'export'`: `/browse/[slug]` and `/orders/[id]` are
dynamic segments over ids that exist only at runtime, and a static export
demands `generateStaticParams` for them. Rewriting the product's routing to
suit its packaging was not the right trade for a first test build. **A store
build needs that decision made** — see "Not yet done" below.

## Prerequisites

- Android Studio (ships the JDK the build uses) with an SDK containing
  build-tools and a platform ≥ 36
- The phone and the development machine on the **same Wi-Fi**
- The machine's address on that network (`ipconfig` / `ip addr`)

## Build

```bash
DASH_MOBILE_HOST=<machine-lan-ip> npm run apk:debug --workspace @dash/mobile
```

`DASH_MOBILE_HOST` has no default and the build refuses `localhost` and
`127.*`. On a phone those mean *the phone*, and a build pointed there installs
perfectly and then fails with a network error that says nothing about why.

Output:

```
apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

## Run the backend so the phone can reach it

Three settings, all of which default to loopback and none of which work from a
handset:

```bash
# apps/web/.env.local — the client must call the API by network address
NEXT_PUBLIC_API_URL=http://<machine-lan-ip>:4000
```

```bash
# .env — bind beyond loopback, and put the device origin in the allowlist
API_HOST=0.0.0.0
PUBLIC_WEB_URL=http://<machine-lan-ip>:3000
PUBLIC_API_URL=http://<machine-lan-ip>:4000
```

`PUBLIC_WEB_URL` is what admits the device origin to CORS and to the realtime
socket's origin check. Both allowlists derive from it, so **no security code is
relaxed to let a phone in** — `localhost` and `127.0.0.1` stay allowed
alongside it, so browser testing is unaffected.

Then `npm run dev` and install:

```bash
adb install -r apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

Or copy the APK to the phone and open it (allow "install unknown apps").

## Security posture

- **Cleartext is not switched on globally.** Capacitor's `cleartext: true` sets
  `usesCleartextTraffic` for every destination. Instead
  `res/xml/network_security_config.xml` is generated per build with
  `cleartextTrafficPermitted="false"` as the base and a single domain exception
  for `DASH_MOBILE_HOST`. Every other host still requires TLS. That file is
  regenerated on each build so the permitted host cannot drift from the host
  the WebView targets.
- **Permissions:** `INTERNET` only.
- **Application id** is `ng.dashapp.test`, distinct from any production id, so
  a test build cannot be mistaken for or upgrade over a real one.
- The APK carries no credentials. Sessions are established by signing in, and
  the refresh token remains an `HttpOnly` cookie exactly as on the web.
- Cookies are host-scoped, so the web client and the API must be reached by the
  **same host** — `http://<ip>:3000` and `http://<ip>:4000`. Mixing `localhost`
  and `127.0.0.1` silently drops the session.

## Not yet done

- **No release build.** Debug signing only; no keystore, no minification, no
  Play submission.
- **No offline capability.** The shell needs the dev server reachable. Making
  the app work standalone requires resolving the static-export routing
  question above.
- **HTTP, not HTTPS.** Acceptable for a LAN test build with a scoped cleartext
  exception; a hosted test environment should serve TLS and the exception
  should then be removed.
- **Not tested on a physical device by the author** — no handset was attached
  to the build machine. Everything the device path depends on was verified
  against the machine's network address rather than loopback: the served page,
  CORS preflight from the device origin, customer and rider sign-in, authorized
  API calls, and a realtime socket that connects and authenticates.
