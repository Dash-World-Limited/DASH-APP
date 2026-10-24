/**
 * The single maintenance entry point a scheduler calls.
 *
 *   npm run maintenance:all -- --dry-run
 *   npm run maintenance:all
 *   npm run maintenance:all -- --only=outbox
 *
 * One command, so a cron entry, a systemd timer, or a Kubernetes CronJob has
 * one thing to invoke and one exit code to alarm on. The individual runners
 * (`maintenance:retention`, `maintenance:accounts`) still exist for running a
 * job by hand during an incident; this is what runs unattended.
 *
 * ## Order matters
 *
 * The outbox relay goes first and always. It is the only job whose backlog
 * represents work the platform has promised a customer and not yet done — an
 * order accepted but not dispatched. Retention, expiry, and reconciliation can
 * all wait a cycle; a rider who was never sent cannot.
 *
 * Reconciliation goes last, so it sees the ledger after that cycle's writes
 * rather than in the middle of them.
 *
 * ## Exit codes
 *
 *   0  every job either ran cleanly or was skipped because another instance
 *      held its lease
 *   1  at least one job failed, or reconciliation found the ledger out of
 *      balance, or a job is overdue
 *
 * A skipped job is not a failure. Two schedulers overlapping is ordinary, and a
 * command that exited non-zero for it would page someone nightly until they
 * stopped reading the alerts.
 */

