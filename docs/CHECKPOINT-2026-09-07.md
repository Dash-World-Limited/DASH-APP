# Pre-review checkpoint — 7 September 2026

For Codex, returning after six days away. This is the state of DASH APP as of
today, written to be read cold: what changed, what is proven, what is claimed
but unproven, and what I would audit first if I were you.

Everything here was measured today, not remembered. Where a claim rests on one
run or one device, it says so.

---

## 1. Review baseline and branch topology

The last thing you reviewed is on `origin/main`. Nothing has been merged there
since.

```
origin/main   43790ca  2026-09-04  legal: reserve DASH APP source rights
              5fd4e5b  2026-09-04  docs: record latest development status
```

Those two commits were made directly on `main` and are **not** in any working
branch — the branches were cut from an earlier `main` (`eabaf72`). A future
merge has to reconcile that; it is not a conflict today but it will be.

Unreviewed work: **12 commits, 190 files, +25,633 / −903**.

| Branch | Tip | Pushed? |
|---|---|---|
| `claude/milestone-v-realtime` | `6839257` | yes |
| `claude/milestone-vi-v1-experience` | `fb22e63` | **no — local only** |
| `main` | `43790ca` | untouched |

Two commits (`9669aaa`, `fb22e63`) exist only on this machine. There is also an
uncommitted working tree — see §6.

---

## 2. The twelve commits

Grouped as they were built. Each line is what the commit protects, not what it
touched.

### Milestones III–V (2–3 Sept) — infrastructure

| Commit | Subject | Size |
|---|---|---|
| `2a8255c` | Milestone III: production secret management and key custody | 30 files, +6,915 |
| `5915fd4` | Milestone IV: transactional outbox and scheduled maintenance | 29 files, +2,949 |
| `4d8418b` | Milestone V: secure realtime, notifications not data | 67 files, +8,200 |

Milestone V is the largest single piece and the one with the most novel security
surface: topic authorization, `not_found` refusals rather than `forbidden`, and
a notifications-not-data protocol where the client re-reads through authorized
routes rather than trusting the socket payload.

### Defect fixes found by driving the app (3 Sept)

| Commit | Subject |
|---|---|
| `76ca998` | Fix dispatch jobs being dropped as duplicate enqueues |
| `204d38e` | Let staff sign in, and replace the browser prompts the console relied on |
| `55edad4` | Fix seeded riders being permanently location-stale |

### The hardened lifecycle checkpoint (4–5 Sept)

Four commits, each independently reviewed diff-by-diff before it was accepted
(see §12 for what that review was and was not).

| Commit | Subject | What it protects |
|---|---|---|
| `fa2c380` | Make Preparing the only trigger for normal rider dispatch | One dispatch per order, at the moment the kitchen commits |
| `5780c75` | Let a rider recover their work from the server, not from React state | An accepted delivery survives refresh, reconnect and restart |
| `3b9b1a5` | Add the Android shell, and give the rider a position it can actually get | A rider on a real phone can report a position at all |
| `6839257` | Let a vendor accept an order exactly once | Lifecycle and audit records converge under concurrency |

### Milestone VI (5 Sept) — consumer experience, local only

| Commit | Subject |
|---|---|
| `9669aaa` | Make every rider a customer, and say whether they may work |
| `fb22e63` | Give DASH a consumer shell, and one account two faces |

---

## 3. Gate results, measured today

| Gate | Result |
|---|---|
| Full test suite | **1,462 passed / 52 files**, 0 failed |
| Typecheck | clean, 4/4 projects |
| Lint | clean |
| Secret scan (`npm run check:secrets`) | 11 passed, 0 failed |
| Production web build | clean |

These were run against the **working tree**, which includes uncommitted work
(§6) — not against any single commit.

**One caveat you should not let me gloss over.** On 5 September a full-suite run
reported `1 failed | 1433 passed`, and I did not capture which test. Five
consecutive runs since were clean. I could not reproduce it and cannot prove it
was pre-existing flakiness rather than something real. Candidate homes are the
suites that drive genuine timing: `redis.test.ts` (real connection refusals
against `127.0.0.1:6390`), `ratelimit.test.ts` (rate-limit windows), and the
concurrency suites (`Promise.all` against SQLite). Treating this as resolved
would be wrong.

---

## 4. What is proven on real hardware

A complete order lifecycle ran end to end on a physical Android handset on
5 September, under the **real** dispatch rules — the unrestricted-coverage flag
was explicitly turned off for the run.

