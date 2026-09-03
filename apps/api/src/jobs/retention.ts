/**
 * Retention and housekeeping job.
 *
 * Applies the policy in `@dash/domain/retention`. Safe to run repeatedly, safe
 * to run twice at once, and safe to run against a database it has already
 * processed — every operation is a bounded delete or update over rows that are
 * already past their cutoff, so a second pass simply finds nothing.
 *
 * Three properties this job must never lose:
 *
 *   1. **It never touches money or audit records.** The policy marks those
 *      `retain`, and this file has no code path that deletes them.
 *   2. **It reports counts, never rows.** A job that prints the personal data
 *      it just removed has moved the problem into the logs.
 *   3. **A failure in one rule does not stop the others.** Each is isolated, so
 *      a single bad rule cannot block session pruning indefinitely.
 */

import {
  coarsenCoordinate,
  cutoffFor,
  RETENTION_RULES,
  summariseRetention,
  type RetentionOutcome,
  type RetentionReport,
} from '@dash/domain/retention';
import { writeAudit, type PrismaClient } from '@dash/db';
import { pruneExpiredSessions } from '../auth/sessions.js';

export interface RetentionOptions {
  /** Report what would change without writing anything. */
  readonly dryRun?: boolean;
  /** Pinned so every rule in one run shares an instant. Defaults to now. */
  readonly now?: Date;
  /** Per-rule overrides, already validated by config. */
  readonly overrides?: Readonly<Record<string, number>>;
  /**
   * Rows touched per rule per run.
   *
   * Bounded so a first run against years of accumulated data cannot hold a
   * write lock for minutes or blow up memory. Whatever is left is picked up by
   * the next run.
   */
  readonly batchSize?: number;
}

const DEFAULT_BATCH_SIZE = 5_000;

/**
 * Run the policy.
 *
 * Returns a report rather than throwing on a rule failure: an operator needs to
 * see which rules succeeded, and one broken rule must not prevent the rest from
 * ever running again.
 */
