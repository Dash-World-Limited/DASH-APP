# DASH APP — Play Store release candidate: status

Branch `claude/playstore-readiness`, based on `claude/native-mobile-v1`
(`88f7104`). `main` is untouched (local `eabaf72`, GitHub `43790ca`). Nothing
has been deployed. No real card has been charged. This page states what is
proven, what is built but unproven, and what blocks release — nothing more.

| Document | For |
|---|---|
| `ENVIRONMENT.md` | the Paystack and Brevo variables David enters, and where |
| `SIGNING.md` | creating the upload key and building a signed bundle |
| `PLAY-CONSOLE.md` | the Play Console steps, in order |
| `DATA-SAFETY.md` | Data Safety answers traced to the code |
| `STORE-LISTING-DRAFT.md` | listing text for David to edit |
| `PRIVACY-POLICY-DASH-APP-DRAFT.md` | a draft policy for the delivery app (not published) |
| `A55-TEST-SHEET.md` | the manual device test |

## Proven (with the evidence)

- **Automated suite:** 2,453 tests passing on `4f21045` (the pushed
  checkpoint), plus later native/app tests — re-run before every push. Lint,
  five typechecks, Prisma validation (SQLite and PostgreSQL schemas), SQLite
  migrations applied from zero with no drift, secret hygiene, a key-shape
  scan of the branch diff, and the key-custody drill all pass locally.
- **Android debug APK** (arm64, `com.dashworldng.dash.dev`) built locally from
  `33761dc`; JS bundle embedded; targetSdk 36.
- **Android release App Bundle** built locally from `29a9ff6` (staging
  variant): all four ABIs, targetSdk 36, minSdk 24, six permissions (location
  coarse/fine, internet, network state, vibrate, wake lock). Signed with the
  debug key — **verification only, not uploadable**.
- **Upload-key signing** switches on only with all four `DASH_UPLOAD_*`
  variables, proven with a throwaway keystore and `gradlew signingReport`.

## Built and tested against simulated providers — not yet run for real

- **Paystack** (test mode): real adapter, server-side verification, webhook
  signature/replay, the webhook-and-app race, retries, reconciliation —
  tested end to end through the API against an in-memory Paystack. **No
  request has been made to Paystack yet**; that needs David's `sk_test_` key.
- **Brevo** email: adapter tested against a simulated Brevo. **No real email
  has been sent**; needs a key and a verified sender.
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
2. **Brevo key and verified sender**, and one real code to an approved inbox.
3. **A reachable HTTPS API** for the release build (staging): PostgreSQL,
   Redis, migrations applied (`npm run db:pg:migrate`), reference data seeded
   (`npm run db:seed:reference` — this is also what fixes Declutters showing
   only "Everything": categories come from that seed).
4. **Application ID** `com.dashworldng.dash` confirmed (permanent after upload).
5. **Upload key** created by David; a signed bundle built with it.
6. **Legal documents for the delivery app.** The published Terms of Service
   *and* Privacy Policy describe only Declutters, yet signup asks every DASH
   customer to accept them. A DASH APP policy draft is here; Terms are not
   drafted. Both need David's approval (ideally legal review) and publishing
   as new versions.
7. **Store assets:** 512×512 icon, 1024×500 feature graphic, 2–8 real phone
   screenshots.
8. **The A55 manual pass**, with any failures fixed.
9. **CI green** on the pushed branch (check the Actions tab).
10. **Facts for the listing:** support email, launch area; Data Safety
    judgement calls marked "David to confirm".

## Deliberately not in this release

| Item | Why |
|---|---|
| Rides (passenger transport) | No foundations exist — no model, pricing, routes or screens. Not presented anywhere in the app |
| Cash on delivery, DASH Wallet, saved cards | Not built; hidden (no Wallet tab, no such payment options) |
| SMS / phone verification | Off (`SMS_ENABLED=false`); phones shown as unverified; the flag cannot be switched on while SMS is off |
| Automatic refunds | Owed refunds are recorded as `refund_pending_manual_review` and returned through Paystack by a person; nothing says "refunded" before Paystack confirms |
| Background rider location / push notifications | Rider reports and offers work only with the app open; offers are polled every 5 s, not pushed |
| Live map for the customer | Status and the rider's name/vehicle are shown; no map |
| Product photographs | The API cannot serve product images yet; designed placeholders are shown |
| DASH wordmark refinements (S rebalance, A-with-gold-dot options) | Not started; functional work came first |
| Declutters in the Android app | Declutters is the website; the app does not include it |
| Vendor tools in the app | Vendors apply at `/vendor/apply` and work in the web console |

## Known risks

- `npm audit` reports high advisories in development tooling (Prisma CLI,
  Next build, Vitest) — none in the deployed runtime path; see `SECURITY.md`.
  The CI dependency job will stay red until an owner decision or upgrades.
- Brevo bounces and complaints are not yet fed back into suppression (the
  existing suppression feed is SES-only).
- Offer polling every 5 s per online rider is fine for early access; it
  should move to the existing realtime socket or push before scale.
- Windows path length breaks local native builds under `Desktop\`; build from
  a short path (see `SIGNING.md`).
