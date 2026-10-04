# Cloud phase handoff — 29 September 2026

For the next local session. Pull this branch and you have the exact state
described below.

| | |
|---|---|
| **Branch** | `claude/awesome-bardeen-95lgbd` |
| **Head** | `c839724` — *Close the Paystack return path, and let a customer cancel* |
| **Started from** | `4644073` — *Record that the integrated app was run on the A55* |
| **Commits added** | 11, all pushed |
| **Working tree** | clean |

```bash
git fetch origin
git checkout claude/awesome-bardeen-95lgbd && git pull
npm ci && npm ci --prefix apps/mobile && npm run db:generate
```

`npm run db:generate` is not optional: without the Prisma client, `apps/api`
and `packages/db` fail to typecheck with dozens of spurious "implicitly has an
any type" errors that look like real defects and are not.

## Verification, all run in this container at `c839724`

| Check | Result |
|---|---|
| `npm run typecheck` | **5 projects clean** — domain, db, api, web, mobile |
| `npm run lint` | **clean** |
| `npm test` | **2,556 passing**, 117 files, 0 failing (was 2,542) |
| `npx vitest run apps/mobile` | **139 passing**, 14 files |
| `npm run brand:assets -- --check` | **Brand images match the wordmark geometry** |
| `npx expo-doctor` | **19/21** — see below |

**expo-doctor's two failures are this container's network policy, not the
project.** "Check Expo config schema" and "Validate packages against React
Native Directory" both fetch remote metadata, and the environment denied
`cdp.expo.dev` (403 on CONNECT). Re-run locally to confirm. To let a cloud
session run them, the environment's Network access setting would need
`cdp.expo.dev` and `reactnative.directory` allowed.

## The 11 commits

| Commit | What |
|---|---|
| `22c0b2a` | The approved wordmark, and the rider's own first name |
| `21302e8` | Import v2's category artwork instead of `require`-ing it (lint was red) |
| `0928d45` | Stop showing invented merchants, ratings and delivery times |
| `adbf59e` | A real checkout, and refunds on the order |
| `a5a513a` | Port registration, deletion, legal and rider apply |
| `f1d8ece` | Report what customer↔rider messaging would take, and build none of it |
| `59b3d85` | Connect rider earnings; stop implying a wallet exists |
| `22c00c6` | Update the v2 handoff, add the feature audit |
| `976e022` | Pin that the four ported screens are reachable |
| `2d52e16` | A checkout address is one control, not a button inside a radio |
| `c839724` | Close the Paystack return path, and let a customer cancel |

## What was asked, and what happened

**1. Release-critical v2 features.** All ported, from the old app on this
branch and its surviving data layer — nothing reinvented. Create account,
Paystack checkout, account deletion, legal pages, rider application, refunds.
The Paystack path also got its return half: check payment, pay again,
cancellation and the delivery PIN. Per-feature detail in
[`V2-FEATURE-AUDIT.md`](V2-FEATURE-AUDIT.md).

**2. API integration.** The `EXPO_PUBLIC_API_URL` wiring already existed and
was correct end to end; nothing needed changing. The audit found one endpoint
built but uncalled (`/v1/rider/earnings`) and one more (`/v1/search`) — both
now connected. No secret is read on the device.

**3. Rider header.** Greeting and "DASH Rider" removed. It shows the rider's
first name from `/v1/auth/me` and nothing when the server has no name.

**4. Customer↔rider messaging.** Not built, deliberately. Two corrections to
the premise are in [`../design/customer-rider-messaging.md`](../design/customer-rider-messaging.md):
the Message action opens **SMS, not WhatsApp**, and the only WhatsApp in the
codebase belongs to Declutter's admin-mediated contact disclosure. No chat has
ever existed in any branch. The report covers what building it would take.

**5. DASH wordmark.** v2's hand-drawn mark — which the September board study
explicitly rejected — is deleted. v2 renders the approved measured mark, the
same one the brand rule says is the only one the app may draw. Its S is not
scaled or offset, and all four letters share the geometry's 0-to-100 cap
height and baseline.

**6. App icon** and **7. Startup experience.** Already complete before this
session, in `1098e35`. Verified, not rebuilt: `icon.png`, `adaptive-icon.png`,
`adaptive-icon-monochrome.png` (1024² each) and `splash-icon.png` are
generated from the measured wordmark geometry in the approved graphite, bronze
and ivory, `app.config.ts` wires all of them, and a test renders the geometry
fresh and compares pixel for pixel — plus checks every inked pixel of the
adaptive icon stays inside the 66 dp safe circle.

