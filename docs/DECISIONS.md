# Architecture Decision Records

Each ADR records a choice, why it was made, what it costs, and how to reverse it.
Newest last. Never edit an accepted ADR's decision — supersede it with a new one.

---

## ADR-0001 — npm workspaces instead of pnpm + Turborepo

**Status:** Accepted · Milestone 1

**Context.** The build spec recommends Turborepo + pnpm workspaces. The target
machine has Node 24.19 and npm 11.17. pnpm is not installed and installing it
is a prerequisite the user did not ask for.

**Decision.** Use npm workspaces (built into npm 11) with a small Node script for
parallel dev processes. No Turborepo.

**Consequences.**
- Zero extra installs; `npm install` at the root wires every workspace.
- Lost: Turborepo's remote/local task caching. At this repo size a cold
  `typecheck` is a few seconds, so the caching is not yet worth the dependency.
- `tsc --build` project references give us incremental builds, which covers most
  of what Turborepo caching would have bought.

**Reversal.** Adding Turborepo later is additive: `npm i -D turbo`, add
`turbo.json`, change root scripts. No source changes.

---

## ADR-0002 — Fastify + Zod instead of NestJS

**Status:** Accepted · Milestone 1

**Context.** The spec recommends NestJS with REST/OpenAPI. NestJS brings DI,
guards, and decorator-driven modules — genuinely good for a permission model.
It also brings 3–5 files per feature (module, controller, service, DTO, spec)
and a decorator/`reflect-metadata` layer.

**Decision.** Fastify 5 + Zod for validation, with `@fastify/swagger` generating
OpenAPI from the Zod schemas. Authorization is a explicit `requirePermission()`
preHandler rather than a decorator guard.

**Why this is the "strong reason" the spec allows for deviating.**
1. This platform's surface area is very wide (customer, rider, vendor, admin,
   support, finance). Feature-per-token matters, and Fastify routes are ~4x
   denser than the NestJS equivalent.
2. Zod schemas are shared verbatim with the web app for client-side validation
   and with tests. NestJS DTOs would need a second definition or a bridge.
3. Domain logic lives in `@dash/domain` as pure functions with no framework
   coupling, so the DI container NestJS provides has little to manage here.
4. Node 24 + ESM + NodeNext resolution is friction-free on Fastify.

**Consequences.**
- We hand-roll what Nest gives free: the auth preHandler chain, error
  serialization, and route registration. All three are implemented once in
  `apps/api/src/plugins/` and documented.
- Risk: without a DI container, testing seams must be deliberate. Mitigated by
  keeping all I/O behind the adapter interfaces in `packages/domain/src/ports`.

**Reversal.** Costly. Domain logic would port unchanged, but every route would be
rewritten. This is a one-way-ish door and is recorded as such.

---

## ADR-0003 — SQLite for local dev, PostgreSQL + PostGIS as production target

**Status:** Accepted · Milestone 1

**Context.** The spec requires PostgreSQL with PostGIS. The target machine has no
Docker, no pnpm, and no local PostgreSQL. Requiring Docker Desktop before the
first feature exists was explicitly weighed against and rejected by the user.

**Decision.** Prisma with a SQLite dev datasource. The schema is authored to stay
portable, and all geospatial work goes through a `GeoPort` interface with two
implementations.

**Rules that keep the port open.**
- No SQLite-only Prisma features. No `Unsupported()` columns.
- Geometry is stored as ordinary columns — `latitude`/`longitude` as `Float`, zone
  polygons as a JSON array of `[lng, lat]` rings — never as a PostGIS `geography`
  type in the Prisma schema.
- Point-in-polygon, distance, and bounding-box queries go through
  `packages/domain/src/geo/` (pure TypeScript, ray-casting + haversine). The
  PostGIS implementation of the same interface uses `ST_Contains` / `ST_DWithin`
  and is selected by `MAPS_PROVIDER`.
- Money is `Int` (kobo) everywhere. No `Decimal`, no `Float`, no currency math in
  the database.
- Enums are modelled as `String` columns constrained by Zod at the boundary,
  because SQLite has no native enum. Postgres migration can promote them later.

**Consequences.**
- `npm run setup` works on a clean machine with no installs. This was the
  deciding factor.
