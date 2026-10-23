# iOS release candidate / TestFlight preparation

Release hardening from `ef69541c14c38bbade05be7acd3bf5112e68e43d`, 23 October 2026.
This document does not authorize deployment, upload, merging or production data changes.
The owner reports the completed iPhone 17 Pro staging order → Android Rider → chat → delivery → rating journey; that is the accepted functional baseline, not a new test result from this PR.

## What changed and what stays intact

- Existing self-service deletion UI is already under Customer Profile → Delete my account (`customer.delete-account`). The confirmed POST now includes the backend's required `Idempotency-Key`, retained across a lost-response retry. The existing confirmation, cancellation, cooling-off policy, authorization and active-order restrictions remain. No second deletion service or backend change.
- iOS uses native Firebase Messaging for **FCM** acquisition/refresh, then the existing `/v1/devices` registration and logout pipeline. Expo still owns foreground presentation and notification responses. APNs tokens are never submitted to the FCM sender. Pending acquisition cannot register/cache a token after its account scope ends.
- Existing validated order/chat/support notification targets, server-backed screen reads, Rider restoration/active-delivery guards and warm/cold response handling remain. There is no separate background order/payment state machine or silent-push delivery promise.
- Android keeps Expo's FCM token acquisition, channel creation and registration behavior. RNFirebase is explicitly excluded from Android autolinking. Unconfigured iOS builds exclude its native modules as well.
- iOS configuration rejects a stale baked API origin from another build variant and non-production map hosts in production. Existing production API/version checks remain. Production notification test controls remain hidden.
- Dispatch, matching/radius/scoring, pricing, zones, order business rules, location, chat, rating and product layouts are untouched.

## Build identities and assets

| Variant | Display name | Bundle identifier |
| --- | --- | --- |
| development | DASH (dev) | `com.dashworldng.dash.dev` |
| staging | DASH (staging) | `com.dashworldng.dash.staging` |
| production | DASH | `com.dashworldng.dash` |

All retain the approved `assets/brand/icon.png` and `splash-icon.png`, portrait iPhone layout, explicit foreground location explanation and automatic appearance. No Always location, background rider tracking, Face ID or motion permission is added. Version is `DASH_VERSION_NAME`; native build number uses `DASH_VERSION_CODE`. Both are explicit for production; the owner must select an unused increasing upload build number.

The existing payment contract remains `dash://orders`; query parameters do not identify an order or establish success. All variants currently claim that same scheme. When multiple variants are installed, iOS custom-scheme selection is not deterministic: perform browser-return QA with only the intended variant installed. This limitation is recorded rather than changing the accepted web/native return contract speculatively. Bundle IDs, separate device storage and validated Firebase clients remain isolated.

## Optional genuine iOS push configuration

The default development/staging/production **source-validation** path needs no private Firebase file, Apple identity or signing. It produces a functioning non-push build with an honest unavailable message. It is not a push-complete release.

To enable the native FCM path, supply these in a private build environment:

- `GOOGLE_SERVICE_INFO_PLIST`: absolute/local ignored path to the real Apple client configuration for the exact selected bundle. Never commit its contents. It is not an Admin credential or the Android JSON file.
- `FIREBASE_PROJECT_ID`: explicit expected project matching that client's `PROJECT_ID` and the corresponding DASH environment's existing backend sender.
- `DASH_APNS_ENVIRONMENT`: `development` for a development-signed device build; **`production` for TestFlight/App Store**, even when the app variant is staging. A production variant refuses development APNs.

The file must contain the matching bundle, Firebase iOS app ID and sender ID. Missing/mismatched/unreadable supplied files fail configuration; no placeholder is generated. Core Firebase configuration and dynamic-framework support are applied only to configured iOS builds. RNFirebase 26 / Firebase Apple SDK 12.15 is pinned for the existing Node 22 toolchain. Its SPM native resolution/compilation must be verified with the real client before sign-off. Absence of the owner file is not proof that the configured SDK build works. The newer RNFirebase 27 web dependency requires Node 24; it is not used to silently change this repo's build toolchain.

After notification permission, the bridge ensures APNs registration, requires its native APNs mapping and obtains the FCM registration token. FCM refresh and existing Expo/APNs events trigger the same coalesced registration. Registration carries `platform: ios`, this build's bundle ID, account preference and any replaced token. Unconfigured builds never request permission for an unavailable service. Logout unregisters with the existing authenticated API and clears cached iOS notification responses.

Foreground banners use the existing suppression rules for the order/chat/support screen already visible. Background/terminated alert delivery is owned by Apple/Firebase and the OS; a tap uses Expo's existing response/cold-cache path. No push payload settles payments or updates authoritative order state.

## Repeatable source/config checks

Use Node 22.23.3 and the committed lockfiles:

```sh
npm ci --include=dev
npm ci --prefix apps/mobile --include=dev
npm run typecheck --prefix apps/mobile
npx eslint apps/mobile
npx vitest run apps/mobile
npx vitest run apps/api/src/__tests__/account-deletion.test.ts apps/api/src/__tests__/push.test.ts apps/api/src/__tests__/push-notifications.test.ts apps/api/src/__tests__/push-staging.test.ts
npm run doctor --prefix apps/mobile
node scripts/check-secrets.mjs
```

