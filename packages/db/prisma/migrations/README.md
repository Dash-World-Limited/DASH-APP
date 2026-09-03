# Migrations

Checked-in Prisma migrations, so a fresh database can be built reproducibly and
every schema change is reviewable as SQL — not only inferred from `db push`.

| Migration | What |
|---|---|
| `20260901000000_init` | Baseline. The whole schema **as of `v0.2.0-auth` + Milestones A–G**, before Milestone E. Generated with `prisma migrate diff --from-empty`. |
| `20260901010000_milestone_e_account_deletion_export` | Milestone E and its production hardening: `AccountDeletionRequest` (incl. `held` / `heldReason` / `heldAt`), `DataExportRequest` (incl. the atomic build claim — `buildClaimId` / `buildClaimUntil` / `buildAttempts` — and the download lease — `downloadLeaseId` / `downloadLeaseUntil`), `Identity.anonymisedAt`, and their indexes. |
| `20260903000000_milestone_iv_outbox_maintenance` | Milestone IV: `OutboxEvent` (the transactional outbox, with its publish claim and retry state) and `MaintenanceLease`. |
| `20260904000000_milestone_v_realtime` | Milestone V: `Order.revision` — a monotonic counter incremented inside the same transaction as every change worth announcing. It is the ordering for realtime notifications; `updatedAt` cannot be, because two writes in one millisecond are indistinguishable and instance clocks do not agree closely enough to order anything. |

## Applying

```bash
npm run db:migrate          # prisma migrate deploy — production / CI / fresh DB
npm run db:migrate:status    # what has and has not been applied
```

`npm run db:push` is still used for **local development and the test harness**
(it is faster and needs no shadow database). Both paths converge on the same
schema; `prisma migrate diff --from-migrations ... --to-schema-datamodel` reports
no drift.

## Rules

- **Never edit or delete an applied migration.** Add a new one.
- The provider is pinned in `migration_lock.toml` (`sqlite` for local; the schema
  is written to stay portable to PostgreSQL — see ADR-0003).
- A fresh-database boot is verified in CI-equivalent terms by
  `npm run db:migrate` followed by the drift check above.