import { PrismaClient } from '@prisma/client';
import { loadConfig, retentionOverrides } from '../config.js';
import { LocalExportArchiveAdapter, MemoryQueueAdapter } from '../adapters/index.js';
import { RedisQueueAdapter } from '../adapters/redis-queue.js';
import { createQueueRedis } from '../redis/client.js';
import { relayOutbox } from '../events/outbox.js';
import { formatRetentionReport, runRetention } from './retention.js';
import {
  accountMaintenanceFailed,
  formatAccountMaintenanceReport,
  runAccountMaintenance,
} from './account-maintenance.js';
import {
  formatLedgerReconciliationReport,
  ledgerReconciliationFailed,
  runLedgerReconciliation,
} from './ledger-reconciliation.js';
import {
  describeJobFailure,
  maintenanceStaleness,
  withLease,
  type MaintenanceJobOutcome,
} from './maintenance.js';
import {
  formatPaymentReconciliationReport,
  paymentReconciliationNeedsAttention,
  runPaymentReconciliation,
} from './payment-reconciliation.js';
import { buildPayments } from '../server.js';
import { effectiveCapabilities } from '../deployment/profile.js';

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function flagValue(name: string): string | null {
  const match = process.argv.find((argument) => argument.startsWith(`--${name}=`));
  return match ? match.slice(name.length + 3) : null;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const dryRun = hasFlag('dry-run');
  const only = flagValue('only');

  const prisma = new PrismaClient();

  // The relay needs a queue. In a dry run it gets an in-memory one so nothing
  // is published: a dry run that enqueued real jobs would not be a dry run.
  const queue =
    dryRun || config.QUEUE_PROVIDER !== 'redis' || !config.REDIS_URL
      ? new MemoryQueueAdapter()
      : new RedisQueueAdapter(createQueueRedis(config.REDIS_URL));

  const archive = new LocalExportArchiveAdapter(config.STORAGE_LOCAL_DIR);
  const outcomes: MaintenanceJobOutcome[] = [];

  const shouldRun = (job: string): boolean => only === null || only === job;

  /** Run one job under its lease, converting any throw into a reported outcome. */
  async function job(name: string, run: () => Promise<string>): Promise<void> {
    if (!shouldRun(name)) return;

    try {
      const outcome = await withLease(prisma, name, run);
      if (outcome.skipped) {
        outcomes.push({
          job: name,
          ran: false,
          skipped: true,
          failed: false,
          summary: 'another instance holds the lease',
        });
        return;
      }
      outcomes.push({ job: name, ran: true, skipped: false, failed: false, summary: outcome.result });
    } catch (error) {
      // Isolated on purpose, exactly as the retention job isolates its rules:
      // one failing job must not stop the rest from running for the night.
      outcomes.push({
        job: name,
        ran: true,
        skipped: false,
        failed: true,
        summary: describeJobFailure(error),
      });
    }
  }

  try {
    // 1. Outbox first — the backlog here is work already promised.
    await job('outbox', async () => {
      if (dryRun) {
        return 'dry run — the relay publishes nothing, so it is not exercised';
      }
      const result = await relayOutbox(prisma, queue);
      if (result.exhausted > 0 || result.undeliverable > 0) {
        throw new Error(
          `outbox: ${result.exhausted} event(s) exhausted their attempts and ${result.undeliverable} were undeliverable`,
        );
      }
      return `published ${result.published}, retrying ${result.retrying}, claimed ${result.claimed}`;
    });

    // 2. Retention — session pruning and rider-location coarsening.
    await job('retention', async () => {
      const report = await runRetention(prisma, {
        dryRun,
        overrides: retentionOverrides(config),
      });
      if (report.failed > 0) throw new Error(`${report.failed} retention rule(s) failed`);
      return formatRetentionReport(report);
    });

    // 3. Accounts — deletion finalisation and export archive expiry.
    await job('accounts', async () => {
      const report = await runAccountMaintenance(prisma, archive, { dryRun });
      if (accountMaintenanceFailed(report)) throw new Error('account maintenance reported failures');
      return formatAccountMaintenanceReport(report);
    });

    // 4. Ledger last, so it sees this cycle's writes.
    // Only where this deployment takes payments; a Declutters deployment has
    // no provider to ask.
    if (effectiveCapabilities(config).has('payments')) {
      await job('payments', async () => {
        const report = await runPaymentReconciliation({ prisma, payments: buildPayments(config), queue }, { dryRun });
        if (paymentReconciliationNeedsAttention(report)) {
          throw new Error(`payments needing a person:\n${formatPaymentReconciliationReport(report)}`);
        }
        return formatPaymentReconciliationReport(report);
      });
    }

    await job('ledger', async () => {
      const report = await runLedgerReconciliation(prisma, { dryRun });
      if (ledgerReconciliationFailed(report)) {
        // SEV1 per docs/RUNBOOKS.md. The report is still printed below.
        throw new Error(
          report.balanced
            ? 'ledger reconciliation did not cover the whole ledger'
            : `ledger does not balance — drift ${report.totalDriftKobo} kobo`,
        );
      }
      return formatLedgerReconciliationReport(report);
    });

    // --- Report ------------------------------------------------------------
    console.warn('\nmaintenance run' + (dryRun ? ' (dry run)' : ''));
    console.warn('='.repeat(60));
    for (const outcome of outcomes) {
      const status = outcome.skipped ? 'SKIP' : outcome.failed ? 'FAIL' : 'ok  ';
      console.warn(`  ${status}  ${outcome.job}`);
      for (const line of outcome.summary.split('\n')) {
        console.warn(`        ${line}`);
      }
    }

    // --- Staleness ---------------------------------------------------------
    // The check that catches the failure mode this whole module exists for: a
    // job that is not failing because it is not running.
    const staleness = await maintenanceStaleness(prisma);
    const stale = staleness.filter((entry) => entry.stale && shouldRun(entry.job));
    if (stale.length > 0 && !dryRun) {
      console.warn('\noverdue:');
      for (const entry of stale) {
        console.warn(
          `  ${entry.job} — last success ${entry.lastSucceededAt?.toISOString() ?? 'never'}`,
        );
      }
    }

    const failed = outcomes.filter((outcome) => outcome.failed);
    if (failed.length > 0) {
      console.error(`\n${failed.length} job(s) failed: ${failed.map((o) => o.job).join(', ')}`);
      process.exitCode = 1;
    } else if (stale.length > 0 && !dryRun) {
      console.error(`\n${stale.length} job(s) overdue: ${stale.map((s) => s.job).join(', ')}`);
      process.exitCode = 1;
    }
  } finally {
    await queue.close();
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  // Scrubbed: a connection failure from the driver underneath carries a URL.
  console.error('\nMaintenance run failed to start:', describeJobFailure(error));
  process.exit(1);
});