**8. Catalogue.** Urban Bites, Mama's Kitchen and the rest are gone, with
their ratings and ETAs, and nothing replaced them. Every catalogue screen now
reports what it knows: not-connected, loading, the server's error, or a
genuinely empty category.

**9. Core flow.** See the split below.

**10/11.** Eleven small commits, each validated before the next.

## What the cloud verified, and what it did not

**Verified here:** that every project typechecks, that lint is clean, that
2,556 tests pass, that the brand images still match the wordmark geometry, and
that the client calls the endpoints the API actually serves — every path in
the audit was checked against the route table rather than assumed.

**Not verified here, and not claimed anywhere:** nothing was run on a device.
No APK was built. Nobody has looked at the launcher icon, the startup screen,
the wordmark on a real display, the rider header on a phone, a real Paystack
transaction, a runtime permission prompt, or crash behaviour. The API was
never actually contacted — there is no server running in this container, so
every request path is verified by reading the route definitions and by the
client's own tests against a fake, not by a live round trip.

## What must now be done locally

1. **Build the release APK in WSL2.** Not native Windows — the Fabric codegen
   path exceeds `MAX_PATH`. See the build notes in
   [`V2-HANDOFF.md`](V2-HANDOFF.md).
2. **Install on the A55** after uninstalling the old app.
3. **Look at the things only eyes can check:** launcher icon (and its themed
   and adaptive variants), startup screen, the DASH wordmark in the header —
   specifically that the S is neither oversized, clipped, nor crowding the A —
   and the rider header showing a first name.
4. **Build again with `EXPO_PUBLIC_API_URL`** pointed at a reachable DASH API
   with a seeded database, then walk the whole flow: register, confirm the
   emailed code, browse, cart, quote, pay through Paystack, return to the app,
   watch the order, cancel one to see the refund wording, apply to ride, read
   both legal documents, delete the account.
5. **Re-run `npx expo-doctor`** to clear the two network-blocked checks.

## Decisions waiting on you

- **The S rebalance.** Four options were prepared on 28 September
  (`measured`, `symmetric`, `lighter`, `lighter-symmetric`) and none applied,
  because a rebalance is a design choice and not a measurement error. The live
  mark is the measured S. Applying a choice is one command plus regenerating
  the brand images — see the wordmark README.
- **The bronze bar in the A's counter.** Present in four of five board
  appearances, and the smallest feature measured. The README asks you to
  confirm it is intended.
- **The Wallet tab.** There is no wallet API and no plan recorded for one. The
  tab now says a balance is not available. Either it gets a milestone or the
  tab should go.
- **Customer↔rider chat.** Build it as its own milestone, or keep SMS. Note the
  caveat in the report: SMS puts both real phone numbers on each other's
  handsets, which the platform is otherwise careful to avoid.
- **In-app support.** `/v1/support/cases` is administrator-only. A customer
  support screen needs a customer-facing endpoint first.

## Configuration and secrets needed (none of it in the app)

- **`EXPO_PUBLIC_API_URL`** — build-time, public, not a secret. Without it the
  app is honest about being unconnected; with it everything works.
- **Paystack and Brevo keys** — on the **server**, never in the app. The app
  only opens whatever authorization URL the server returns.
- **`GOOGLE_MAPS_ANDROID_API_KEY`** — build-time, restricted by package
  signature rather than secrecy. Absent today, so the rider map shows its
  designed "unavailable" state instead of a grey rectangle.
- **`DASH_UPLOAD_*`** — the Play upload key, for a signed release. See
  [`SIGNING.md`](SIGNING.md).

None of these was requested in chat, and none is stored in the repository.

## Still only in git history

Recoverable at `ad3b944^` if wanted; deliberately not ported, because v2 has
its own equivalents or the feature has no home yet:

- The Expo Router home, shops landing and service pages — v2 has its own home.
- `screens/SettingsSection.tsx` and the settings routes — v2's Account screen
  covers what they did.
- `features/RiderShift.tsx` — superseded by `RiderFlowProvider`.
- `ui/AppBar.tsx`, `ui/TabBar.tsx`, `ui/ComingScreen.tsx` — v2 draws its own.
- The customer notifications screen — a stub either way; there is no endpoint.
