# Handoff

Everything needed to pick this up cold. Read this first, then
[`ARCHITECTURE.md`](ARCHITECTURE.md), then
[`docs/DECISIONS.md`](docs/DECISIONS.md).

---

## Where this is

**Code-level pre-integration readiness.** The platform runs end to end on one
machine, with administrator MFA, encryption at rest, retention, observability
seams, and a verified PostgreSQL/PostGIS and Redis production path on `main`.
A secret-store-ready secret-management contract (Milestone III) is implemented
and locally verified **on an unmerged branch**, not on `main`. Nothing has ever
been deployed, and no adapter has been exercised against a live provider.

It is **not** production ready. That phrase requires deployment, a secret store
and hosting platform actually chosen, observability wired to something real,
backup and restore rehearsed, incident response practised, and external
verification — none of which has happened.

| | |
|---|---|
| **Branch** | `main` — the source-of-truth line. `master` is kept only as a pre-Milestone-E recovery anchor. |
| **Latest tag** | `v0.2.0-auth` (`ad2e81b`) — this work is **untagged**, see below |
| **Date** | 2026-09-02 |

### Milestones on `main` since `v0.2.0-auth`

| | Commit | What |
|---|---|---|
| — | `f7078b5` | Business API integration coverage and BOLA audit |
| — | `33ef023` | Fix the typecheck script, which never ran |
| A | `3640d52` | Enforce real administrator MFA |
| B | `960e6be` | Automate the last script-only endpoint coverage |
| D | `efa2d29` | Encrypt vendor payout details at rest |
| C | `3d7ac5b` | Privacy retention and session housekeeping |
| F | `d25eb22` | Security scanning in CI and operational runbooks |
| G | `8839312` | Observability seams without a vendor |
| E | `32180ce` → `71b2fc5` | Account deletion and personal-data export — **merged on `main`** (four commits: initial, then three rounds of review corrections) |
| I | `0f0c533` | Checkpoint reconciliation — dependency-audit analysis, smoke repair, status corrections |
| II | `416b6af` → `eabaf72` | PostgreSQL/PostGIS + Redis production path — **merged on `main`, verified against real PostgreSQL 16 + PostGIS 3.4 (14/14) and Redis 7 (8/8)** |
| III | *(branch `claude/milestone-iii-secret-management`)* | Secret management and key custody — **implemented, locally verified, not merged** |

**Milestone E is merged on `main` and remains untagged.** It is implemented and
**locally verified only**: the full suite, typecheck, lint, build, coverage,
migrations, smoke, and dispatch checks all pass on this machine. It has **not**
been exercised against any real external provider — payments, storage, mail,
SMS, and push are all still adapters (see *An adapter is not an integration*
below), and there is no deployment. No new tag has been created because tagging
would imply a verified release, which this is not.

`master` is deliberately left at `533f32c`, one commit behind the Milestone E
line, as a recovery anchor. It is not the working branch and should not be
built from.

```bash
git log --oneline v0.2.0-auth..HEAD    # everything since the last tag
git tag -l -n1                         # existing tags
```

---

## Requirements

- Node.js 22+ (built and tested on **24.19.0**)
- npm 10+ (built on **11.17.0**)

That is the whole list. No Docker, no pnpm, no local PostgreSQL — see ADR-0003
for why local development uses SQLite and what the path to PostgreSQL + PostGIS
looks like.

---

## Commands

### First run

```bash
npm run setup
```

Installs, generates the Prisma client, creates the SQLite database, and seeds a
fictional Lagos. Equivalent to:

```bash
npm install
npm run db:generate
npm run db:push
npm run db:seed
```

If `npm install` warns about unapproved install scripts, approve the ones that
are needed — Prisma downloads its query engine in a postinstall step, and
esbuild (via Vitest) needs one too:

```bash
npm approve-scripts prisma @prisma/client @prisma/engines esbuild
```

This gate is an **npm 11** feature. The `allowScripts` block in `package.json`
pins exact versions, so a dependency bump can make those keys stale and the
approval has to be repeated. On npm 10 (which Node 22 ships, and which CI uses)
there is no gate and this step is unnecessary.

### Environment

```bash
cp .env.example .env
```

Then generate two **different** secrets — the API refuses to start if they match,
because a shared secret would let a refresh token verify as an access token:

```bash
node -e "console.log('JWT_ACCESS_SECRET=' + require('crypto').randomBytes(48).toString('base64url'))"
node -e "console.log('JWT_REFRESH_SECRET=' + require('crypto').randomBytes(48).toString('base64url'))"
```

