# Progress

Updated at the end of every milestone. If you are picking this up cold, read
this file first, then `docs/DECISIONS.md`.

**Last updated:** 2026-09-01 · Milestone E (account deletion and data export) built on branch `claude/dash-app-v1`, unmerged; past tag `v0.2.0-auth`

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
boundaries — 48 checks. Then close the full loop:

```bash
node scripts/dispatch-check.mjs
```

That takes one order from payment through dispatch, a rider accepting the offer,
the PIN handover, and the rider being paid — 20 checks. `npm test` runs the 268
unit tests.

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
- **`@dash/db`** — Prisma schema, 46 models, authored portable between SQLite
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

**Test results:** 268 unit tests passing; 48/48 smoke checks and 20/20 dispatch checks passing.
Coverage on `packages/domain` at that point: ~97% statements. See the tag
summary below for the final figures.

### Milestone 3 — The web app
- **`apps/web`** — one Next.js 15 app (ADR-0004) with the customer, vendor,
  rider, and operations surfaces. 11 routes, ~113 kB first load.
- Original design system: Midnight Graphite / Dash Gold / Warm Ivory, with a
  dark "field" surface for the rider and ops screens because both are read
  outdoors or in a dim dispatch room.
- Accessibility taken seriously rather than retrofitted: a visible focus ring on
  every control, `prefers-reduced-motion` honoured globally, pinch-zoom left
  enabled, 44px minimum touch targets on rider controls, a skip link, and
  labelled live regions instead of a screenful of unannounced grey boxes.
- **The basket stores no prices** — only item ids, quantities, and modifier ids.
  Every naira comes from `/v1/orders/quote` on each change, so a tampered
  `localStorage` basket cannot influence what anyone is charged.
- Verified in a real browser end to end: browse → customise an item with
  required modifier groups → sign in by OTP → quote → checkout → vendor accepts
  → order advances. The ledger stayed balanced across the whole run.

**Flows confirmed working in the browser, not just by API call:**
- Serviceability resolves the customer's zone and rejects unserviceable points.
- Required modifier groups block "add to basket" until satisfied, matching the
  server rule that would reject it anyway.
- Membership free delivery renders as an explained line, and the service fee is
  halved — the exact scenario that had unbalanced the ledger.
- The delivery PIN is shown once at checkout and never returned by any
  subsequent order read.
- The vendor queue shows the customer's first name only, their food revenue
  rather than the customer's total, and no phone number.
- The ops board hides ledger status from a dispatcher, who lacks the permission.

### Milestone 4a — Dispatch loop closed
- **Dispatch worker** (`apps/api/src/workers/dispatch.ts`) consumes
  `dispatch.find_rider`, runs the scoring engine, writes `DispatchOffer` rows
  with the full score breakdown, and drives the offer → timeout → re-offer →
  escalate cycle. Escalation to a human dispatcher is a first-class outcome
  rather than an infinite retry.
- **Rider pay** (`@dash/domain/pay`) replaces the flat ₦600 constant: base,
  distance, a paid approach leg, waiting time beyond a free allowance, a
  vehicle running-cost multiplier, a 70% share of any surge, a hard minimum for
  any completed delivery, and a cap so a GPS glitch cannot produce a five-figure
  payout. Every term is explained in the rider's earnings breakdown.
- Rider pay is computed from the trip, never copied from the customer's delivery
  fee — the fee is what the market bears, the pay is what the work is worth, and
  coupling them would let a surge discount quietly cut a rider's earnings.

**The complete loop now runs end to end**, verified by
`scripts/dispatch-check.mjs` (20/20): rider goes online → GPS spoof rejected →
customer orders → vendor accepts → dispatch offers → rider accepts → the exact
address is revealed only after acceptance → progress through pickup → a wrong
PIN is refused → the right PIN completes it → the rider is paid → the ledger
still balances.

### Business API integration coverage (post `v0.2.0-auth`, untagged)
- **159 new API integration tests** across orders, vendor workflow,
  dispatch/rider, finance/ledger, and staff authorization - the same
  `inject()` + temporary-SQLite approach the auth suite uses, so none needs a
  running server.
- **A BOLA/IDOR audit** run from every role against every endpoint taking a
  resource id. Cross-customer, cross-vendor, cross-rider, and cross-city
  substitutions all return `404 Not found.`
- **Race coverage**: two riders accepting the same offer resolves to exactly one
  winner, repeated five times. The atomic `updateMany` guard on `riderId: null`
  is what makes that hold.
- **Financial invariants asserted, not status codes**: every ledger transaction
  sums to zero after every money-moving operation; duplicated operations cannot
  duplicate financial effects; failed operations leave no partial posting.
