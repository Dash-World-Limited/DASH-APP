# Business API endpoint matrix

Derived from the route files, not from intent. Source of truth:
`apps/api/src/routes/*.ts`.

**Legend**

- **Scope** — the object-level ownership check applied *after* the permission
  check. `—` means the endpoint takes no resource id, or is intentionally
  global for the roles that hold the permission.
- **Cov** — automated API integration coverage: ✅ covered, ⚠️ partial,
  ❌ none (script suites only).

A cross-tenant denial always renders as **404 `Not found.`**, never 403, so
probing cannot distinguish "exists but not yours" from "does not exist".

---

## Customer — orders and addresses

`apps/api/src/routes/orders.ts`

| Endpoint | Method | Permission | Scope | State transition | Cov |
|---|---|---|---|---|---|
| `/v1/addresses` | GET | `address:manage:own` | filtered by `actor.customerId` | — | ✅ |
| `/v1/addresses` | POST | `address:manage:own` | writes to `actor.customerId` | — | ✅ |
| `/v1/orders/quote` | POST | `order:create` | address must belong to caller; items must belong to the branch's vendor | — | ✅ |
| `/v1/orders` | POST | `order:create` | as above, **+ `Idempotency-Key` required** | `draft → payment_pending → placed` | ✅ |
| `/v1/orders` | GET | `order:read:own` | filtered by `actor.customerId` | — | ✅ |
| `/v1/orders/:id` | GET | `order:read:own` | `requireScope(customerId)` | — | ✅ |
| `/v1/orders/:id/cancel` | POST | `order:cancel:own` | `requireScope(customerId)` | `→ cancelled` (customer) | ✅ |

Notes:
- Prices, fees, discounts, surge, and the wallet balance are all derived
  server-side in `priceBasket()`. A client-supplied price is ignored.
- Cancellation eligibility and the fee come from
  `evaluateCustomerCancellation()`, which the state machine must agree with —
  asserted in `orders.test.ts` (they did not; see Bug 1).

---

## Vendor

`apps/api/src/routes/vendor.ts`

| Endpoint | Method | Permission | Scope | State transition | Cov |
|---|---|---|---|---|---|
| `/v1/vendor/orders` | GET | `vendor:order:read` | filtered by `actor.vendorId` (+ `branchId` when branch-bound) | — | ✅ |
| `/v1/vendor/orders/:id/accept` | POST | `vendor:order:accept` | `requireScope(vendorId, branchId)` | `placed/vendor_reviewing → accepted` | ✅ |
| `/v1/vendor/orders/:id/reject` | POST | `vendor:order:reject` | `requireScope(vendorId, branchId)` | `→ rejected`, queues refund | ✅ |
| `/v1/vendor/orders/:id/progress` | POST | `vendor:order:progress` | `requireScope(vendorId, branchId)` | `accepted → preparing → ready` | ✅ |
| `/v1/vendor/orders/:id/verify-pickup` | POST | `vendor:order:progress` | `requireScope(vendorId, branchId)` | — (verifies hashed code) | ✅ |
| `/v1/vendor/branch/:id/state` | PATCH | `vendor:hours:write` | `requireScope(vendorId)` | — | ✅ |
| `/v1/vendor/items/:id/availability` | PATCH | `vendor:inventory:write` | `requireScope(vendorId)` | — | ✅ |
| `/v1/vendor/reports/summary` | GET | `vendor:report:read` | filtered by `actor.vendorId` | — | ✅ |

Notes:
- Vendor-bound roles: `vendor_owner` ⊃ `vendor_manager` ⊃ `vendor_staff`.
- A role holding a vendor permission but **not** vendor-bound (only
  `super_admin` today) bypasses vendor scoping by design — the operational
  escape hatch. It is now recorded as `ops`, not `vendor` (see Bug 5).

---

## Rider and dispatch

`apps/api/src/routes/rider.ts`

