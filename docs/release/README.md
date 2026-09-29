# DASH APP — Play Store release candidate: status

Branch `claude/awesome-bardeen-95lgbd`: a fast-forward of
`claude/playstore-readiness` (`7b7f860`), which was based on
`claude/native-mobile-v1` (`88f7104`); both release branches run CI. `main` is
untouched (GitHub `43790ca`). Nothing has been deployed. No real card has been
charged. This page states what is proven, what is built but unproven, and
what blocks release — nothing more.

| Document | For |
|---|---|
| `ENVIRONMENT.md` | the Paystack and Brevo variables David enters, and where |
| `SIGNING.md` | creating the upload key and building a signed bundle |
| `PLAY-CONSOLE.md` | the Play Console steps, in order |
| `DATA-SAFETY.md` | Data Safety answers traced to the code |
| `STORE-LISTING-DRAFT.md` | listing text for David to edit |
| `PRIVACY-POLICY-DASH-APP-DRAFT.md` | a draft policy for the delivery app (not published) |
| `TERMS-DASH-APP-DRAFT.md` | draft Terms for the delivery app (not published) |
| `A55-TEST-SHEET.md` | the manual device test |

## Proven (with the evidence)

- **Automated suite:** 2,542 of 2,542 tests passing locally on 28 September
  (after this session's changes), re-run before every push. Lint, five typechecks, the mobile typecheck, Prisma
  validation (SQLite and PostgreSQL schemas), SQLite migrations applied from
  zero with no drift, secret hygiene, a key-shape scan of the branch diff,
  and the key-custody drill all pass locally.
- **End-to-end journey against a real API process** (`npm run e2e:journey`):
  31 of 31 steps on `64f6a2e` — a customer registers and orders, the vendor
  accepts and prepares, a rider is dispatched, collects with the pickup code
  and delivers with the customer's PIN, access control and account deletion
  hold. Mock payment and console email; a throwaway database.
- **Android debug APK** (arm64, `com.dashworldng.dash.dev`) built locally from
  `64f6a2e`, pointed at this PC's API over Wi-Fi for the A55 run; JS bundle
  embedded; targetSdk 36. It has not been installed on a phone yet.
- **Android release App Bundle** built locally from `29a9ff6` (staging
  variant): all four ABIs, targetSdk 36, minSdk 24, six permissions (location
  coarse/fine, internet, network state, vibrate, wake lock). Signed with the
  debug key — **verification only, not uploadable**.
- **Upload-key signing** switches on only with all four `DASH_UPLOAD_*`
  variables, proven with a throwaway keystore and `gradlew signingReport`.
- **CI on GitHub**, first read on 28 September: every run on the release line
  had been red. On `ed73a28` every job is green except the two in blocker 9:
  lint, typecheck, **the full test suite**, coverage thresholds, the
  key-custody drill and the business-critical suites; the fresh-database boot
  and retention dry run (red on `main` since 1 September); PostgreSQL
  migrations, PostGIS and Redis; the production build; secret scan and
  hygiene. Causes fixed: the native lockfile out of step with CI's npm, a
  retention step pointed at a database no step creates, a missing `prisma
  generate`, an Android SDK package that no longer exists, and SQLite
  lock-upgrade deadlocks between test transactions on a loaded runner.
  **The Android APK workflow is green for the first time** (`d077535`) and
  publishes an installable debug APK as a run artifact (arm64, development
  variant, with the new launcher icon and splash; kept 7 days).
- **Launcher icon, adaptive and themed icon, splash, Play icon and feature
  graphic** generated from the measured wordmark and checked through
  `expo prebuild` (blocker 7).

## Built and tested against simulated providers — not yet run for real

- **Paystack** (test mode): real adapter, server-side verification, webhook
  signature/replay, the webhook-and-app race, retries, reconciliation, and
  refund confirmation (`GET /refund/:id`, matched to our transaction by
  Paystack's transaction id), and the refunds still waiting on a person (owed
  over 48 hours, failed, or needs-attention at Paystack — reported by the
  maintenance job on every run until cleared, and flagged on `/ops/refunds`) —
  tested end to end through the API against an in-memory Paystack shaped from
  Paystack's published API docs. **No request
  has been made to Paystack yet**; that needs David's `sk_test_` key.
- **Brevo** email: adapter tested against a simulated Brevo. **No real email
  has been sent**; needs a key and a verified sender. Brevo's bounce and
  complaint webhook (`/v1/webhooks/brevo-events`) now feeds the suppression
  list — before, only SES's did, so in production nothing was ever
  suppressed. Tested with simulated Brevo events; needs `BREVO_WEBHOOK_TOKEN`
  and the webhook set up in Brevo (`ENVIRONMENT.md`).
- **The native flows** (registration, checkout, Paystack return, order
  tracking, rider shift/offer/delivery, deletion) typecheck and have unit
  tests for their logic; **none has run on a phone against a server yet** —
  that is the A55 sheet.
- **PostgreSQL + PostGIS + Redis:** a CI job now migrates a disposable
  database from zero and checks for drift. Its first run was triggered by the
  push of `4f21045`; its result is not visible from this machine (private
  repository, no GitHub CLI sign-in) — see the repository's Actions tab.

## Release blockers

1. **Paystack test key** in `.env`, and one real test-mode checkout end to end.
2. **Brevo key and verified sender**, and one real code to an approved inbox;
   and the bounce/complaint webhook configured with `BREVO_WEBHOOK_TOKEN`.
3. **A reachable HTTPS API** for the release build (staging): PostgreSQL,
   Redis, migrations applied (`npm run db:pg:migrate`), reference data seeded
   (`npm run db:seed:reference` — this is also what fixes Declutters showing
   only "Everything": categories come from that seed).
4. **Application ID** `com.dashworldng.dash` confirmed (permanent after upload).
5. **Upload key** created by David; a signed bundle built with it.
6. **Legal documents for the delivery app.** The published Terms of Service
   *and* Privacy Policy describe only Declutters, yet signup asks every DASH
   customer to accept them. Drafts of both for the delivery app are here. Both need David's approval (ideally legal review) and publishing
   as new versions.
7. **Store assets, launcher icon and splash screen.** Now configured and
   generated from the measured wordmark (`npm run brand:assets`): the launcher
   icon (legacy, adaptive and Android 13 themed), the splash, the 512×512
   Play icon and the 1024×500 feature graphic, checked through `expo prebuild`
   and held to the geometry by a test. Still needed: **David's approval** of
   the wordmark-only icon and feature graphic (or a dedicated symbol), his
   choice of **S rebalance** (options and one-command apply in
   `docs/design/boards/2026-09-13/wordmark/README.md`; the icons regenerate
   with one more command), and 2–8 real phone screenshots from the A55 pass.
8. **The A55 manual pass**, with any failures fixed.
9. **CI green.** Everything is green on `ed73a28` except two jobs no code
   change can fix: **Dependency audit** (high advisories in development
   tooling; an owner decision, see `SECURITY.md`) and **CodeQL** ("Code
   scanning is not enabled for this repository": enable code scanning in the
   repository's Settings → Code security; a private repository may need
   GitHub Advanced Security).
10. **Facts for the listing:** support email, launch area; Data Safety
    judgement calls marked "David to confirm".

## Deliberately not in this release

| Item | Why |
|---|---|
| Rides (passenger transport) | No foundations exist — no model, pricing, routes or screens. Not presented anywhere in the app |
| Cash on delivery, DASH Wallet, saved cards | Not built; hidden (no Wallet tab, no such payment options) |
| SMS / phone verification | Off (`SMS_ENABLED=false`); phones shown as unverified; the flag cannot be switched on while SMS is off |
| Automatic refunds | Owed refunds are recorded as `refund_pending_manual_review`; a person refunds in the Paystack dashboard and links the refund ID at `/ops/refunds`; DASH marks it refunded only when Paystack reports it processed for that payment and amount (see `docs/RUNBOOKS.md`, "Returning an owed refund") |
| Background rider location / push notifications | Rider reports and offers work only with the app open; offers are polled every 5 s, not pushed |
| Live map for the customer | Status and the rider's name/vehicle are shown; no map |
| Product photographs | The API cannot serve product images yet; designed placeholders are shown |
| DASH wordmark refinements | **S rebalance:** four measured options prepared, one command to apply, awaiting David's choice (the live S is unchanged; `docs/design/boards/2026-09-13/wordmark/README.md`). **A-with-gold-dot options:** not started |
| Declutters in the Android app | Declutters is the website; the app does not include it |
| Vendor tools in the app | Vendors apply at `/vendor/apply` and work in the web console |

## Known risks

- `npm audit` reports high advisories in development tooling (Prisma CLI,
  Next build, Vitest) — none in the deployed runtime path — plus a moderate
  `uuid` advisory reached through `firebase-admin`; 17 in all on 28 September,
  see `SECURITY.md`. The CI dependency job will stay red until an owner
  decision or upgrades.
- The development API on SQLite should use `?connection_limit=1` (now in
  `.env.example`); an older `.env` without it can deadlock two overlapping
  writes (see the A55 sheet). Production is PostgreSQL and unaffected.
- Brevo bounces and complaints feed suppression only once the webhook is
  configured in Brevo; until then nothing is suppressed.
- Offer polling every 5 s per online rider is fine for early access; it
  should move to the existing realtime socket or push before scale.
- Windows path length breaks local native builds under `Desktop\`; build from
  a short path (see `SIGNING.md`).