- Cost: the in-TypeScript geo path loads all candidate zones for a city and tests
  them in process. Correct, and fine for Lagos-scale zone counts (tens), but it
  will not scale to national zone counts without the PostGIS implementation.
  This limit is recorded in `docs/PROGRESS.md` under Known Limitations.
- Cost: no true concurrent writers. Acceptable for single-developer local work;
  it is the reason SQLite is dev-only and never a production option.

**Reversal.** Change `provider` in `schema.prisma` to `postgresql`, point
`DATABASE_URL` at Postgres, run the migration, set `MAPS_PROVIDER=postgis`. The
schema was authored for this; the geo port is the only code that switches.

---

## ADR-0004 — One Next.js app with role route groups, not five apps

**Status:** Accepted · Milestone 1

**Context.** The spec lists five separate front-ends (customer, rider, vendor,
admin, support). Five Next.js apps means five dev servers, five ports, five build
pipelines, and five copies of the auth client.

**Decision.** A single `apps/web` (Next.js 15, App Router) with route groups:
`(marketing)`, `(customer)`, `(rider)`, `(vendor)`, `(admin)`. Each group owns its
own `layout.tsx`, navigation, and theme surface. Support is a section inside the
admin group because support agents and dispatchers share a shell and a session
model.

**Consequences.**
- One `npm run dev:web`, one port, one auth client, one design-token import.
- Route groups give genuinely separate layouts and loading/error boundaries, so
  the customer app does not inherit the admin chrome.
- Cost: one deploy artifact for all roles. A bug in the build blocks every
  audience at once. Mitigated by per-group error boundaries and by keeping the
  API — where the real authorization lives — deployed separately.
- **Security note:** route groups are a code-organization device, not a security
  boundary. Every permission check is enforced in the API. The web app's role
  routing is convenience only, and the adversarial tests assert that hitting a
  vendor endpoint with a customer token is rejected server-side.

**Reversal.** Splitting a route group into its own app is mechanical: move the
directory, add a `package.json`, keep the shared `@dash/ui` and `@dash/api-client`
imports unchanged.

---

## ADR-0005 — Adapter ports for every external dependency

**Status:** Accepted · Milestone 1

**Context.** Payments, maps, SMS, email, push, object storage, and queues are all
external. None can be verified on this machine without live credentials, and the
spec forbids claiming an integration works before it is tested against a sandbox.

**Decision.** Each is defined as a TypeScript interface (a "port") in
`packages/domain/src/ports/`, with at minimum a deterministic offline
implementation used by default in development and tests.

| Port | Default (dev) | Production target |
|---|---|---|
| `PaymentPort` | `mock` — deterministic, no network | Paystack (sandbox first) |
| `GeoPort` | `local` — haversine + ray-casting | PostGIS / Google / Mapbox |
| `SmsPort` / `EmailPort` / `PushPort` | `console` — writes to the log | Termii / SMTP / FCM |
| `StoragePort` | `local` — `./.storage`, signed-URL emulation | S3 / MinIO |
| `QueuePort` | `memory` — in-process, ordered | Redis + BullMQ |

**Consequences.**
- The whole platform runs and is testable offline with no accounts.
- Honesty is structural: `PAYMENT_PROVIDER=mock` in the log banner at boot makes
  it impossible to mistake the mock for a live integration.
- Cost: an indirection layer over things that could have been called directly,
  and the real adapters remain unverified until credentials exist. Every such
  adapter is listed as "adapter-only, untested" in `docs/PROGRESS.md` until a
  sandbox test proves otherwise.

---

## ADR-0006 — Money as integer kobo, balances only via an append-only ledger

**Status:** Accepted · Milestone 1

**Context.** Floating-point currency and mutable balance columns are the two
defects that are hardest to recover from once real money has moved.

**Decision.**
- Every monetary value is an integer count of kobo (₦1 = 100 kobo), typed as a
  branded `Kobo` type so a raw `number` cannot be passed by accident.
- No table has a mutable `balance` column. Balances are derived by summing
  `LedgerEntry` rows. Every entry belongs to a `LedgerTransaction` whose entries
  must sum to zero (double-entry).
- Ledger rows are append-only: no update, no delete, no soft-delete. Corrections
  are new reversing transactions.
- Every money-moving operation takes an idempotency key and is safe to retry.