- **`docs/API_MATRIX.md`** records every business endpoint with its permission,
  ownership rule, state transition, and coverage status.
- Five bugs found and fixed - see 13-17 below. Three moved money or falsified
  the audit record.

### Phase 1 — CI and production-grade authentication (post-tag)
- **Refresh tokens moved into a `HttpOnly`, `Secure`, `SameSite=Lax` cookie**
  scoped to `/v1/auth`. Never returned in a response body — a test greps the raw
  body to prove it. Script cannot read it, so an XSS now yields at most a
  15-minute access token instead of a 30-day session.
- **CSRF protection** — double-submit token in a readable cookie, echoed in an
  `X-CSRF-Token` header, compared in constant time, reissued on every rotation.
  Enforced only on state-changing requests that carry the refresh cookie.
- **Access token is memory-only** in the web client. `sessionStorage` is now
  empty — verified in a real browser.
- **72 API integration tests** using Fastify's `inject()` against a real
  per-suite SQLite database: login, OTP, refresh, rotation, reuse, logout,
  CSRF, multiple sessions, rate limiting, and every production boot guard.
- **Production boot guards extended** to refuse every mock adapter (payments,
  maps, SMS, email, push, storage, queue), `DEV_EXPOSE_OTP`, placeholder or
  low-entropy secrets, identical access/refresh secrets, disabled rate limiting,
  and a plain-HTTP public URL. All 29 guards have tests.
- **GitHub Actions CI**: lint, typecheck across four workspaces, 340 tests,
  coverage thresholds, Prisma schema validation, fresh-database boot + seed +
  ledger verification, production web build, gitleaks secret scan, `npm audit`.

### Milestone E — account deletion and data export (branch `claude/dash-app-v1`, unmerged)
- **Deletion is a scheduled state machine**, not an instant drop:
  `scheduled → cancelled | completed`, one `AccountDeletionRequest` per identity,
  opened behind a fresh step-up, with a cooling-off window
  (`ACCOUNT_DELETION_COOLING_OFF_DAYS`, default 14) and a no-step-up cancellation
  path. A staff on-behalf-of path (`admin:account:delete`, step-up, mandatory
  reason, `onBehalfOf` audit) is kept separate.
- **Legal holds** — an active order, an unresolved refund/dispute, an open
  safety/fraud case, or a negative wallet balance — defer acceptance and name the
  blocker rather than deleting anyway.
- **Anonymise, never delete, what the ledger references.** Finalisation deletes
  sessions, devices, OTP/MFA challenges, recovery codes, and carts; it
  anonymises the identity, addresses, order notes, review comments (rating
  kept), support-action bodies, and customer profile fields **in place**.
  Orders, payments, refunds, settlements, subscriptions, legal acceptances, and
  every ledger entry keep their ids and amounts. The delete/anonymise/retain
  rule for all 24 model classes is `packages/domain/src/account` at 100%
  coverage.
- **Idempotent, single-transaction finalisation** — an `Identity.anonymisedAt`
  marker, a claimed request row, and set-to-constant writes mean a repeated or
  concurrent run is a no-op and writes no second audit entry. Sessions are gone
  afterwards, so the account's tokens stop working immediately.
- **Data export** runs off the request path: a queue worker gathers the
  subject's own data (filtered by their ids so nothing else is swept in) into
  one JSON archive stored through the new `ExportArchivePort` (local dir in
  tests, object storage in production). The download link is a **stateless
  signed HMAC capability** carrying the request id and an expiry
  (`DATA_EXPORT_TTL_HOURS`, default 24), issued only to the authenticated owner
  and **single-use** — enforced by a guarded `downloadCount: 0` update. The
  bytes are deleted the instant the download completes.
- **`npm run maintenance:accounts`** (with `--dry-run`) finalises due deletions
  and expires stale export archives; aggregate counts only, non-zero exit on any
  failure. Nothing schedules it yet.
- **90 new tests**: `account-deletion.test.ts` (34), `account-export.test.ts`
  (20), `packages/domain/src/account/account.test.ts` (36). IDOR on the
  id-addressed routes, replay, repeated requests, cancellation racing
  finalisation, concurrent finalisation, single-use and expired downloads, a
  build failure that does not wedge the queue, and proof the financial rows
  survive. Suite total **859**, domain coverage **97.09%** (account module 100%).

---

## Milestone summary — `v0.1.0-mvp`

