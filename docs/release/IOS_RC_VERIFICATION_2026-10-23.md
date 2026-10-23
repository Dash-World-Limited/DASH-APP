# iOS release-readiness verification — 23 October 2026

Branch: `codex/ios-testflight-readiness-2026-10-23`.
Starting point: `ef69541c14c38bbade05be7acd3bf5112e68e43d`; `ios/first-native-build` remains untouched.
Implementation/lock checkpoint: `aaf360fdf79f7f3561326c3dc1bddb91d7dafdb0`. This report is added by a subsequent documentation-only commit; obtain its exact final SHA with `git rev-parse HEAD` or the linked review receipt.

No merges, deployments, uploads, production requests or Claude-branch integration were performed. The owner's existing staging journey remains an accepted baseline, not a newly claimed authenticated result from this verification.

## Checkpoints

| Commit | Change |
| --- | --- |
| `cb84439ca25fdfcf0cbd8b5c5dda91067868fd6b` | Optional genuine iOS FCM bridge/configuration, logout acquisition guard, deletion idempotency defect, focused regressions and release/device checklists. |
| `7184338d3d4e0b6f806acf9ff8b8246bf0118f3c` | RNFirebase 26 / Node 22 compatibility, npm 10 lock correction. |
| `ecc189b893452077868a0b0c29924076ece4971b` | Explicit production ATS enforcement; retain development Metro allowance. |
| `aaf360fdf79f7f3561326c3dc1bddb91d7dafdb0` | Reviewed six-pod Expo patch lock update, validated by locked CocoaPods install. |

## Concrete implementation

The existing deletion screen omitted the backend's mandatory `Idempotency-Key`, causing the real API contract to reject a confirmed request. The screen now sends an existing repository-generated key and retains it across ambiguous retries. Existing cancellation, authentication, confirmation and backend policies remain. A reproduction failed before the change; all eight screen regressions now pass.

The existing backend sends FCM and already accepts `platform: ios`; Expo's iOS device token is APNs, not FCM. Configured iOS builds now acquire/refresh the native FCM token after permission and APNs mapping, then reuse DASH's registration/preferences/logout pipeline. Expo still handles presentation and tap responses. Pending token acquisition is scope-guarded so a completed logout cannot register/cache its late result; a regression failed before that guard. Android retains Expo FCM/channels and excludes RNFirebase native autolinking.

A real optional Apple Firebase plist must match the selected bundle and explicitly pinned Firebase project. TestFlight requires production APNs transport, including a staging TestFlight app. Missing owner setup leaves honest non-push functionality and credential-free native generation; explicit release verification rejects that missing configuration. No fake native client, token or delivery result was created.

Production configuration checks the compiled API input, map host, version/build, bundle and push-client isolation. Generated production ATS explicitly disables arbitrary loads and local-network exceptions. Development retains Metro access. Dev/staging/prod IDs are respectively `com.dashworldng.dash.dev`, `com.dashworldng.dash.staging`, `com.dashworldng.dash`.

No dispatch, pricing, order, Rider, chat, rating or backend business logic changed. The audited existing Paystack flow already validates links, defers to authentication restoration, protects Rider mode, deduplicates and reloads server-owned state; it was left untouched. All variants still claim the existing `dash://orders` scheme: test browser returns with only the intended variant installed, since iOS selection between multiple installed handlers is not deterministic.

## Dependency changes

Only the mobile npm lock/package and staging native lock changed; the root/API/domain/web locks and manifests did not.

- Pin `@react-native-firebase/app` and `@react-native-firebase/messaging` to **26.0.0** (Firebase Apple SDK 12.15.0). RNFirebase 27 was rejected after real Node 22 installation exposed its Node 24 web dependency requirement.
- Add `expo-build-properties` **57.0.22** for conditional dynamic-framework support and dev dependency `@expo/plist` **0.8.1** for validating the owner's genuine client.
- Align Doctor-required Expo patches: Expo **~57.0.31**, expo-location **~57.0.22**, expo-notifications **~57.0.24**; corresponding native pod versions/checksums are retained in Git.
- Override mobile `@grpc/grpc-js` to **1.14.6**, resolving the newly introduced Firebase transitive advisory without altering the root lock.
- Regenerate using **npm 10.9.9**; clean `npm ci --include=dev` for both locks passed on the real Mac with Node **22.23.3**. The first npm 11-generated nested override lock failed npm 10 CI and was replaced, not bypassed.

## Complete changed-file manifest

