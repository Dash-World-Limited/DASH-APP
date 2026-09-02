# Operational runbooks

Actionable procedures for running DASH APP. **Nothing here has been executed
against real infrastructure**, because none exists. Every step marked
**[CODEX]** must be built and rehearsed before it can be relied on; a runbook
that has never been run is a draft.

Read alongside [`SECURITY.md`](../SECURITY.md),
[`KEY_MANAGEMENT.md`](KEY_MANAGEMENT.md), and [`RETENTION.md`](RETENTION.md).

---

## 1. Incident response

### Severity

| Level | Means | Response |
|---|---|---|
| **SEV1** | Money is wrong, or an attacker has access | Immediate. Wake someone. |
| **SEV2** | A core flow is broken for many users | Within the hour, business hours or not |
| **SEV3** | Degraded or partial | Next business day |
| **SEV4** | Cosmetic or internal | Backlog |

**Ledger integrity failure is always SEV1**, even if no customer has noticed.
The ledger is the record that says what happened; if it disagrees with itself,
every downstream number is suspect.

### First fifteen minutes

1. **Declare.** Name an incident lead. One person decides; everyone else
   reports to them.
2. **Do not fix yet.** Capture evidence first — it is far easier to lose than
   to recover. Snapshot the database, export the relevant `AuditLog` rows and
   application logs, and record the `requestId` values involved. Every API
   error carries one, and it is the only link between what a user saw and what
   the server logged.
3. **Contain.** Prefer narrow to broad:
   - One account compromised → revoke its sessions
     (`POST /v1/auth/logout-everywhere`, or set `revokedAt` directly).
   - Staff credential compromised → revoke sessions, then disable MFA and force
     re-enrolment; a stolen TOTP secret survives a password reset.
   - A zone or vendor is the blast radius → pause it rather than the platform.
   - Payment provider misbehaving → this is what the adapter boundary is for.
4. **Communicate.** Say what is known and what is not. Do not estimate a fix
   time in the first fifteen minutes.

### Credential and key rotation

| Compromised | Do |
|---|---|
| `JWT_ACCESS_SECRET` | Rotate. Every access token becomes invalid at once; users re-authenticate transparently via refresh. |
| `JWT_REFRESH_SECRET` | Rotate **and** revoke every session. Rotating alone does not invalidate the opaque refresh tokens, which are validated against stored hashes, not the secret. |
| `ENCRYPTION_KEY` | Follow [`KEY_MANAGEMENT.md`](KEY_MANAGEMENT.md). Rotation does not un-decrypt what an attacker already read: treat every TOTP secret and payout record as compromised, force MFA re-enrolment, and require vendors to re-confirm bank details. |
| Payment provider keys | Rotate at the provider first, then here. Expect webhook failures during the window; they are retried. |
| Database credentials | **[CODEX]** Rotate at the database, then redeploy. Requires the separate migration and runtime accounts that do not exist yet. |
| `REDIS_URL` password | Rotate at Redis, then redeploy. Rate limiting fails **closed** during the window — requests are rejected rather than silently unlimited — so treat the rotation as a brief outage, not a background task. |
| Anything read during break-glass | Rotate it. A value a person has seen exists outside the store, whether or not it was misused (§2a). |

Rotating a secret is only half of an exposure response. The other half is
deciding what the exposed value could already have been used for — see the
`ENCRYPTION_KEY` row above, which is the case where rotation protects the least.

### Payment incidents

The mock adapter cannot move money, so **any real payment incident implies a
live integration exists** — which, as of this milestone, it does not. When it
does:

1. Stop the dispatch worker before stopping the API. An order captured but never
   dispatched is recoverable; a rider sent to collect food for a payment that
   was reversed is not.
2. Reconcile before refunding. `GET /v1/finance/ledger/integrity` is the
   authority on what the platform believes; the provider dashboard is the
   authority on what moved. Differences are the incident.
3. Corrections are **reversing transactions, never edits.** The ledger is
   append-only by design (ADR-0006).
4. **[CODEX]** Notify the payment provider per their incident terms.

### After

Within five working days: a written timeline, the contributing causes, and what
changed as a result. **Every incident that could have been caught by a test gets
a test in the same week**, and that test is the deliverable — not the document.

