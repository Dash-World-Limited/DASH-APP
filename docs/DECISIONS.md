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
test suite could not run without a database server — it builds a per-worker
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

## ADR-0011 — Runtime environment injection as the secret-source contract

**Status:** Accepted · Milestone III

### Context

Milestone III is production secret management. The obvious reading of that
brief is "integrate a secret manager", and the obvious implementations are AWS
Secrets Manager, GCP Secret Manager, or HashiCorp Vault.

DASH APP has not chosen a deployment platform. It has never been deployed, and
the hosting decision is open (see `ROADMAP.md` Gate 2). Choosing a secret store
now would be choosing a cloud vendor now, by a side door, on the strength of an
infrastructure milestone rather than a deployment decision.

Meanwhile the actual risks are not hypothetical and are not vendor-specific:

- Secret values could reach a log, an error, or a health response.
- A misconfigured keyring could boot and silently make rows unreadable.
- `.env.example` could grow something that looks like a real credential.
- No inventory said which variables were secret in the first place.

None of those is fixed by an SDK.

### Decision

**Secrets enter the process through the environment. The application does not
know, and must not ask, what put them there.**

`loadConfig(source: NodeJS.ProcessEnv)` already takes the environment as an
argument. That parameter *is* the injection seam, and no further abstraction is
introduced. Specifically:

- **No secret-store SDK is added.** Not AWS, not GCP, not Azure, not Vault.
- **No `SecretSource` interface is added** either. An interface with exactly one
  implementation is ceremony that makes the codebase look like it supports
  something it does not.
- Investment goes instead into the parts that are vendor-independent and were
  genuinely missing: an explicit classification of every variable, redaction
  driven by that classification, hardened key custody, and a rotation procedure
  with a verifiable retirement gate.

### What this supports

| Environment | How values arrive |
|---|---|
| Development, test | A `.env` file, or the harness passing an object directly |
| Staging, production | The platform's own injection — Kubernetes secrets projected as env vars, AWS/GCP secret managers through the platform, Vault's agent, a hosting provider's secret UI |
| A future direct integration | An adapter that fetches from a store and returns a populated object, passed to the same `loadConfig(source)` |

The third row is why no abstraction is needed today: the seam for it already
exists and is already exercised, because every test in the suite uses it.

### Consequences

**The application stays portable.** Any platform that can set an environment
variable can run this, which is all of them. Nothing needs rewriting when the
hosting decision is finally made.

**No dependency, no credential, no IAM policy** is required to run the service
locally or in CI, and no cloud SDK sits in the dependency tree carrying its own
advisories.

**The honest status is "secret-store-ready", not "secret store integrated".**
Documentation must say so. A reader who takes this for a managed secret store
would skip provisioning one.

**Injection quality is the platform's responsibility, and unverified here.**
Whether the platform's environment injection is itself secure — whether the
values appear in a pod spec, a build log, or a process listing — is outside what
this repository can check. It is on the production readiness checklist.

**The classification table becomes load-bearing.** Log redaction, the leak
tests, and the `.env.example` gate all read from
`apps/api/src/secrets/classification.ts`. A secret variable that is not
classified is not protected, so classifying one is part of adding one.

### Rejected alternatives

**Integrate AWS Secrets Manager.** Picks a cloud vendor as a side effect of a
security milestone, adds an SDK and IAM setup to run the app locally, and would
have to be rewritten if the platform decision goes elsewhere.

**Write a `SecretSource` interface with an `EnvironmentSecretSource`.** Looks
like extensibility and provides none: the single implementation reads
`process.env`, which is what `loadConfig` already does. It would also invite the
next contributor to write a stub `VaultSecretSource` that nothing uses — a fake
integration, which is worse than an absent one.

**Write a stub adapter for each cloud provider.** Explicitly rejected. A stub
that claims a provider is supported is a lie in the shape of a file.

---

## ADR-0012 — A transactional outbox, and a scheduler this repository does not own

**Status:** Accepted · Milestone IV

### Context

Every background job was scheduled by a dual write:

```ts
await prisma.order.update({ ... });           // committed
await queue.enqueue({ name: 'dispatch...' }); // separate network call
```