```text
apps/mobile/app.config.ts
apps/mobile/ios-dependencies/staging/Podfile.lock
apps/mobile/package-lock.json
apps/mobile/package.json
apps/mobile/plugins/iosAutolinking.test.ts
apps/mobile/plugins/iosReleaseConfig.js
apps/mobile/plugins/iosReleaseConfig.test.ts
apps/mobile/react-native.config.js
apps/mobile/scripts/verify-ios-config.mjs
apps/mobile/src/v2/account/DeleteAccountScreen.test.tsx
apps/mobile/src/v2/account/DeleteAccountScreen.tsx
apps/mobile/src/v2/account/NotificationSettingsScreen.test.tsx
apps/mobile/src/v2/account/NotificationSettingsScreen.tsx
apps/mobile/src/v2/push/iosFcm.test.ts
apps/mobile/src/v2/push/iosFcm.ts
apps/mobile/src/v2/push/pushRegistration.test.ts
apps/mobile/src/v2/push/pushRegistration.ts
apps/mobile/src/v2/push/usePushNotifications.test.tsx
apps/mobile/src/v2/push/usePushNotifications.ts
docs/release/IOS_PHYSICAL_DEVICE_QA.md
docs/release/IOS_PUSH_PARITY.md
docs/release/IOS_RC_VERIFICATION_2026-10-23.md
docs/release/IOS_RELEASE_CANDIDATE.md
```

## Automated verification

| Gate | Actual result |
| --- | --- |
| Full mobile suite | **577 passed, 0 failed, 47 files**, Windows and real Mac. Accepted baseline was 529; no tests weakened. |
| Full domain suite | **817 passed, 0 failed, 25 files**, local test fixtures. |
| Full API suite | **1,529 passed, 0 failed, 71 files**, local isolated test databases. |
| Combined mobile/domain/API | **2,923 passed, 0 failed, 143 files**; mobile and domain/API run separately. Earlier focused 90 API tests also passed; not double-counted. |
| Typecheck | All **5 repository projects** clean; independent mobile check on Mac also passed. |
| Lint | Full repository lint clean; independent mobile lint on Mac passed. |
| Expo Doctor | **21/21 passed**, no exclusions/skips added. |
| Config | Development, staging and production introspection passed. Strict release check intentionally rejects absent `GOOGLE_SERVICE_INFO_PLIST`. |
| Native generation | Fresh staging and production generation passed on macOS without Apple/Firebase credentials. |
| Hermes/export | Staging and production Hermes exports passed. Production no-bytecode export passed the existing bundle-isolation verifier. |
| CocoaPods | Targeted six-pod patch update passed; **`pod install --deployment` passed with unchanged lock**. No RNFirebase pods linked in the unconfigured build. |
| Xcode | **Unsigned arm64 Release simulator build succeeded**, Xcode 26.6 (17F113), iOS 26.5 SDK, CocoaPods 1.17.0. |
| Startup | Installed and launched; process remained alive after 15 seconds; real welcome-screen capture retained. |
| Native navigation | Existing Maestro 2.11.0 flow **1/1 passed**: welcome, sign-in/back, registration/back, warm/cold signed-out `dash://orders`. |
| Private-file hygiene | **12/12 passed**; release-branch commit-delta Gitleaks scan found no leaks. No client plist, signing artifacts or secrets committed. |

Production configuration/export validation used deliberately non-deployable `https://release-validation.invalid` and `https://maps.release-validation.invalid/style.json`, version 0.1.0/build 1. These prove validation/generation/bundle isolation only. They do not prove real production origins, connectivity or final upload metadata.

Native work used `/Users/ec2-user/DASH-APP-ios-rc-20261023`, not the original Mac checkout. The initial native build ran at `ecc189b` with the generated lock subsequently committed verbatim as `aaf360f`. The staging API was compiled only into the disposable verification worktree, matching existing CI; this generated `buildConfig.ts` was never committed. Final-head build/launch receipts are retained alongside the review/handoff. The separate simulator is `751823A1-B4CC-4A06-A56F-9F3833038540` (DASH RC 20261023 iPhone 17 Pro); the owner's original simulator/session was preserved.

Evidence on the Mac: `~/dash-ios-rc-evidence-20261023-ecc189b/` and the final-head evidence directory recorded in the handoff. Windows evidence: task workspace `outputs/verification/`. These contain logs, JSON counts, generated plists, locks, build result and native screenshots; keep them private and review before sharing.

