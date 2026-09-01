/**
 * Retention job entry point.
 *
 *   npm run maintenance:retention -- --dry-run
 *   npm run maintenance:retention
 *
 * Designed to be driven by whatever scheduler production ends up using — cron,
 * a Kubernetes CronJob, a queue worker. It takes no arguments beyond the flags
 * below, exits non-zero if any rule failed, and prints aggregate counts only.
 *
 * Codex: see docs/RETENTION.md for how to schedule and monitor this.
 */

import { PrismaClient } from '@prisma/client';
import { loadConfig, retentionOverrides } from '../config.js';
import { formatRetentionReport, runRetention } from './retention.js';

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<void> {
  const config = loadConfig();

  // Dry run is the default when the flag is present; there is deliberately no
  // "--force" shorthand, because a destructive default is how accidents happen.
  const dryRun = hasFlag('dry-run');

  const prisma = new PrismaClient();

  try {
    const report = await runRetention(prisma, {
      dryRun,
      overrides: retentionOverrides(config),
    });

    // stdout, so a scheduler capturing output records the summary.
    console.warn(formatRetentionReport(report));

    if (report.failed > 0) {
      console.error(`${report.failed} retention rule(s) failed. See the report above.`);
      process.exitCode = 1;
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  // No row data reaches here: runRetention catches per-rule failures and only
  // genuinely unexpected errors escape.
  console.error('\nRetention job failed to run:', error instanceof Error ? error.message : error);
  process.exit(1);
});