| Endpoint | Method | Permission | Scope | State transition | Cov |
|---|---|---|---|---|---|
| `/v1/rider/availability` | POST | `rider:availability:set` | `actor.riderId` | — (clears location on `offline`) | ✅ |
| `/v1/rider/location` | POST | `rider:location:report` | `actor.riderId` | — (plausibility-checked) | ✅ |
| `/v1/rider/offers` | GET | `rider:offer:respond` | filtered by `actor.riderId` | — | ✅ |
| `/v1/rider/offers/:id/respond` | POST | `rider:offer:respond` | `requireScope(riderId)` | `ready → rider_assigned` (atomic claim) | ✅ |
| `/v1/rider/deliveries/:id` | GET | `rider:delivery:progress` | `requireScope(riderId)` | — | ✅ |
| `/v1/rider/deliveries/:id/progress` | POST | `rider:delivery:progress` | `requireScope(riderId)` | `rider_arrived → picked_up → en_route → arrived` | ✅ |
| `/v1/rider/deliveries/:id/complete` | POST | `rider:delivery:progress` | `requireScope(riderId)` **+ delivery PIN** | `→ delivered`, posts rider pay | ✅ |
| `/v1/rider/earnings` | GET | `rider:earnings:read:own` | filtered by `actor.riderId` | — | ✅ |

Notes:
- Offer acceptance uses `updateMany` guarded on `riderId: null`, which is what
  makes two simultaneous accepts resolve to exactly one winner.
- The exact drop-off address is withheld until the offer is accepted; before
  that only a 3-dp coarsened area is returned.

---

## Operations, support, finance, admin

`apps/api/src/routes/admin.ts`

| Endpoint | Method | Permission | Scope | State transition | Cov |
|---|---|---|---|---|---|
| `/v1/ops/live` | GET | `ops:livemap:read` | filtered by `actor.cityIds` | — | ✅ |
| `/v1/ops/orders/:id/reassign` | POST | `ops:dispatch:reassign` | `requireScope(cityId)` | `rider_assigned/rider_arrived → ready` | ✅ |
| `/v1/ops/zones/:id/pause` | POST | `ops:zone:pause` | `requireScope(cityId)` | — | ✅ |
| `/v1/ops/zones/:id/surge` | POST | `ops:surge:write` | `requireScope(cityId)` | — (capped by city rule) | ✅ |
| `/v1/support/cases` | GET | `support:case:read` | global for support roles | — | ✅ |
| `/v1/support/cases/:id/compensate` | POST | `support:compensation:issue` **+ step-up** | global for support roles | — (credits wallet) | ✅ |
| `/v1/finance/orders/:id/refund` | POST | `finance:refund:approve` **+ step-up** | global for finance roles | — (posts refund) | ✅ |
| `/v1/finance/ledger/integrity` | GET | `finance:ledger:read` | — | — | ✅ |
| `/v1/admin/audit` | GET | `admin:audit:read` | — | — | ✅ |
| `/v1/admin/feature-flags` | GET | `admin:featureflag:write` | — | — | ✅ |
| `/v1/admin/feature-flags/:key` | PATCH | `admin:featureflag:write` | — | — | ✅ |

Notes:
- Support and finance are **globally scoped by design** — a support agent works
  any customer's case. Their containment is the permission set plus step-up
  auth plus the audit log, not a tenancy boundary.
- `support:refund:request` and `finance:refund:approve` are deliberately
  separate: an agent cannot approve their own request.

---

## Public / unauthenticated

`apps/api/src/routes/catalog.ts`

| Endpoint | Method | Permission | Scope | Cov |
|---|---|---|---|---|
| `/v1/cities` | GET | none | live cities only | ✅ |
| `/v1/serviceability` | GET | none | — | ✅ |
| `/v1/vendors` | GET | none | approved vendors only | ✅ |
| `/v1/vendors/:slug` | GET | none | approved vendors only; never returns bank details or commission | ✅ |
| `/v1/search` | GET | none | approved vendors only | ✅ |

Covered by `catalog.test.ts` (30 tests) in the standard `npm test` run — no
running server required. Asserts that only live cities and approved vendors
appear, that commission and banking fields never leak, that an unapproved
vendor returns 404 rather than 403, that archived items are hidden while
unavailable ones stay visible and flagged, and that limits, cursors, and
search bounds are enforced rather than silently ignored.

## Webhooks

| Endpoint | Method | Auth | Cov |
|---|---|---|---|
| `/v1/webhooks/payments` | POST | provider signature; CSRF-exempt; replay-protected on `(provider, eventId)` | ✅ |