### Daily

| Command | What it does |
|---|---|
| `npm run dev` | API on `:4000` and web on `:3000`, prefixed output, Ctrl-C stops both |
| `npm run dev:api` | API only |
| `npm run dev:web` | Web only |
| `npm test` | 1112 tests — domain units and API integration suites |
| `npm run lint` | ESLint across all workspaces |
| `npm run typecheck` | `tsc --build` across project references |
| `npm run db:seed` | Wipe and reseed (safe to re-run; refuses in production) |
| `npm run db:studio` | Prisma Studio |
| `npm run build` | Production build of every workspace |

### Verification

```bash
npm test                          # no server needed
npm run typecheck                 # all four workspaces
npm run lint
npx vitest run --coverage packages/domain

npm run check:secrets             # 11 checks over 23 protected file classes
npm run check:keys                # 31 checks — key custody drill, synthetic keys only

npm run maintenance:retention -- --dry-run   # retention, reports only

npm run dev:api                   # then, in a second terminal:
node scripts/smoke.mjs            # 52 checks
node scripts/dispatch-check.mjs   # 21 checks
```

The two `check:` scripts need nothing — no server, no database, no credential.
`check:secrets` is plain Node with no dependencies, so it gates the repository
even when an install has failed. `check:keys` generates its own keys in memory,
reads no secret store, writes nothing to disk, and prints no key value.

Against real infrastructure, when you have it:

```bash
PG_CHECK_URL='postgresql://USER:PASSWORD@HOST:5432/dash_verify' npm run check:postgres
REDIS_CHECK_URL='redis://HOST:6379' npm run check:redis
```

The smoke and dispatch scripts need a **running API and a seeded database**.
They are supplementary — every business and public endpoint also has an
automated integration suite that runs in `npm test` and in CI.

### Stopping a stuck server (Windows)

`pkill` does not work here. Kill by port:

```powershell
Get-NetTCPConnection -LocalPort 4000 -State Listen | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force }
```

---

## Verification state

Everything below was run on this machine at this commit.

| Check | Result |
|---|---|
| `npm test` | **1112 passing**, 34 files, 0 failing |
| `npm run typecheck` | 4 projects clean |
| `npm run lint` | clean |
| `npm run build` | web app builds, 11 routes |
| `npm run check:secrets` | 11/11, over 23 protected file classes |
| `npm run check:keys` | 31/31 |
| Domain coverage, full suite | **97.36%** statements · 94.82% branches · 96.62% functions (`src/redaction` 99.15%, `src/envelope` 98.98%, `src/account` 100%) |
| Domain coverage, `--coverage packages/domain` (the CI gate) | 95.44% statements · 95.04% branches, against thresholds of 80/75/80/80 |
| `node scripts/smoke.mjs` | 52/52 |
| `node scripts/dispatch-check.mjs` | 21/21 |
| `npm run maintenance:retention -- --dry-run` | runs, reports, writes nothing |
| `npm run maintenance:accounts -- --dry-run` | runs, reports, writes nothing |
| `npm run db:migrate` on a fresh DB + drift check | applies `0_init` + `milestone_e`, `migrate status` clean, no drift vs schema |
| SQLite `db push` + `db:seed` + `ci-verify-seed` on a fresh temp database | passes |

> **Two coverage figures, because there are two commands.** CI runs
> `npx vitest run --coverage packages/domain`, which restricts *which tests run*
> to the domain suites while still counting every domain source file — so
> `src/crypto` and `src/ports`, which only application tests exercise, read 0%
> and pull the aggregate down to 95.44%. The full-suite run is the 97.36% figure.
> An earlier revision of this table recorded a single number without saying which
> command produced it; it was the full-suite one.

> **The suite flakes under machine load, and always has.** Several API suites
> build a Fastify instance and copy a SQLite template per test, and on a loaded
> machine that overruns Vitest's 5s test / 10s hook timeouts — the failures read
> `Test timed out in 5000ms`, never an assertion. Observed on this machine both
> before and after Milestone III. Clean runs sit at 82–88s. The most recent
> contended run took 174s and reported three failures whose messages were not
> captured; the three runs either side of it were clean, and the two suites
> changed most recently passed on repeated targeted runs, so
> load is the likely cause rather than a defect — but that particular run was
> not diagnosed. Previously captured contended failures all read as timeouts and
> all passed on a serial re-run
> (`npx vitest run --no-file-parallelism --testTimeout=30000 --hookTimeout=60000`).
> Treat a timeout failure as an environment signal and re-run before
> investigating; treat an assertion failure as real.
| `npm audit --audit-level=high` | **FAILS — exit 1**, unresolved. See below. |

