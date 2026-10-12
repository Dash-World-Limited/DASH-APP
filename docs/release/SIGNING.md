# Signing the Android App Bundle

Google Play needs every bundle signed with **your upload key**. Google then
re-signs the app for devices with an **app signing key** it holds (Play App
Signing). If the upload key is ever lost or leaked, Google can reset it; the
app signing key never leaves Google.

The repository never contains a key. `withReleaseSigning` (an Expo config
plugin in `apps/mobile/plugins/`) writes only the *names* of four environment
variables into the generated Gradle file.

- **Production** (`APP_VARIANT=production`): the release build is signed with
  the upload key or **not built at all** — Gradle stops, naming any missing
  variable or a keystore path that is not a file. There is no debug fallback.
- **Development and staging**: the upload key is used when all four are set;
  otherwise the Android debug key, which Play rejects, so the staging APK can
  be sideloaded without the key and never mistaken for an upload.

**The normal path for a Play upload is the GitHub workflow**, not a laptop
build: see [`PRODUCTION-AAB.md`](PRODUCTION-AAB.md). It verifies the AAB's
signature against the upload certificate's fingerprint before releasing it.
The local steps below remain for an emergency build.

## 1. Create the upload key (once, by David)

Use the JDK 21 the build uses. In Git Bash:

```bash
"/c/Users/admin/Desktop/OMIC-V3/dash-worktrees/claude-dash-app/.tooling/jdk-21.0.12.1+1/bin/keytool" -genkeypair -v -storetype JKS -keystore "$HOME/dash-keys/dash-upload.jks" -alias dash-upload -keyalg RSA -keysize 2048 -validity 10000
```

- Create the folder first: `mkdir -p "$HOME/dash-keys"` — it is **outside**
  the repository on purpose.
- keytool asks for a keystore password and your name/organisation. Choose a
  strong password and store it in a password manager.
- Back up `dash-upload.jks` and its password somewhere safe and separate (for
  example an encrypted USB drive). Anyone with both can publish updates as
  DASH.
- Never commit it, email it, or paste it into chat.

## 2. Build a signed bundle

From Git Bash, in a folder with a short path (Windows limits paths to 260
characters and the native build exceeds that under `Desktop\…`; see
"Windows path length" below):

```bash
export DASH_UPLOAD_STORE_FILE="$HOME/dash-keys/dash-upload.jks"
export DASH_UPLOAD_KEY_ALIAS=dash-upload
read -s -p "Keystore password: " DASH_UPLOAD_STORE_PASSWORD; echo; export DASH_UPLOAD_STORE_PASSWORD
export DASH_UPLOAD_KEY_PASSWORD="$DASH_UPLOAD_STORE_PASSWORD"
export DASH_VERSION_CODE=1          # higher than every code already uploaded
export DASH_VERSION_NAME=1.0.0      # required for production
export APP_VARIANT=production       # only after the application ID is confirmed
export EXPO_PUBLIC_API_URL=https://api.example.invalid          # the HTTPS production API origin
export EXPO_PUBLIC_MAP_STYLE_URL=https://maps.example.invalid/style.json   # required for production
cd apps/mobile
npx expo prebuild --platform android --clean --no-install
cd android && ./gradlew :app:bundleRelease
```

`read -s` keeps the password off the screen and out of shell history.

The bundle is at `apps/mobile/android/app/build/outputs/bundle/release/app-release.aab`.

Check it is signed with your key, not the debug key:

```bash
"<jdk>/bin/keytool" -printcert -jarfile app/build/outputs/bundle/release/app-release.aab
```

The owner shown must be the name you gave in step 1 — not "Android Debug".

## 3. Application ID — decide before the first upload

`APP_VARIANT=production` builds `com.dashworldng.dash`. **Once a bundle with
that ID is uploaded to Play it can never change.** It has not been confirmed
yet; until it is, build `APP_VARIANT=staging` (`com.dashworldng.dash.staging`)
for verification only.

## 4. versionCode

Every upload needs a higher `DASH_VERSION_CODE` than the last. Play refuses a
bundle whose versionCode it has already seen. Record each upload's
versionCode, git commit, and date in `docs/release/UPLOADS.md` (create it at
the first upload).

## Windows path length

The React Native native build creates object-file paths longer than 260
characters under `C:\Users\admin\Desktop\dash-app\…`, and ninja fails with
"Filename longer than 260 characters". Either:

- build from a short path, e.g. a git worktree: `git worktree add --detach C:/b/rc HEAD`,
  then `npm ci` and `npm ci --prefix apps/mobile` there; or
- enable long paths in Windows (Administrator PowerShell, then restart):
  `New-ItemProperty -Path HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem -Name LongPathsEnabled -Value 1 -PropertyType DWORD -Force`

GitHub Actions builds on Linux and is not affected.

## What was verified (28 September 2026)

- A release bundle builds from commit `29a9ff6` (staging variant): 82 MB,
  arm64-v8a, armeabi-v7a, x86, x86_64; targetSdk 36, minSdk 24. It was signed
  with the debug key and is **verification only**, not uploadable.
- With a throwaway keystore (deleted afterwards), `gradlew :app:signingReport`
  showed the release variant switching to the supplied keystore and alias;
  without the variables it showed the debug keystore.
- A bundle signed with David's real upload key has **not** been built yet.
