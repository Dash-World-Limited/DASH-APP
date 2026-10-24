# Handoff: bring native v2 up to the release line (29 September)

**Decision (David):** the native v2 app is the approved DASH mobile base. Keep
its UI/UX. Do not redesign it, do not switch back to the Expo Router app, and
do not reintroduce react-native-screens / Expo Router navigation.

## Where things are

| Branch | What it holds |
|---|---|
| `claude/awesome-bardeen-95lgbd` | **The release line.** All backend/domain/web work (Paystack, refunds, Brevo, auth, vendor/rider approval, CI fixes). Its `apps/mobile` is still the **old Expo Router app** (the one that crashes on switching). |
| `codex/native-mobile-v2-rebuild` (`4da0b81`) | The v2 app (`apps/mobile/src/v2`, `index.js`), plus one web/API commit: "Build approved Vendor operations console". Untouched. |
| `claude/v2-a55-standalone` (`e8178c4`) | v2 + a workflow that builds a **release** APK (no Metro, embedded bundle only) and fails unless the bundle contains `rider-home-v2` and no `RNSScreen`. Its APK: Actions run 36510982074, artifact `DASH-native-v2-arm64-release`. |

Every other branch's work is already in the release line, except two older
commits: `533f32c` (a SECURITY note, superseded) and `87a0c7f` on
`claude/milestone-vi-v1-experience` (web design system/shell, 9 Sep) —
**check whether it was superseded** before porting anything from it.

## The earlier A55 crash

It was not v2's code. v2's bundle has no react-native-screens module and no
`RNSScreen`; the crash dump had one. The debug APK loaded the old app's JS from
the PC's Metro (same package id `com.dashworldng.dash.dev`). Use the release
APK, uninstall the old app first, and stop any Metro for the old app.

**Verified on the A55 on 29 September 2026 — the crash does not reproduce.**
A release APK built from `claude/v2-a55-standalone` (bundle checked: carries
`rider-home-v2`, contains no `RNSScreen`) was installed after uninstalling the
old app. Switching to the Rider face, tapping Go Online, cycling every rider
tab repeatedly while online, switching faces back and forth, and a
package-restricted 400-event monkey run all left the process alive with an
empty crash buffer, and no `RNSScreen` or "child already has a parent" appears
anywhere in `logcat -b all`.

## Plan

1. ~~**Verify** the standalone v2 release APK on the A55.~~ **Done** — see
   above.
2. ~~**Integrate on the release line**~~ **Done** (29 September), in four
   commits: v2 becomes the app, the Expo Router app is deleted, the APK
   workflow becomes a release build, and CI can build a connected APK.

   How it landed, where it differs from the sketch above:

   - v2 compiled against this branch's shared modules unchanged, so no v2
     source had to be rewritten. The branch's Play-readiness config is intact:
     `versionCode`, adaptive icon, splash, blocked permissions,
     `withReleaseSigning`, and the worklets override.
   - Removing `expo-router` and `react-native-screens` also removed
     `react-native-reanimated`, `react-native-worklets`,
     `react-native-gesture-handler` and `masked-view`, which existed only as
     expo-router's dependencies — six fewer native compiles per build, and no
     way to create an `RNSScreen` at all.
   - `src/data/services.ts` survived the removal by typing `href` as `string`
     instead of expo-router's `Href`, which is what all its values already
     were. `src/navigation/tabs.ts` and its test went: they asserted that the
     deleted `app/` route files exist, and v2 defines its own tabs.
   - The rest of the old `src/data` and `src/features` is deliberately kept as
     the porting source for step 3 — unreachable from `index.js`, so unbundled,
     but still typechecked and tested.
   - v2's colours had to be declared against this branch's token discipline.
     Two entries deserve a decision rather than a permanent exception: the
     delivery-PIN border wants a stronger line than `palette.line` and no token
     carries that weight, and `CatalogScreens`' accents belong to a placeholder
     merchant list.
   - **The vendor console needed no work.** The v2 branch's
     "Build approved Vendor operations console" (`4da0b81`) is already on this
     branch as `4dbfd05` — identical patch-id — and `b6933dc` (wordmark),
     `f75a3c0`, `880abc8` and `7b7f860` (handoff actions) are layered on top.
     This branch strictly supersedes the v2 branch's copy; nothing was ported.

   **The integrated build was then run on the A55** (29 September, 17:05).
   It compiles in 19m 22s against the previous 49m, 388 Gradle tasks against
   604, and the APK is 36 MB against 49 MB — the six native libraries really
   are gone. On the phone: Go Online works, ten rider-tab switches while
   online and repeated face switches leave the process alive, the crash buffer
   empty, and no `RNSScreen` or "child already has a parent" anywhere in
   logcat. The rider header shows the greeting for the actual hour and no
   longer claims a 4.9 rating over 128 trips it has never measured.
3. ~~**Port into v2, one at a time**~~ **Done** (29 September, cloud session
   on `claude/awesome-bardeen-95lgbd`). The table below is how it landed.
   Sources were the old app on this branch and its surviving data layer; no
   feature was reinvented.