For staging on macOS/Linux:

```sh
export APP_VARIANT=staging
export EXPO_PUBLIC_API_URL=https://staging.dashworldng.com
npm run ios:verify-config --prefix apps/mobile
npm run ios:generate --prefix apps/mobile
npm run ios:bundle --prefix apps/mobile -- --output-dir /tmp/dash-ios-staging-export
```

Production additionally requires owner-reviewed `EXPO_PUBLIC_API_URL`, `EXPO_PUBLIC_MAP_STYLE_URL`, `DASH_VERSION_NAME` and `DASH_VERSION_CODE`. Do not inherit staging shell values. `npm run ios:verify-config` and `ios:generate` validate configuration without signing. Validation runs using `.invalid` origins are explicitly non-deployable schema/native-generation evidence, never production connectivity proof.

With the genuine Firebase Apple client configured, also run `npm run ios:verify-release --prefix apps/mobile`. This stricter check refuses missing push setup or non-production APNs for a TestFlight candidate. Passing the generic config gate alone is not release approval.

## Native build / archive procedure

Use an isolated checkout and separate simulator; preserve the owner's existing staging session and working copy. `DASH_BUILD_PLATFORM=ios` is set by the npm iOS commands; retain it for direct Expo/Xcode commands.

For the credential-free staging baseline, copy `apps/mobile/ios-dependencies/staging/Podfile.lock` into the generated `ios/`, then use CocoaPods 1.17.0 `pod install --deployment`. A dependency patch requires a reviewed lock update first; never silently replace the lock in a release job. A configured Firebase build adds native SDK/SPM resolution, which requires a separately verified and retained dependency resolution record. Do not reuse a non-Firebase native lock as evidence of configured Firebase reproducibility.

Build the generated workspace/scheme listed by `xcodebuild -list -json`, Release, `-sdk iphonesimulator`, with `CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO`. Install/launch the produced app on the isolated simulator, check it survives startup, and run the existing Maestro `apps/mobile/e2e/ios-startup.yaml`. Record source SHA, toolchain, dependency lock, screenshots and actual results.

For an archive, select the owner's real production environment and genuine Firebase client, run both iOS configuration gates, generate the native project, resolve/lock the configured dependencies, and select the actual Apple team. Then archive the generated Release scheme using `-destination 'generic/platform=iOS'` and the intended `.xcarchive` output path. Device signing/provisioning must be supplied securely; do not disable signing and describe that as a distributable archive. Review archive bundle ID, version/build, entitlements, embedded API configuration, Firebase project and SDK privacy manifests before any owner-authorized distribution.

## Owner-only actions / release blockers

1. Confirm active Apple Developer Program membership and App Store Connect roles. A new Apple account alone does not establish membership. Owner handles identity checks, agreements and fees privately.
2. Confirm the permanent production bundle identifier; register matching Apple identifiers/capabilities and the App Store Connect app record. Configure signing certificates/profiles and team access through approved secret storage. No `.p8`, private key, provisioning profile, signing certificate or Firebase client plist in Git.
3. Register the three intended Firebase Apple apps against their exact bundles/environment projects; supply their ignored client paths/project pins. Upload the owner's genuine APNs authentication key to the matching Firebase project and verify team/key IDs. Keep existing DASH backend architecture.
4. Build and validate the **configured** native FCM path. Until real Apple/Firebase setup exists, that native compilation and actual registration/delivery remain unverified. Unit substitutes establish contracts only.
5. Confirm final production API/map/version/build values and run production validation/export/archive against those exact values. Resolve/review remaining dependency advisories; no forced major downgrade or audit suppression is part of this PR.
6. Complete [physical iPhone QA](IOS_PHYSICAL_DEVICE_QA.md). Paystack testing must positively use test mode and real server verification. No live money/production account tests.
7. Owner completes App Store Connect privacy/export-compliance/beta information, any required reviewer-access setup, archive validation/upload and TestFlight external beta review/invitation. This PR does not perform any upload or deployment.

## Paystack audit outcome

No payment source change is required. Existing iOS-only listener mounts above auth gates, subscribes before initial URL read, rejects unrelated/malformed URLs and preserves Rider mode. Returns select server-backed Customer Orders; the order/detail screens re-read authoritative state, discard stale reads and suppress obsolete Pay again UI. Existing regressions cover successful/cancelled/failed URL parameters, duplicate returns, cold/warm races, signed-out/session restoration and active/restoring Rider protection. Actual Safari/Paystack success/cancel/failure and force-closed return remain staging/device QA, not unit-test claims.

Official integration references: [Firebase Apple FCM](https://firebase.google.com/docs/cloud-messaging/ios/get-started), [RNFirebase Expo setup](https://rnfirebase.io/), [TestFlight external invitations/review](https://developer.apple.com/help/app-store-connect/test-a-beta-version/invite-external-testers/).
