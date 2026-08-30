# Architecture

How DASH APP is put together and why. For the *decisions* behind these choices —
including what each one costs and how to reverse it — see
[`docs/DECISIONS.md`](docs/DECISIONS.md). For what is actually built versus
stubbed, see [`docs/PROGRESS.md`](docs/PROGRESS.md).

**Status at `v0.1.0-mvp`:** local MVP. Runs end to end on one machine with no
external service. No integration has been tested against a live provider.

---

## The shape

```
                    ┌──────────────────────────────┐
                    │        apps/web              │
                    │  Next.js 15 · one app        │
                    │                              │
                    │  /browse /basket /orders     │  customer
                    │  /vendor                     │  vendor console
                    │  /rider                      │  rider app
                    │  /ops                        │  dispatch + finance
                    └──────────────┬───────────────┘
                                   │  JSON over HTTP
                                   │  Bearer access token
                    ┌──────────────▼───────────────┐
                    │        apps/api              │
                    │  Fastify 5 · Zod validation  │
                    │                              │
                    │  routes/    51 endpoints     │
                    │  http/      auth, errors,    │
                    │             idempotency      │
                    │  workers/   dispatch, refund │
                    │  adapters/  offline impls    │
                    └───────┬──────────────┬───────┘
                            │              │
              ┌─────────────▼───┐   ┌──────▼─────────────────┐
              │  packages/db    │   │  packages/domain       │
              │  Prisma · 46    │   │  pure · no I/O         │
              │  models         │   │                        │
              │  ledger posting │   │  money  geo  pay       │
              │  audit + redact │   │  orders pricing        │
              └─────────┬───────┘   │  dispatch ledger       │
                        │           │  permissions crypto    │
              ┌─────────▼───────┐   │  ports (interfaces)    │
              │  SQLite (dev)   │   └────────────────────────┘
              │  Postgres+      │
              │  PostGIS (prod) │
              └─────────────────┘
```

One rule explains most of the layout: **`packages/domain` has no I/O.** No
database, no network, no `new Date()` it did not receive as an argument. The
parts that must be provably correct — money, permissions, the order state
machine, pricing, dispatch scoring, the ledger — are pure functions, and
everything that can fail in the real world lives outside them.

---

## Workspaces

| Workspace | What it owns | Depends on |
|---|---|---|
| `packages/domain` | Business rules. Pure. | nothing but `zod` |
| `packages/db` | Prisma schema, seed, ledger posting, audit redaction | `domain` |
| `apps/api` | HTTP surface, auth, workers, adapters | `domain`, `db` |
| `apps/web` | All four user surfaces | `domain` (types + money formatting) |

Dependencies point one way only. `domain` cannot import `db`; `db` cannot import
`api`. That is enforced by there being no such import, not by tooling — a
dependency-cruiser rule is on the roadmap.

### `packages/domain`

| Module | Owns |
|---|---|
| `money` | Branded `Kobo` integer type, exact percentage math, safe allocation |
| `geo` | Haversine, ray-cast point-in-polygon, GPS jump detection, privacy coarsening |
| `crypto` | scrypt password/OTP hashing, SHA-256 token hashing, readable reference codes |
| `permissions` | 60 permissions, 12 roles, step-up auth, four-eyes, object-level scope |
| `orders` | 17-state machine with per-actor transition rules, cancellation policy |
| `pricing` | Deterministic explained quotes, surge, discounts, membership, settlement |
| `pay` | Rider pay: base, distance, approach, waiting, vehicle, surge share, floor, cap |
| `dispatch` | Explainable rider scoring, hard eligibility filters, offer rounds |
| `ledger` | Double-entry, append-only, zero-sum enforced before write |
| `ports` | Adapter interfaces for every external service, plus an injectable clock |

---

## The five rules that shape everything else

### 1. Money is an integer count of kobo, never a float

`₦1,500.00` is the integer `150000`. `Kobo` is a branded type, so a raw `number`
cannot become a price by accident. `percentOf` is implemented in pure integer
arithmetic — multiply, then integer-divide with an explicit half-up remainder
test — because a float path once lost a kobo on every commission calculation
(see bug 1 in `docs/PROGRESS.md`).

### 2. Balances are derived from an append-only ledger, never stored