```
20:27:18  draft           -> payment_pending  by customer
20:27:18  payment_pending -> placed           by system
20:27:18  placed          -> accepted         by vendor
20:27:19  accepted        -> preparing        by vendor
20:27:22  preparing       -> rider_assigned   by rider    (+4s)
20:28:20  rider_assigned  -> rider_arrived    by rider
20:29:01  rider_arrived   -> picked_up        by rider
20:29:38  picked_up       -> en_route         by rider
20:29:45  en_route        -> arrived          by rider
20:29:52  arrived         -> delivered        by rider
```

Order `DASH-K3EU8V`, proof recorded as `pin_verified`, rider returned to `idle`
with 0 active trips. Location during the delivery: **7 reports, 0 rejected,
longest gap 25 s** against a 120 s staleness limit — which is the evidence that
reporting does not stop when a rider goes `on_delivery`.

Constraints that were live during that run: 8 km pickup limit, zone eligibility,
120 s GPS freshness, rider approval, motorcycle capacity 3, anti-spoofing.

**Scope of that proof:** one vendor (Iya Kemi Kitchen), one rider, one device,
one run. The other three seeded vendors passed the same lifecycle at the **API
layer** on 4 September, not on handsets.

---

## 5. Security-sensitive changes — audit these first

Ranked by how much damage a mistake would do.

1. **Realtime topic authorization** (`4d8418b`). Subscription is authorized per
   topic; an unauthorized topic is refused as `not_found`, never `forbidden`, so
   a subscriber cannot infer that a topic exists. Payloads carry identifiers and
   a version only — no personal data — and `assertPublishable` enforces that at
   the outbox boundary.
2. **Compare-and-set on every lifecycle transition** (`fa2c380`, `5780c75`,
   `6839257`). `assertTransition` judges a status read *before* the transaction
   opens. Three routes had that TOCTOU window: vendor progress, vendor accept,
   and rider progress/completion. All now name the expected prior status in the
   `where`, so the loser of a race matches no row and rolls back. `OutboxEvent.
   idempotencyKey` is deliberately **not** unique, so the database was never a
   backstop here.
3. **`riderStatus` on `/v1/auth/me`** (`9669aaa`). A pending, suspended or
   rejected rider still has a `riderId`. The client is told the status so it can
   *hide* an option, never so it can grant one; the server refuses rider routes
   independently. Asserted in `auth-capability.test.ts`.
4. **Rider → customer back-fill** (`9669aaa`). Every rider identity gains a
   Customer profile, a `customer` role and one delivery address. Idempotent, and
   deliberately scoped to riders — vendor, ops and admin identities are **not**
   converted.
5. **Android cleartext scope** (`3b9b1a5`). `base-config
   cleartextTrafficPermitted="false"` with a single generated domain exception
   for the development host. Capacitor's application-wide `cleartext: true` was
   explicitly rejected.
6. **Dev diagnostics elimination** (`3b9b1a5`). The rider GPS diagnostics panel
   is gated on `NODE_ENV !== 'production'` with no flag able to override it, and
   is verified *absent from the built bundle* by grepping the chunk — not merely
   hidden.

---

## 6. Uncommitted working tree

26 paths, all Milestone VI consumer work plus one held-out flag. Nothing here
has been committed, reviewed, or pushed.

**Held out deliberately** — a delivery-coverage feature flag
(`DELIVERY_COVERAGE_UNRESTRICTED`) across `config.ts`, `catalog.ts`,
`server.ts`, `workers/dispatch.ts`. When on it lifts the 8 km pickup cap and
zone eligibility in the dispatch worker and makes `/v1/serviceability` return
true for unzoned addresses. It defaults off, is **off** in the local
environment, and has **zero test coverage**. It was excluded from the checkpoint
for exactly that reason and needs its own commit and its own adversarial tests.
**This is the single most dangerous thing in the tree — please look at it.**

**The five-section consumer restructure** — Home now presents Shops,
Restaurants, Local Market, Pharmacy and Declutter as five equal sections, each
routing through one shared `SectionPage` component to the existing
`/browse/[slug]`. New: `lib/sections.ts`, `components/SectionPage.tsx`,
`SideDrawer.tsx`, `AccountDrawer.tsx`, `lib/images.ts`, `lib/condition.ts`, and
five thin route files. Plus one additive nullable column, `MenuItem.condition`,
and three seeded test sellers so no section opens empty.

---

## 7. Migrations

Local development is SQLite; PostgreSQL + PostGIS is the production target
(ADR-0003). One additive schema change since your last review that is not yet
committed: `MenuItem.condition String?` — nullable, additive, no backfill
required. `packages/db/prisma/postgres/schema.prisma` was regenerated by
`npm run db:pg:sync` and the drift test (`schema-sync.test.ts`, 14 tests) is
green.