**Consequences.**
- Reading a balance costs an aggregate query rather than a column read.
  Mitigated later with a materialized snapshot + `as_of` cursor if it measures
  slow; the ledger stays the source of truth regardless.
- Cost: more rows, and more discipline required of every contributor.
- This is the invariant the finance tests assert hardest against.

---

## ADR-0007 — Deterministic, explainable dispatch and pricing — no ML claims

**Status:** Accepted · Milestone 1

**Context.** The spec explicitly forbids pretending to use AI/ML where no trained
model exists.

**Decision.** Pricing, dispatch scoring, and ETA are pure, versioned, deterministic
functions. Each returns not just a result but a `breakdown` explaining every term
that contributed, and the `ruleVersion` that produced it. Both are persisted with
the order.

**Consequences.**
- Any quote or assignment can be reconstructed and defended months later, which
  matters for vendor disputes and rider pay complaints.
- Prediction inputs and actual outcomes are recorded (`EtaPrediction`), so a model
  can be trained later from real data instead of guessed at now.
- Cost: rules will be less accurate than a tuned model would eventually be. That
  is the correct trade at launch, when there is no data to train on.

---

## ADR-0008 — Refresh tokens in HttpOnly cookies, with double-submit CSRF

**Status:** Accepted · Phase 1 (post `v0.1.0-mvp`)

**Context.** Until this change the refresh token was returned in the sign-in
response body and stored in `sessionStorage`. That is readable by any script on
the origin, so a single XSS yielded a 30-day session rather than a 15-minute
one. `sessionStorage` at least dies with the tab, which is why it was chosen
over `localStorage`, but it was recorded from the outset as the largest
weakness in the system.

**Decision.**

- The refresh token moves into a `HttpOnly`, `Secure`, `SameSite=Lax` cookie
  scoped to `/v1/auth`, and is **never** returned in a response body.
- The access token stays in the body and is held in memory only — 15 minutes,
  never persisted.
- CSRF is defended by double-submit: a separate non-HttpOnly cookie is echoed
  back in an `X-CSRF-Token` header, compared in constant time, and reissued on
  every rotation.

**Why these specific attributes.**

*`HttpOnly`* is the entire point — script cannot read the value.

*Path-scoped to `/v1/auth`* so the browser never attaches a 30-day credential to
an order read, a catalogue browse, or a file upload. It narrows the blast radius
of every other endpoint.

*`Secure` in production only.* Browsers refuse to store a `Secure` cookie over
plain HTTP on anything but localhost, and the development stack is HTTP.
`assertSecureCookieConfig()` fails the boot if this ever inverts in production,
and `config.ts` rejects a plain-HTTP `PUBLIC_WEB_URL` there.

*`SameSite=Lax`, not `Strict`.* The web app and API run on different ports in
development. Ports do not affect same-site classification, so `Lax` is enough
for the cross-port XHR while still blocking the cross-site top-level POST. The
CSRF token is the real defence; SameSite is depth.

*Double-submit rather than a server-side synchroniser token.* It needs no
server-side state, which suits an API that is otherwise stateless between
requests. It is safe because the attacker can cause the cookie to be **sent**
but cannot **read** it to forge the matching header.

**Consequences.**

- An XSS now yields at most a 15-minute access token.
- Cookies must be sent cross-origin, so every client request needs
  `credentials: 'include'`, and CORS needs `credentials: true` with a strict
  origin allowlist and `X-CSRF-Token` in `allowedHeaders`. A reflected origin
  alongside credentials would be a serious hole; the allowlist is what makes it
  safe.
- Non-browser clients (a future native app, a test harness) must handle cookies
  or use the CSRF token returned in the body.
- Cost: more moving parts, and a class of bug — a cookie not cleared on logout,
  attributes that do not match on clear — that is invisible until someone looks.
  Hence the 37 integration tests that assert on the actual `Set-Cookie`
  attributes rather than on the code's intent.

**What this change uncovered.** Refresh-token reuse detection had been written
at `v0.1.0-mvp` but was unreachable: rotation marks the old session both
`rotatedAt` and `revokedAt`, and the generic revoked check sat above the reuse
check, so it always won. A replayed token reported "revoked" and the session
family was never torn down. See bug 11 in `docs/PROGRESS.md`.

**Reversal.** Not intended. Returning to a body-carried refresh token would
reintroduce the vulnerability this exists to close.