> **`npm audit` fails, and CI's dependency job is red — deliberately left that
> way.** 11 vulnerabilities (2 critical, 5 high, 4 moderate) from four root
> advisories, all in pre-existing transitive dependencies: the Prisma CLI's
> `deepmerge-ts`, Next's internally pinned PostCSS, and Vite / `@vitest/mocker`.
> **None is reachable in the deployed runtime path**, and the critical one
> requires a Vitest UI server this repository never starts. Targeted
> `overrides` were attempted and reverted because they do not displace Next's
> pinned copy; `--force` means major upgrades needing their own verification
> pass.
>
> These are **unresolved findings pending an owner decision** — not an accepted
> risk and not a granted exception. Nothing has been suppressed, downgraded,
> ignored, or force-upgraded to turn the gate green. Full per-advisory analysis
> and the remediation options are in [`SECURITY.md`](SECURITY.md).

### Milestone II — real-infrastructure verification, now PASSED

These were pending when Milestone II was written and have since been run. This
section previously still said PENDING while §*Infrastructure, in dependency
order* below said they had passed; the two contradicted each other and this is
the correction.

| Check | Status | Command |
|---|---|---|
| PostgreSQL fresh migration + status + drift | **PASSED** | `PG_CHECK_URL=... npm run check:postgres` |
| PostGIS installed and agreeing with the in-process test | **PASSED** — 14/14, including boundary and hole semantics | same script |
| Redis healthy-path queue round trip, dedupe, delay, retry | **PASSED** — 8/8 | `REDIS_CHECK_URL=... npm run check:redis` |
| Rate-limit counters shared across two instances | **PASSED** | same script |

Also covered on this machine without real infrastructure: the Redis
**unavailable** path (fail-closed rate limiting, readiness, enqueue failure) in
`redis.test.ts`, the PostGIS adapter's query construction and WKT in
`postgis.test.ts` and `geo.test.ts`, and the two-schema drift guard in
`schema-sync.test.ts`.

**Still true: none of this has been deployed.** Verified against a disposable
local service is not verified in production.

Coverage thresholds are enforced in `vitest.config.ts` at 80/75/80/80.

### API integration suites

All run under `npm test` with no server to start — each builds a real Fastify
instance and drives it with `inject()` against a temporary SQLite file.

| Suite | Tests |
|---|---|
| `mfa` | 51 |
| `auth` | 41 |
| `config` | 40 |
| `dispatch` | 40 |
| `account-deletion` | 42 |
| `orders` | 31 |
| `retention` | 31 |
| `vendor` | 31 |
| `catalog` | 30 |
| `staff` | 29 |
| `finance` | 28 |
| `payout` | 24 |
| `webhooks` | 24 |
| `observability` | 22 |
| `account-export` | 33 |
| `ratelimit` | 4 |

The remainder are domain unit tests in `packages/domain` — including
`account` (43), the pure deletion/export policy.

`scripts/smoke.mjs` and `scripts/dispatch-check.mjs` still need a running server
and a full seed. They are **supplementary** now — no behaviour depends on them
alone.

---

## Seed accounts

**Every account below is fictional.** Phone numbers use a reserved-style
`+234 700` block that cannot ring a real handset. No real person's details, and
no real business's catalogue or branding, appear anywhere in this repository.

Staff and vendors sign in with a password. Customers and riders sign in with an
OTP, which in development is printed to the API console **and** returned in the
response body as `devCode` while `DEV_EXPOSE_OTP=true`. Production refuses to
boot with that flag set.

### Password accounts — all use `DashDev!2026`

| Role | Email |
|---|---|
| Super admin | `admin@dashapp.test` |
| Dispatcher (Lagos) | `ops@dashapp.test` |
| Support agent | `support@dashapp.test` |
| Finance analyst | `finance@dashapp.test` |
| City manager (Lagos) | `city@dashapp.test` |
| Vendor owner | `iya-kemi-kitchen@dashapp.test` |
| Vendor owner | `suya-republic@dashapp.test` |
| Vendor owner | `freshcart-grocers@dashapp.test` |
| Vendor owner | `carewell-pharmacy@dashapp.test` |