**[CODEX]** Decide regulator notification obligations with counsel. NDPA 2023
imposes breach-notification duties this repository does not attempt to
interpret.

---

## 2. Secret inventory

Everything the running system needs that must never be committed.

**This table is generated from a source of truth, not maintained by hand.**
Every variable below is classified in
[`apps/api/src/secrets/classification.ts`](../apps/api/src/secrets/classification.ts),
and `npm run check:secrets` fails if a classified secret is missing from this
section. That is what stops the inventory drifting behind the code — which it
had, by nine variables, before Milestone III.

### In use today

| Secret | Used by | Rotation | If leaked |
|---|---|---|---|
| `JWT_ACCESS_SECRET` | API | Quarterly | Rotate; tokens expire in 15 min anyway |
| `JWT_REFRESH_SECRET` | API | Quarterly | Rotate **and** revoke all sessions |
| `ENCRYPTION_KEY` | API, seed | Cadence undecided — owner call | See KEY_MANAGEMENT.md — treat protected values as compromised |
| `ENCRYPTION_KEYS_RETIRED` | API | Removed only when the rotation survey is clear | Same as `ENCRYPTION_KEY`; removing one too early makes rows permanently unreadable |
| `DATABASE_URL` | API, jobs | On staff change | Rotate at the database. Carries the password in its userinfo. |
| `REDIS_URL` | Queue, rate limiter | On staff change | Rotate at Redis. Carries the password in its userinfo. |
| `PAYSTACK_SECRET_KEY` | Config only — no integration yet | Per provider policy | Rotate at provider first |
| `PAYSTACK_WEBHOOK_SECRET` | Config only — no integration yet | Per provider policy | Rotate; unsigned events are already rejected |
| `GOOGLE_MAPS_API_KEY` | Config only — no integration yet | Per provider policy | Rotate at provider; restrict by referrer/IP |
| `MAPBOX_ACCESS_TOKEN` | Config only — no integration yet | Per provider policy | Rotate at provider |

### Anticipated — reserved names, read by no code

Listed so the placeholder gate and the redaction vocabulary cover them from the
start, rather than from the day someone first pastes a real value beside an
unguarded name. **None of these providers is integrated** (Phase 4).

| Secret | For | If leaked |
|---|---|---|
| `TERMII_API_KEY` | Termii SMS | Rotate at provider |
| `TWILIO_AUTH_TOKEN` | Twilio SMS | Rotate at provider |
| `SMTP_URL` | Email | Rotate the mailbox credential; carries a password in its userinfo |
| `FCM_SERVICE_ACCOUNT_JSON` | Push | Revoke the service-account key in the Google console |
| `S3_ACCESS_KEY_ID` | Object storage | Rotate the access key pair |
| `S3_SECRET_ACCESS_KEY` | Object storage | Rotate the access key pair |
| `ERROR_TRACKING_DSN` | Error reporting | Rotate the DSN; carries a credential in its userinfo |

`PAYSTACK_PUBLIC_KEY` is deliberately **not** in this table. It is a publishable
key designed to be embedded in a client, and listing it beside the secret key is
how the two get confused.

### Rules

1. **Never in git.** `gitleaks` runs in CI for pattern-matchable credentials, a
   `hygiene` job refuses any committed `.env`, database, or build output, and
   `npm run check:secrets` refuses committed key files, dumps, and backups that
   match no credential pattern at all.
2. **Never in a log, an error message, an audit entry, or a screenshot.**
   Enforced in code by the shared vocabulary in `@dash/domain/redaction`, the
   Pino redact paths and `err` serializer in `apps/api/src/secrets/logging.ts`,
   and `redact()` in `packages/db`. Asserted by
   `apps/api/src/__tests__/secrets.test.ts`, which iterates the classification
   table rather than a hand-picked example.
3. **Different values per environment.** See §4. A staging key that decrypts
   production data makes staging access equal to production access.
4. `.env.example` carries placeholders only, checked **per variable** by
   `npm run check:secrets`. Provider key prefixes (`sk_live_`, `sk_test_`,
   `AKIA`, `whsec_`, …) are refused there even as placeholders: a fake key
   wearing a real prefix is indistinguishable from a leaked one to a scanner or
   to a reviewer skimming a diff.

