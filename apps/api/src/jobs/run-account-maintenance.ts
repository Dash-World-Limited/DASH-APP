/**
 * Account-maintenance entry point.
 *
 *   npm run maintenance:accounts -- --dry-run
 *   npm run maintenance:accounts
 *
 * Finalises deletions whose cooling-off window has passed and expires stale
 * export archives. Prints aggregate counts only. Exits non-zero if any item
 * failed. Codex: schedule daily alongside the retention job — see
 * docs/RETENTION.md.
 */

import { PrismaClient } from '@prisma/client';
import { loadConfig } from '../config.js';
import { LocalExportArchiveAdapter } from '../adapters/index.js';
import {
  accountMaintenanceFailed,
  formatAccountMaintenanceReport,
  runAccountMaintenance,
} from './account-maintenance.js';

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const dryRun = hasFlag('dry-run');

  const prisma = new PrismaClient();
  // The CLI uses the local archive adapter directly. Production wires its real
  // ExportArchivePort through the same function.
  const archive = new LocalExportArchiveAdapter(config.STORAGE_LOCAL_DIR);

  try {
    const report = await runAccountMaintenance(prisma, archive, { dryRun });
    console.warn(formatAccountMaintenanceReport(report));

    if (accountMaintenanceFailed(report)) {
      console.error('Some account-maintenance items failed. See the report above.');
      process.exitCode = 1;
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(
    '\nAccount-maintenance job failed to run:',
    error instanceof Error ? error.message : error,
  );
  process.exit(1);
});