| | |
|---|---|
| Tag | `v0.1.0-mvp` |
| Commit | `6d536234828ac4f362764a79f8a6488ca305fa3d` (`git rev-parse v0.1.0-mvp^{commit}`) |
| Tests at the tag | **268** unit across 8 files |
| Tests on `main` now | **340** across 11 files (268 domain + 72 API integration) |
| Smoke checks | **48**, all passing (`scripts/smoke.mjs`) |
| Dispatch checks | **20**, all passing (`scripts/dispatch-check.mjs`) |
| Domain coverage | **93.98%** statements · **94.97%** branches · **94.25%** functions |
| Lint | clean |
| Typecheck | clean across all four workspaces |
| Web build | succeeds — 11 routes, ~113 kB first load |
| Prisma models | 46 |
| API endpoints | 51 |

Coverage fell from ~97% to ~94% when `packages/domain/src/pay` landed in
Milestone 4a. Thresholds in `vitest.config.ts` remain 80/75/80/80, so this is
comfortably above the gate — but it is a real decline and worth reversing.

### Pinned versions

Node 24.19.0 · npm 11.17.0 · TypeScript 5.9.3 · Fastify 5.12.1 · Prisma 6.19.3 ·
Next 15.5.24 · React 19.2.8 · Zod 3.25.76 · jose 5.10.0 · Tailwind 4.3.3 ·
Vitest 2.1.9 · ESLint 9.39.5 · tsx 4.23.13

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

6. **Dark-surface text was invisible.** `body { color: var(--ink) }` resolves the
   variable once, at the body. The rider and ops screens redefine `--ink` on a
   nested wrapper, but nothing re-reads it unless a rule sets `color` again — so
   every element inside inherited the body's *light-theme* colour and rendered
   near-black text on a near-black surface. Order codes on the live board were
   unreadable. Fixed by re-declaring `color` and `background` on the surface
   itself.

7. **A hydration mismatch on every authenticated page.** `hasSession()` reads
   `sessionStorage`, which does not exist on the server, so the server rendered
   "signed out" and the client rendered "signed in". React reported the mismatch
   and discarded the server HTML. Replaced with a `useHasSession()` hook that
   returns false until an effect has run.

8. **`/v1/auth/me` was called four times per page load.** The header and the
   permission hook each fetched the identity independently. Added request
   deduplication and a 30-second cache, invalidated on any session change.
   Measured before and after in the browser: four requests down to one.

9. **Rider pay was reserved to an account no rider could draw from.** Found by
   the dispatch check: a rider completed a delivery and their earnings screen
   still read ₦0. Pay is reserved at payment capture — deliberately, so the
   money is committed the moment the customer pays — but no rider exists yet at
   that point, so the `rider_payable` entry was written with a null owner. The
   ledger balanced perfectly the whole time; the money simply sat in a pool
   nobody owned. Completion now posts a `buildRiderAssignment` transaction that
   releases the reservation, credits the actual rider their true entitlement
   (real approach distance, real waiting time, their vehicle, their tip), and
   books the difference against platform revenue.

10. **The dispatch worker logged that it found nobody, but not why.** The
    scoring engine records an exclusion reason for every rejected rider — that
    is the whole point of it — and the worker was throwing them away. "No rider
    was found" is unactionable; "all three were zone-restricted" is a
    configuration fix. Now summarised by reason in one log line, which is how
    the zone misconfiguration above was diagnosed in seconds.

11. **Refresh-token reuse detection was unreachable dead code.** Rotation marks
    the old session both `rotatedAt` and `revokedAt` (reason `rotated`). The
    generic `revokedAt` check sat *above* the reuse check, so it always won: a
    replayed token was reported as "revoked" and the session family was never
    torn down.

    Not cosmetic. If an attacker steals a refresh token and redeems it **before**
    the victim, the attacker gets a live session and the victim's legitimate
    refresh is the one that looks like a replay. Without family revocation the
    attacker simply keeps the account. Found by the integration test asserting
    that the victim's *rotated* token also dies; fixed by checking `rotatedAt`
    first. Both orderings are now pinned by tests.

12. **`LOG_LEVEL=silent` was rejected by config validation.** A real Pino level
    and the right one for tests, but absent from the enum, so the test harness
    could not start. Added — and it now doubles as the signal that mutes the
    console SMS/email/push adapters, so a passing suite no longer buries its
    output under a wall of fake OTP messages.

13. **The cancellation policy and the state machine disagreed for five
    statuses.** `evaluateCustomerCancellation()` reported `allowed: true` for
    `accepted`, `preparing`, `ready`, `rider_assigned`, and `rider_arrived` -
    the API returns that as `cancellation.allowed`, and the web app renders its
    "Cancel this order" button from it. The transition table did not list
    `customer` on `cancelled` for any of those states, so every one of those
    cancellations failed with a 409.

    A customer whose food had not left the kitchen was shown a cancel button
    that could never work, and the 30% fee the policy describes could never be
    charged. Fixed by adding `customer` to those five transitions, and pinned by
    a test asserting the two sources agree for **every** status.

