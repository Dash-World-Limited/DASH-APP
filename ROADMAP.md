# Roadmap

Where DASH APP is and what comes next, in the order it should happen.

Latest tag: **`v0.2.0-auth`**. Considerable work has landed on `main` since —
business API coverage, administrator MFA, encryption at rest, retention,
security scanning, observability seams, account deletion and data export
(Milestone E), and the PostgreSQL/PostGIS and Redis production path
(Milestone II) — and is deliberately **untagged**. Milestone II was verified
against real PostgreSQL, PostGIS, and Redis; everything else on `main` is
locally verified only. Nothing has been run against a real external provider or
deployed, so a tag would overstate it.

**Milestones III and IV are not on `main`.** Secret management and key custody
(III) is on `claude/milestone-iii-secret-management`; durability (IV) builds on
it on `claude/milestone-iv-durability-scale`. Both are implemented and locally
verified, and are described below as such.

The ordering is not arbitrary. Each phase removes a blocker for the next, and
the two hard gates below exist because getting them wrong is expensive to undo.

> **Gate 1 — no live payment integration until authentication is
> production-grade.** *Cleared in Phase 1.* Refresh tokens are now HttpOnly
> cookies with CSRF protection and tested reuse detection. Payments remain
> gated on the rest of Phase 4's prerequisites: sandbox credentials, and a
> signature, idempotency, and failure-path test for each provider.
>
> **Gate 2 — no production deployment until CI, secret management, backups, and
> an incident runbook exist.** *Still closed, but narrower than it was.* CI
> exists. The incident runbook is written (`docs/RUNBOOKS.md`) and unrehearsed.
> Secret management is done **on the application side, on a branch that has not
> been merged** — every variable classified, redaction proven, boot validation
> fail-closed, key custody and rotation verified locally (Milestone III) — and
> **no secret store or hosting platform has been chosen**, so nothing injects
> those secrets anywhere yet.
> Backups do not exist: the procedure is documented, the key half is rehearsed
> against synthetic material, and no real backup has ever been taken or
> restored. A deployment without those last two is not a deployment, it is an
> outage waiting for a date.

---

## Done — `v0.1.0-mvp`

| Milestone | What landed |
|---|---|
| 0 | Discovery, ADRs, toolchain assessment |
| 1 | Monorepo, domain core (money, geo, permissions, orders, pricing, dispatch, ledger, ports) |
| 2 | Prisma schema (46 models), seed, Fastify API (51 endpoints) |
| 3 | Next.js app — customer, vendor, rider, ops surfaces |
| 4a | Dispatch worker, real rider pay, closed loop |

**Working end to end:** browse → customise → sign in → quote → pay (mock) →
vendor accept → dispatch → rider offer → accept → pickup → PIN → delivered →
rider paid → ledger balanced.

268 unit tests, 48 smoke checks, 20 dispatch checks. Ten bugs found and fixed
along the way, documented in [`docs/PROGRESS.md`](docs/PROGRESS.md).

---

## Done — Phase 1: CI and production-grade authentication

Shipped. The refresh token no longer touches script, CSRF protection is in
place, and a merge is now gated on lint, typecheck, 340 tests, a fresh-database
boot, a production build, a secret scan, and a dependency audit.

**Delivered:**
- Refresh token in a `HttpOnly`, `Secure`, `SameSite=Lax` cookie scoped to
  `/v1/auth`; never returned in a response body.
- Access token 15 minutes, in memory only.
- Double-submit CSRF, constant-time compared, rotated on every refresh.
- Reuse detection fixed (it was unreachable dead code) and covered by tests
  including the attacker-redeems-first ordering.
- 72 API integration tests: login, refresh, logout, replay, CSRF, multiple
  sessions, rate limiting, and every production boot guard.
- GitHub Actions: lint, typecheck, tests, coverage, schema validation, fresh
  boot + seed + ledger verification, production build, gitleaks, `npm audit`.

**Still open from this phase:** branch protection on `main` must be enabled in
the repository settings — it cannot be configured from the codebase.

---

## Done — Administrator MFA

Shipped. Staff roles complete TOTP before receiving a session; a password alone
returns a five-minute, single-use challenge and nothing else.

Standards-based TOTP via `otplib`, the secret held as an AES-256-GCM envelope
bound to its owner, replay blocked by recording the accepted time step, ten
single-use recovery codes stored as hashes, and disable/regenerate gated behind
a fresh step-up that revokes every session. 72 new tests.

---

## Done — Phase 2: test depth and observability

Shipped, except where noted.

