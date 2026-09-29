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
2. **Integrate on the release line** (`claude/awesome-bardeen-95lgbd`):
   `apps/mobile` = v2 (`src/v2`, `assets/v2`, `index.js`, `main: index.js`,
   no `expo-router` plugin) + the release line's shared modules and fixes
   (lockfile/worklets override, `withReleaseSigning`, `versionCode`,
   blocked permissions, icon/splash via `npm run brand:assets`). Remove the
   old `app/` screens and, if nothing needs them, the `expo-router` and
   `react-native-screens` dependencies. Replace the old APK workflow with v2's
   release workflow and its bundle checks. Reconcile v2's vendor console
   (`apps/web/src/app/vendor/*`, `apps/api/src/routes/vendor.ts`) with the
   release line's later vendor changes (`7b7f860` handoff actions, `b6933dc`
   wordmark).
3. **Port into v2, one at a time**, in v2's existing screens and patterns,
   each with tests and a typecheck (sources are the old app on the release
   line):

| Feature | Old app (release line) | v2 today |
|---|---|---|
| Sign in by emailed code | `(customer)/sign-in.tsx`, `features/signIn.ts` | has it |
| Create account (emailed code) | `(customer)/register.tsx`, `features/register.ts` | missing |
| Paystack checkout + return | `(customer)/checkout.tsx`, `data/orders.ts` | quote + order only, no payment |
| Real order history + tracking | `(tabs)/orders.tsx`, `order/[id].tsx` | partial |
| Refund status on the order | `order/[id].tsx` (`refundTone`) | missing |
| Cart kept across launches | `features/CartProvider.tsx`, `cart.ts` | check |
| Delete account (Play requirement) | `(customer)/delete-account.tsx` | missing |
| Honest phone / no wallet or cash | `account.tsx`, `checkout.tsx` | v2 shows a Wallet tab — **product decision** before hiding |
| Legal pages | `legal/[slug].tsx` | missing |
| Apply to ride | `rider-apply.tsx` | missing |
| Rider shift / offers / deliveries | `features/RiderShift.tsx`, `rider/*` | has most; compare |
| Services from the API, bundled fallback | `data/services.ts`, `useServiceTiles.ts` | check |
| Release signing, versionCode, permissions | `plugins/withReleaseSigning.js`, `app.config.ts` | missing |
| Launcher icon + splash | `scripts/brand-assets.ts`, `assets/brand/*` | missing |

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