14. **A rider who travelled while offline could not report their location.**
    The plausibility check divides distance by elapsed time. Going offline did
    not clear the last known position, so a rider who ended a shift, went home,
    and came back on had their first ping compared against a position
    kilometres away and rejected as a teleport. A rejected ping does not update
    the baseline, and dispatch excludes riders whose location is stale - so the
    rider sat online, available, and invisible to dispatch until enough
    wall-clock time passed for the implied speed to fall below the threshold.
    For a 20km commute that is over ten minutes of lost earnings at the start
    of a shift.

    It was also inconsistent with the stated privacy posture: we say location is
    collected only while a rider is online, then used movement we deliberately
    did not observe to judge them. Going offline now clears the baseline.

15. **A full refund could be taken twice by changing only the destination.**
    The refund idempotency key included `destination`, so refunding the whole
    order to the payment method and then again to the wallet produced two
    distinct keys and two ledger postings. The per-call ceiling
    (`amount > captured.amount`) passed both times because each call was
    individually within it. Different *amounts* broke it the same way.

    Real money: an order could be refunded to twice its value. Fixed by bounding
    the **cumulative** total refunded against the payment, and by dropping
    `destination` from the key - the same amount to a different destination is
    the same refund taking a different route out, not a second entitlement.

16. **Support compensation could be issued twice by double-clicking.** The
    idempotency key was `compensation_<caseId>_<Date.now()>`, so every call was
    unique and the ledger's replay protection could never fire. Two clicks
    credited the customer twice. The key is now a hash of the case, amount, and
    reason, and a replayed posting no longer writes a second `SupportAction`
    row either - the case history was showing payments the customer never
    received.

17. **An admin acting on a vendor's order was recorded as the vendor.** A super
    admin holds every permission and is bound to no vendor, so vendor scoping
    does not apply to them - that is the intended operational escape hatch. But
    the status event and audit entry hardcoded `vendor`, making the intervention
    indistinguishable from the vendor's own action. That is precisely the record
    a vendor would later dispute ("we never rejected that order"). The acting
    party is now derived from the caller's roles and recorded truthfully as
    `ops`.

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

**Milestone 4b — the remainder.**

1. WebSocket push, replacing polling on the tracking, vendor, and ops screens.
2. An automated API integration suite against a test-scoped database, and CI.
   `smoke.mjs` and `dispatch-check.mjs` prove the flows but need a running
   server and are not wired into a pipeline.
3. Batched/stacked dispatch — the scoring engine supports capacity and vehicle
   compatibility, but nothing groups compatible orders yet.

---

## Known limitations (honest list)

- **No adapter has been tested against a live service.** Payments, maps, SMS,
  email, push, and storage exist as interfaces plus offline implementations
  only. `PAYMENT_PROVIDER=mock` is the default and is printed in the boot banner
  so it cannot be mistaken for a working integration. Nothing here should be
  described as "Paystack integration works" until it is run against real sandbox
  keys.
- **Admin MFA is modelled, not enforced.** `mfaSecret` and `mfaEnrolledAt` exist
  and seeded staff are pre-enrolled, but there is no TOTP verification flow.
  Step-up reuses the OTP challenge, so a staff account is protected by a
  password and a phone rather than a true second factor.
- **API integration tests cover authentication only.** Ordering, dispatch,
  vendor, and finance routes still rely on the two script suites, which need a
  running server and are not part of the CI gate.
- **Dispatch runs in-process on an in-memory queue.** Jobs are lost on restart,
  which is why `QUEUE_PROVIDER=memory` is rejected in production. Redis + BullMQ
  is the production target and the worker code is unchanged by that switch.
- **A rider must be zone-permitted to be offered an order.** The seed gives each
  rider exactly one zone, which is more restrictive than a real operation would
  be. It is data, not code — but it means a rider can be online, nearby, and
  still correctly receive nothing.
- **Rider pay assumes a motorcycle at reservation time.** No rider is assigned
  when payment is captured, so the reservation uses a motorcycle rate and a zero
  approach leg. The true-up on delivery corrects it, but the reserved figure is
  an estimate rather than a promise.
- **SQLite is dev-only.** No concurrent writers, no PostGIS. The in-TypeScript
  geo path loads a city's candidate zones and tests them in process — correct at
  Lagos zone counts (tens), but it will not scale nationally without the PostGIS
  implementation of `GeoPort`.
- **No websockets yet.** Order tracking is poll-only; live push is Milestone 4.
- **`scripts/smoke.mjs` is not an automated integration suite.** It needs a
  running server and a seeded database, and it is not wired into CI. Proper API
  tests against a test-scoped database are outstanding.
- Nigeria data-protection and consumer obligations have **not** been reviewed by
  counsel. No legal template in this repo is legal advice.