No destructive migration exists in this range.

---

## 8. Integrations — what is real

Stated in the vocabulary the handoff requires.

| Area | Honest status |
|---|---|
| Payments | **Mocked.** `PAYMENT_PROVIDER=mock`. A Paystack abstraction exists — `Payment`/`PaymentWebhook` models, signature and replay checks, boot guards refusing `mock` in production and refusing Paystack without a webhook secret — but **no Paystack adapter is implemented and none has ever run against a sandbox.** No real money has moved. |
| Realtime | Implemented and exercised in tests and on a device. In-memory adapter locally; Redis adapter verified separately. |
| Queue | BullMQ + ioredis present; `queue=memory` in local dev. |
| PostGIS | Adapter implemented and verified locally. |
| Storage / SMS / email / maps / push | **Not integrated.** SMS is console, storage is local, push does not exist — `Device.pushToken` is modelled but nothing sends. |

---

## 9. Known risks and debt

Honest list, worst first.

1. **No deployment exists.** The Android APK points at a laptop on Wi-Fi over
   plain HTTP. There is no production Android build configuration, no HTTPS
   origin, and no deployment target of any kind.
2. **No real payment has ever been taken.**
3. **The intermittent test failure in §3** is unexplained.
4. **Push notifications do not exist.** A rider must keep the screen open to
   receive work, which is not a viable product.
5. **The coverage flag** (§6) is untested code that can disable distance and
   zone rules.
6. **Standing docs are stale.** `HANDOFF.md`, `ROADMAP.md` and `docs/PROGRESS.md`
   describe Milestones III–V but say nothing about the six commits since, nor
   the working tree. They are behind, not wrong.
7. **`pickupCode`** is generated and hashed but never returned to anyone, so the
   vendor's verify-pickup step asks for something the rider cannot see. It is
   not a gate — it returns `{verified:true}` and changes no state — but it is
   incoherent.
8. **Vendor `/v1/orders/quote` and order creation** now permit riders, because a
   rider is a customer. Ownership still gates by address (404). Worth a second
   pair of eyes.
9. **Line endings.** Several files were rewritten by tooling on Windows and
   normalised back to LF by hand. `schema-sync.test.ts` caught one instance;
   others may not have been caught.

---

## 10. Recommended audit order

1. §6 — the uncommitted coverage flag. Untested, and it can switch off two
   eligibility rules.
2. `4d8418b` — realtime authorization and the notifications-not-data protocol.
   Largest new attack surface.
3. The four compare-and-set transitions (`fa2c380`, `5780c75`, `6839257`).
   Concurrency correctness, and whether the CAS pattern is applied everywhere it
   is needed rather than only where it was found.
4. `9669aaa` — the capability model. One identity holding both roles changes
   what every consumer endpoint will accept.
5. `3b9b1a5` — the Android shell: cleartext scoping, bridge configuration, and
   whether anything debug-only can reach a release build.
6. `fb22e63` and the working tree — consumer shell and mode switching, where the
   rule is that mode is presentation and the server is authority.

---

## 11. What I would like challenged

Places where I made a judgement call and would rather be wrong early.

- Treating **403 for a missing capability** and **404 for a failed ownership
  check** as the correct split. `/v1/rider/*` returns 403 to a customer-only
  account; record-level probes return 404.
- Reusing the **vendor/catalogue model for Declutter** rather than building a
  second commerce engine. A curated resale seller is an approved vendor whose
  category is `declutter`; a listing is a menu item with a `condition`.
- **Client-supplied `recordedAt`** on rider location. The server guards future
  timestamps and derives both staleness and plausible speed from the field.
  Backdating is possible and is self-punishing (it ages you out faster), but it
  is client-supplied input feeding an anti-spoofing rule.
- The decision to **hold the coverage flag out** of the checkpoint rather than
  test it inline.

---

## 12. What review this has already had

Between 4 and 5 September, every commit in the hardened checkpoint was reviewed
diff-by-diff before acceptance. That review was performed by ChatGPT, working
from diffs pasted into a chat — it had **no access to the repository**.

It was genuinely useful: it demanded the concurrency test that exposed the
vendor-accept TOCTOU, and it caught that a duplicate GPS reading was being
returned as a usable position. It also produced a repository gap analysis that
was **wrong in four places**, each claiming something was missing that already
existed — Paystack abstraction, role separation, the identity model, and
grocery/pharmacy categories. Every error pointed the same way: toward rebuilding
working code.

So: the diffs have had a second pair of eyes. The **codebase** has not. That is
what you are for.
