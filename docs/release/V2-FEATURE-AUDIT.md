# DASH App (native v2) — feature audit

**12 October 2026**, on `claude/dash-app-production-release`, branched from
`feature/declutters-launch-readiness` at `609b7e6`. Read from the code, not
from earlier documents: every endpoint the app calls was matched against the
API's own route definitions. This replaces the 29 September audit, which
listed Wallet and chat as not built.

"Verified" here means **in code and tests**. Nothing on this page was run on
a phone in this pass; that is `A55-PRODUCTION-ACCEPTANCE.md`.

## Architecture

- Entry `apps/mobile/index.js` → `src/v2/App.tsx`: one React root, faces
  switched by state. No Expo Router, no `react-native-screens`, no native
  navigator — neither is a dependency, and the production bundle contains no
  `RNSScreen`.
- `AuthGate` is the front door: nothing behind it mounts until a session is
  restored. With no API address the app stops at sign-in.
- The API origin is compiled into the bundle (`src/api/buildConfig.ts`,
  written by CI) with Expo config and `EXPO_PUBLIC_API_URL` as fallbacks.

## Features

| Area | State | Endpoints | Notes |
|---|---|---|---|
| Sign-in, signup, session restore | Built | `/v1/auth/otp/request`, `/otp/verify`, `/signup`, `/email/verify`, `/email/resend`, `/refresh`, `/me`, `/logout` | Email-only (SMS off). Cold restore via refresh cookie; a network failure on restore shows "Could not reach DASH" with retry. A server-sent dev code is never shown in a production build |
| Customer Home, six categories | Built | — | Food, Shops, Pharmacy, Local Market, Declutter, Logistics |
| Catalogue, store, product | Built | `/v1/vendors`, `/v1/vendors/:slug` | Honest empty/not-connected/error states; no invented merchants. Products show category artwork, not product photos |
| Search | Built | `/v1/search` | Two-character minimum, debounced |
| Cart | Built | — | Persists across launches; one merchant per cart |
| Checkout, addresses | Built | `/v1/addresses`, `/v1/orders/quote`, `/v1/orders` | Server quote only; idempotency key per attempt; address position from the phone's location |
| Paystack payment, return, retry | Built | `/payment/verify`, `/payment/retry` | Opens Paystack's page; checks on return to the foreground; "Pay again" only where the outcome allows |
| Orders, tracking, cancellation, refunds | Built | `/v1/orders`, `/v1/orders/:id`, `/cancel` | Live map once a rider reports a position, joined to the address by a dashed straight line (no routing provider; no drawn route); refunds in the server's wording, green only once Paystack confirms |
| DASH Wallet | Built (read-only) | `/v1/wallet` | Balance and last 50 ledger entries. No top-up or spending from the app |
| Customer ↔ rider order chat | Built | `/v1/orders/:orderId/chat`, `/chat/messages` | Order-scoped: only the order's customer and its assigned rider; from rider assignment; read-only once closed. Polled, not pushed |
| Rider application and approval | Built | `/v1/rider/applications`, `/v1/rider/application` | The Rider face is locked unless the server says `approved` |
| Rider online/offline | Built | `/v1/rider/availability`, `/v1/rider/location` | One live workspace (map + state panel; see `RIDER-EXPERIENCE.md`). Foreground GPS, high accuracy, at most every 5 s; a fix at least every 20 s even when stationary, so dispatch and the 15-minute online lease stay fresh. No background location |
| Rider offers | Built | `/v1/rider/offers`, `/offers/:id/respond` | Polled every 8 s while online and on return to the app; no manual check needed. Countdown from the server's `expiresAt`; drop-off is an approximate area until acceptance. A banner shows an open offer on every other rider screen |
| Pickup, delivery, PIN | Built | `/v1/rider/deliveries*`, `/progress`, `/complete` | Accepting turns the same screen into the journey: step bar, destination, Navigate (hands off to the phone's maps app), pickup code while awaiting collection, customer call/chat after acceptance, then the customer's 4-digit PIN |
| Rider earnings and history | Built | `/v1/rider/earnings`, `/v1/rider/history` | From the payout ledger. Rider Home shows the real balance owed; its former hard-coded "Today's Earnings" and "Current Zone" figures are gone |
| Declutters feed and detail | Built | `/v1/declutter/listings`, `/listings/:slug` | **The same endpoints and the same server filter as the website** (approved, available or reserved; newest first). No second catalogue. Limit: the app loads the 40 newest with no "load more" |
| Account deletion | Built | `POST/GET/DELETE /v1/account/deletion` | Cooling-off period, cancellable |
| Terms and Privacy | Built | `/v1/legal/:slug` | Server-published, versioned; reachable from sign-up and Account |
| Customer Support tab | Not built | — | `/v1/support/cases` is staff-only. The tab says so |
| Notifications list, push | Not built | — | No push SDK; no device token registered |
| Logistics booking | Not built | — | The category says booking is not open |

## Build and identity

| | |
|---|---|
| App icon, adaptive icon, Android 13 monochrome | Generated from the measured wordmark; `npm run brand:assets -- --check` passes; adaptive ink inside the 66 dp safe circle (tested) |
| Splash | Wordmark on `#F8F7F2`, 176 dp wide (inside Android 12's 192 dp mask) |
| Maps | MapLibre. Development/staging default to OpenFreeMap Liberty; production must supply `EXPO_PUBLIC_MAP_STYLE_URL` |
| Package ids | `com.dashworldng.dash` (production), `.staging`, `.dev` |
| Version | `DASH_VERSION_CODE` / `DASH_VERSION_NAME` — required for production, default `1` / `0.1.0` otherwise |
| Signing | Upload key via `DASH_UPLOAD_*`; production fails without it (see `PRODUCTION-AAB.md`) |
| Requested permissions (production main manifest) | `INTERNET`, `ACCESS_COARSE_LOCATION`, `ACCESS_FINE_LOCATION`; libraries add `ACCESS_NETWORK_STATE`. Blocked: background location, foreground service, boot, biometrics, overlay, storage, vibrate |

## Found and fixed in this pass

- **Invented data in every bundle.** The rider preview mode — "Urban
  Bites", "Chevron Drive", order `DASH782910`, PIN `2468`, fake history — was
  unreachable but compiled in. Removed; the production bundle now carries
  none of the thirteen strings the base branch's did.
- **Dev sign-in code.** A production build no longer displays one, whatever
  the server sends.
- **Pickup code.** The vendor console asks the rider for it; v2 never showed
  it. Restored, including after a relaunch.
- **VIBRATE** permission from Expo's template, unused — blocked.
- **Staging workflow's navigation check could never fail** (`! grep` under
  `set -e`). Fixed.
- **No production build path.** Added, fail-closed (`PRODUCTION-AAB.md`).

## Rider pass (12 October)

- **Fabricated routes.** The rider route screen and customer tracking drew
  road-like lines that no routing service computed. Both now show a dashed
  straight bearing line, and the rider gets a Navigate hand-off.
- **Five disconnected rider pages** merged into one live workspace.
  Accepting an offer turns into the journey on the same screen.
- **Manual "Check for orders now"** while polling was already running,
  plus a dead "Preview an incoming order" button. Replaced by an automatic
  searching state with a real "checked Ns ago" and a small Refresh link.
- **Hard-coded Rider Home figures** replaced by the payout ledger's balance.
- **Stationary riders dropped offline.** No GPS fixes without 5 m of
  movement meant a stale position after 2 minutes and a lapsed online lease
  after 15. Fixed with a 20-second heartbeat fix.
- **Offers visible only inside the online page.** Now a banner on every
  other rider screen.

## Found and not changed

- **`chatgpt/a55-rider-polish`** (18 commits) was triaged commit by commit
  in `RIDER-EXPERIENCE.md`. Nothing was merged. DASH tones are deferred to
  v1.1 (new native audio dependencies, likely `RECORD_AUDIO`). Two-way
  calling is deferred pending a privacy decision, because it would send the
  rider's personal number to customers. The workspace rebuild and its CI
  workflows are obsolete. The last staging APK (run 57) was built from that
  branch, not this one.
- **Declutters shows at most 40 listings** in the app.
- **Product photographs** are not shown; category artwork stands in.