> **Staff sign-in now needs a second factor.** Every seeded staff account shares
> one fixed, fictional TOTP secret, printed by `npm run db:seed`:
>
> ```
> JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP
> ```
>
> Add it to any authenticator app once as "DASH APP (dev)" and every staff
> account works. Vendor owners are **not** MFA-required and sign in with a
> password alone.
>
> Signing in twice within the same 30 seconds fails by design — a TOTP step is
> accepted once. Wait for the next code.

### OTP accounts

| Role | Phone | Notes |
|---|---|---|
| Customer — Amaka Okoye | `+2347000000201` | Has an active **Dash+** membership (free delivery, half service fee, surge-exempt) |
| Customer — Segun Adeyemi | `+2347000000202` | |
| Customer — Fatima Bello | `+2347000000203` | |
| Rider — Musa Ibrahim | `+2347000000301` | Motorcycle, **Victoria Island zone only** |
| Rider — Grace Eze | `+2347000000302` | Motorcycle, Lekki Phase 1 |
| Rider — Kunle Balogun | `+2347000000303` | Bicycle, **Yaba/Surulere** — use this one for Iya Kemi Kitchen orders |
| Rider — Peter Obi-Nwosu | `+2347000000304` | Car, Ikeja, starts offline |

> **Gotcha that will cost you an hour.** Each seeded rider is permitted in
> exactly one zone. A rider who is online and nearby but not zone-permitted for
> the vendor is correctly refused the offer and dispatch escalates. The worker
> logs `exclusionsByReason` — read it before assuming the engine is broken.

### Seeded world

1 city (Lagos) · 4 zones (Victoria Island & Ikoyi, Lekki Phase 1, Ikeja &
Maryland, Yaba & Surulere) · 4 fictional vendors · 20 catalogue items ·
3 customers · 4 riders · 5 orders across the lifecycle · 3 promotions
(`DASH10`, `FREERIDE`, `KITCHEN500`) · 5 feature flags · a balanced ledger.

The seed verifies every ledger transaction balances before it reports success.

---

## Mock integrations — nothing here talks to a real service

| Port | Default | Config value | Production target | Ever tested live? |
|---|---|---|---|---|
| Payments | Deterministic mock | `PAYMENT_PROVIDER=mock` | Paystack | **No** |
| Maps / routing | Haversine + detour factor | `MAPS_PROVIDER=local` | Google / Mapbox / PostGIS | **No** |
| SMS | Logs to console | `SMS_PROVIDER=console` | Termii / Twilio | **No** |
| Email | Logs to console | `EMAIL_PROVIDER=console` | SMTP | **No** |
| Push | Logs to console | `PUSH_PROVIDER=console` | FCM / APNs | **No** |
| Storage | `./.storage` on disk | `STORAGE_PROVIDER=local` | S3 / MinIO | **No** |
| Queue | In-process, retries + backoff | `QUEUE_PROVIDER=memory` | Redis + BullMQ | **No** |

The API prints its adapter line at boot:

```
DASH APP API on http://127.0.0.1:4000  [payments=mock  maps=local  sms=console  storage=local  queue=memory]
Payments are MOCKED. No real money moves in this configuration.
```

If that banner says `payments=mock`, **no card has ever been charged.** Do not
describe any of these as working until it has run against a real sandbox with a
signature test, an idempotency test, and a failure-path test.

The mock payment adapter is deterministic and driven by the order reference: a
reference containing `fail` declines, one containing `pending` stays unresolved,
everything else captures. It verifies webhook signatures too — a check that only
runs in production is a check that has never been tested.

---

## Architectural decisions in force

Full reasoning, costs, and reversal paths in
[`docs/DECISIONS.md`](docs/DECISIONS.md). Summary:

| ADR | Decision | Why | Reversible? |
|---|---|---|---|
| 0001 | npm workspaces, not pnpm + Turborepo | pnpm not installed; npm 11 workspaces suffice at this size | Easily — additive |
| 0002 | Fastify + Zod, not NestJS | ~4× denser routes; Zod schemas shared with the web app and tests; domain logic is framework-free so DI has little to manage | Costly — one-way-ish door |
| 0003 | SQLite dev, PostgreSQL + PostGIS production | No Docker or Postgres on the target machine; `npm run setup` works on a clean machine | Yes — schema written for it |
| 0004 | One Next.js app with route groups, not five apps | One dev server, one auth client; route groups give real layout separation | Yes — mechanical |
| 0005 | Adapter ports for every external dependency | Whole platform runs offline; honesty is structural | n/a |
| 0006 | Integer kobo, append-only double-entry ledger | Float money and mutable balances are the hardest defects to recover from | No — foundational |
| 0007 | Deterministic, explainable pricing/dispatch/pay | No trained model exists; records the features one would need | n/a |

