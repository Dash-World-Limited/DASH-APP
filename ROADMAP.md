# Roadmap

Where DASH APP is and what comes next, in the order it should happen.

Latest tag: **`v0.2.0-auth`**. Considerable work has landed on `master` since —
business API coverage, administrator MFA, encryption at rest, retention,
security scanning, and observability seams — and is deliberately **untagged**.
The last requested milestone (account deletion and data export) is now built on
`claude/dash-app-v1` but not yet merged to `master`; tagging waits for the merge.

The ordering is not arbitrary. Each phase removes a blocker for the next, and
the two hard gates below exist because getting them wrong is expensive to undo.

> **Gate 1 — no live payment integration until authentication is
> production-grade.** *Cleared in Phase 1.* Refresh tokens are now HttpOnly
> cookies with CSRF protection and tested reuse detection. Payments remain
> gated on the rest of Phase 4's prerequisites: sandbox credentials, and a
> signature, idempotency, and failure-path test for each provider.
>
> **Gate 2 — no production deployment until CI, secret management, backups, and
> an incident runbook exist.** *Still closed.* CI now exists; secret management,
> backups, and the runbook do not. A deployment without those is not a
> deployment, it is an outage waiting for a date.

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
  batching, convergence, and concurrency safety. **Nothing schedules it yet.**
  The account-maintenance job (Milestone E) shares the same properties and the
  same gap.
- ✅ Runbooks: incident response, secret inventory, backup/restore, environment
  separation, readiness checklist, rollback criteria, alert severities.

## Built, awaiting merge — account deletion and data export

Implemented on `claude/dash-app-v1`: a `scheduled → cancelled | completed`
deletion state machine behind a fresh step-up, a cooling-off window, a
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

## Phase 3 — Durability and scale

- **Redis + BullMQ** replacing the in-memory queue. Today a second API instance
  would run its own dispatch worker and double-offer, so this gates horizontal
  scale.
- **PostgreSQL + PostGIS** replacing SQLite. The schema and `GeoPort` were
  written for this; it is a datasource change plus the PostGIS `GeoPort`
  implementation.
- Websockets replacing polling on tracking, the vendor queue, and the ops board.
- Transactional outbox for domain events.
- Scheduled jobs: session pruning, rider-location retention, account-deletion
  finalisation and export-archive expiry, nightly ledger reconciliation.

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
- Backup, restore rehearsal, and point-in-time recovery.
- Secret management, key rotation, per-environment credentials.
- Separate development, staging, and production environments.
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