- ✅ API integration coverage for every business and public endpoint — ordering,
  vendor, dispatch, rider, finance, staff, catalogue, search, and webhooks. No
  behaviour depends on the script suites alone any more.
- ✅ Adversarial cases as automated tests: IDOR sweeps, privilege escalation,
  cross-tenant probes, rate-limit behaviour, webhook replay and concurrent
  delivery, MFA replay, and retention concurrency.
- ✅ Liveness/readiness split, an error-reporting port, and a metrics port —
  all with console implementations and redaction, no vendor selected.
- ✅ SAST (CodeQL), dependency review, and a repository-hygiene job, alongside
  the existing secret scan and dependency audit.
- ❌ Playwright journeys for the web surfaces — not started.
- ❌ Accessibility checks in CI — not started.
- ❌ DAST — needs a deployed staging target. Handoff plan in `docs/RUNBOOKS.md`.
- ❌ Container and IaC scanning — no container or IaC files exist to scan.

## Done — administrator MFA, encryption at rest, and retention

- ✅ TOTP enforced for all seven staff roles, with encrypted secrets, replay
  protection, single-use recovery codes, and step-up-gated disable.
- ✅ AES-256-GCM envelope with key-version rotation, protecting TOTP secrets and
  vendor payout details, each bound to its owner.
- ✅ Retention policy and job — delete, anonymise, or retain, with dry run,
  batching, convergence, and concurrency safety. Runnable on a schedule since
  Milestone IV via `npm run maintenance:all`; a scheduler still has to invoke
  that command.
- ✅ Runbooks: incident response, secret inventory, backup/restore, environment
  separation, readiness checklist, rollback criteria, alert severities.

## Merged, untagged — account deletion and data export

Merged on `main` (`32180ce` → `71b2fc5`): a
`scheduled → held | cancelled | completed` deletion state machine behind a
fresh step-up, a cooling-off window, a
cancellation path, a staff on-behalf-of path, legal holds, and an idempotent
single-transaction finalisation that **anonymises everything the ledger
references and deletes nothing it sums over**. Data export runs off the request
path through `ExportArchivePort` and is delivered by a stateless signed
single-use download link. `npm run maintenance:accounts` finalises due deletions
and expires stale archives. Adversarial coverage is in `account-deletion.test.ts`,
`account-export.test.ts`, and `packages/domain/src/account/account.test.ts`.