| Feature | Old app | v2 now |
|---|---|---|
| Sign in by emailed code | `features/signIn.ts` | had it |
| Create account (emailed code) | `features/register.ts` | **ported** — `v2/auth/RegisterScreen.tsx` |
| Paystack checkout + return | `data/orders.ts` | **ported** — `v2/orders/CheckoutScreen.tsx` |
| Real order history + tracking | `(tabs)/orders.tsx` | wired; invented preview orders removed |
| Refund status on the order | `refundTone` | **ported** — `RefundSection` |
| Cart kept across launches | `features/CartProvider.tsx` | already worked; line names now come from the live storefront |
| Delete account (Play requirement) | `delete-account.tsx` | **ported** — `v2/account/DeleteAccountScreen.tsx` |
| Legal pages (Play requirement) | `legal/[slug].tsx` | **ported** — `v2/legal/LegalScreen.tsx` |
| Apply to ride | `rider-apply.tsx` | **ported** — `v2/rider/RiderApplyScreen.tsx` |
| Rider shift / offers / deliveries | `features/RiderShift.tsx` | `RiderFlowProvider` already complete |
| Rider earnings | — | **connected** — `/v1/rider/earnings` existed, nothing called it |
| Rider header name | — | **fixed** — first name from `/v1/auth/me`, greeting removed |
| Wordmark | `src/brand/Wordmark.tsx` | **fixed** — v2's rejected hand-drawn mark deleted; the approved measured one is rendered |
| Catalogue | `data/catalog.ts` | **fixed** — invented merchants, ratings and ETAs removed; honest empty/loading/not-connected states |
| Search | — | **connected** — `/v1/search` existed, nothing called it |
| Release signing, versionCode, permissions | `withReleaseSigning.js` | already intact |
| Launcher icon + splash | `scripts/brand-assets.ts` | already intact, generated from the measured geometry and test-verified |

   Per-screen detail, including what has no endpoint at all, is in
   [`V2-FEATURE-AUDIT.md`](V2-FEATURE-AUDIT.md). Customer-rider chat was
   **not** built; the report on what it would take is in
   [`../design/customer-rider-messaging.md`](../design/customer-rider-messaging.md).

4. **Build and inspect** a release APK from the integrated line (manifest,
   bundle markers, icons) before each device test.

Backend needs nothing new for any of the above; the API already serves it.
Paystack and Brevo secrets are not needed until the real end-to-end test
(mock payment and console email cover everything before that).

## Running it on the laptop

```bash
git fetch origin
git checkout claude/awesome-bardeen-95lgbd && git pull
npm ci && npm ci --prefix apps/mobile && npm run db:generate
npm test            # 2,542 pass on cd339f8
adb devices         # the A55 should be listed
```

`DATABASE_URL` in `.env` should end in `?connection_limit=1` for SQLite (see
`.env.example`).

### Building the APK: use WSL, not Windows

A native Windows Gradle build **cannot** produce this APK. It fails in
`:app:buildCMakeRelWithDebInfo` with
`ninja: error: Stat(...): Filename longer than 260 characters`, because React
Native's Fabric codegen mirrors each source file's full absolute path inside
the `.cxx` object tree, reaching ~389 characters. Shortening the repo root
(`subst`, a junction) saves only ~60 of those characters, so it cannot help.
This is a Windows `MAX_PATH` limit, not a defect in the app, and CI does not
hit it because CI is Linux.

Build in WSL2 instead, with the monorepo synced there (sync the whole repo, not
just `apps/mobile`, or the typecheck fails because `@dash/domain` and `vitest`
resolve through the root workspace install). Keep `adb` on the Windows side,
since the phone is attached to the host. On an 8 GB laptop the build is also
memory-bound: `--max-workers` alone does not help because ninja spawns one
clang per core, so cap WSL in `%USERPROFILE%\.wslconfig` (`processors=3`,
`swap=12GB`) or the Linux OOM killer will silently kill Gradle mid-build. A
full clean build takes roughly 50 minutes.

### What a device test can and cannot show today

The development APK has **no DASH API URL compiled into it** — the Account
screen says so on the device. Until a staging endpoint is supplied, on-device
testing can only exercise UI, navigation and offline/preview paths; sign-in,
ordering, payment and real dispatch cannot be verified on the phone, and the
rider stats stay placeholders. Treat any "works on the A55" claim as covering
the client only.

### What a device test can show now (updated 29 September, cloud session)

The sentence above still holds for a build with no API URL — but the "preview
paths" it refers to are gone. A disconnected build no longer shows invented
merchants, ratings, ETAs, orders or riders; every such screen now says it is
not connected and names `EXPO_PUBLIC_API_URL` as the build setting. So a
device test on a disconnected APK exercises navigation, theming, typography,
the wordmark, the launcher icon and the startup screen, and nothing else —
which is a narrower but honest surface than before.

**With `EXPO_PUBLIC_API_URL` set** at build time to a reachable DASH API with a
seeded database, the whole path is now exercisable on the phone: create an
account, confirm the emailed code, browse real vendors, add to cart, take the
server's quote, pay through Paystack, watch the order, see a refund, apply to
ride, read the Terms and Privacy Policy, and delete the account.

Paystack and Brevo keys are needed on the **server**, not in the app. The app
holds no secret: it opens whatever authorization URL the server returns.

### Cloud phase complete — what is left for the laptop

Nothing in this pass was verified on a device, and no such claim is made
anywhere in it. What the cloud could verify (typecheck, lint, the full test
suite, the brand-asset render check) is recorded in the commits. What it
could not:

1. Build the release APK in WSL2 (see above) and install it on the A55.
2. Confirm on the phone: the launcher icon and its adaptive/themed variants,
   the startup screen, the DASH wordmark in the header, the rider's first name
   in place of the greeting, and that nothing crashes.
3. With a staging API URL compiled in, walk the flow end to end, including a
   real Paystack test transaction.
4. `npx expo-doctor` — two of its 21 checks could not run in the cloud because
   the environment's network policy denies `cdp.expo.dev` and the React Native
   Directory. Both are remote-metadata checks, not project defects; re-run
   locally to confirm.