No table has a mutable `balance` column. Every monetary movement is a
`LedgerTransaction` whose `LedgerEntry` rows must sum to exactly zero, asserted
in `assertBalanced()` before the write and again by
`GET /v1/finance/ledger/integrity`. Corrections are reversing transactions; the
original stays visible forever.

This is not ceremony. It caught two real money bugs before any money moved —
a free-delivery discount counted twice, and a negative vendor payable silently
clamped to zero.

### 3. Every client is untrusted

The client sends item ids, quantities, and modifier ids. It never sends a price,
a role, a permission, a fee, a discount, a surge multiplier, or a balance. All of
those are derived server-side in `priceBasket()` from the database. A request
body carrying `roles: ['super_admin']` changes nothing, because `buildActor()`
recomputes permissions from the identity's role rows.

### 4. Permission and ownership are separate checks

`assertPermission()` answers *"may you accept vendor orders?"*. `assertScope()`
answers *"is this order yours?"*. Both must pass. A cross-tenant probe throws an
`out_of_scope` error that the error handler renders as **404 Not found**, never
403 — a 403 confirms the record exists, which is exactly what an IDOR probe is
looking for.

### 5. Pricing, dispatch, and pay are deterministic and explained

Each returns not just a number but every factor that produced it, plus a
`ruleVersion`. Those are persisted with the order. A quote, an assignment, or a
rider's pay can be reconstructed and defended months later. There is no model
and no ML claim — these are rules engines that record the features a model would
one day need.

---

## Request lifecycle

```
request
  → genReqId          caller's X-Request-Id if it matches [\w-]{8,64}, else a UUID
  → helmet            strict CSP (this API serves no HTML), no-referrer
  → cors              explicit origin allowlist, never a reflected origin
  → rate limit        keyed by identity when authenticated, IP when not
  → route preHandler
      authenticate()  verify JWT, then REBUILD the actor from the database
      assertPermission()
  → handler
      load record
      requireScope()  object-level ownership — the IDOR defence
      domain call     pure function, returns an explained result
      persist         inside a transaction where more than one row changes
  → error handler     one shape: { error: { code, message, requestId } }
```

`authenticate()` deliberately hits the database on every request rather than
trusting the token's claims alone. That means a revoked session, a suspended
account, or a role removed a minute ago takes effect immediately instead of
after the 15-minute access-token TTL.

---

## Authentication

**At `v0.1.0-mvp` this is the weakest part of the system, and knowingly so.**

Today: access token in memory, refresh token in `sessionStorage`, sent as a JSON
body field. `sessionStorage` dies with the tab, which beats `localStorage`, but
it is still readable by any script on the origin.

Refresh-token rotation with reuse detection is already implemented in
`apps/api/src/auth/sessions.ts`: every refresh mints a new token and retires the
old one, and presenting a retired token revokes the entire session family
forward and backward. Losing a session is far cheaper than leaving a stolen one
live.

The production form — httpOnly `Secure` `SameSite` cookies plus CSRF protection
— is the next milestone. See [`ROADMAP.md`](ROADMAP.md) and
[`SECURITY.md`](SECURITY.md).

---

## Adapters

Every external dependency is an interface in `packages/domain/src/ports/` with a
deterministic offline implementation. Nothing here has been tested against a
live provider.

| Port | Default (dev) | Production target | Verified? |
|---|---|---|---|
| `PaymentPort` | `mock` — deterministic, signature-verified webhooks | Paystack | **No** |
| `GeoPort` | `local` — haversine + ray-casting | PostGIS / Google / Mapbox | **No** |
| `SmsPort` | `console` | Termii / Twilio | **No** |
| `EmailPort` | `console` | SMTP | **No** |
| `PushPort` | `console` | FCM / APNs | **No** |
| `StoragePort` | `local` — `./.storage`, signed-URL emulation | S3 / MinIO | **No** |
| `QueuePort` | `memory` — in-process, retries, backoff, dead-letter | Redis + BullMQ | **No** |
| `ClockPort` | `systemClock` | same | n/a |

The boot banner prints which adapters are live. If it says `payments=mock`,
nothing has ever charged a card. `apps/api/src/config.ts` refuses to start a
production process with any mock adapter selected.

---

## Data model

46 Prisma models. Authored to stay portable between SQLite (development) and
PostgreSQL + PostGIS (production), per ADR-0003:

- No SQLite-only features, no `Unsupported()` columns.
- Geometry is ordinary columns — `Float` lat/lng, JSON polygon rings — never a
  PostGIS `geography` type in the schema. Spatial logic lives behind `GeoPort`.
- Money is always `Int` (kobo). Never `Decimal`, never `Float`.
- Enums are `String` columns constrained by Zod at the boundary, because SQLite
  has no native enum.
- Every public identifier is a CUID. Sequential ids leak volume and invite
  enumeration.

Zone polygons carry a cached bounding box so serviceability rejects most zones
with a cheap comparison before running the exact point-in-polygon test.

---

## Dispatch

```
order paid ─┐
            ├─→ queue: dispatch.find_rider ─→ worker
vendor      ─┘                                  │
accepts                                         ├─ load candidate riders (broad)
(scheduled from                                 ├─ decideDispatch()  ← pure
 the prep estimate)                             │    hard filters, then scoring
                                                ├─ write DispatchOffer rows
                                                │    with the full factor breakdown
                                                └─ queue: dispatch.expire_round
                                                          (timeout + 2s)
                                                             │
                              rider accepts ─────────────────┤
                              (atomic claim: updateMany       │
                               guarded on riderId: null)      │
                                                              ├─ reoffer (next round)
                                                              └─ escalate to a human
                                                                 after 4 rounds
```

The candidate query is deliberately broad — the domain layer applies the hard
filters *and records why each rider was excluded*. Filtering in the query would
throw that away, and "no rider found" is unactionable where "all three were
zone-restricted" is a configuration fix.

Escalation to a human dispatcher is a first-class outcome, not a failure. An
order nobody accepted after four rounds appears on the ops board flagged as
unassigned rather than retrying invisibly forever.

---

## Money flow through one order

```
checkout          reserve rider pay (no rider exists yet → unowned pool)
  │               buildOrderCapture:
  │                 platform_cash        +total
  │                 customer_wallet      +walletApplied   (drawing down a liability)
  │                 promotion_expense    +platformFundedItemDiscount
  │                 vendor_payable       −vendorPayable
  │                 rider_payable        −reservedPay      (ownerId: null)
  │                 tax_payable          −tax
  │                 platform_revenue     −grossRevenue
  │                                      ─────────────────
  │                                      must sum to 0
  │
delivery          buildRiderAssignment:
  completes         rider_payable        +reservedPay      (release the pool)
                    rider_payable        −actualPay        (ownerId: riderId)
                    platform_revenue     ±difference       (the true-up)
```

Rider pay is reserved at capture so the money is committed the moment the
customer pays, then trued up on completion once the real approach distance,
waiting time, vehicle, and tip are known. The correction is a visible ledger
entry, never an edit to history.

Rider pay is computed from the trip and is **not** the customer's delivery fee.
The fee is what the market bears; the pay is what the work is worth. Coupling
them would let a surge discount quietly cut a rider's earnings.

---

## Testing strategy

| Layer | Tool | Count | Needs |
|---|---|---|---|
| Domain units | Vitest | 268 | nothing |
| Full journey + authz probes | `scripts/smoke.mjs` | 48 | running API, seeded DB |
| Dispatch loop | `scripts/dispatch-check.mjs` | 20 | running API, seeded DB |

Domain coverage is ~94% statements / ~95% branches, with thresholds enforced in
`vitest.config.ts` so erosion fails rather than passing quietly.

The suites are deliberately adversarial where it matters: cross-tenant sweeps,
self-promotion attempts, GPS spoofing, price tampering, discount stacking, promo
codes gamed to dodge fees, replayed webhooks, and money-conservation checks
across randomised orders.

**Gap:** the two script suites are not automated tests. They need a running
server and a seeded database, and are not wired into CI. Real API integration
tests against a test-scoped database are the next testing milestone.

---

## What this architecture does not yet do

- No websockets. Tracking, the vendor queue, and the ops board all poll.
- No CI.
- No horizontal scale story. The in-memory queue is per-process, so a second API
  instance would run its own dispatch worker and double-offer. Redis + BullMQ is
  the answer and the worker code is unchanged by it.
- No mobile apps. The rider surface is a responsive web app, not React Native.
- No PostGIS. The in-TypeScript geo path tests a city's zones in process —
  correct at Lagos zone counts (tens), not at national counts.