### Authentication, as of Phase 1

- Access token: JWT, 15 minutes, in the response body, held in **memory only**
  by the client.
- Refresh token: opaque 256-bit value in a `HttpOnly`, `Secure`, `SameSite=Lax`
  cookie scoped to `/v1/auth`. **Never** in a response body.
- CSRF: double-submit token in a readable cookie, echoed in `X-CSRF-Token`,
  reissued on every rotation.
- Rotation on every refresh, with reuse detection that revokes the entire
  session family, forward and backward through `previousSessionId`.

If you find yourself adding `refreshToken` to a response type, stop: the cookie
has just become decoration.

### Rules a contributor must not break

1. **Money is integer kobo.** No floats, no `Decimal`, no currency math in the
   database.
2. **No mutable balance columns.** Balances are summed from `LedgerEntry`.
   Corrections are reversing transactions.
3. **The client never sends a price, role, or permission.** All derived
   server-side.
4. **Permission and ownership are separate checks.** Both must pass. Cross-tenant
   denial returns 404, never 403.
5. **`packages/domain` has no I/O.** No database, no network, no ambient clock.
6. **An adapter is not an integration.** Nothing is described as working until a
   sandbox test proves it.
7. **Secrets enter through `loadConfig` and nowhere else.** A `process.env` read
   outside the configuration boundary is a lint error. It skips boot validation,
   every production guard, and the classification that makes the value redacted.
8. **A new secret variable is classified before it is used.** Add it to
   `apps/api/src/secrets/classification.ts`; the leak tests and the
   `.env.example` gate read from that table, so an unclassified secret is an
   unprotected one.

---

## What is not done

### Requested, built, and merged — untagged and provider-unverified

**Milestone E — account deletion and data export.** Merged on `main`
(`32180ce` → `71b2fc5`); a first commit (`32180ce`) plus a second that corrects four
production blockers a Codex review of that commit found. What is in place:

- A `scheduled → held | cancelled | completed` deletion state machine
  (`AccountDeletionRequest`, one row per identity), a fresh step-up on the
  request, a cooling-off window (`ACCOUNT_DELETION_COOLING_OFF_DAYS`, default
  14), and a cancellation path that needs no step-up.
- A staff on-behalf-of path (`admin:account:delete`, step-up, mandatory reason,
  `onBehalfOf` audit) kept separate from the self-service one.
- **Legal holds checked twice** — at request time *and again at finalisation*.
  An active order, unresolved refund/dispute, open safety/fraud case, or negative
  wallet balance acquired during the cooling-off window parks the request in
  `held`; the maintenance run retries it and it resumes once the matter clears.
- Finalisation: every session deleted, credentials and drafts deleted,
  everything the ledger references **anonymised in place**. Orders, payments,
  refunds, settlements, and every ledger entry keep their ids and amounts. The
  policy for all 24 model classes is `packages/domain/src/account` (100%
  coverage), complementing `packages/domain/src/retention`.
- Idempotent, single-transaction finalisation (`anonymisedAt` marker, a claimed
  request row, set-to-constant writes) — safe to run repeatedly and
  concurrently.