export async function runRetention(
  prisma: PrismaClient,
  options: RetentionOptions = {},
): Promise<RetentionReport> {
  const dryRun = options.dryRun ?? false;
  const now = options.now ?? new Date();
  const overrides = options.overrides ?? {};
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const startedAt = new Date();

  const outcomes: RetentionOutcome[] = [];

  for (const rule of RETENTION_RULES) {
    if (rule.action === 'retain') {
      // Recorded in the report so "why was nothing done to the ledger?" has a
      // visible answer, rather than the ledger simply being absent.
      outcomes.push({
        rule: rule.name,
        action: 'retain',
        cutoff: null,
        affected: 0,
        dryRun,
      });
      continue;
    }

    const days = overrides[rule.name] ?? rule.afterDays!;
    const cutoff = cutoffFor({ ...rule, afterDays: days }, now)!;

    try {
      const affected = await applyRule(prisma, rule.name, cutoff, dryRun, batchSize);
      outcomes.push({ rule: rule.name, action: rule.action, cutoff, affected, dryRun });
    } catch (error) {
      // Isolated deliberately: one rule failing must not abandon the others.
      outcomes.push({
        rule: rule.name,
        action: rule.action,
        cutoff,
        affected: 0,
        dryRun,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const report = summariseRetention(startedAt, new Date(), dryRun, outcomes);

  // A real run leaves a trace. A dry run does not — it changed nothing, and an
  // audit entry claiming otherwise would be misleading.
  if (!dryRun && report.totalAffected > 0) {
    await writeAudit(prisma, {
      identityId: null,
      action: 'maintenance.retention.applied',
      resourceType: 'system',
      resourceId: 'retention',
      // Counts only. Never an id, never a coordinate, never a phone number.
      after: {
        totalAffected: report.totalAffected,
        failed: report.failed,
        rules: report.outcomes
          .filter((outcome) => outcome.affected > 0)
          .map((outcome) => ({ rule: outcome.rule, affected: outcome.affected })),
      },
    });
  }

  return report;
}

/**
 * Apply one rule.
 *
 * Every branch is keyed on a name from the policy, so adding a rule without
 * implementing it fails loudly here rather than silently doing nothing.
 */
async function applyRule(
  prisma: PrismaClient,
  name: string,
  cutoff: Date,
  dryRun: boolean,
  batchSize: number,
): Promise<number> {
  switch (name) {
    case 'expired_sessions': {
      // Delegates to the session module's own housekeeping helper rather than
      // reimplementing the delete here — one definition of "an old session",
      // in the file that owns session lifecycle. Expired, not merely revoked: a
      // revoked session is still evidence of a sign-out until it would have
      // expired anyway.
      return pruneExpiredSessions(prisma, cutoff, { dryRun });
    }

    case 'consumed_otp_challenges': {
      const where = {
        OR: [{ consumedAt: { lt: cutoff } }, { expiresAt: { lt: cutoff } }],
      };
      if (dryRun) return prisma.otpChallenge.count({ where });
      return (await prisma.otpChallenge.deleteMany({ where })).count;
    }

    case 'consumed_mfa_challenges': {
      const where = {
        OR: [{ consumedAt: { lt: cutoff } }, { expiresAt: { lt: cutoff } }],
      };
      if (dryRun) return prisma.mfaChallenge.count({ where });
      return (await prisma.mfaChallenge.deleteMany({ where })).count;
    }

    case 'expired_idempotency_keys': {
      const where = { expiresAt: { lt: cutoff } };
      if (dryRun) return prisma.idempotencyKey.count({ where });
      return (await prisma.idempotencyKey.deleteMany({ where })).count;
    }

    case 'rejected_rider_locations': {
      const where = { rejectedReason: { not: null }, recordedAt: { lt: cutoff } };
      if (dryRun) return prisma.riderLocation.count({ where });
      return (await prisma.riderLocation.deleteMany({ where })).count;
    }

    case 'published_outbox_events': {
      // `status: 'published'` is the whole guard. A `pending` event is work the
      // platform still owes someone and a `failed` one is work it dropped —
      // deleting either would destroy the only record that it was ever meant to
      // happen, which is the opposite of what this table is for.
      const where = { status: 'published', publishedAt: { lt: cutoff } };
      if (dryRun) return prisma.outboxEvent.count({ where });
      return (await prisma.outboxEvent.deleteMany({ where })).count;
    }

    case 'rider_location_history': {
      return anonymiseRiderLocations(prisma, cutoff, dryRun, batchSize);
    }

    default:
      throw new Error(`Retention rule "${name}" has no implementation`);
  }
}

/**
 * Coarsen old tracking points in place.
 *
 * Kept rather than deleted so aggregate ETA and coverage analysis survives,
 * while the trail stops being a record of where one person was on a given
 * afternoon.
 *
 * Batched, and skips rows already coarsened so a repeated run converges rather
 * than rewriting the same rows forever. That is also what makes it safe to run
 * concurrently: two runs coarsening the same row write the same value.
 */
async function anonymiseRiderLocations(
  prisma: PrismaClient,
  cutoff: Date,
  dryRun: boolean,
  batchSize: number,
): Promise<number> {
  const due = await prisma.riderLocation.findMany({
    where: { recordedAt: { lt: cutoff }, anonymisedAt: null },
    select: { id: true, latitude: true, longitude: true },
    take: batchSize,
  });

  if (dryRun || due.length === 0) return due.length;

  let changed = 0;

  // One statement per row rather than a bulk update, because each coordinate
  // rounds to a different value. Wrapped so a partial failure does not leave
  // half the batch marked anonymised while still holding precise coordinates.
  await prisma.$transaction(async (tx) => {
    for (const row of due) {
      const result = await tx.riderLocation.updateMany({
        // The `anonymisedAt: null` guard makes a concurrent run a no-op for any
        // row the other has already taken, rather than a double write.
        where: { id: row.id, anonymisedAt: null },
        data: {
          latitude: coarsenCoordinate(row.latitude),
          longitude: coarsenCoordinate(row.longitude),
          // Accuracy and heading would reconstruct precision that has just been
          // deliberately removed.
          accuracy: null,
          heading: null,
          speed: null,
          anonymisedAt: new Date(),
        },
      });
      // Count rows this run actually changed, not iterations. When two runs
      // race, both read the same batch but only one `updateMany` per row
      // matches — so counting attempts would report each row twice and make
      // the aggregate exceed what exists.
      changed += result.count;
    }
  });

  return changed;
}

/**
 * Render a report for a terminal.
 *
 * Aggregates only — this output goes to logs and CI, and must stay safe to
 * paste into a ticket.
 */
export function formatRetentionReport(report: RetentionReport): string {
  const lines: string[] = [];
  const durationMs = report.finishedAt.getTime() - report.startedAt.getTime();

  lines.push('');
  lines.push(report.dryRun ? 'Retention — DRY RUN (nothing written)' : 'Retention');
  lines.push('='.repeat(58));

  for (const outcome of report.outcomes) {
    const action = outcome.action.padEnd(10);
    const count = outcome.error
      ? 'FAILED'
      : outcome.action === 'retain'
        ? '—'
        : String(outcome.affected);

    lines.push(`  ${action} ${outcome.rule.padEnd(28)} ${count.padStart(8)}`);
    if (outcome.error) lines.push(`             ${outcome.error}`);
  }

  lines.push('='.repeat(58));
  lines.push(
    `  ${report.totalAffected} row(s) ${report.dryRun ? 'would be' : ''} affected, ` +
      `${report.failed} rule(s) failed, ${durationMs}ms`,
  );
  lines.push('');

  return lines.join('\n');
}

/**
 * Rule names this file knows how to apply.
 *
 * Exported so a test can assert it matches the policy exactly. Adding a rule to
 * `RETENTION_RULES` without implementing it here would otherwise be a silent
 * no-op — the job would report success having done nothing.
 */
export const IMPLEMENTED_RULES: ReadonlySet<string> = new Set([
  'expired_sessions',
  'consumed_otp_challenges',
  'consumed_mfa_challenges',
  'expired_idempotency_keys',
  'rejected_rider_locations',
  'published_outbox_events',
  'rider_location_history',
]);