Two systems, no shared transaction. The gap between them is where work
disappears, and it was not theoretical: `redis/client.ts` already classified an
enqueue failure as `retryable` and noted that the caller's durable row is
already committed. So a vendor accepts an order, the row commits, Redis is
briefly unreachable — and the endpoint returns **500** for an order that is, in
the database, accepted. A rider is never dispatched. Nothing records that one
was supposed to be. A test added in this milestone reproduces exactly that
against the pre-existing code.

Five call sites had this shape, and the worst was vendor rejection: the customer
is charged, the order is dead, and the refund the platform owes is queued by a
network call that may not happen.

Separately, four maintenance jobs — retention, session pruning, account deletion
finalisation, export expiry — were implemented, tested, and run by nothing.
`HANDOFF.md` had said "nothing schedules them" since Milestone C.

### Decision

**Two things, deliberately separate.**

**1. A transactional outbox for domain events.** The intent to enqueue is a row
written inside the caller's transaction (`enqueueViaOutbox(tx, …)`). A relay
publishes it afterwards. If the transaction rolls back, the intent rolls back;
if it commits, the intent is durable and will be published however long the
queue is down.

Delivery is **at-least-once** and that is stated rather than wished away: the
relay can publish and crash before marking, so a duplicate is possible. The
dedupe key is therefore mandatory (`assertPublishable` refuses an event without
one) and passed straight through to the queue. Exactly-once across two systems
is not purchasable; a harmless duplicate is.

Latency is preserved by a best-effort `flushOutbox` immediately after commit.
When the queue is healthy the job is published in-request exactly as before;
when it is not, the flush swallows the failure and the scheduled relay takes
over. A durable row must never become a failed customer request.

**2. A single maintenance command, not an in-process scheduler.**
`npm run maintenance:all` runs the outbox relay, retention, account
maintenance, and ledger reconciliation, in that order, each under a lease.

### Why not an in-process timer

A `setInterval` in the API means every instance runs every job, so how often the
ledger gets reconciled becomes a function of how many pods happen to be up.
Queue-based self-scheduling is worse: the queue is Redis, Redis is precisely
what maintenance must keep working without, and a job that schedules its own
successor stops for ever the first time one run dies.