Earlier resolved attempts remain in those evidence directories: Node-incompatible RNFirebase 27, npm-version lock mismatch, an over-broad development ATS assertion, and the expected old-pod-lock mismatch. One Windows test run overlapped an install and lost dependency imports; that invalid orchestration attempt was discarded, followed by a clean serial 577-test pass. Native/Metro build warnings and Fastify deprecation notices were retained, not suppressed.

## Regression coverage / Android preservation

- Deletion: config/auth/confirmation/cancel gates, required request header, scheduled state, failure without false success, same retry key and cancellation/reload.
- FCM: unconfigured/Android gates, APNs-before-FCM requirement, token success/error/absence, refresh listener disposal and delayed-import logout race.
- Shared registration: iOS platform/bundle/permission, replacement/preference, unavailable service and scope invalidation during asynchronous acquisition; Android token/channel cases remain passing.
- UI/config: honest iOS availability, production test-helper hiding, RNFirebase excluded from Android and unconfigured iOS autolinking, valid/mismatched owner-config contracts, stale compiled API/map rejection and production ATS assertions.

Android behavior is supported by those regressions and full shared tests, not a newly built APK. Expo patch versions are shared native dependencies; no new Android APK/device test was performed. Existing native Android FCM/client-file requirement remains. No Android-shell, web or backend source changed.

## Remaining security and owner-only release gates

The mobile npm audit still reports **18 high / 0 moderate / 0 critical** dependency entries. The remaining direct advisories are inherited `braces` (GHSA-vfj7-8cjw-p6xm) and `node-forge` (GHSA-86w9-cpqp-85rv) in Expo tooling chains; no new advisory URL remains relative to the accepted baseline. Metavulnerability counts increased through RNFirebase's Expo dependency. Do not force an incompatible Expo downgrade or suppress checks; review upstream fixes/exposure before distribution.

1. Owner confirms paid Apple Developer membership, team/roles, agreements and App Store Connect access. A new Apple account is insufficient evidence.
2. Owner confirms permanent bundles/app record, enables Push Notifications, supplies legitimate team signing certificates/profiles securely and authorizes archive/distribution separately.
3. Register matching Firebase Apple apps/projects; privately provide ignored `GOOGLE_SERVICE_INFO_PLIST` paths and matching `FIREBASE_PROJECT_ID`. Add real APNs key/team/key-ID configuration in Firebase. Never put these files/keys in Git/chat.
4. Run `ios:verify-release` with genuine selected client and production APNs for TestFlight; generate and validate the **configured** RNFirebase/SPM native build, retain resolved dependencies, archive/sign and inspect entitlements/privacy manifests. This path has not compiled here because the owner client is absent.
5. Owner chooses final real production API/map URLs and unused version/build, then reruns production bundle/config/archive checks. No signing/uploaded archive/TestFlight build was produced in this task.
6. Complete [physical iPhone QA](IOS_PHYSICAL_DEVICE_QA.md): real GPS/permissions, legitimate Customer and approved Rider, real Paystack test-mode success/cancel/failure and browser returns, chat/order recovery, real foreground/background/terminated APNs/FCM and tap/logout/rotation tests, call/rating/preferences/deletion. No real push/payment success is claimed.
7. Complete App Store Connect privacy/export compliance/beta reviewer setup, validate/upload the signed archive and obtain beta review/invite testers only after explicit distribution authorization.

## Claude branch comparison and future integration order

Read-only comparison against `feature/order-ops-controls` tip **`339a90a37c3148e390baaf0196bccf445217e62d`**, common base `ef69541`, found **zero changed-path intersections** with this branch. The five supplied commits match the remote. No checkout, merge, cherry-pick, rebase or conflict reconciliation was performed.

There are no presently confirmed text-conflict files. Semantic integration attention belongs to Claude's `apps/mobile/src/v2/rider/RiderFlowProvider.tsx`, `RiderScreens.tsx`, `journey.ts` and corresponding tests, plus its API/domain order/permission/dispatch changes: test Rider protection and notification routing against their new operational transitions together. That is combined-build QA, not a reason to alter either isolated branch now.

Recommended future order, subject to owner approval: review/integrate this iOS readiness PR first against its known `ef69541` baseline; review/integrate Claude's operational PR separately afterward; run combined repository tests and a new exact-final-SHA native build and staging Customer/Rider journey before any TestFlight candidate. Neither branch's earlier binary proves the combined tree. Retain both histories and do not squash/restart the accepted iOS work.
