# Progress

Updated at the end of every milestone. If you are picking this up cold, read
this file first, then `docs/DECISIONS.md`.

**Last updated:** 2026-08-30 · end of Milestone 2 (API and data layer)

---

## How to run what exists right now

```bash
npm install && npm run db:generate && npm run db:push && npm run db:seed
```

Then start the API:

```bash
npm run dev:api
```

And, in a second terminal, walk the whole platform end to end:

```bash
node scripts/smoke.mjs
```

That places a real order, has the vendor accept it, and probes the authorization
boundaries — 48 checks, all passing. `npm test` runs the 249 unit tests.

### Development sign-in

All accounts are fictional and local-only. Staff and vendors use a password;
customers and riders use OTP (printed to the API console, and returned in the
response while `DEV_EXPOSE_OTP=true`).

| Role | Sign in with |
|---|---|
| Super admin | `admin@dashapp.test` / `DashDev!2026` |
| Dispatcher | `ops@dashapp.test` / `DashDev!2026` |
| Support | `support@dashapp.test` / `DashDev!2026` |
| Finance | `finance@dashapp.test` / `DashDev!2026` |
| Vendor owner | `iya-kemi-kitchen@dashapp.test` / `DashDev!2026` |
| Customer | OTP to `+2347000000201` |
| Rider | OTP to `+2347000000301` |

---

## Completed

### Milestone 0 — Discovery and decisions
- Inspected the toolchain: Node 24.19, npm 11.17. **No Docker, no pnpm, no
  PostgreSQL** on this machine. This shaped ADR-0001 and ADR-0003.
- Confirmed DASH APP is a greenfield repo, unrelated to any other project in the
  user's workspace.
- Wrote `docs/DECISIONS.md` with seven ADRs covering every significant deviation
  from the original build spec, each with its cost and its reversal path.

### Milestone 1 — Monorepo foundation and domain core (partial)
- npm-workspaces monorepo, TypeScript 5.7 in strict mode with
  `noUncheckedIndexedAccess`. Zero `any` in `packages/domain`.
- **`@dash/domain`** — the pure business core. No database, no network, no
  ambient clock. This is the part that has to be provably right:

  | Module | What it owns |
  |---|---|
  | `money` | Branded `Kobo` integer type, allocation, exact percentage math |
  | `geo` | Haversine, ray-cast point-in-polygon, GPS jump detection, privacy coarsening |
  | `permissions` | 60 permissions, 12 roles, step-up auth, four-eyes, object-level scope |
  | `orders` | 17-state machine with per-actor transition rules, cancellation policy |
  | `pricing` | Deterministic explained quotes, surge, discounts, membership, settlement |
  | `dispatch` | Explainable rider scoring, hard eligibility filters, offer rounds |
  | `ledger` | Double-entry, append-only, zero-sum enforced before write |
  | `ports` | Adapter interfaces for payments, maps, SMS, email, push, storage, queue, clock |

### Milestone 2 — Data layer and API
- **`@dash/db`** — Prisma schema, 40 models, authored portable between SQLite
  (dev) and PostgreSQL + PostGIS (production) per ADR-0003. Covers identity,
  sessions, geography, vendors, catalogue, riders, orders, dispatch, payments,
  the ledger, promotions, support, and governance.
- Seed builds a fictional Lagos: 4 zones, 4 invented vendors, 20 catalogue
  items, 3 customers, 4 riders, 5 orders across the lifecycle, and a balanced
  ledger. The seed refuses to run against `NODE_ENV=production` and verifies
  every transaction balances before it finishes.
- **`apps/api`** — Fastify 5 with Zod validation, ~40 endpoints across auth,
  discovery, ordering, the vendor portal, the rider app, ops/support/finance,
  and payment webhooks.

**Security properties actually verified by the smoke test, not just intended:**
- A client-supplied price, subtotal, or total is ignored; the server reprices
  from the database.
- Cross-tenant access returns *Not found*, never *Forbidden* — a 403 would
  confirm the record exists.
- A super admin still cannot approve a refund without a recent step-up auth.
- Sign-in failures are identical for a wrong password and a nonexistent
  account, and OTP requests reveal nothing about whether a number is registered.
- The delivery PIN is never echoed back in any order payload.
- Vendors never see the customer's phone number.
- An unsigned webhook is answered `200` and does nothing.
- Replaying an `Idempotency-Key` returns the original order rather than
  charging twice.

**Test results:** 249 unit tests passing; 48/48 end-to-end smoke checks passing.
Coverage on `packages/domain`: ~97% statements, ~95% branches. Thresholds
enforced in `vitest.config.ts` at 80/75/80/80.

---

## Bugs found and fixed while building

Recorded because each one would have been expensive to find in production.

1. **Money lost a kobo to float representation.** `multiply()` used
   `Math.round(amount * factor)`. IEEE-754 evaluates `100 * 1.005` as
   `100.49999999999999`, so it rounded to 100 instead of 101 — always in the
   platform's favour, never the customer's. `percentOf` was built on it, so
   every commission, service fee, and tax calculation carried the bias. Fixed by
   rewriting `percentOf` in pure integer arithmetic (multiply, then integer
   divide with an explicit half-up remainder test) and correcting `multiply` to
   collapse to 15 significant digits before rounding. Regression test sweeps
   every whole-naira basket to ₦2,000.

