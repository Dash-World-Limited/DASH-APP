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

| Secret | Used by | Rotation | If leaked |
|---|---|---|---|
| `JWT_ACCESS_SECRET` | API | Quarterly | Rotate; tokens expire in 15 min anyway |
| `JWT_REFRESH_SECRET` | API | Quarterly | Rotate **and** revoke all sessions |
| `ENCRYPTION_KEY` | API, seed | Annual **[CODEX: confirm]** | See KEY_MANAGEMENT.md — treat protected values as compromised |
| `DATABASE_URL` | API, jobs | On staff change | Rotate at the database |
| `PAYSTACK_SECRET_KEY` | API | Per provider policy | Rotate at provider first |
| `PAYSTACK_WEBHOOK_SECRET` | API | Per provider policy | Rotate; unsigned events are already rejected |
| `REDIS_URL` | Queue **[CODEX]** | On staff change | — |
| SMS / email / push / storage credentials | Adapters **[CODEX]** | Per provider | — |

### Rules

1. **Never in git.** `gitleaks` runs in CI, and a `hygiene` job refuses any
   committed `.env`, database, or build output.
2. **Never in a log, an error message, an audit entry, or a screenshot.** The
   Pino redaction list and `redact()` in `packages/db` enforce this in code;
   tests assert it.
3. **Different values per environment.** A staging key that decrypts production
   data makes staging access equal to production access.
4. `.env.example` carries `replace-me` placeholders only. CI fails if a value
   there stops looking like a placeholder.

**[CODEX]** Choose the secret store, wire runtime injection, and record who may
read each secret and who approves a break-glass read.

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
3. Restore the encryption keyring — including any key in
   `ENCRYPTION_KEYS_RETIRED`. Rows name the key that encrypted them; a missing
   retired key means those rows are permanently unreadable.
4. Run `npx prisma migrate deploy` to bring the schema forward if the snapshot
   is older than the deployed code.
5. **Verify before serving traffic:**
   - `GET /v1/finance/ledger/integrity` returns `balanced: true` and
     `totalDriftKobo: 0`
   - A staff sign-in completes password **and** TOTP
   - A vendor's masked payout details still render — proves the key matches
6. Start the API. Start the worker only once the API is confirmed healthy.
7. Reconcile against the payment provider for the gap between snapshot and
   incident. Orders in that window may have been paid for but not recorded.

---

## 4. Environment separation

| | Development | Staging **[CODEX]** | Production **[CODEX]** |
|---|---|---|---|
| Database | SQLite, disposable | PostgreSQL + PostGIS | PostgreSQL + PostGIS |
| Payments | `mock` | Paystack **sandbox** | Paystack live |
| Queue | in-memory | Redis | Redis |
| Storage | local disk | S3 bucket | Separate S3 bucket |
| Secrets | `.env`, fictional | Secret store, staging-only | Secret store, production-only |
| Data | Fictional seed | Synthetic only | Real |

### Non-negotiable

- **Production data never leaves production.** Not into staging, not onto a
  laptop, not into a bug report. Staging uses synthetic data generated by the
  same seed.
- **No credential is shared between environments.** Separate database users,
  separate encryption keys, separate provider keys.
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
- [ ] Secret store with runtime injection
- [ ] Backups, PITR, and **a rehearsed restore**
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