---

## ADR-0008 — Two Prisma schemas, not one dynamic datasource

**Status:** Accepted · Milestone II

**Context.** ADR-0003 chose SQLite for development and PostgreSQL + PostGIS for
production. Milestone II had to make the production half real without making
local development need Docker, a database server, or any setup the previous
milestones did not.

Prisma does not permit this in one file. Three independent constraints:

- `provider` may not be `env()` — Prisma rejects it with P1012.
- `migration_lock.toml` pins the provider, and migrations refuse to run against
  a datasource that disagrees with it.
- The SQLite migration history is SQLite DDL. The committed migrations contain
  139 `DATETIME` columns and 50 inline `TEXT NOT NULL PRIMARY KEY` declarations;
  PostgreSQL needs `TIMESTAMP(3)`, `DOUBLE PRECISION`, and separate
  `ADD CONSTRAINT … PRIMARY KEY`. The same history cannot replay on both.

**Decision.** Keep two schemas and two migration histories.
`packages/db/prisma/schema.prisma` is authored;
`packages/db/prisma/postgres/schema.prisma` is **generated** from it by
`packages/db/src/postgres-schema.ts`, which applies one declared substitution —
the provider line — and nothing else.

The obvious hazard is that the two drift. Three things stop that:

1. The PostgreSQL schema is generated, never edited. `npm run db:pg:sync`
   writes it; `--check` verifies it.
2. `schema-sync.test.ts` asserts regeneration reproduces the checked-in file
   byte-for-byte, **and** — computed independently of the transform, so a bug in
   the transform cannot mask a real divergence — that the model surface of both
   files is character-identical.
3. Every intentional dialect difference is an entry in `DIALECT_SUBSTITUTIONS`
   with a written reason. There is one. The schema carries no `@db.*` native
   type annotations, so Prisma maps every field itself and the models are
   genuinely the same document in both dialects.

**Alternatives rejected.** Moving development to PostgreSQL would have meant the
887-test suite could not run without a database server — it builds a per-worker
SQLite template file — and would have added exactly the local-development
friction ADR-0003 exists to avoid. A runtime-switched datasource is not
available to us at any price: Prisma forbids it.

**Reversible?** Yes, in one direction cheaply: dropping SQLite later means
deleting the authored schema and promoting the generated one. Going the other
way after production data exists would not be.

---

## ADR-0009 — PostGIS as a query capability, not a column type

**Status:** Accepted · Milestone II

**Context.** `GeoPort.zonesContaining` has always carried the note that "the
local implementation tests polygons in process; the PostGIS one uses
`ST_Contains`". Milestone II is where that becomes true. The question was
whether PostGIS geometry should become part of the data model.

**Decision.** It should not. Geometry is built per query from the `polygon` text
the schema already stores, using `ST_GeomFromText` over WKT that
`polygonToWkt()` produces in pure, tested domain code. No column, no
`Unsupported()` type, no `geometry` in either schema.

Three reasons:

- The domain models did not have to be redesigned, which was an explicit stop
  condition for this milestone.
- The two schemas stay byte-identical apart from the provider, so the drift
  guard in ADR-0008 stays strong. A PostGIS-only column would have been the
  first entry in a divergence list that tends to grow.
- Prisma's drift check keeps its meaning. A geometry column outside the model
  would show as drift on every run, and the usual fix — teaching the check to
  ignore it — is how a drift check stops catching anything.

**What PostGIS is actually buying.** Not speed, at this size. Correctness: the
containment test becomes PostgreSQL's own topological predicate rather than a
hand-written ray cast, which is what gets edges, shared vertices, and holes
right. And the bounding-box pre-filter now runs in the database against indexed
columns instead of loading every zone in a city into the API process.

**Known cost.** There is no GiST index, because there is no indexed column to
build one on. The indexed bounding-box pre-filter is what keeps the exact test
running over a handful of candidate rows. At a scale where one city holds
thousands of overlapping zones, the answer is a materialised geometry column
with a GiST index — which would mean revisiting this ADR and accepting a
declared divergence between the schemas. That is a deliberate trade recorded
here, not an oversight.

---

## ADR-0010 — What Redis is trusted with, and how it fails

**Status:** Accepted · Milestone II