Covered by `webhooks.test.ts` (24 tests): missing, wrong, and post-signing
tampered signatures; duplicate and concurrent delivery of one event id;
provider-vs-record amount mismatch; unknown reference; malformed and empty
bodies; and that no rejection leaves partial order, payment, or ledger state.

Two properties worth naming because they are easy to get backwards:

* **The body's `amount` is not consulted.** The route re-asks the provider and
  compares that to the payment record, so a tampered body amount is irrelevant
  rather than merely rejected.
* **Webhook idempotency and financial idempotency are separate.** A new event
  id for an already-placed order is accepted as a new event and still moves no
  money, because the order state — not the event id — guards the ledger.

---

## Authentication and MFA

| Endpoint | Method | Auth | Notes | Cov |
|---|---|---|---|---|
| `/v1/auth/login` | POST | none | Staff receive an MFA challenge, **not** a session | ✅ |
| `/v1/auth/otp/request` | POST | none | Identical response whether or not the number exists | ✅ |
| `/v1/auth/otp/verify` | POST | none | Single-use, attempt-limited | ✅ |
| `/v1/auth/refresh` | POST | refresh cookie + CSRF | Rotates; reuse revokes the family | ✅ |
| `/v1/auth/logout` | POST | session | | ✅ |
| `/v1/auth/logout-everywhere` | POST | session | | ✅ |
| `/v1/auth/me` | GET | session | | ✅ |
| `/v1/auth/sessions` | GET | session | Own sessions only | ✅ |
| `/v1/auth/sessions/:id` | DELETE | session | Own sessions only; 404 otherwise | ✅ |
| `/v1/auth/mfa` | GET | session | Status only — never the secret | ✅ |
| `/v1/auth/mfa/enrol/start` | POST | challenge **or** session | Refuses if already enrolled | ✅ |
| `/v1/auth/mfa/enrol/confirm` | POST | challenge **or** session | Proves possession; issues recovery codes | ✅ |
| `/v1/auth/mfa/verify` | POST | challenge | TOTP or one recovery code, never both | ✅ |
| `/v1/auth/mfa/step-up` | POST | session | | ✅ |
| `/v1/auth/mfa/recovery/regenerate` | POST | session + step-up | Voids all unused codes | ✅ |
| `/v1/auth/mfa/disable` | POST | session + step-up | Revokes every session | ✅ |

The eight endpoints above with `none` or `challenge` auth are the only
state-changing routes in the API without a `preHandler` guard, and each is
deliberately so: they *are* the authentication surface. The webhook is the ninth,
authenticated by signature. A script rebuilds this list from the route code
during audit; nothing else was found unguarded.

## Vendor payout details

| Endpoint | Method | Permission | Scope | Cov |
|---|---|---|---|---|
| `/v1/vendor/payout-details` | GET | `vendor:settlement:read` | own vendor; masked to last four digits | ✅ |
| `/v1/vendor/payout-details` | PUT | `vendor:payout:write` **+ step-up** | own vendor; owner only | ✅ |

There is deliberately **no endpoint that reads the account number in clear**, and
no permission that would allow one. Decryption happens server-side in the
settlement path only.

## Health

| Endpoint | Method | Auth | Notes |
|---|---|---|---|
| `/health` | GET | none | Liveness. Touches no dependency, so a database blip cannot trigger a restart loop. |
| `/health/ready` | GET | none | Readiness. Dependency name and status only — no provider, host, version, or failure reason. 503 when not ready. |

## Coverage summary

| Area | Automated integration tests |
|---|---|
| Orders (customer) | 31 |
| Vendor workflow | 31 |
| Dispatch and rider | 40 |
| Finance and ledger | 28 |
| Staff / ops / admin | 29 |
| Authentication | 41 |
| Administrator MFA | 51 |
| Vendor payout details | 24 |
| Public catalogue and search | 30 |
| Payment webhooks | 24 |
| Retention job | 31 |
| Observability and health | 22 |
| Config guards | 40 |
| Rate limiting | 4 |

Every business and public endpoint above now has automated integration
coverage that runs in `npm test` and in CI without a manually started server.

`scripts/smoke.mjs` (49 checks) and `scripts/dispatch-check.mjs` (21 checks)
remain as supplementary end-to-end checks against a real listening server and
a full seed. They are no longer the only coverage for anything.
