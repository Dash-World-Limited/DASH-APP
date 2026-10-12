# Building the production AAB for Google Play

The Play upload is built by **`.github/workflows/mobile-production-aab.yml`**.
It produces a signed, verified Android App Bundle for `com.dashworldng.dash`
as a workflow artifact. It never uploads to Play; putting the AAB on a track
is done by hand in Play Console.

The staging APK for the A55 (`mobile-release-apk.yml`) is separate and
unchanged: `com.dashworldng.dash.staging`, debug-signed, arm64 only, for
sideloading.

## What makes it fail-closed

A production build exists only if every value is supplied and valid. There
is no default for any of them, and nothing falls back to debug signing.

| Layer | What it refuses |
|---|---|
| Workflow preflight | any secret or variable unset; an upload-certificate fingerprint that is not 64 hex digits; a production API equal to the staging one |
| `plugins/releaseConfig.js` (run by `app.config.ts` at prebuild **and** again by expo-constants during Gradle) | an API origin that is not https, is a local/private address, has a path or credentials, or has a hostname label like `staging`, `dev`, `test`, `qa`; a non-https map style; a missing or invalid version code or version name |
| `plugins/withReleaseSigning.js` (Gradle) | any `DASH_UPLOAD_*` variable missing, or a keystore path that is not a file — the build stops; debug signing is never used |
| AAB verification | a signature that does not verify, more than one signer, the Android debug key, a certificate whose SHA-256 is not `DASH_UPLOAD_CERT_SHA256`, a missing ABI, staging assets, or anything `release-verify.ts` rejects (below) |

`apps/mobile/scripts/release-verify.ts` reads the bundle, the embedded Expo
config and Gradle's merged manifest out of the build and requires: a release
JS bundle carrying the v2 screen markers; no `RNSScreen`,
`react-native-screens` or Expo Router; no staging or dev package id; no
localhost or emulator URL; the production API origin present and the staging
origin absent; none of the invented merchants, people, addresses or orders
older builds carried; an embedded config of variant `production` with the
right package, version, API and an https map style; and a manifest that is
the right package and version, not debuggable, with no cleartext traffic and
only these permissions:

| Permission | Why |
|---|---|
| `INTERNET` | every API, image and map request |
| `ACCESS_NETWORK_STATE` | added by expo-image and MapLibre to check connectivity |
| `ACCESS_COARSE_LOCATION`, `ACCESS_FINE_LOCATION` | delivery addresses; a rider's position while online — **foreground only** |
| `com.dashworldng.dash.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION` | AndroidX's own signature permission; grants nothing to other apps |

Anything else fails the build until someone decides it belongs (and
declares it in Data Safety). Blocked in `app.config.ts`: background
location, foreground service, boot receiver, biometrics, fingerprint, draw
over other apps, external storage, and vibrate.

**This list has not yet been checked against a real merged manifest.** The
cloud session that wrote it could not run the Android SDK. The first run of
the workflow is that check: if a library contributes a permission not listed
here, the build fails and names it, and the right response is a decision,
not editing the allowlist to pass.

## GitHub configuration David needs to add

Create an environment named **`production`** (repository Settings →
Environments → New environment). Add **required reviewers** so a production
build waits for a second approval, and optionally restrict it to the branch
production builds should come from.

On that environment:

### Variables (not secret — each ships inside the app or is a fingerprint)

| Name | Value |
|---|---|
| `DASH_PRODUCTION_API_URL` | The production API origin, e.g. `https://api.dashworldng.com` — https, no path, no trailing slash |
| `DASH_PRODUCTION_MAP_STYLE_URL` | The reviewed production MapLibre style URL (https). Check its tile provider's terms permit a production mobile app at DASH's traffic |
| `DASH_UPLOAD_CERT_SHA256` | The upload certificate's SHA-256 fingerprint (see below). Colons and case do not matter |

### Secrets

| Name | Value |
|---|---|
| `DASH_UPLOAD_KEYSTORE_BASE64` | The upload keystore file, base64-encoded (see below) |
| `DASH_UPLOAD_STORE_PASSWORD` | The keystore password |
| `DASH_UPLOAD_KEY_ALIAS` | The key alias, e.g. `dash-upload` |
| `DASH_UPLOAD_KEY_PASSWORD` | The key password |

The existing repository variable `EXPO_PUBLIC_API_URL` (the staging origin
the APK workflow uses) stays as it is; the production workflow reads it only
to prove it is **not** in the production bundle.

### Getting the two values from the keystore

On the machine that holds the keystore (never paste the output into chat):

```bash
# The fingerprint, for DASH_UPLOAD_CERT_SHA256 — the line starting "SHA256:"
keytool -list -v -keystore dash-upload.jks -alias dash-upload | grep SHA256

# The keystore as one base64 line, for DASH_UPLOAD_KEYSTORE_BASE64
base64 -w0 dash-upload.jks > dash-upload.jks.b64      # Git Bash / Linux
# then paste the file's contents into the secret, and delete the .b64 file
```

If Play App Signing is already set up, the same fingerprint is in Play
Console → the app → Setup → App signing → **Upload key certificate**.

## Running it

Actions → **Mobile production AAB (Play upload candidate)** → Run workflow:

- **branch** — the commit to ship;
- **version_code** — higher than every code ever uploaded to Play for this
  package (Play rejects a reused code permanently; record each one);
- **version_name** — what people see, `MAJOR.MINOR.PATCH`. The current
  development value is `0.1.0`; the first public release is conventionally
  `1.0.0`. **David's choice.**

The run takes roughly 30–60 minutes (three ABIs). Its artifact holds the
AAB, its SHA-256, and a verification report naming the commit, package,
version, API origin, map style, ABIs and signing fingerprint.

## Verified so far, and how

In a cloud container without the Android SDK, so **no AAB has been built
yet**. What was run:

- `app.config.ts` with production: refuses with nothing set (naming all four
  values), refuses a staging host, http style, code `0` and name `1.0`;
  resolves `com.dashworldng.dash 1.0.0 (12)` when valid.
- A real production `expo prebuild`: `applicationId 'com.dashworldng.dash'`,
  versionCode and versionName as given, the production signing gate in the
  release build type; the main manifest requests only INTERNET and the two
  location permissions.
- The production signing gate's generated Groovy, executed with Gradle
  8.14.3: stops with no variables, with one missing, and with a keystore
  path that is not a file; proceeds when complete.
- A real production JS bundle (`expo export:embed`, 895 modules) and the
  embedded config from expo-constants' own script: `release-verify` passes.
  The same export from the pre-change base branch fails it with thirteen
  invented merchants, addresses and orders.
- The workflow's own "Verify the AAB" script, run against a stand-in AAB
  holding that real bundle and config: passes signed with the expected key;
  fails for a different key, an unsigned AAB, a bundle carrying the staging
  origin, and a missing ABI.

Still unverified until the first real run: the Gradle build itself, the
merged manifest's actual permission set, and the AAB's real signature.