- Export behind a fresh step-up. The **build is claimed atomically**
  (`pending → building` under one worker's claim id) before any subject data is
  read or blob written; the **download reads the archive before committing
  `delivered`**, under a short lease, so a storage read failure is a retryable
  `503` that does not consume the one download. Delivered by a **stateless signed
  single-use** capability with an expiry (`DATA_EXPORT_TTL_HOURS`, default 24).
- `npm run maintenance:accounts` finalises due deletions, retries held ones,
  expires stale archives, fails abandoned builds, and cleans orphaned blobs.
  Still **nothing schedules it** — see below.
- **Checked-in Prisma migrations** (`packages/db/prisma/migrations/`): a
  `0_init` baseline + a `milestone_e` migration. `npm run db:migrate` on a fresh
  database + a drift check reproduce `schema.prisma` exactly. `db push` is still
  the local/test path.
- Adversarial coverage: `account-deletion.test.ts` (42), `account-export.test.ts`
  (33), `packages/domain/src/account/account.test.ts` (43) — IDOR, replay,
  repeated requests, cancellation racing finalisation, concurrent finalisation,
  holds appearing mid-window, single-use / expired / storage-failure / concurrent
  downloads, concurrent and lost-claim builds, stale-claim recovery, and proof
  the financial rows survive.

Not done for this milestone: merge to `master`, review against `master`, a tag,
and a production `ExportArchivePort` adapter — only the local one exists.

### Implemented on a branch, NOT merged

**Milestone III — secret management and key custody.** Lives on
`claude/milestone-iii-secret-management` at the moment of writing. It has **not
been merged to `main`**, not tagged, and not deployed, so nothing in this block
describes code on the main line. Implemented and verified locally only. What is
in place:

- **One classification table** (`apps/api/src/secrets/classification.ts`) naming
  every configuration variable secret or non-secret, including the seven
  provider credentials no code reads yet. It drives log redaction, the leak
  tests, and the `.env.example` gate, so those cannot drift apart.
- **Redaction in two dimensions**, because one is not enough: by key fragment
  (so `paystackSecretKey` is caught, not only `secret`) and by shape inside free
  text (so the password in `postgresql://dash:pw@db:5432` is stripped from a
  driver's own error message, which no key-based pass can reach). One vocabulary
  in `@dash/domain/redaction`, shared by the audit log, the error-tracker seam,
  the metrics seam, and Pino.
- **Key custody hardened.** A key id the envelope format cannot carry, one id
  that is both active and retired, the same material under two ids, a duplicate
  retired id, and retired keys with no active key are all refused at boot. The
  first of those could previously write ciphertext that was correctly encrypted
  and permanently unreadable; the second used to be resolved silently in favour
  of the active entry, which quietly destroys every row written under the other.
- **Rotation with a real retirement gate** (`apps/api/src/secrets/rotation.ts`).
  A survey reads each ciphertext's key id out of the envelope prefix without
  decrypting — so it needs no key material — and answers whether destroying an
  old key is safe. Re-encryption covers payout details **and** both TOTP columns;
  covering only payout is how a rotation looks complete and is not.
- **The configuration boundary is enforced.** A `process.env` read outside
  `loadConfig` is now a lint error, with a short documented allowlist.
- Repository hygiene: `npm run check:secrets` replaces a CI step that only
  looked like a gate — it passed as long as any one line still said
  `replace-me`, so a real key pasted into `.env.example` went through untouched.

Not done for this milestone: merge, tag, and everything that needs a platform —
see below.

### Blocking production — infrastructure, all Codex

- **A secret store and a hosting platform.** The application side is done
  (Milestone III) and the contract is runtime environment injection
  ([ADR-0011](docs/DECISIONS.md#adr-0011--runtime-environment-injection-as-the-secret-source-contract)),
  so any platform that can set an environment variable works with no code
  change. **Nothing has been chosen, and no production secret exists.**
- **No backups and no restore rehearsal.** The procedure is documented and the
  key half of it is rehearsed against synthetic material by `npm run check:keys`;
  no real backup has ever been taken or restored.
- **Break-glass role, holder, and authoriser** — the policy is written
  (`docs/RUNBOOKS.md` §2a), the people are an owner decision.
- PostgreSQL/PostGIS and Redis/BullMQ are implemented and verified against real
  services (Milestone II) but **not provisioned anywhere**. Until they are, the
  in-memory queue remains the running configuration, and it is per-process — a
  second API instance would run its own dispatch worker and double-offer.
- The retention **and account-maintenance** jobs are implemented and tested
  but **nothing schedules them**. Nor does anything schedule key re-encryption,
  which is deliberate — rotation is supervised — but it does mean a half-finished
  rotation stays half-finished until someone looks.
- Error reporting and metrics are console implementations; nothing is wired to a
  real destination.
- No branch protection on `master` — a repository setting, not committable.

### Blocking production — integrations, all Codex

Every adapter is offline. Payments, maps, SMS, email, push, and storage have
each never spoken to a real provider. **An adapter is not an integration until
it has been run against a sandbox with a signature test, an idempotency test,
and a failure-path test.**

### Known gaps in what exists

- **`POST /v1/ops/orders/:id/reassign` is not request-idempotent.** Two requests
  create two reassignment events. The dispatch job keyed off each is now
  deterministic (fixed during this audit), so the damage is bounded to an extra
  offer round, and the atomic order claim means only one rider can ever win.
  Making the endpoint itself idempotent means requiring an `Idempotency-Key`
  header, which changes the contract for every existing ops client — noted
  rather than changed silently.
- **Rider pay is estimated at reservation.** No rider exists when payment is
  captured, so the reservation assumes a motorcycle and a zero approach leg. The
  true-up on delivery corrects it, but the reserved figure is an estimate.
- **No websockets.** Tracking, the vendor queue, and the ops board poll.
- **SQLite is development-only.** No concurrent writers, no PostGIS. The
  PostgreSQL/PostGIS path landed in Milestone II and is the production target;
  the in-process geo path remains the development default and tests a city's
  zones in memory — fine at Lagos scale, not national.
- **`packages/db` reads `process.env` directly** in two places (the Prisma log
  level, and the seed's encryption key). It cannot import the API's config
  without a circular dependency. The log-level read is non-secret. The seed's
  read is a secret, and since Milestone III it goes through the same
  `assembleKeyring` the API uses, so it can no longer apply weaker validation
  than the API does — it previously could, and would have happily seeded rows
  under a key id the API refuses. Everywhere else, a `process.env` read outside
  the configuration boundary is a lint error.
- **Nothing schedules key re-encryption.** The primitives are in
  `apps/api/src/secrets/rotation.ts` and are covered by tests, but a rotation is
  driven by hand from the runbook. That is deliberate — rotation is a supervised
  operation — but it does mean a rotation left half-finished stays half-finished
  until someone looks.

### Modelled but not built

Vendor and rider onboarding flows, catalogue management UI, support agent
workspace, finance settlement console, ratings write path, batched dispatch,
scheduled orders, package delivery, events ticketing.

### Legal

NDPA 2023 and Nigerian consumer-law obligations have **not** been reviewed by
counsel. Every retention period is an engineering default, not a compliance
claim. No document in this repository is legal advice.

---

## CODEX START HERE

The shortest correct path from a clean clone to running, inspecting, and
extending this.

### 1. Run it

```bash
npm ci
cp .env.example .env
```

Then put three real values in `.env` — two **different** JWT secrets and one
encryption key. The API refuses to start otherwise, deliberately:

```bash
node -e "console.log('JWT_ACCESS_SECRET=' + require('crypto').randomBytes(48).toString('base64url'))"
node -e "console.log('JWT_REFRESH_SECRET=' + require('crypto').randomBytes(48).toString('base64url'))"
node -e "console.log('ENCRYPTION_KEY=' + require('crypto').randomBytes(32).toString('base64'))"
```

```bash
npm run db:generate && npm run db:push && npm run db:seed
npm run dev
```

Web on `:3000`, API on `:4000`. Sign in as `admin@dashapp.test` /
`DashDev!2026`, then supply a TOTP code from the dev secret above.

### 2. Confirm the state matches this document

```bash
npm test && npm run typecheck && npm run lint && npm run build
node scripts/smoke.mjs           # with the API running
node scripts/dispatch-check.mjs
```

If any of that disagrees with *Verification state*, trust the run and not the
document.

### 3. Read, in this order

1. [`ARCHITECTURE.md`](ARCHITECTURE.md) — the shape and the five rules
2. [`SECURITY.md`](../SECURITY.md) — what is defended and what is open
3. [`docs/API_MATRIX.md`](docs/API_MATRIX.md) — every endpoint, its permission,
   its ownership rule, its coverage
4. [`docs/RUNBOOKS.md`](docs/RUNBOOKS.md) — everything marked **[CODEX]** is
   yours
5. [`docs/KEY_MANAGEMENT.md`](docs/KEY_MANAGEMENT.md) and
   [`docs/RETENTION.md`](docs/RETENTION.md) — before touching keys or the
   retention schedule
6. [`apps/api/src/secrets/classification.ts`](apps/api/src/secrets/classification.ts)
   — which variables are secret, and why there is no cloud SDK here
   ([ADR-0011](docs/DECISIONS.md#adr-0011--runtime-environment-injection-as-the-secret-source-contract))

### 4. Infrastructure, in dependency order

1. **PostgreSQL + PostGIS — implemented and real-infrastructure verified in Milestone II.**
   A separate PostgreSQL Prisma schema and migration path now coexists with the
   SQLite development/test path. PostgreSQL 16 + PostGIS 3.4 were exercised
   against a fresh disposable database: migration apply, migration status, and
   schema drift all passed. The PostGIS `GeoPort` was verified against the real
   service, including boundary and hole semantics, with **14/14 checks passing**.
   Boundary-inclusive containment uses `ST_Covers`, and SRID parameters are
   explicitly bound as PostgreSQL integers. **Merged on `main`; not yet deployed.**
2. **Secret store — the application side is done (Milestone III); the platform
   is not chosen.** Every variable is classified secret or non-secret in
   `apps/api/src/secrets/classification.ts`, secrets are redacted from every
   log, error, health response, and metric, ambiguous keyrings are refused at
   boot, and rotation has a survey that says when destroying an old key is
   actually safe. All locally verified.

   What you provide is the injection. The contract is **runtime environment
   injection** — the application reads its configuration from the process
   environment and does not know what populated it, so Kubernetes secrets, AWS
   Secrets Manager, GCP Secret Manager, Vault, or a hosting provider's secret UI
   all work with no code change. That is a deliberate decision, recorded as
   [ADR-0011](docs/DECISIONS.md#adr-0011--runtime-environment-injection-as-the-secret-source-contract);
   **no cloud SDK was added, and no secret store is integrated.**

   Read `docs/KEY_MANAGEMENT.md` before touching a real key — especially that
   the encryption key is backed up *separately* from the database, and that the
   backup must include every retired key. `npm run check:keys` rehearses that
   procedure against synthetic material.

   Two **owner decisions** block completion: who holds the break-glass role, and
   who authorises assuming it (`docs/RUNBOOKS.md` §2a).
3. **Redis + BullMQ — implemented and real-infrastructure verified in Milestone II.**
   Redis-backed queueing, idempotent job handling, delay/retry behaviour, and
   shared fail-closed rate limiting are implemented. Verification against Redis
   7 passed **8/8 checks**, including a shared rate-limit budget across two API
   instances. This removes the previous single-instance `MemoryQueueAdapter`
   limitation for these paths. **Merged on `main`; not yet deployed.**
4. **Backups and a rehearsed restore.** The restore procedure in `RUNBOOKS.md`
   has never been executed.
5. **Schedule the retention job.** Daily, off-peak, single concurrency, alert on
   non-zero exit.
6. **Wire the observability ports.** `ErrorReportPort` and `MetricsPort` in
   `apps/api/src/observability` have console implementations; write real ones.
   Everything is already scrubbed before it leaves.

### 5. Sandbox integrations, in this order

Payments first — everything else is a nicety by comparison.

For each provider, the adapter interface is in
`packages/domain/src/ports/index.ts` and the offline implementation in
`apps/api/src/adapters/index.ts`. Write the real one beside it and select it by
config. **Do not change a call site.**

Before calling any of them integrated, it needs:

- a signature/authentication test,
- an idempotency test (send the same thing twice, assert one effect),
- a failure-path test (provider down, provider disagrees, malformed response).

`apps/api/src/__tests__/webhooks.test.ts` is the template — it already covers
signature, replay, concurrent delivery, and provider-vs-record disagreement
against the mock.

### 6. Do not

- Do not weaken a production boot guard to make a deployment start. They are
  tested, and each one prevents a specific incident.
- Do not add ledger, payment, order, settlement, or audit records to the
  retention job.
- Do not build a plaintext read endpoint for vendor bank details. Decryption is
  server-side, for the payout job only.
- Do not call an adapter an integration until it has run against a sandbox.

---

## Where to look

| I want to… | Go to |
|---|---|
| Understand the shape | [`ARCHITECTURE.md`](ARCHITECTURE.md) |
| Know why something is the way it is | [`docs/DECISIONS.md`](docs/DECISIONS.md) |
| See what works vs. what is stubbed | [`docs/PROGRESS.md`](docs/PROGRESS.md) |
| Understand the security posture | [`SECURITY.md`](SECURITY.md) |
| Know what is next | [`ROADMAP.md`](ROADMAP.md) |
| Change pricing | `packages/domain/src/pricing/` — bump `PRICING_RULE_VERSION` |
| Change rider pay | `packages/domain/src/pay/` — bump `RIDER_PAY_RULE_VERSION` |
| Change dispatch scoring | `packages/domain/src/dispatch/` — bump `DISPATCH_RULE_VERSION` |
| Add a permission | `packages/domain/src/permissions/` — add to `PERMISSIONS`, then a role |
| Add an endpoint | `apps/api/src/routes/` — guard with `requirePermission`, scope with `requireScope` |
| Add a screen | `apps/web/src/app/` |

### Ten bugs found while building

Documented with cause and fix in
[`docs/PROGRESS.md`](docs/PROGRESS.md#bugs-found-and-fixed-while-building).
Worth reading before changing money code — two of them were caught only because
the double-entry ledger refused to write, and one only by a randomised property
test.