**Context.** Redis was needed for two things the in-process implementations
cannot do across more than one instance: a rate limit that is actually one
budget, and a queue whose jobs survive a restart. The risk with a cache in the
request path is that it quietly becomes a single point of failure, or quietly
becomes the system of record.

**Decision.** Redis holds counters and job payloads. Nothing else.

Sessions, OTP challenges, MFA challenges, idempotency keys, the ledger, and
every account-lifecycle record stay PostgreSQL rows. `redis.test.ts` asserts
this by name: a responsibility whose name contains `session`, `otp`, `ledger`,
`idempotency`, `order`, or `payment` fails the suite. No cache was added,
because nothing needed one and a cache is an invalidation bug looking for a
reason to exist.

Each responsibility is classified in `REDIS_RESPONSIBILITIES`, and the register
is asserted rather than documentary:

| Responsibility | Mode | Correctness-critical | On outage |
|---|---|---|---|
| Rate limiting | **fail-closed** | Yes | Requests are rejected |
| Queue | **retryable** | No | `enqueue` throws; the durable row is untouched |

**Rate limiting fails closed, deliberately.** `@fastify/rate-limit` defaults to
`skipOnError: true` — fail *open*. `config.ts` already refuses to start
production with rate limiting disabled, on the grounds that it is the only
defence against credential stuffing and OTP brute force. A Redis outage that
silently fell back to no limiting would be that same disabled state, reached by
accident and visible to nobody. The server registers `skipOnError: false`.

**The consequence, accepted.** A Redis outage takes the API out of service
rather than degrading it. That is the intended trade for a security control, and
it is why `/health` and `/health/ready` are exempt from rate limiting: an
instance must still be able to answer "am I healthy?" during the outage, and a
load balancer needs 503 (take me out) rather than 429 (slow down). Both routes
are cheap — liveness touches nothing, readiness runs one `SELECT 1` and one
`PING` — so there is nothing to amplify.

**Queue failures surface.** An enqueue that cannot reach Redis throws rather
than returning a fabricated job id. A caller that believes work was queued when
it was not is how an export sits `pending` for ever with nobody aware.

**Not a hidden single point of failure.** Where Redis sits in the request path
is written down above, asserted in tests, and visible in readiness — which
reports the dependency by role (`queue`) rather than by technology, preserving
the `/health/ready` non-disclosure contract from Milestone G.

---

## ADR-0011 — Native-first clients and a stable six-service product contract

**Status:** Accepted · Product foundation

**Context.** The current milestone proved the core flow through one responsive
Next.js application. Product review established that the customer and rider
experiences must be genuine mobile applications, while vendor and operations
work remain browser-based. The earlier public category names also mixed UI
language with legacy Vendor.category storage values.

**Decision.**

- Customer and rider are separate React Native / Expo applications. They call
  the existing API directly and must not embed the web app in a WebView.
- Vendor, admin, support and finance remain web surfaces, designed to feel like
  purpose-built operational applications rather than a wrapped consumer site.
- The permanent public service ids, in order, are: food, shops, pharmacy,
  local_market, declutter, logistics. Their visible navigation labels are
  FOOD, SHOPS, PHARMACY, LOCAL MARKET, DECLUTTER and LOGISTICS.
- Food, Shops, Pharmacy and Local Market are merchant-commerce services.
  Declutter is a marketplace domain. Logistics is a shipment-request domain.
- Existing Vendor.category values remain compatibility storage until a later
  additive migration. No historical row is reinterpreted or destructively
  renamed for this decision.
- The existing merchant Order aggregate keeps its required vendor and branch.
  Declutter and Logistics must receive separate aggregates and may share a
  fulfilment abstraction only after their different ownership, pricing,
  cancellation, dispute and proof-of-delivery rules are explicit.

**Consequences.** The current customer and rider web routes remain useful as a
staging harness while native clients are built, but they are no longer the
official end-product direction. Legacy API clients may continue using the
category filter during a measured compatibility window; new clients use the
service filter and the public service-category endpoint.

**Supersedes.** This supersedes ADR-0004 only for client topology. Its rule
that authorization is enforced by the API remains fully in force.

**Migration safety.** Future database work is additive: create new structures,
dual-read or backfill in bounded batches, observe, cut over, and only then
remove old paths in a later release. A migration may not make merchant-order
fields nullable merely to squeeze a different business model into Order.
