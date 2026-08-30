# Roadmap

Where DASH APP is and what comes next, in the order it should happen.

Current tag: **`v0.1.0-mvp`** — local MVP, complete order lifecycle, no external
integration.

The ordering is not arbitrary. Each phase removes a blocker for the next, and
the two hard gates below exist because getting them wrong is expensive to undo.

> **Gate 1 — no live payment integration until authentication is
> production-grade.** Wiring a real gateway to a system whose refresh tokens sit
> in `sessionStorage` is the wrong order.
>
> **Gate 2 — no production deployment until CI, secret management, backups, and
> an incident runbook exist.** A deployment without those is not a deployment,
> it is an outage waiting for a date.

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

## Next — Phase 1: CI and production-grade authentication

**In progress.** The single most important change before anything else, because
every later phase inherits its security posture.

### Authentication
- Short-lived access token, in memory only, never persisted.
- Refresh token in a `Secure` `HttpOnly` `SameSite` cookie, scoped to the
  refresh path.
- CSRF protection — double-submit token, verified on every state-changing
  request that carries a cookie.
- Refresh-token reuse detection and family revocation (already implemented;
  needs cookie-path coverage and tests).
- Tests for login, refresh, logout, replay, CSRF, and concurrent sessions.

### CI
- GitHub Actions: format, lint, typecheck, unit tests, coverage thresholds,
  Prisma schema validation, fresh-database boot, web production build.
- Branch protection on `main`.

### Production boot safety
- Extend the existing guards so a production process cannot start with mock
  adapters, `DEV_EXPOSE_OTP`, or placeholder secrets — and add tests that prove
  each guard fires.

**Exit criteria:** a merge to `main` is blocked unless everything above passes,
and `NODE_ENV=production` with any development setting refuses to boot.

---

## Phase 2 — Test depth and observability

- API integration tests against a test-scoped database, replacing the two
  script suites as the merge gate (the scripts stay as smoke checks).
- Adversarial suite as automated tests: IDOR sweeps, privilege escalation, mass
  assignment, rate-limit bypass, race conditions, webhook replay.
- Playwright journeys for the customer, vendor, and ops surfaces.
- Structured request/response metrics, health checks, an error-tracking adapter.
- Accessibility checks in CI (axe), responsive viewport checks.
- Dependency, secret, and container scanning.

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
- Scheduled jobs: session pruning, rider-location retention, nightly ledger
  reconciliation.

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
- **Admin MFA** — TOTP enrolment and verification. `mfaSecret` is modelled and
  unused; step-up currently reuses the OTP challenge.
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
- Account deletion and data export — `deletionRequestedAt` is modelled only.

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
