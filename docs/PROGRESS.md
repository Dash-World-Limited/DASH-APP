# Progress

Updated at the end of every milestone. If you are picking this up cold, read
this file first, then `docs/DECISIONS.md`.

**Last updated:** 2026-08-30 · end of Milestone 1 (partial — domain core)

---

## How to run what exists right now

```bash
npm install
npm test
```

That runs the full domain test suite (229 tests). There is no server or web app
to start yet — see *Next* below.

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

**Test results:** 229 passing, 0 failing. Coverage on `packages/domain`:
96.98% statements, 94.66% branches, 95.23% functions. Thresholds enforced in
`vitest.config.ts` at 80/75/80/80, so a regression fails CI rather than
silently eroding.

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

**Milestone 1 remainder:**
- `packages/db` — Prisma schema (SQLite dev, Postgres-portable per ADR-0003)
- `packages/ui` — design tokens for the DASH palette
- `apps/api` — Fastify server, auth plugin, health check, OpenAPI
- Seeded fictional Lagos data
- `scripts/dev.mjs` for parallel dev processes

**Then Milestone 2:** identity/OTP, sessions, cities/zones, vendors, catalog.

---

## Known limitations (honest list)

- **No adapter has been tested against a live service.** Payments, maps, SMS,
  email, push, and storage exist as interfaces plus offline implementations
  only. `PAYMENT_PROVIDER=mock` is the default and is printed in the boot banner
  so it cannot be mistaken for a working integration. Nothing here should be
  described as "Paystack integration works" until it is run against real sandbox
  keys.
- **SQLite is dev-only.** It has no concurrent writers and no PostGIS. The
  in-TypeScript geo path loads a city's candidate zones and tests them in
  process — correct, and fine at Lagos zone counts (tens), but it will not scale
  to national zone counts without the PostGIS implementation of `GeoPort`.
- **No UI exists yet.** The domain core is done; nothing is clickable.
- **Rider pay rules are not written yet.** `computeSettlement` takes
  `riderDeliveryPay` as an input rather than computing it. That module is
  Milestone 5.
- **No integration, API, or end-to-end tests yet** — there is nothing to
  integrate against. All 229 tests are unit tests of pure functions.
- Nigeria data-protection and consumer-law obligations have **not** been
  reviewed by counsel. No legal template in this repo is legal advice.
