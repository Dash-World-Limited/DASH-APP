# Google Play Data Safety — answers from the code as built

Every answer below is traced to what the DASH Android app (`apps/mobile`) and
its API (`apps/api`) do at commit `04a8e04` and later on
`claude/playstore-readiness`. If the code changes, these answers must be
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
| Location → Precise location | Yes | No (see note 2) | Optional for customers; required for riders while online | App functionality | customers: only when they tap "Use my current location" for an address; riders: every 20 s while Online **and the app is open**. No background location |
| Location → Approximate location | Yes | No | as above | App functionality | derived from the same readings |
| Financial info → Purchase history | Yes | No | Required to order | App functionality | orders, receipts |
| Financial info → Payment info (card numbers) | **No** | — | — | — | Entered on Paystack's own page; the app and API never see card details. Paystack is a service provider (note 3) |
| App activity → Other user-generated content | Yes | No | Optional | App functionality | order notes / delivery instructions |
| Photos and videos | **No** (Android app) | — | — | — | Declutters photo upload exists on the website, not in this app |
| Messages | **No** | — | — | — | No in-app chat; calls and texts use the phone's own dialler and messages app |
| App info and performance (crash logs, diagnostics) | **No** | — | — | — | No crash-reporting or analytics SDK is in the app |
| Device or other IDs | **No** | — | — | — | The app registers no push token and reads no advertising ID |

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

## Security practices section

- Data is encrypted in transit: **Yes**.
- You can request data deletion: **Yes** (in-app and at the web URL).
- Committed to Play Families Policy: **No** — DASH requires users to confirm
  they are 18 or older.
- Independent security review: **No** (do not claim one until it has happened).
