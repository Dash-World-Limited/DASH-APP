# Data retention

What DASH APP keeps, for how long, and what the retention job does about it.

**No period here has been reviewed by qualified counsel.** They are conservative
engineering defaults chosen to be defensible, not compliant. The NDPA 2023
review is outstanding and is listed as an owner decision below.

---

## The policy

Defined in `packages/domain/src/retention/index.ts` — pure, so the decisions are
readable and testable in one place. Every class of data is explicitly one of
three things.

### Deleted

| Data | After | Why |
|---|---|---|
| Expired sessions | 60 days past expiry | Authenticates nothing. Kept briefly so support can answer "was this device signed in last month?" during a dispute. |
| Consumed/expired OTP challenges | 7 days | A spent one-time code has no further use; holding the hash only widens what a leak yields. |
| Consumed/expired MFA challenges | 7 days | Same class of spent credential. |
| Expired idempotency keys | 30 days | The stored response body can contain order detail. The key only needs to outlive a provider retry window. |
| Rejected rider locations | 30 days | Points rejected as implausible are fraud evidence briefly, then dropped. They were never trusted enough to act on. |

### Anonymised

| Data | After | Why |
|---|---|---|
| Rider location history | 90 days | The most sensitive routine data the platform holds. Coordinates are coarsened to 2dp (~1km) and accuracy/heading/speed cleared, so aggregate ETA and coverage analysis survives while the trail stops being a record of where one person was on a given afternoon. |

Anonymisation is in place, not by deletion, and is marked with `anonymisedAt` so
repeated and concurrent runs converge instead of rounding the same rows forever.

### Retained indefinitely

Ledger transactions and entries, payments and refunds, orders, settlements and
payouts, the audit log, and payment webhook records.

The job has **no code path that deletes any of these.** Two of them are worth
naming explicitly:

- **The audit log.** An audit trail that deletes itself is not an audit trail. If
  it ever needs pruning, that is a separate and separately-authorised job.
- **Payment webhooks.** Replay protection depends on remembering event ids.
  Deleting them reopens the window the unique constraint closes.

Personal data inside orders is handled by account deletion, not by this job.

---

## Running it

```bash
npm run maintenance:retention -- --dry-run   # report only, writes nothing
npm run maintenance:retention                # apply
```

Dry run is opt-in via the flag and there is deliberately no `--force`
shorthand — a destructive default is how accidents happen.

Output is aggregate counts only. The job never prints a row, an id, a
coordinate, or a phone number, so its output is safe to paste into a ticket.

### Properties it guarantees

- **Idempotent.** Every operation is bounded to rows already past their cutoff,
  so a second pass finds nothing.
- **Concurrency-safe.** Anonymisation is guarded on `anonymisedAt: null`, so a
  row claimed by one run is a no-op for another. Tested with two simultaneous
  runs over the same rows.
- **Batched.** 5,000 rows per rule per run by default, so a first run against
  years of accumulated data cannot hold a write lock for minutes. The remainder
  is picked up next run.
- **Isolated per rule.** One rule failing is reported and the rest still run, so
  a single broken rule cannot block session pruning indefinitely.
- **Audited.** A real run that changed something writes one aggregate audit
  entry. A dry run writes none, because it changed nothing.

### Tuning

| Variable | Governs |
|---|---|
| `RETENTION_SESSIONS_DAYS` | Expired sessions |
| `RETENTION_RIDER_LOCATION_DAYS` | Rider location history |
| `RETENTION_OTP_DAYS` | OTP **and** MFA challenges — one variable so they cannot drift apart |
| `RETENTION_IDEMPOTENCY_DAYS` | Idempotency keys |

Unset means the policy default applies.

**Shortening a period is always allowed** — less data held is never a compliance
risk. **Lengthening one past its ceiling is refused at boot**, because "keep
rider movement for five years" should require a documented decision rather than
an environment variable. Ceilings are in `MAX_ALLOWED_DAYS`.

Validation runs in every environment, not only production: a period that would
be refused in production is refused in staging too, or staging stops being a
rehearsal.

---

## CODEX: scheduling and monitoring

None of this exists. The job is a callable entry point and nothing invokes it.

### Scheduling

Run **daily, off-peak**. Once per day is enough — every period is measured in
days, and the batch limit means a backlog drains over consecutive runs.

Whatever scheduler you choose (Kubernetes `CronJob`, a cloud scheduler, or a
BullMQ repeatable job once Redis exists), it must:

1. Run with the **same `DATABASE_URL` and `ENCRYPTION_KEY`** as the API.
2. Allow only **one concurrent execution**. Two are safe, but a pile-up during
   an incident is noise you do not want. Set `concurrencyPolicy: Forbid` or the
   equivalent.
3. Capture stdout — the report is the operational record.
4. Treat a **non-zero exit as an alert**. The job exits 1 if any rule failed.

### First production run

Run `--dry-run` first and read the counts. On a database with real history the
first real run will touch far more rows than steady state, so:

- Run it during a quiet window.
- Consider a smaller batch size for the first few runs.
- Confirm the counts fall towards zero over subsequent days.

### Alerts

| Condition | Severity | Why |
|---|---|---|
| Job exits non-zero | High | A rule is failing; personal data is being retained past policy. |
| Job has not run in 48h | High | Silent failure of the schedule looks identical to success. |
| `rider_location_history` affected count does not fall towards zero | Medium | Either the backlog exceeds the batch size, or anonymisation is not converging. |
| Any run reports a rule not in the policy | High | Code and policy have diverged. |

### What must never be added

Do not add ledger, payment, order, settlement, or audit records to this job. If
a legal retention limit for accounting data is ever established, it needs its
own job, its own authorisation, and its own review — not a new line in
`RETENTION_RULES`.

---

## Open decisions

| Question | Owner |
|---|---|
| Are these periods lawful under NDPA 2023? | **Qualified Nigerian counsel** |
| Minimum retention for accounting records under Nigerian tax and company law | **Qualified Nigerian counsel** |
| Whether 90 days of rider location is proportionate | Owner + counsel |
| Scheduler, alert routing, and on-call ownership | Codex / infrastructure |
| Whether anonymised location should eventually be deleted outright | Owner |