Outstanding: merge and review against `master`, a tag, a scheduler for
`maintenance:accounts`, and a production `ExportArchivePort` adapter. Details in
[`HANDOFF.md`](HANDOFF.md#what-is-not-done).

---

## Done — Milestone II: the PostgreSQL/PostGIS and Redis production path

Merged on `main` (`416b6af` → `eabaf72`). A separate PostgreSQL Prisma schema
and migration path coexists with the SQLite development/test path, the PostGIS
`GeoPort` pushes zone containment into the database as `ST_Covers`, and
Redis/BullMQ replaces the in-memory queue with idempotent job handling,
delay/retry behaviour, and rate-limit counters shared across instances — failing
**closed** on a Redis outage.

Verified against real infrastructure: PostgreSQL 16 + PostGIS 3.4 (**14/14**
checks, including boundary and hole semantics) and Redis 7 (**8/8**, including a
shared rate-limit budget across two API instances). **Merged; not deployed.**

---

## Implemented and locally verified on branch — not merged — Milestone III: secret management and key custody

> **Not on `main`.** This work lives on `claude/milestone-iii-secret-management`
> and has not been merged, tagged, or deployed. Nothing in this section describes
> code that has landed on the main line.

Every configuration variable classified secret or non-secret in one table that
drives log redaction, the leak tests, and the `.env.example` gate. Redaction by
key fragment *and* by shape inside free text, which is what catches a connection
string in a driver's own error message. Key custody hardened: an ambiguous
keyring no longer boots, and a key id the envelope format cannot carry is
refused before it can write an unreadable row. A rotation survey answers "is it
safe to destroy the old key yet?" without decrypting anything.

The secret-source contract is **runtime environment injection**
([ADR-0011](docs/DECISIONS.md#adr-0011--runtime-environment-injection-as-the-secret-source-contract)) —
deliberately no cloud SDK, because no deployment platform has been chosen.
Locally verified on the branch. **Not merged. No secret store is integrated and
no production secret exists.**

---

## Implemented and locally verified on branch — not merged — Milestone V: realtime

> **Not on `main`.** This work lives on `claude/milestone-v-realtime`, based on
> the (also unmerged) Milestone IV commit. It has not been merged, tagged, or
> deployed.

**A WebSocket endpoint that pushes notifications, not data.** `GET /v1/realtime`
sends `{subject, version}` and the client re-reads through the ordinary
authorized route. The extra round trip is the point: the field-level projection
rules that took the whole project to get right — vendor sees a first name and no
phone number, rider position only while the order is active, delivery PIN to
nobody — live in the route handlers, and a socket that pushed rows would bypass
every one of them, silently, for every subscriber at once
([ADR-0013](docs/DECISIONS.md#adr-0013--realtime-carries-notifications-not-data)).

**Everything else follows from that choice.** At-least-once and unordered
delivery stop being dangerous, because acting on a duplicate re-reads state that
is already current. Reconnection needs no replay — a fresh subscription is told
`resync` and reads the current state. And degrading to polling is not a second
code path: it is the same read on a timer, which is what these screens already
did.

**Authentication is a frame, not a handshake.** No token in the query string, no
cookie — the first would put a 15-minute credential in access logs, the second
is cross-site WebSocket hijacking waiting to happen. The socket opens with no
privilege and sends the ordinary access token. That also fixes the problem most
long-lived sockets ignore: authority on a socket cannot outlive authority on an
HTTP request, because the socket closes when its token lapses, and a sweep
re-reads the session on a timer.

**Notifications go through the Milestone IV outbox — no second dual write.**
`recordOrderChange(tx, orderId)` bumps a monotonic `Order.revision` and records
the notification inside the caller's transaction. Publishing before the commit
would announce a state the order never reached; publishing after it would lose
the notification in the gap with nothing recording that it was owed.

**Queue *then* broadcast**, because they are opposites. A queue job goes to one
consumer; a notification must reach every instance, since the client watching an
order is rarely on the instance whose worker took the job. Redis pub/sub is
classified `degradable` — losing it means screens refresh on a timer.
`REALTIME_BROADCAST=memory` is refused in production for the same reason
`QUEUE_PROVIDER=memory` is.

**196 tests**: 76 pure (topic parsing against crafted input, authorization truth
tables, frame parsing, backoff), 49 over real sockets on an ephemeral port, 24
on the hub, 13 on the outbox seam, and 34 on the browser client — including a
rendered component proving a hostile frame never reaches the DOM.

**Verified against real infrastructure.** `npm run check:redis` passes 14/14: a
notification published by one instance reaches a second instance's hub and
becomes a frame on its socket, deployments sharing one Redis are isolated by
prefix, and malformed or crafted broadcasts are rejected rather than delivered.
`npm run check:postgres` passes 17/17 against PostgreSQL 16 + PostGIS 3.4 with
the `Order.revision` migration in the history, from an empty database.

**All four screens consume it, and all four keep polling.** Customer tracking,
the vendor queue, the dispatch board, and the rider's offer list share one
socket per tab and re-read on a notification; their existing poll stretches to a
30-second safety net while live and returns to its old interval when not. The
rider's *position* stays on its own timer — it changes every few seconds, is
written by that client rather than read by it, and pushing it would multiply it
by the number of watchers.

---

## Implemented and locally verified on branch — not merged — Milestone IV: durability

> **Not on `main`.** This work lives on `claude/milestone-iv-durability-scale`,
> based on the (also unmerged) Milestone III commit. It has not been merged,
> tagged, or deployed.

**A transactional outbox**, closing a dual write at five call sites. The intent
to enqueue is now a row written inside the same transaction as the state change
that caused it, so an accepted order and the instruction to dispatch a rider can
no longer disagree. Before this, a Redis outage between the two returned **500**
for an order that was already accepted in the database — reproduced by a test
against the pre-existing code. Delivery is at-least-once and says so; the dedupe
key is mandatory and passed through to the queue. A best-effort flush after
commit keeps latency unchanged when the queue is healthy.

**A nightly ledger reconciliation** over the *whole* ledger by keyset
pagination, rather than the newest 5 000 the on-demand endpoint checks. It also
catches the invariant `verifyLedgerIntegrity` cannot see on its own: a
transaction with no entries sums to zero vacuously while recording money that
did not move. It repairs nothing (ADR-0006) and records every run.

**One maintenance command** — `npm run maintenance:all` — running the outbox
relay, retention, account maintenance, and reconciliation under a portable
lease, exiting non-zero for a failure *or* an overdue job. It does not schedule
itself ([ADR-0012](docs/DECISIONS.md#adr-0012--a-transactional-outbox-and-a-scheduler-this-repository-does-not-own));
a cron entry, systemd timer, or CronJob must invoke it.

Session pruning, rider-location retention, deletion finalisation, and export
expiry were already implemented — what they lacked was anything to run them.

---

## Phase 3 — Durability and scale

Redis + BullMQ and PostgreSQL + PostGIS landed in Milestone II. The transactional
outbox and the maintenance jobs landed in Milestone IV, below. What remains:

- **A browser journey against a running server.** Milestone V's client is
  covered by tests against a fake socket and a real DOM, and its server by a
  real WebSocket on an ephemeral port, but the two have never been connected in
  an actual browser.
- **Rider position streaming.** Deliberately excluded from Milestone V: a
  notify-then-re-read design multiplies position pings by the number of
  watchers. Pushing coarse position on its own channel is separate work.
- **A scheduler that invokes `npm run maintenance:all`.** The command exists and
  is idempotent; nothing in this repository calls it on a timer, deliberately
  ([ADR-0012](docs/DECISIONS.md#adr-0012--a-transactional-outbox-and-a-scheduler-this-repository-does-not-own)).
  Until a cron entry, systemd timer, or CronJob exists, the jobs do not run.
- Background key re-encryption on a schedule. The primitives exist
  (`apps/api/src/secrets/rotation.ts`); nothing runs them automatically, which
  is deliberate — rotation is a supervised operation, not something that should
  be able to start itself.

---

## Phase 4 — Real integrations

**Gated on Phase 1.** Each is an adapter that exists and has never been run
against a live service. Each needs sandbox credentials, a signature test, an
idempotency test, and a failure-path test before it can be called working.

| Integration | Adapter status |
|---|---|
| Paystack (payments + webhooks) | Interface + mock only |
| Google Maps or Mapbox (routing, geocoding) | Interface + local haversine only |
| Termii or Twilio (SMS/OTP) | Interface + console only |
| SMTP (email) | Interface + console only |
| FCM/APNs (push) | Interface + console only |
| S3 or MinIO (storage) | Interface + local disk only |

Nothing moves to "working" in the docs until a sandbox test proves it.

---

## Phase 5 — Product breadth

Features the domain already anticipates but the product does not yet offer:

- **Vendor onboarding** — KYB application, document review, approval workflow.
  Models exist (`VendorDocument`), no flow does.
- **Rider onboarding** — identity/KYC submission, vehicle papers, training
  checklist, agreement acceptance.
- **Catalogue management UI** — the API supports availability and stock; there is
  no screen for categories, items, modifiers, or bulk actions.
- **Support workspace** — cases and actions are modelled and seeded; the agent
  UI does not exist.
- **Finance console** — settlements, payout batches, statements. The ledger
  supports all of it; only the integrity endpoint is exposed.
- Batched/stacked dispatch — the scorer handles capacity and vehicle
  compatibility, but nothing groups compatible orders.
- Scheduled orders, package delivery, events ticketing — flagged off in
  `FeatureFlag`, not implemented.
- Ratings and reviews — modelled and seeded, no write path.

---

## Phase 6 — Pre-launch

- Threat model review and a documented authorization matrix.
- Load testing: order placement, location ingestion, dispatch, dashboards.
- Backup, restore rehearsal, and point-in-time recovery. **Not started** — the
  procedure is documented and the key half is rehearsed against synthetic
  material, but no real backup has ever been taken or restored.
- Secret store selection and runtime injection. The application side is done on
  the unmerged Milestone III branch; the platform is not chosen.
- Break-glass role, its holder, and its authoriser. **Owner decisions.**
- Separate development, staging, and production environments, with per-
  environment credentials. The rules are written and enforceable in code; the
  environments do not exist.
- Incident-response runbook: detection, containment, key rotation, provider
  notification, evidence preservation, recovery, post-incident review.
- **Nigerian data-protection (NDPA 2023) and consumer-law review by qualified
  counsel.** Every legal template in this repo is a draft and is not legal
  advice.
- Store-build configuration if mobile apps are pursued.

---

## Explicitly not planned yet

- **React Native mobile apps.** The rider surface is a responsive web app.
  Native shells would reuse the same API and domain packages, but the web
  surfaces should earn their keep first.
- **Multi-city or multi-country rollout.** Everything is data-driven and
  city-scoped by design, but only Lagos is seeded, and the in-TypeScript geo path
  will not scale past a city's worth of zones without PostGIS.
- **ML for pricing, ETA, or dispatch.** The engines are deterministic rules that
  record the features a model would need. There is no training data yet, and
  claiming otherwise would be dishonest.