What this repository does not have is a deployment platform — the same fact
behind [ADR-0011](#adr-0011--runtime-environment-injection-as-the-secret-source-contract).
cron, systemd timers, and Kubernetes CronJobs all exist, are operated by people
who understand the platform, and restart on their own. Inventing a worse one
here would be the same mistake as inventing a secret store.

### The lease

Two instances firing the same cron minute is ordinary. The jobs are individually
safe to run concurrently, but doing the same work twice still costs two full
ledger scans and two audit rows for one fact.

Acquisition uses nothing provider-specific, because this repository runs SQLite
in development and PostgreSQL in production: a guarded `updateMany` takes over a
lease whose expiry has passed, and a `create` claims a job that has never run,
with the primary key deciding that race. No advisory locks, no `SELECT … FOR
UPDATE`.

The lease **expires** rather than being held until success, so an instance
killed mid-run does not block the job until a human notices. It prevents waste,
not corruption — correctness still comes from the jobs' own idempotency.

### Consequences

**The dual write is gone from all five call sites**, and the routes no longer
reference the queue at all — the compiler confirmed that by reporting `queue` as
unused in four files.

**The outbox table needs its own retention.** An append-only record of every
domain event that ever fired grows without bound and holds nothing the audit log
does not, so `published_outbox_events` is deleted after 14 days. `pending` and
`failed` events are never deleted: those are outstanding work.

**Payloads are identifiers only.** This table is unencrypted, widely read, and
lives in backups — exactly where Milestone III keeps personal data out of. The
same `isSensitiveKey` vocabulary the logger and audit log use refuses a payload
carrying a phone number or a secret.

**Staleness is the alert that matters.** A job that fails loudly gets noticed; a
job that silently stops being scheduled is the one that goes unnoticed for a
quarter — which is exactly how four implemented jobs came to be run by nothing.
`maintenanceStaleness` treats "never succeeded" and "succeeded long ago" as the
same fact, and the runner exits non-zero for both.

**Key rotation is deliberately excluded.** Its primitives exist and are not
scheduled, because rotation is a supervised operation with a runbook. That
remains true.

### Rejected alternatives

**Keep the dual write and retry the enqueue in-process.** A retry loop holds the
request open while Redis is down and still loses the work when the process
restarts. The durability has to be in the database.

**Publish inside the transaction.** A transaction that waits on Redis holds
database locks while a third party is unreachable, which turns a queue outage
into a database outage.

**Change nothing and rely on the queue's own durability.** BullMQ is durable
once it has the job. The failure is in never getting it.

---

## ADR-0013 — Realtime carries notifications, not data

**Status:** Accepted · Milestone V

### Context

Tracking, the vendor queue, and the ops board all polled. Polling is honest but
wrong-shaped for this product: a rider's dispatch offer times out in seconds, a
vendor needs to see an incoming order before the customer wonders why nothing
has happened, and a dispatcher watching an escalation wants it on the board when
it escalates, not up to a poll interval later.

The obvious design is to push the changed record down the socket. It is also the
one that quietly undoes the access-control work of every previous milestone.

Field-level projection rules live in the route handlers, and they are not
uniform: the vendor list returns the customer's **first name only** and no phone
number, the customer's tracking route returns the rider's coarse position **only
while the order is active**, the ops board returns a different shape again, and
the delivery PIN is returned to nobody. Those rules took the whole project to
get right. A socket that pushed rows out of the outbox would bypass every one of
them, silently, for every subscriber at once — and the bypass would not show up
in any test of the HTTP routes, because the HTTP routes would still be correct.

### Decision

**A realtime message carries identifiers and a version. Never domain data.**

```json
{ "type": "event", "topics": ["order:abc"], "subject": "order:abc",
  "version": 12, "eventId": "order:abc@12", "occurredAt": 1788000000000 }
```

The client answers it by re-reading through the ordinary authorized HTTP route.
That is an extra round trip, and it buys the only property that matters: the
projection rules apply to realtime automatically, and they can never drift from
the ones the API already enforces, because they *are* the ones the API enforces.

Four consequences follow, and each removes a problem rather than adding one.

**Ordering and duplicates stop being dangerous.** Delivery is at-least-once and
unordered. Acting on a duplicate means re-reading state that is already current;
acting on a stale one means re-reading state that is newer than the notification
claimed. Neither can corrupt anything. `version` exists so a client can skip
work it has already done — not so it can reconstruct state from the stream,
which would be event sourcing, and this is not that.

**Reconnection needs no replay.** There is no per-topic log and none is needed:
a client that subscribes is told `resync: true` and reads the current state.
There is no gap to replay, only a screen to refresh.

**Degrading is not a second code path.** With no socket, the client polls the
same route on a timer — which is what every one of these screens did before this
milestone and still does. Losing realtime costs freshness and nothing else.

**Authorization is one decision, made twice.** `canSubscribe` answers "could
this actor ever watch a topic of this kind?" from the actor alone;
`canReachOrder` / `canReachVendor` answer "may they watch *this* one?" against
the row. Both are pure functions in `@dash/domain/realtime` with truth-table
tests, and both mirror the checks the corresponding routes already make. A
refusal is always `not_found`, never `forbidden` — the same reason `assertScope`
returns 404 rather than 403.

### Authentication is a frame, not a handshake

A browser cannot set an `Authorization` header on a WebSocket. Of the four ways
round that, three are worse:

| Approach | Why not |
|---|---|
| Token in the query string | Lands in access logs, proxy logs, URL sampling. This codebase already refuses to put personal data in a URL; a 15-minute credential is worse. |
| Cookie | Upgrades are not subject to CORS and browsers send cookies on them — cross-site WebSocket hijacking. The refresh cookie is scoped to `/v1/auth` for this family of reasons. |
| `Sec-WebSocket-Protocol` | Keeps it out of the URL, but overloads a negotiation header with a credential and is awkward to rotate on a live socket. |

So the socket opens with no privilege at all and authenticates from an
`authenticate` frame carrying the ordinary access token. Unauthenticated sockets
are closed after ten seconds; the `Origin` header is checked against the same
allowlist CORS uses.

This also solves the problem long-lived sockets usually ignore. An access token
expires in fifteen minutes; a socket lives for hours. Because authentication is
a frame, the client simply sends another — and **authority on a socket can never
outlive authority on an HTTP request**, because the socket is closed when its
token lapses. A revocation sweep re-reads the session on a timer, closing that
window further, and re-authentication clears the connection's subscriptions so
their ownership checks are re-run rather than assumed.

### Queue *then* broadcast

`QueuePort` and `RealtimeBroadcastPort` look similar and do opposite things. A
queue job goes to exactly one consumer — that is what stops two instances
dispatching the same order twice. A notification has to reach **every** instance,
because the customer watching an order is connected to whichever instance the
load balancer picked, and that is rarely the one whose worker took the job.

Routing notifications through the queue alone would deliver to one instance and
silently drop them for everyone connected elsewhere: perfect on a developer's
machine, losing most updates in production in proportion to how well the
deployment is scaled. So the path is outbox → relay → queue → one worker →
broadcast → every hub. `REALTIME_BROADCAST=memory` is refused in production for
the same reason `QUEUE_PROVIDER=memory` is.

Redis pub/sub is classified **degradable** in `REDIS_RESPONSIBILITIES`: losing
it makes screens refresh on a timer instead of on a change. Nothing is lost,
because the state was committed to PostgreSQL before any notification existed.

### The outbox, again — not a new dual write

Notifications are recorded with `enqueueViaOutbox` inside the transaction that
caused them, exactly as dispatch and refund intents are
([ADR-0012](#adr-0012--a-transactional-outbox-and-a-scheduler-this-repository-does-not-own)).
Publishing before the commit would announce a state the order never reached, and
a rolled-back transaction would leave clients re-reading and watching the screen
move backwards. Publishing after it would lose the notification in the gap with
nothing recording that it was owed.

### `Order.revision`

Ordering needs a monotonic value per order, and nothing existing could be one.
`updatedAt` cannot: two writes in the same millisecond are indistinguishable,
and wall clocks on different instances do not agree closely enough to order
anything. A notification wrongly judged older than what a client holds is
dropped, and the symptom is a screen that stays stale — the exact failure this
milestone exists to prevent. So a counter, incremented inside the transaction,
in the one helper that also records the notification, where it cannot be
forgotten.

It is per *subject*, not per topic. A client watching a vendor queue sees
notifications about many orders and tracks each order's version separately;
comparing two different orders' revisions would be meaningless.

### On the client

The same rule, enforced by shape rather than by discipline. The browser client's
refresh callback receives `{reason, subjects}` — a reason and identifiers — and
nothing from the frame. A screen therefore *cannot* render notification content
even by accident: there is no field to reach for. Its only possible response is
to call its own authorized read, which is the same fetch it made on a timer
before any of this existed.

Polling is slowed, never removed: 6–10 seconds becomes a 30-second safety net
while the socket is live, and returns when it is not. At-least-once delivery
promises a notification may arrive *twice*; nothing promises one always arrives.
A dropped frame with no poll behind it is a screen that is silently wrong until
someone reloads — a worse failure than the polling it replaced, and an invisible
one.

### Consequences

- Rider **location** streaming is deliberately **not** included. Position updates
  arrive every few seconds per rider and have different economics — a
  notification-then-re-read design would multiply them by the number of
  watchers. Tracking screens still poll for the rider pin. Doing it properly
  means pushing coarse position on its own channel, and that is its own piece of
  work.
- An ownership relationship that ends mid-socket — a rider reassigned off an
  order — is not re-derived on every sweep, because that would mean loading
  every subscribed order. It is bounded instead: re-authentication clears
  subscriptions, so a stale relationship cannot outlive one access token, and
  what it exposes in the meantime is a version number for an order the actor was
  legitimately attached to minutes earlier — never any of its data.
- `canSubscribe` is **stricter** than `GET /v1/ops/live` in one case: that route
  applies its city filter only when the actor has cities listed, so a dispatcher
  with an empty list sees every city there and none here. Failing closed is the
  right direction for the looser of two checks to be corrected towards; the
  route itself is left alone rather than changed as a side effect of this
  milestone.

### Rejected alternatives

**Push the changed record.** The reason this ADR exists. It bypasses every
field-level projection rule in the API, for every subscriber, invisibly.

**Server-Sent Events instead of WebSockets.** SSE is simpler and would carry
these notifications adequately. It is also one-directional, so subscription
management would need a parallel HTTP API and per-connection state keyed by
something other than the connection — which is more moving parts, not fewer, and
the client-side reconnect semantics are the same either way.

**A durable per-topic event log for replay.** Would let a reconnecting client
receive what it missed. It is also a second source of truth for state that
PostgreSQL already holds, with its own retention, compaction, and drift
problems, in exchange for saving one HTTP read on reconnect.

**A short-lived ticket endpoint.** Genuinely reasonable, and rejected only
because in-band authentication needs no new endpoint, no new token type, no new
secret, and no new table — and solves token renewal on a live socket, which a
ticket does not.

---

## ADR-0014 — Deployment profiles: a disabled capability is unreachable, not mocked

**Status:** Accepted · Declutters launch

### Context

DASH World Declutters is deployed on its own — `declutters.dashworldng.com` — and it
is a marketplace. It takes no money, dispatches no rider, sends no SMS, pushes to
no device and geocodes no address. It needs PostgreSQL, PostGIS (because the
database is shared with DASH APP's schema), Redis, S3 and SES, and nothing else
external.

The production boot guards refused it. They require a real payment provider, a
real maps provider, a real SMS provider and a real push provider whenever
`NODE_ENV=production`, because each mock or console adapter reports success and
does nothing — a production service that claims to charge a card and settles
nothing, or logs a login code to stdout and tells the customer it was sent. Those
guards are correct. They were also, for this deployment, asking a question with
no subject: there is no payment to mock because there is no payment.

The effect was that the documented Declutters deployment could not boot without
being handed Paystack keys it would never use, a Google Maps key for addresses it
would never geocode, and an SMS provider for codes it would never send. Unused
production credentials are a liability with no corresponding benefit.

### Decision

`DEPLOYMENT_PROFILE` selects a named set of **capabilities**
(`apps/api/src/deployment/profile.ts`). `full` has all nine. `declutters` has
`email` and `storage`.

A capability does three things:

1. **It chooses the adapter.** A disabled capability gets an adapter from
   `apps/api/src/adapters/disabled.ts` whose every method throws
   `CapabilityDisabledError`. `providerName` is `disabled` and `isLive` is
   `false`.
2. **It decides whether routes are registered.** Without `delivery`, the
   catalogue, order, vendor and rider routes are never mounted. Without
   `payments`, neither is the Paystack webhook. Without `push`, neither is device
   registration. Without `dataExport`, neither is the export half of the account
   routes. They answer `404`.
3. **It scopes the guard.** Each provider guard runs only when the deployment has
   the capability it is about.

The same variable is read by `apps/web`, where a middleware serves only
`/declutter`, `/ops/declutter` and `/signin` and answers 404 for the rest. Without
it the marketplace host would serve DASH APP's customer shell, vendor console and
rider app against an API that no longer has their endpoints — a *broken* DASH APP
rather than no DASH APP — and the landing page, which lists every internal console
by name. That one is a deployment boundary rather than a security boundary: those
pages already require a session and a server-side permission check.

The default is `full`. A deployment that forgets to declare itself gets the
strictest checks, not the loosest.

### Consequences

- The `full` profile is unchanged. Every guard behaves exactly as before, and
  `deployment-profile.test.ts` asserts that a `full` production boot still
  refuses all four mock providers by name.
- Guards that are not about a capability still apply everywhere: email, storage,
  PostgreSQL-not-SQLite, PostGIS, Redis-backed rate limiting, a durable queue,
  secret strength, `ENCRYPTION_KEY`, SES and S3 completeness.
- `zonesContaining` is deliberately *not* disabled with `maps`. PostGIS answers
  it from the database, so it needs no provider; routing and geocoding do, and
  those throw.
- `realtime` became the ninth capability for the same reason as the other four,
  found late: `REALTIME_ENABLED` defaults to on and `REALTIME_BROADCAST` defaults
  to in-memory, which production refuses, so a Declutters deployment was still
  refused at boot — over a variable the runbook never mentioned. Both the
  capability and the flag must now agree before a socket is served, so the flag
  cannot re-enable fan-out on a profile that has no realtime.
- The capability set is what documentation is checked against. `CONFIG_VARIABLE_NAMES`
  is derived from the config schema, and a test asserts the runbook names nothing
  outside it — after the runbook was found requiring `ENCRYPTION_KEYS`,
  `ENCRYPTION_ACTIVE_KEY` and `REFRESH_TOKEN_PEPPER`, none of which any code has
  ever read, while omitting three variables production refuses to start without.
- A disabled `parseWebhook` returns `null` rather than throwing, because `null`
  already means "this did not verify, act on nothing" — which is precisely how a
  deployment with payments off should treat a payment webhook.
- Adding a capability means adding it in one table, not auditing every guard and
  route again.

### Rejected alternatives

**Relax the four guards in production.** The smallest diff, and the worst
outcome. It leaves `MockPaymentAdapter` and `ConsoleSmsAdapter` wired into a
production process with nothing left to object, which recreates the exact silent
failure the guards existed to prevent. The guard was never the safety property;
the absence of a lying adapter is.

**A boolean per feature (`PAYMENTS_ENABLED`, `SMS_ENABLED`, …).** Eight
independent switches is 256 combinations, most of them incoherent — delivery
without payments, push without devices — and each one a configuration a
deployment could reach by accident. A named profile is a reviewed combination.

**A separate API service containing only the marketplace.** The honest long-term
answer, and far too much for a launch: it means splitting the schema, the
identity system and the admin console, when there is deliberately **one** DASH
identity and **one** source of truth.

**`NODE_ENV=staging` or a looser environment.** Would relax the guards by
relaxing production itself, including the ones about secrets, SQLite and rate
limiting. This deployment is production. It serves real sellers' identity
documents.

## ADR-0015 — Native-first clients and a stable six-service product contract

**Status:** Accepted · Product foundation

*Numbered ADR-0011 on `codex/native-service-foundation`, which was cut from
`main` before ADR-0011 to ADR-0014 landed on the V1 line. Renumbered on
integration; the content is unchanged.*

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

## ADR-0016 — One native app with two faces, built outside the npm workspaces

**Status:** Proposed · Native mobile Checkpoint 1 · awaiting director review

**Context.** ADR-0015 made Customer and Rider genuine React Native / Expo
clients and described them as *separate* applications. The director's
13 September instruction asks for one `apps/mobile` holding a Customer shell and
a Rider shell, and the earlier product decision (9 September) was that every
consumer identity is a Customer and an approved rider switches to the Rider
face inside the same identity and session. The approved Customer and Rider
boards were supplied the same day.

**Decision.**

- **One app, two faces.** `apps/mobile` is a single Expo app. The Customer face
  lives at the root; the Rider face under `/rider`. Switching is a profile
  action that changes which face is shown — no second sign-in, no second
  session. In a production build the switch is offered only to an identity the
  server has approved as a rider; every rider route still authorises on the
  server regardless. This supersedes ADR-0015's "separate applications" line
  only; the rest of ADR-0015 stands.
- **A standalone project, not a workspace.** React Native requires React to
  match its renderer exactly; Expo SDK 57 pins React 19.2.3 while the web app
  runs 19.2.8. `apps/mobile` therefore has its own lockfile and is excluded from
  the npm workspaces (which become an explicit list). It shares *source* with
  the monorepo: Metro bundles `@dash/domain` through a `file:` link, with a
  resolver shim for the domain's `.js`-named TypeScript imports. The web and API
  dependency graphs are unchanged. `scripts/typecheck.mjs` checks the app with
  its own TypeScript and fails, never skips, when its dependencies are absent;
  CI installs them.
- **Expo development builds.** Native projects are generated from
  `app.config.ts` by `expo prebuild` and not committed. Variants
  (`development`, `staging`, `production`) install side by side under
  `com.dashworldng.dash[.dev|.staging]`; the production identifier is permanent
  once published and needs confirmation first.
- **Auth needs no backend change.** The HttpOnly refresh cookie (path
  `/v1/auth`) is kept by the platform HTTP cookie store and never reaches
  JavaScript; the double-submit CSRF value the server already returns in the
  body is kept in SecureStore and echoed on refresh and logout; the access
  token stays in memory. ADR-0008 holds unchanged.
- **The server's projections are the client's models.** Where a board shows
  data the API does not serve, the client model marks it as a gap rather than
  inventing it. Where a board shows data the API *withholds by rule* — the
  customer's name on an offer before acceptance — the model has no field for
  it, and the difference is reported.
- **Tokens from the boards.** Colours are sampled from the approved board
  pixels; the bronze is the midpoint of the two boards' renderings. Blue is
  retired as a brand colour. Dark mode shares every token key and is marked as
  a derivation pending approval.

**Consequences.** The Capacitor WebView shell moved to `apps/android-shell`,
history intact, and remains the only physically proven rider client until the
native Rider reaches parity. Native Checkpoint 1 is visually complete against
the boards for its screens, wired only for the service list, and not yet
device-verified. Merchant imagery, vendor cover and logo fields, product
galleries and variants, rider earnings, demand signals and customer names after
acceptance are backend gaps listed in `apps/mobile/src/data/models.ts`.