2. **`-0` could enter the system as a balance.** Negating a zero-value ledger
   entry produced `-0`, which fails `Object.is(-0, 0)` — so a fully settled
   vendor account compared unequal to zero, and would have rendered as
   "-₦0.00". Normalised at the `kobo()` mint point so no `-0` can exist anywhere.

3. **A lat/lng swap is undetectable by distance at Lagos latitude.** Lagos sits
   at ~6.4°N, ~3.4°E; both values are small and similar, so swapping them moves
   the point into the Gulf of Guinea while barely changing the computed distance
   between two equally-swapped points. A distance sanity-check would pass it
   through. Serviceability (point-in-polygon) is what actually catches it. This
   is why coordinates are named fields, never positional pairs, throughout.

4. **Settlement double-counted a free-delivery discount.** Found by the ledger
   refusing to post the very first real checkout — the customer happened to be
   a Dash+ member. `computeSettlement` subtracted the whole platform-funded
   discount from platform revenue, which is right for an *item* discount (the
   vendor is paid full menu price while the customer paid less, so the platform
   covers a real gap) and wrong for a *delivery* waiver (the fee was never
   charged, so there is no gap and nothing to absorb). The waiver was counted
   twice and the transaction was out by ₦575.

   Fixed by splitting funded discounts by what they discount —
   `platformFundedItemDiscount` vs `platformFundedDeliveryDiscount` — and using
   only the item portion in settlement and in the ledger. The unit tests had
   passed because the conservation test only ever exercised item discounts.
   All eight discount × funder combinations are pinned now.

   This is the bug the double-entry ledger exists to catch. It refused to write
   rather than quietly booking wrong numbers, and nothing was charged.

5. **A negative vendor payable was clamped to zero, destroying money.** Found by
   the randomised contract test added for bug 4 — one order in a few hundred
   drifted by 127 kobo. When a vendor funds free delivery on a small basket, the
   waiver can exceed their food revenue net of commission, so the vendor
   genuinely owes the platform for that order. `atLeastZero` silently swallowed
   the difference. Now the payable stays signed, and the ledger posts a debit
   entry that nets against the vendor's next settlement.

---

## Deliberate policy decisions worth reviewing

These are business calls encoded in the domain, not technical details. If any is
wrong for DASH APP, it is a small change now and a migration later.

- **Surge never applies to food, only to the delivery fee.** Multiplying a plate
  of jollof by 1.8× because it is raining is indefensible.
- **The small-order fee is assessed on the pre-discount subtotal**, so a promo
  code cannot push a basket under the threshold and trigger a fee the customer
  did not expect.
- **Tips go to the rider in full.** The platform takes nothing, and tips are
  never taxed.
- **Cancellation is free until the vendor starts cooking**, then 30% to cover
  the vendor, then refused once the rider has the food.
- **A zone boundary is inclusive.** Standing exactly on a border gets you served
  rather than rejected over a floating-point tie.
- **Ops cannot touch a customer's unsubmitted basket.** The operational escape
  hatch starts when an order becomes shared work.
- **Payment confirmation comes only from the provider webhook** — not from a
  client, and not even from an ops action.

---

## In progress / next

**Milestone 3 — the web app.** A single Next.js app (`apps/web`, ADR-0004) with
route groups for customer, rider, vendor, and admin. Nothing is clickable yet;
the API is currently driven only by `scripts/smoke.mjs`.

---

## Known limitations (honest list)

- **No adapter has been tested against a live service.** Payments, maps, SMS,
  email, push, and storage exist as interfaces plus offline implementations
  only. `PAYMENT_PROVIDER=mock` is the default and is printed in the boot banner
  so it cannot be mistaken for a working integration. Nothing here should be
  described as "Paystack integration works" until it is run against real sandbox
  keys.
- **No UI exists yet.** The API is complete enough to run a full order; there is
  no interface for a human to do it through.
- **Dispatch is not wired to a worker.** The scoring engine is written and
  tested, and `dispatch.find_rider` jobs are enqueued at checkout and on vendor
  accept, but no handler consumes them yet — so orders never actually reach a
  rider. Milestone 4.
- **Rider pay is a constant.** `confirmOrderPaid` passes a flat ₦600 to
  `computeSettlement`. Real distance- and time-based rider pay rules are
  Milestone 4, and until they exist every rider earnings figure is a
  placeholder.
- **SQLite is dev-only.** No concurrent writers, no PostGIS. The in-TypeScript
  geo path loads a city's candidate zones and tests them in process — correct at
  Lagos zone counts (tens), but it will not scale nationally without the PostGIS
  implementation of `GeoPort`.
- **No websockets yet.** Order tracking is poll-only; live push is Milestone 4.
- **`scripts/smoke.mjs` is not an automated integration suite.** It needs a
  running server and a seeded database, and it is not wired into CI. Proper API
  tests against a test-scoped database are outstanding.
- **No CI pipeline exists yet.**
- Nigeria data-protection and consumer obligations have **not** been reviewed by
  counsel. No legal template in this repo is legal advice.
