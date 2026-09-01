/**
 * Account-maintenance job.
 *
 * Two scheduled tasks that finish the deletion and export flows:
 *
 *   1. **Finalise due deletions.** Every `AccountDeletionRequest` whose
 *      cooling-off window has passed is finalised — the account is anonymised
 *      and its credentials deleted. Idempotent per identity.
 *
 *   2. **Expire stale export archives.** Every `ready` export whose window has
 *      passed unread has its archive deleted and its row marked `expired`.
 *
 * Both are batched, isolated (one failure does not stop the rest), and report
 * counts only — never an email, a phone number, or a coordinate.
 *
 * Codex: schedule alongside the retention job. See docs/RETENTION.md.
 */

import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@dash/db';
import type { ExportArchivePort } from '@dash/domain/ports';
import {
  expireDataExport,
  findExpiredExports,
} from '../account/export.js';
import { finaliseAccountDeletion, findDueDeletions } from '../account/deletion.js';

export interface AccountMaintenanceOptions {
  readonly now?: Date;
  readonly batchSize?: number;
  /** Report what would happen without writing anything. */
  readonly dryRun?: boolean;
}

export interface AccountMaintenanceReport {
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly dryRun: boolean;
  readonly deletions: { due: number; finalised: number; alreadyDone: number; failed: number };
  readonly exports: { expired: number; failed: number };
}

const DEFAULT_BATCH = 200;

export async function runAccountMaintenance(
  prisma: PrismaClient,
  archive: ExportArchivePort,
  options: AccountMaintenanceOptions = {},
): Promise<AccountMaintenanceReport> {
  const now = options.now ?? new Date();
  const batchSize = options.batchSize ?? DEFAULT_BATCH;
  const dryRun = options.dryRun ?? false;
  const startedAt = new Date();

  // --- Deletions --------------------------------------------------------
  const dueIdentityIds = await findDueDeletions(prisma, now, batchSize);
  let finalised = 0;
  let alreadyDone = 0;
  let deletionFailures = 0;

  if (!dryRun) {
    for (const identityId of dueIdentityIds) {
      try {
        const result = await finaliseAccountDeletion(prisma, {
          identityId,
          // A fresh key per attempt: a retry after a genuine failure is meant
          // to run, and the finaliser's own state guards prevent a double
          // anonymisation.
          idempotencyKey: `finalise_${identityId}_${randomUUID()}`,
          now,
        });
        if (result.alreadyDone) alreadyDone += 1;
        else finalised += 1;
      } catch {
        // Isolated: a not-due race or a transient DB error must not abandon
        // the rest of the batch. The row stays `scheduled` and is retried
        // next run.
        deletionFailures += 1;
      }
    }
  }

  // --- Stale exports --------------------------------------------------
  const staleExports = await findExpiredExports(prisma, now, batchSize);
  let expired = 0;
  let exportFailures = 0;

  if (!dryRun) {
    for (const row of staleExports) {
      try {
        await expireDataExport(prisma, archive, row);
        expired += 1;
      } catch {
        exportFailures += 1;
      }
    }
  }

  return {
    startedAt,
    finishedAt: new Date(),
    dryRun,
    deletions: {
      due: dueIdentityIds.length,
      finalised,
      alreadyDone,
      failed: deletionFailures,
    },
    exports: { expired: dryRun ? staleExports.length : expired, failed: exportFailures },
  };
}

export function formatAccountMaintenanceReport(report: AccountMaintenanceReport): string {
  const durationMs = report.finishedAt.getTime() - report.startedAt.getTime();
  const lines: string[] = [
    '',
    report.dryRun ? 'Account maintenance — DRY RUN (nothing written)' : 'Account maintenance',
    '='.repeat(58),
    `  deletions   due ${report.deletions.due}` +
      (report.dryRun
        ? ''
        : `  finalised ${report.deletions.finalised}  already-done ${report.deletions.alreadyDone}  failed ${report.deletions.failed}`),
    `  exports     ${report.dryRun ? 'expiring' : 'expired'} ${report.exports.expired}` +
      (report.dryRun ? '' : `  failed ${report.exports.failed}`),
    '='.repeat(58),
    `  ${durationMs}ms`,
    '',
  ];
  return lines.join('\n');
}

/** True when any part of the run failed. */
export function accountMaintenanceFailed(report: AccountMaintenanceReport): boolean {
  return report.deletions.failed > 0 || report.exports.failed > 0;
}
