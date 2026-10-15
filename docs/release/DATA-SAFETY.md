# Google Play Data Safety — answers from the code as built

Every answer below is traced to what the DASH Android app (`apps/mobile`) and
its API (`apps/api`) do on `claude/dash-app-production-release` as of
15 October 2026 (re-checked after push notifications were added; on
12 October after order chat and the DASH Wallet; the 29 September version of
this page said there was no in-app messaging, which is no longer true). If the code changes, these answers must be
re-checked before the next upload. Items marked **David to confirm** are
judgement calls about Google's definitions, not facts about the code.

## Overview questions

| Question | Answer | Why |
|---|---|---|
| Does the app collect or share any of the required user data types? | **Yes** | Account details, delivery addresses, location, orders |
| Is all user data collected by the app encrypted in transit? | **Yes** | Release builds refuse cleartext HTTP (`usesCleartextTraffic` is only enabled in debug builds); the production API must be served over HTTPS, and config refuses a non-HTTPS `PUBLIC_WEB_URL` in production |
| Do you provide a way for users to request that their data is deleted? | **Yes** | In-app: Account → Delete account. Web: `/delete-account`. 14-day cooling-off, cancellable |

## Data types

| Category → type | Collected | Shared | Required? | Purposes | Where in the code |
|---|---|---|---|---|---|
| Personal info → Name | Yes | No | Required | App functionality, Account management | signup (`/v1/auth/signup`) |
| Personal info → Email address | Yes | No | Required | App functionality, Account management, Developer communications | sign-in codes, verification, application decisions |
| Personal info → Phone number | Yes | No (see note 1) | Required | App functionality | signup; address contact phone for the rider. **Stored unverified**; no SMS is sent |
| Personal info → Address | Yes | No (see note 1) | Required to order | App functionality | `/v1/addresses` (street, landmark, coordinates) |
| Personal info → Other info | Yes | No | Required | Analytics | signup profile: state, city/area, how they plan to use DASH, how they heard of it — self-reported, no decision depends on it |
| Location → Precise location | Yes | No (see note 2) | Optional for customers; required for riders while online | App functionality | customers: when they save a delivery address (the address's position is the phone's); riders: high-accuracy GPS at most every 5 s / 5 m while Online **and the app is open**. No background location — `ACCESS_BACKGROUND_LOCATION` is blocked in the manifest |
| Location → Approximate location | Yes | No | as above | App functionality | derived from the same readings |
| Financial info → Purchase history | Yes | No | Required to order | App functionality | orders, receipts |
| Financial info → Other financial info | Yes | No | Not required | App functionality | DASH Wallet: balance and ledger entries (refund credits, compensation) shown read-only at `/v1/wallet`; riders: earnings from the payout ledger |
| Financial info → Payment info (card numbers) | **No** | — | — | — | Entered on Paystack's own page; the app and API never see card details. Paystack is a service provider (note 3) |
| App activity → Other user-generated content | Yes | No | Optional | App functionality | order notes / delivery instructions |
| Photos and videos | **No** (Android app) | — | — | — | Declutters photo upload exists on the website, not in this app |
| Messages → Other in-app messages | **Yes** | No (see note 5) | Optional | App functionality | Order chat between a customer and the rider assigned to their order (`/v1/orders/:orderId/chat`). Stored on DASH's servers; only those two participants can read or send. "Call customer" uses the phone's own dialler and DASH records nothing about the call |
| App info and performance (crash logs, diagnostics) | **No** | — | — | — | No crash-reporting or analytics SDK is in the app |
| Device or other IDs | **Yes** | No (see note 6) | Optional | App functionality | The Firebase Cloud Messaging push token, registered with DASH (`POST /v1/devices`) only after the person allows Android notifications, so DASH can send order, delivery, message and support notifications. No advertising ID is read (`AD_ID` is not in the manifest) |

Marketing email is sent only to people who opt in at signup; if you declare
"Marketing" as a purpose for Email address, it is optional.

## Notes

1. **Riders and vendors see some of a customer's data** — the rider sees the
   delivery address and the contact phone after accepting an order; the
   vendor sees the order. Google treats a transfer the user initiates and
   expects (placing a delivery order) as *not* sharing. **David to confirm**
   that reading applies; if in doubt, declare Address and Phone number as
   "Shared" with purpose "App functionality" — over-declaring is safe,
   under-declaring is a policy violation.
2. **A rider's position is visible to the customer** whose order they carry,
   while it is on the way (`GET /v1/orders/:id`). Same reasoning as note 1;
   **David to confirm**.
3. **Paystack** processes payments on DASH's behalf. Service providers are
   not "sharing" in Google's definition. Paystack receives the order amount,
   a reference, and the customer's verified email (for the receipt).
4. **Email delivery** goes through Brevo (a service provider) when
   `EMAIL_PROVIDER=brevo`.
5. **Order chat** carries messages between two users of the app about the
   order one is delivering to the other. That is a user-initiated exchange
   between the parties, which Google's guidance does not count as
   "sharing" — **David to confirm**, and if in doubt declare it shared for
   App functionality. Whether DASH staff can read chats, and how long they
   are kept, must match what the Privacy Policy says before launch.
6. **Push notifications** go through Firebase Cloud Messaging, which Google
   operates as a service provider to deliver them — not "sharing" in Google's
   definition. A push carries a short fixed sentence ("Order picked up", "New
   message from your rider") and identifiers (an order, offer or support
   conversation id). It never carries a name, address, phone number, amount,
   bank detail or the words of a message
   (`packages/domain/src/push`, enforced by an allowlist). The token is
   cleared when the person signs out, deletes their account, or the token
   stops working. See `docs/release/PUSH_NOTIFICATIONS.md`.

## Security practices section

- Data is encrypted in transit: **Yes**.
- You can request data deletion: **Yes** (in-app and at the web URL).
- Committed to Play Families Policy: **No** — DASH requires users to confirm
  they are 18 or older.
- Independent security review: **No** (do not claim one until it has happened).
