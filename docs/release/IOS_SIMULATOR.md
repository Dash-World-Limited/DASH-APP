# iOS simulator build

Continue on `ios/first-native-build`. The generated `apps/mobile/ios/` directory
is ignored; `app.config.ts`, the config plugins and the mobile lockfile own it.
Do not copy an Android native project or merge a release branch to restart iOS.

## Push is an independent integration dependency

`ios`, `ios:generate`, `ios:bundle` and `ios:verify-config` select
`DASH_BUILD_PLATFORM=ios` only in their Expo child process. These commands do
not require or read Android's `GOOGLE_SERVICES_JSON`. Unscoped configuration
and Android builds retain the existing production Firebase client-file guard.
For a direct iOS Expo command, scope `DASH_BUILD_PLATFORM=ios` to that command;
do not export it for a shell used to build Android. Shared production URL,
map-style and version validation still applies. This permits native generation
and simulator verification; it is not proof of push readiness or approval to
ship a production app without push.

No Apple/Firebase artifact is required for the current staging simulator path.
Real iOS FCM registration/delivery still requires the owner integration listed
in [IOS_PUSH_PARITY.md](IOS_PUSH_PARITY.md). Preserve that explicit unavailable
state until a real provider is wired. Continue other iOS work independently.

## Reproduce on macOS

The workflow uses macOS 26, Xcode 26.6, Node 22.23.3 and CocoaPods 1.17.0. Select
that Xcode and install that CocoaPods version before generating/installing pods.
The staging lock in `apps/mobile/ios-dependencies/staging/Podfile.lock` was
captured from a passing Mac build. Clean generation removes `ios/`; restore the
reviewed lock afterwards and use `pod install --deployment` to refuse dependency
drift. The CI toolchain check also refuses an unreviewed CocoaPods upgrade.
This locks the staging build; development/production targets have not been
independently locked or distribution-tested.

From the repository root, in a clean checkout:

```sh
npm ci --include=dev
npm ci --prefix apps/mobile --include=dev
npm run typecheck --prefix apps/mobile
npx eslint apps/mobile
npx vitest run apps/mobile
cd apps/mobile
export APP_VARIANT=staging
export CI=1
npm run doctor
npx expo install --check
npm run ios:verify-config
npm run ios:bundle
npm run ios:generate
git diff --exit-code -- package.json package-lock.json
cd ios
test "$(pod --version)" = '1.17.0'
cp ../ios-dependencies/staging/Podfile.lock Podfile.lock
pod install --deployment
xcodebuild -workspace DASHstaging.xcworkspace -scheme DASHstaging \
  -configuration Release -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath /tmp/dash-ios-derived \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO build
```

`EXPO_PUBLIC_API_URL` and `EXPO_PUBLIC_MAP_STYLE_URL` are public build settings.
Supply the real staging values before bundling for connected testing; do not
invent an endpoint. The workflow also writes the API origin into the disposable
`src/api/buildConfig.ts` workspace copy, following the existing Android build
contract. That generated copy must not be committed. An unset API URL means
disconnected mode, not a verified live order journey.

`npm run ios:verify-config` evaluates the real Expo plugins without requiring
Xcode. It checks the variant identifier, DASH URL scheme, splash, appearance,
foreground location description and absence of unused Always/motion/Face ID
permissions. iOS generation works on macOS/Linux, including WSL with Linux
Node; Windows Expo intentionally refuses native iOS generation. A successful
prebuild or Hermes export is not proof of a native compile or simulator launch.

## Workflow and diagnostics

`.github/workflows/mobile-ios-simulator.yml` runs on relevant iOS branch pushes,
pull requests and manual dispatch. The branch trigger lets this workflow run
without merging it to the default branch. It runs mobile typecheck, lint, all
mobile tests, the locked Expo Doctor, native generation, config checks, pods,
unsigned Release compilation and a simulator launch with a 15-second process
survival check. The application scheme comes from its generated Xcode project,
not the first alphabetic scheme from the Pods workspace.

Artifacts include the simulator app zip and SHA-256, build log, xcresult and
startup screenshot/log. The screenshot must be inspected: process survival alone
does not establish that startup left the splash or that navigation works.

On 18 October 2026, private-repository runs were rejected before a runner started
because of account billing/spending restrictions. After the user made the
repository public and the source/history exposure audit passed, retry attempt 2
of run **39104953248**, at `2bf99560f604c26f90aa331b7142e9a123224251`, succeeded:
native generation, pods, unsigned Release compilation, simulator installation,
launch and the 15-second process check all passed. The startup screenshot was
inspected and shows the DASH welcome screen with Sign in/Create account, beyond
the splash. There were dependency compiler warnings, but no compiler errors.

The successful toolchain was Xcode 26.6 (17F113), iOS Simulator SDK 26.5,
CocoaPods 1.17.0, Node 22.23.3 and npm 10.9.9. Later private-repository attempts
can encounter the same billing block; a zero-step job is an infrastructure
failure, not evidence of a compiler regression.

The workflow also runs the pinned, SHA-256-verified Maestro 2.11.0 CLI against
`apps/mobile/e2e/ios-startup.yaml`. This uses a disposable, signed-out simulator,
clears its app state and exercises welcome, sign-in, back, registration and back using existing
accessible controls. It does not enter credentials, submit forms, accept terms
or create an account. JUnit output, screenshots and failure diagnostics are
retained separately. Inspect the particular run's UI-test result before claiming
native navigation passed.

The iOS workflow fetches complete branch/tag/PR history and runs the pinned,
SHA-256-verified Gitleaks 8.30.1 CLI with redacted output before installing app
dependencies. The existing exact synthetic-fixture allowlist is used; inline
allow comments are ignored. Private-file hygiene remains a separate gate.
Simulator zip checksums use the zip basename so `shasum -a 256 --check` works
after downloading both files into one folder.

## Remaining parity and device checks

- Push: Expo's iOS native token is APNs, but DASH's sender accepts FCM tokens.
  This build deliberately does not prompt/register iOS for FCM; settings explain
  the limitation. Integrate a real iOS FCM client with owner-supplied Apple/Firebase setup
  through the existing registration pipeline; see IOS_PUSH_PARITY.md. Do not send APNs tokens to FCM or reuse Android's
  google-services.json as Apple configuration. No backend behavior changed.
- Startup/navigation: test cold launch, sign-in/restoration, Customer tabs,
  back headers, checkout, chat, Profile/settings and approved Rider face switching.
  Automated route-model tests pass, but native gestures/rendering are unverified.
- MapLibre: verify native map rendering, marker/camera updates and Apple Maps
  handoff. Native linking is still uncompiled. Test foreground permission grant,
  denial and Settings recovery with a simulated location and then on hardware.
- Keyboard: iOS chat avoidance/dismissal helpers already exist. Check number-pad
  completion, delivery PIN, OTP, bank details and bottom composer on an iPhone.
- Payments/support: verify browser-to-app return, phone and WhatsApp handoffs.
  A `dash` URL scheme exists; that alone does not prove payment return handling.
- Lifecycle: active-only rider GPS is existing behavior; background tracking and
  guaranteed background offers are not implemented. Test foreground/resume and
  SecureStore session restoration; do not describe this as background parity.
- Store/device distribution: Apple team, signing/provisioning, APNs credentials,
  version/build numbering, ATS policy and App Store privacy declarations still
  need review. An unsigned simulator zip cannot be installed on a physical iPhone.

Sources for the token contract and runner toolchain:
[Expo notifications](https://docs.expo.dev/versions/latest/sdk/notifications/),
[GitHub macOS runner images](https://github.com/actions/runner-images).
