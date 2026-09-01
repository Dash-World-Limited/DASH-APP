/**
 * Account-maintenance job.
 *
 * The scheduled tasks that finish the deletion and export flows:
 *
 *   1. **Finalise due deletions.** Every `AccountDeletionRequest` past its
 *      cooling-off window is finalised — the account anonymised, credentials
 *      deleted. Legal holds are re-checked at this moment: a request blocked by
 *      a hold acquired during the window parks in `held` and is retried here on
 *      every run, resuming automatically once the hold clears.
 *
 *   2. **Expire stale export archives.** Every `ready` export whose window has
 *      passed unread has its archive deleted and its row marked `expired`.
 *
 *   3. **Fail abandoned export builds.** A `building` row whose worker claim has
 *      gone stale is failed and any half-written blob dropped.
 *
 *   4. **Clean orphaned export archives.** A `delivered` / `expired` row that
 *      still carries a `storageKey` — a delete that failed — has the delete
 *      retried.
 *
 * All batched, isolated (one failure does not stop the rest), and reporting
 * counts only — never an email, a phone number, or a coordinate.
 *
 * Codex: schedule alongside the retention job. See docs/RETENTION.md.
 */

import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@dash/db';
import type { ExportArchivePort } from '@dash/domain/ports';
import {
  cleanOrphanedExportArchive,
  expireDataExport,
  failStaleExportBuild,
  findExpiredExports,
  findOrphanedExportArchives,
  findStaleExportBuilds,
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
  readonly deletions: {
    due: number;
    finalised: number;
    held: number;
    alreadyDone: number;
    failed: number;
  };
  readonly exports: {
    expired: number;
    staleBuildsFailed: number;
    orphansCleaned: number;
    failed: number;
  };
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

  // --- 1. Deletions ---------------------------------------------------
  const dueIdentityIds = await findDueDeletions(prisma, now, batchSize);
  let finalised = 0;
  let held = 0;
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
        if (result.held) held += 1;
        else if (result.alreadyDone) alreadyDone += 1;
        else finalised += 1;
      } catch {
        // Isolated: a not-due race or a transient DB error must not abandon the
        // rest of the batch. The row stays scheduled/held and is retried next run.
        deletionFailures += 1;
      }
    }
  }

  // --- 2. Stale (expired) export archives ---------------------------
  const staleExports = await findExpiredExports(prisma, now, batchSize);
  let expired = 0;
  let exportFailures = 0;

  if (!dryRun) {
    for (const row of staleExports) {
      try {
        // False means the row was left alone — a downloader holds a live lease
        // and may finish. Not a failure; the next run picks it up.
        if (await expireDataExport(prisma, archive, row, now)) expired += 1;
      } catch {
        exportFailures += 1;
      }
    }
  }

  // --- 3. Abandoned export builds ---------------------------------
  const staleBuilds = await findStaleExportBuilds(prisma, now, batchSize);
  let staleBuildsFailed = 0;

  if (!dryRun) {
    for (const row of staleBuilds) {
      try {
        if (await failStaleExportBuild(prisma, archive, row, now)) staleBuildsFailed += 1;
      } catch {
        exportFailures += 1;
      }
    }
  }

  // --- 4. Orphaned archives (a delete that failed) --------------
  const orphans = await findOrphanedExportArchives(prisma, batchSize);
  let orphansCleaned = 0;

  if (!dryRun) {
    for (const row of orphans) {
      try {
        if (await cleanOrphanedExportArchive(prisma, archive, row)) orphansCleaned += 1;
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
      held,
      alreadyDone,
      failed: deletionFailures,
    },
    exports: {
      expired: dryRun ? staleExports.length : expired,
      staleBuildsFailed: dryRun ? staleBuilds.length : staleBuildsFailed,
      orphansCleaned: dryRun ? orphans.length : orphansCleaned,
      failed: exportFailures,
    },
  };
}

export function formatAccountMaintenanceReport(report: AccountMaintenanceReport): string {
  const durationMs = report.finishedAt.getTime() - report.startedAt.getTime();
  const d = report.deletions;
  const e = report.exports;
  const lines: string[] = [
    '',
    report.dryRun ? 'Account maintenance — DRY RUN (nothing written)' : 'Account maintenance',
    '='.repeat(58),
    `  deletions   due ${d.due}` +
      (report.dryRun
        ? ''
        : `  finalised ${d.finalised}  held ${d.held}  already-done ${d.alreadyDone}  failed ${d.failed}`),
    `  exports     ${report.dryRun ? 'expiring' : 'expired'} ${e.expired}` +
      (report.dryRun
        ? `  stale-builds ${e.staleBuildsFailed}  orphans ${e.orphansCleaned}`
        : `  stale-builds ${e.staleBuildsFailed}  orphans ${e.orphansCleaned}  failed ${e.failed}`),
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
