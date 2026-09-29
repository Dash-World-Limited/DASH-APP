# v2 feature audit: every screen against every endpoint

29 September 2026, on `claude/awesome-bardeen-95lgbd`.

Every v2 screen that was empty or inactive, checked against the API's actual
route table, and sorted into the three cases that matter:

- **Wired, waiting on an origin** — the client code is complete and the screen
  works the moment `EXPO_PUBLIC_API_URL` points at a server.
- **Endpoint existed, not connected** — a real backend route nothing was
  calling. These were connected in this pass.
- **Not built** — no endpoint exists. Documented, not faked.

## How the API origin reaches the app

There is nothing left to wire. The path is:

```
EXPO_PUBLIC_API_URL                       (build environment)
  → app.config.ts  extra.apiUrl           (baked into the native build)
  → src/api/index.ts  normaliseBaseUrl()  (http(s) only, trailing slash trimmed)
  → createApiClient({ baseUrl })
```

`src/api/index.ts` falls back to `process.env.EXPO_PUBLIC_API_URL` because the
web build's manifest carries the key without the string. `normaliseBaseUrl`
returns `null` for anything that is not an http(s) origin, and a null base URL
makes `api.configured` false — which is the single flag every screen branches
on. No secret is read on the device, and no origin is hardcoded anywhere.

## The audit

| Screen | Case | Endpoint | Note |
|---|---|---|---|
| Sign in / session | Wired | `/v1/auth/otp/request`, `/otp/verify`, `/auth/me`, `/auth/refresh`, `/auth/logout` | Was already complete. |
| Create account | **Connected this pass** | `/v1/auth/signup`, `/auth/email/verify`, `/auth/email/resend` | Logic and tests existed in `features/register.ts`; no screen called them. |
| Catalogue, storefront, product | **Connected this pass** | `/v1/vendors`, `/v1/vendors/:slug` | Was calling them, but fell back to invented merchants on any error. |
| Search | **Connected this pass** | `/v1/search` | The endpoint existed and nothing called it; search was a local filter over fabricated data. |
| Cart | Wired | — | Local, by design; the server owns prices. Line names now resolve from the merchant's storefront. |
| Checkout + Paystack | **Connected this pass** | `/v1/addresses`, `/v1/orders/quote`, `/v1/orders`, `/payment/verify`, `/payment/retry` | All of `data/orders.ts` existed with tests; the screen was a dead end. |
| Order history | Wired | `/v1/orders` | Previews removed. |
| Order tracking | Wired | `/v1/orders/:id` | Previews removed. |
| Refund status | **Connected this pass** | `/v1/orders/:id` (`refunds[]`) | Server already sent it; nothing rendered it. |
| Legal documents | **Connected this pass** | `/v1/legal/:slug` | Play requires both in-app. |
| Delete account | **Connected this pass** | `POST`/`GET`/`DELETE /v1/account/deletion` | Play requires this in-app. |
| Rider application | **Connected this pass** | `POST /v1/rider/applications`, `GET /v1/rider/application` | |
| Rider shift, offers, deliveries | Wired | `/v1/rider/availability`, `/offers`, `/offers/:id/respond`, `/deliveries*`, `/location` | `RiderFlowProvider` was already complete. |
| Rider earnings | **Connected this pass** | `/v1/rider/earnings` | Showed a hardcoded ₦0 over three hardcoded ₦0 metrics. |
| Rider header name | **Connected this pass** | `/v1/auth/me` | Showed a greeting and "DASH Rider". |
| Customer Wallet | **Not built** | — | No wallet API exists. `POST /v1/support/cases/:id/compensate` issues wallet credit administratively, but there is no customer-facing balance, top-up or ledger route. Screen now says a balance is not available and explains how payment and refunds actually work. |
| Customer Support | **Not built** | — | `/v1/support/cases` is an administrator route behind `support:case:read`. No customer-facing case creation or listing exists. |
| Notifications (in-app list) | **Not built** | — | No notification endpoint. |
| Push notifications | **Not built** | — | `expo-notifications` is not a dependency, there is no device-token table, and no FCM sender. `/v1/devices` exists but is not push registration. |
| Rider Inbox | **Not built** | — | No operational-messaging endpoint. |
| Customer ↔ rider chat | **Not built** | — | See `docs/design/customer-rider-messaging.md`. SMS fallback retained. |
| Logistics booking | **Not built** | — | No quote-a-journey endpoint. The category now says booking is not open rather than listing invented couriers. |
| Saved addresses (Account) | Endpoint exists, not surfaced | `/v1/addresses` | Reachable through checkout, which lists and creates them. A dedicated Account screen is still a stub. |
| Payment methods (Account) | **Not built** | — | Paystack holds the instrument; DASH stores no card. The row is a stub. |
| Maps on rider screens | Wired, needs a key | — | `GOOGLE_MAPS_ANDROID_API_KEY` is absent, so `mapsConfigured` is false and the app shows a designed "map unavailable" state rather than a grey rectangle. |

## What this means for a device test

With `EXPO_PUBLIC_API_URL` set to a reachable DASH API and a seeded database,
the whole customer and rider path is now exercisable on the phone: create an
account, sign in, browse real vendors, add to cart, quote, pay through
Paystack, watch the order, see a refund, apply to ride, read the legal
documents and delete the account.

Without it, every one of those screens says it is not connected and names the
build setting. None of them shows invented data any more.