### How secrets reach the process

Every value above arrives in the **process environment**, and something outside
the application put it there. In development that is a `.env` file; in staging
and production it is whatever the platform provides. `loadConfig(source)` takes
the environment as an argument, which is the injection seam.

**No managed secret store is integrated**, because no deployment platform has
been chosen. That is a deliberate decision, not an omission — see
[ADR-0011](DECISIONS.md#adr-0011--runtime-environment-injection-as-the-secret-source-contract).

**[CODEX]** Choose the platform and wire its injection. Record who may read each
secret and who approves a break-glass read (§2a).

---

## 2a. Break-glass access to secrets

**This is a policy, not an implementation.** There is no UI, no endpoint, and no
code path here — nothing in this repository grants or logs access to a secret
store, because there is no secret store yet. What follows is the contract the
chosen platform must be configured to meet.

| Rule | Why |
|---|---|
| The **runtime service identity** holds normal read access to the secrets its own environment needs, and to nothing else. | An application that can read staging's keys from production is a lateral-movement path. |
| **Human read access is denied by default.** No engineer, including whoever provisions the platform, holds standing read access to a production secret. | Standing access is access that is used. The whole point of runtime injection is that no person needs to see the value. |
| A single named **break-glass role** exists, empty in normal operation, granting temporary read access. | One documented path is auditable. Several undocumented ones are not. |
| Assuming it requires **explicit authorisation from a second person**, recorded before the access, with a stated reason. | Self-authorised emergency access is standing access with extra steps. |
| **Every read of the secret store is logged** — by the store itself, not by the application. Who, which secret, when, under what authorisation. | The application cannot log an access it is not party to. If the store cannot log reads, it is not a suitable store. |
| Every break-glass use is **reviewed afterwards** by someone other than the person who used it, and the review is recorded. | An unreviewed audit log is a log nobody reads. |
| Any secret exposed to a human during break-glass is **rotated afterwards**, on the assumption it is now known. | A value a person has seen is a value that exists outside the store. |

**Undecided, and an owner decision:** who holds the break-glass role, and who
authorises assuming it. This repository defines no organisational roles and will
not invent them. Recorded as open in
[`KEY_MANAGEMENT.md`](KEY_MANAGEMENT.md#open-decisions).

---

## 3. Backup and restore

**None of this exists.** SQLite in development is disposable; production
PostgreSQL is Codex's to provision.

### Requirements **[CODEX]**

| Requirement | Reason |
|---|---|
| Automated daily full backup, encrypted at rest | Baseline |
| Point-in-time recovery, at least 7 days | An incident is usually discovered after the fact |
| **Encryption key backed up separately from the database** | A database backup without the key is unrecoverable ciphertext; a key stored beside it defeats the encryption. Two halves, kept apart. |
| Restore rehearsed quarterly into a scratch environment | A backup that has never been restored is a hypothesis |
| Documented RPO and RTO | Currently undecided — owner call |

### Restore procedure **[CODEX: rehearse before relying on this]**

1. Stop the API and the dispatch worker. A worker writing into a half-restored
   database is worse than downtime.
2. Restore the database snapshot.
3. Restore the encryption keyring — including **every** key in
   `ENCRYPTION_KEYS_RETIRED`. Rows name the key that encrypted them; a missing
   retired key means those rows are permanently unreadable. This is the step
   that fails quietly: the system boots, most rows read, and a minority are
   dead. `npm run check:keys` demonstrates it against synthetic keys.
4. Run `npx prisma migrate deploy` to bring the schema forward if the snapshot
   is older than the deployed code.
5. **Verify the keyring matches the data, before anything writes.** The survey
   in `apps/api/src/secrets/rotation.ts` reads each ciphertext's key id out of
   the envelope prefix without decrypting. It takes key **ids** only
   (`{ activeKeyId, heldKeyIds }`), so whoever runs it needs no key material —
   that is enforced by its signature, not by convention:
   - `unknownKeyIds` must be **empty**. Non-empty means a key is missing from
     the restore and those rows are already unreadable — stop and find it.
   - `rowsNeedingReEncryption` above zero is normal mid-rotation and is not a
     restore failure.
6. **Verify before serving traffic:**
   - `GET /v1/finance/ledger/integrity` returns `balanced: true` and
     `totalDriftKobo: 0`
   - A staff sign-in completes password **and** TOTP
   - A vendor's masked payout details still render — proves the key matches
7. Start the API. Start the worker only once the API is confirmed healthy.
8. Reconcile against the payment provider for the gap between snapshot and
   incident. Orders in that window may have been paid for but not recorded.

### Rehearsing the key half without a real backup

`npm run check:keys` walks the custody procedure against keys generated in
memory for that run. It demonstrates, rather than asserts:

- a database restored **without** its key yields unrecoverable ciphertext;
- a restore that keeps the active key and drops the retired ones silently loses
  a subset of rows;
- rotation in the documented order loses nothing, and rotation in the wrong
  order destroys data;
- every ambiguous keyring configuration is refused at boot, with no key
  material in the message.

It reads no secret store, writes nothing to disk, prints no key value, and
**does not constitute a rehearsed restore**. The database half remains
unrehearsed and stays on the readiness checklist below.

---

## 4. Environment separation

| | Development | Staging **[CODEX]** | Production **[CODEX]** |
|---|---|---|---|
| Database | SQLite, disposable | PostgreSQL + PostGIS | PostgreSQL + PostGIS |
| Payments | `mock` | Paystack **sandbox** | Paystack live |
| Queue | in-memory | Redis | Redis |
| Storage | local disk | S3 bucket | Separate S3 bucket |
| Secrets | `.env`, fictional | Injected at runtime, staging-only values | Injected at runtime, production-only values |
| Encryption key | Fictional, in `.env` | Its own key | Its own key |
| Data | Fictional seed | Synthetic only | Real |

### Non-negotiable

- **Production data never leaves production.** Not into staging, not onto a
  laptop, not into a bug report. Staging uses synthetic data generated by the
  same seed.
- **No credential is shared between environments.** Separate database users,
  separate encryption keys, separate JWT secrets, separate provider keys.
  Development, staging, and production each generate their own; none is ever
  copied from another.
- **A staging configuration never depends on a production secret.** Not to read
  a production database, not to decrypt a production row, not to call a
  provider's live API. Staging exists to rehearse production, and a staging
  environment holding production credentials makes staging access — which is
  loosest by design — equal to production access.
- **The encryption key is per environment, and this is enforceable in
  practice**: a staging key applied to a production row fails to decrypt rather
  than merely being discouraged. `npm run check:keys` §5 demonstrates it.
- **The two JWT secrets differ from each other in every environment**, and boot
  refuses equal values everywhere, not only in production. Equal secrets mean a
  refresh token verifies as an access token, which is a full authentication
  bypass that is invisible until someone tries it.
- `config.ts` already refuses a production boot with SQLite, mock payments,
  local storage, an in-memory queue, `DEV_EXPOSE_OTP`, disabled rate limiting,
  MFA disabled, a missing encryption key, or placeholder secrets. Those guards
  are tested, and are the reason a misconfigured production process fails to
  start rather than starting unsafely.

---

## 5. Production readiness checklist

Nothing may go live until every line is ticked by a named person.

### Blocking — code
- [x] Refresh tokens: HttpOnly cookie, rotated, reuse-detected
- [x] CSRF on cookie-authenticated writes
- [x] Administrator MFA (TOTP) enforced for staff roles
- [x] TOTP secrets and vendor bank details encrypted at rest
- [x] Production boot guards, with tests
- [x] Ledger append-only with integrity endpoint
- [x] Object-level authorization on every ID-taking endpoint
- [x] Automated integration coverage in CI for every business endpoint
- [x] Retention job implemented and tested
- [ ] Account deletion and data export **(not built)**

### Blocking — infrastructure **[CODEX]**
- [ ] PostgreSQL + PostGIS provisioned, least-privilege users, TLS
- [ ] Migration account separate from the runtime account
- [ ] Redis + BullMQ, so a second API instance does not double-dispatch
- [ ] **Secret store chosen and its runtime injection wired.** The application
      side is done — every secret is classified, redacted, and validated at
      boot, and it reads its configuration from the process environment
      regardless of what populated it (ADR-0011). What is missing is the
      platform: nothing has been chosen, and no production secret exists.
- [ ] Verify the platform's injection does not itself expose values — not in a
      pod spec, a build log, a process listing, or an image layer. Outside what
      this repository can check.
- [ ] Break-glass role created, empty, with authorisation and review recorded
      (§2a). **Owner decision: who holds it and who authorises assuming it.**
- [ ] Secret-store read auditing enabled — by the store, not the application
- [ ] Backups, PITR, and **a rehearsed restore of both halves** — the database
      *and* the keyring, including retired keys. The key half's procedure is
      rehearsed against synthetic material by `npm run check:keys`; neither half
      has been rehearsed against a real backup.
- [ ] Retention job scheduled and alerting on failure
- [ ] Structured logs shipped somewhere searchable
- [ ] Error reporting wired to a real destination
- [ ] Alerts routed to a human who is on call

### Blocking — integrations **[CODEX]**
- [ ] Each provider exercised against its sandbox with a signature test, an
      idempotency test, and a failure-path test. **An adapter is not an
      integration until this is done.**

### Blocking — legal
- [ ] NDPA 2023 review by qualified Nigerian counsel
- [ ] Consumer-law review of cancellation, refund, and delivery terms
- [ ] Retention periods confirmed lawful
- [ ] Breach-notification obligations documented

### Strongly recommended
- [ ] Load test: order placement, location ingestion, dispatch, dashboards
- [ ] Authenticated DAST against staging
- [ ] Branch protection on `main` (repository setting; cannot be committed)
- [ ] Documented authorization matrix reviewed by someone who did not write it

---

## 6. Deployment and rollback

### Roll back immediately if

- Ledger integrity reports `balanced: false`
- 5xx rate exceeds 1% of requests over five minutes
- Sign-in success rate falls below 90% of its baseline
- Payment capture failures exceed baseline
- Any authorization test fails against the deployed build

**Ledger integrity failing is not a "monitor it" situation.** Roll back, then
investigate.

### Roll back with care if a migration ran

A schema migration is not always reversible. Before rolling back:

1. Does the previous build run against the new schema? Additive migrations —
   new nullable columns, new tables, new indexes — usually yes. Every migration
   in this repository so far is additive.
2. If not, restore from backup and accept the data loss between snapshot and
   now, or roll forward with a fix.

**[CODEX]** Rehearse both paths in staging before the first production deploy.
Rolling back for the first time during an incident is how a small problem
becomes a long one.

### After any rollback

Confirm ledger integrity, confirm a staff sign-in completes both factors, and
confirm the dispatch worker is consuming. Then write down why.

---

## 7. Alerts and ownership

**[CODEX]** None of these are wired. Severity and rationale are set here so the
routing decision is not also a policy decision.

| Alert | Sev | Condition | Why it matters |
|---|---|---|---|
| Ledger integrity failure | SEV1 | Nightly check returns `balanced: false` | Money is wrong. Everything downstream is suspect. |
| Elevated 5xx | SEV2 | Above 1% over 5 min | Something is broken for real users |
| Login / OTP abuse | SEV2 | Rate-limit rejections spike | Credential stuffing or SMS-cost abuse |
| Repeated MFA failures | SEV2 | Many failures on one staff account | Someone is attacking an account that can move money |
| Webhook failures or replay spike | SEV2 | Verification failures rise | Provider trouble, or someone probing the endpoint |
| Queue backlog | SEV2 | Depth rising for 10 min | Dispatch is falling behind; orders sit unassigned |
| Dispatch starvation | SEV2 | Escalations rise sharply | No eligible riders — often a zone or config mistake |
| Retention job failed | SEV3 | Non-zero exit, or no run in 48h | Personal data retained past policy |
| Provider degradation | SEV3 | Adapter error rate up | Early warning before customers notice |
| Certificate expiry | SEV2 | Under 14 days | Entirely avoidable outage |

### Ownership **[CODEX + owner]**

Undecided and blocking: who is on call, what the escalation path is, and what
the acknowledgement target is per severity. An alert with no owner is a log
line.


---

## PostgreSQL, PostGIS, and Redis — bringing the production path up

**Status: implemented, not yet verified against real services.** Nothing below
has been run against a real PostgreSQL or Redis, because the machine this was
built on has neither. The two verification scripts exist and are expected to be
run before any of this is trusted.

### 1. PostgreSQL

```bash
createdb dash
psql -d dash -c 'CREATE EXTENSION IF NOT EXISTS postgis;'

# The PostgreSQL schema is generated from the SQLite one. Check it is current:
npm run db:pg:sync -- --check

# Generate the client for PostgreSQL, then migrate.
DATABASE_URL='postgresql://USER:PASSWORD@HOST:5432/dash?schema=public' npm run db:pg:generate
DATABASE_URL='postgresql://USER:PASSWORD@HOST:5432/dash?schema=public' npm run db:pg:migrate
DATABASE_URL='postgresql://USER:PASSWORD@HOST:5432/dash?schema=public' npm run db:pg:migrate:status
```

`db:pg:generate` matters and is easy to forget. The Prisma client embeds its
datasource provider at generation time, so a client generated from the SQLite
schema will not talk to PostgreSQL — the switch is a build step, not a runtime
one. A production image must run `db:pg:generate`, not `db:generate`.

### 2. Verify it

```bash
PG_CHECK_URL='postgresql://USER:PASSWORD@HOST:5432/dash_verify' npm run check:postgres
REDIS_CHECK_URL='redis://HOST:6379' npm run check:redis
```

Point `check:postgres` at a **throwaway database**. It migrates from zero and
writes a temporary city and zone, then deletes them.

`check:postgres` proves the migration history applies to an empty database,
that `migrate status` is clean and drift is zero, that PostGIS answers, and —
the part that matters — that PostGIS and the in-process adapter give the same
containment answer for a point on an edge, a point in a hole, and a point just
outside a vertex.

`check:redis` proves a job round-trips, that an idempotency key runs a job
exactly once, that a delayed job waits, that a failing job stops at its attempt
limit, and that two API instances sharing one Redis enforce **one** rate-limit
budget between them.

### 3. Runtime configuration

```
DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/dash?schema=public
REDIS_URL=redis://:PASSWORD@HOST:6379
QUEUE_PROVIDER=redis
RATE_LIMIT_REDIS=true
GEO_ZONES_PROVIDER=postgis
```

`config.ts` refuses to start production without all of these. The two that are
easy to leave wrong and would not be noticed:

- `RATE_LIMIT_REDIS=false` gives every instance its own counters, so the real
  limit is the configured one multiplied by the instance count.
- `GEO_ZONES_PROVIDER=local` loads every zone in a city into the API process on
  each containment query.

### 4. When Redis goes down

**The API stops serving, deliberately.** Rate limiting is registered with
`skipOnError: false`, so a Redis outage rejects requests rather than silently
removing the only defence against credential stuffing and OTP brute force. See
ADR-0010.

What to expect, and what to check:

| Symptom | Meaning |
|---|---|
| `/health` still returns 200 | Correct. Liveness is exempt from rate limiting; the process is fine. |
| `/health/ready` returns 503 with `queue` not `ok` | Correct. The load balancer should take this instance out of rotation. |
| Requests return 429/500 | Correct — fail-closed. Not a bug to work around. |
| Jobs stop draining | Expected. Enqueue throws; nothing is silently dropped. |

Do **not** "fix" an outage by setting `RATE_LIMIT_REDIS=false`. That converts a
visible outage into an invisible removal of a security control, which is the
exact failure this design exists to prevent. Restore Redis instead.

Durable state is unaffected by a Redis outage: sessions, OTP challenges,
idempotency keys, orders, payments, and the ledger are all PostgreSQL rows.

### 5. Known limitation — the pending-export gap

If an enqueue fails after its row is committed, a `DataExportRequest` stays
`pending` with no job to build it. `findStaleExportBuilds` only sweeps rows in
`building`, so nothing currently retries a `pending` one. This predates
Milestone II — the same gap exists with the in-memory queue if the process dies
between the two — but a Redis outage makes it easier to hit. Worth a sweep for
`pending` rows older than the build claim window.
