/**
 * Nightly reconciliation, and the lease that stops two schedulers duplicating it.
 *
 * The failure this milestone is really about is not a job that breaks — it is a
 * job that is never run. Four jobs were implemented, tested, and scheduled by
 * nothing at all for three milestones. So the staleness assertions here matter
 * as much as the correctness ones: a maintenance system that cannot tell you it
 * has stopped running is the one that stops running.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  formatLedgerReconciliationReport,
  ledgerReconciliationFailed,
  runLedgerReconciliation,
} from '../jobs/ledger-reconciliation.js';
import {
  acquireLease,
  describeJobFailure,
  maintenanceStaleness,
  releaseLease,
  withLease,
} from '../jobs/maintenance.js';
import { createTestContext, type TestContext } from './harness.js';

let context: TestContext;

beforeEach(async () => {
  context = await createTestContext();
});

afterEach(async () => {
  await context.close();
});

/** A ledger transaction with the entries given. Bypasses the posting guard on purpose. */
async function postRaw(
  reference: string,
  entries: { accountKind: string; amount: number; memo: string }[],
): Promise<void> {
  await context.prisma.ledgerTransaction.create({
    data: {
      kind: 'order_payment_captured',
      idempotencyKey: `key_${reference}`,
      referenceType: 'order',
      referenceId: reference,
      actorId: 'system',
      occurredAt: new Date(),
      entries: { create: entries },
    },
  });
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

describe('ledger reconciliation', () => {
  it('reports balanced on an empty ledger', async () => {
    const report = await runLedgerReconciliation(context.prisma, { dryRun: true });

    expect(report.transactionsChecked).toBe(0);
    expect(report.balanced).toBe(true);
    expect(report.complete).toBe(true);
    expect(ledgerReconciliationFailed(report)).toBe(false);
  });

  it('accepts a transaction that sums to zero', async () => {
    await postRaw('order_ok', [
      { accountKind: 'customer_cash', amount: 1000, memo: 'capture' },
      { accountKind: 'platform_revenue', amount: -1000, memo: 'capture' },
    ]);

    const report = await runLedgerReconciliation(context.prisma, { dryRun: true });
    expect(report.balanced).toBe(true);
    expect(report.transactionsChecked).toBe(1);
    expect(report.entriesChecked).toBe(2);
  });

  it('catches a transaction that does not balance', async () => {
    await postRaw('order_drift', [
      { accountKind: 'customer_cash', amount: 1000, memo: 'capture' },
      { accountKind: 'platform_revenue', amount: -900, memo: 'capture' },
    ]);

    const report = await runLedgerReconciliation(context.prisma, { dryRun: true });

    expect(report.balanced).toBe(false);
    expect(report.totalDriftKobo).toBe(100);
    expect(report.offending).toContain('order:order_drift');
    expect(ledgerReconciliationFailed(report)).toBe(true);
  });

  it('catches a transaction with no entries, which sums to zero vacuously', async () => {
    // The check `verifyLedgerIntegrity` cannot make on its own: an empty entry
    // list balances trivially while recording money that did not move.
    await postRaw('order_empty', []);

    const report = await runLedgerReconciliation(context.prisma, { dryRun: true });

    expect(report.balanced).toBe(false);
    expect(report.empty).toContain('order:order_empty');
    expect(report.totalDriftKobo).toBe(0);
  });

  it('covers the whole ledger, not just the first page', async () => {
    // The gap in the on-demand endpoint, which takes the newest 5 000: the
    // transaction that does not balance is exactly the one nobody looked at.
    for (let index = 0; index < 12; index += 1) {
      await postRaw(`order_${index}`, [
        { accountKind: 'customer_cash', amount: 100, memo: 'capture' },
        { accountKind: 'platform_revenue', amount: -100, memo: 'capture' },
      ]);
    }
    await postRaw('order_late_drift', [
      { accountKind: 'customer_cash', amount: 500, memo: 'capture' },
      { accountKind: 'platform_revenue', amount: -400, memo: 'capture' },
    ]);

    // Page size far smaller than the table, so this only passes if the walk
    // paginates rather than stopping after one read.
    const report = await runLedgerReconciliation(context.prisma, { dryRun: true, pageSize: 3 });

    expect(report.transactionsChecked).toBe(13);
    expect(report.complete).toBe(true);
    expect(report.balanced).toBe(false);
    expect(report.offending).toContain('order:order_late_drift');
  });

  it('reports an incomplete run as a failure, not a clean bill of health', async () => {
    for (let index = 0; index < 6; index += 1) {
      await postRaw(`order_${index}`, [
        { accountKind: 'customer_cash', amount: 100, memo: 'capture' },
        { accountKind: 'platform_revenue', amount: -100, memo: 'capture' },
      ]);
    }

    const report = await runLedgerReconciliation(context.prisma, {
      dryRun: true,
      pageSize: 2,
      maxTransactions: 4,
    });

    expect(report.complete).toBe(false);
    // Balanced as far as it looked — which is not the same as balanced.
    expect(report.balanced).toBe(true);
    expect(ledgerReconciliationFailed(report)).toBe(true);
  });

  it('writes an audit entry on a real run, and none on a dry run', async () => {
    await postRaw('order_audited', [
      { accountKind: 'customer_cash', amount: 100, memo: 'capture' },
      { accountKind: 'platform_revenue', amount: -100, memo: 'capture' },
    ]);

    await runLedgerReconciliation(context.prisma, { dryRun: true });
    expect(
      await context.prisma.auditLog.count({ where: { action: { startsWith: 'maintenance.ledger' } } }),
    ).toBe(0);

    await runLedgerReconciliation(context.prisma);
    const audits = await context.prisma.auditLog.findMany({
      where: { action: { startsWith: 'maintenance.ledger' } },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]!.action).toBe('maintenance.ledger.reconciled');
  });

  it('records an imbalance under its own audit action', async () => {
    await postRaw('order_bad', [{ accountKind: 'customer_cash', amount: 1, memo: 'capture' }]);
    await runLedgerReconciliation(context.prisma);

    const audit = await context.prisma.auditLog.findFirstOrThrow({
      where: { action: { startsWith: 'maintenance.ledger' } },
    });
    expect(audit.action).toBe('maintenance.ledger.imbalance_detected');
  });

  it('repairs nothing', async () => {
    // Corrections are reversing transactions posted by a human (ADR-0006). A
    // job that quietly fixed an imbalance would destroy the evidence of it.
    await postRaw('order_untouched', [
      { accountKind: 'customer_cash', amount: 1000, memo: 'capture' },
      { accountKind: 'platform_revenue', amount: -900, memo: 'capture' },
    ]);

    await runLedgerReconciliation(context.prisma);

    const entries = await context.prisma.ledgerEntry.findMany();
    expect(entries).toHaveLength(2);
    expect(entries.reduce((sum, entry) => sum + entry.amount, 0)).toBe(100);
  });

  it('puts no owner ids or memos in the report', async () => {
    await postRaw('order_private', [
      { accountKind: 'customer_cash', amount: 1000, memo: 'a-memo-that-should-not-travel' },
      { accountKind: 'platform_revenue', amount: -900, memo: 'another-private-memo' },
    ]);

    const report = await runLedgerReconciliation(context.prisma, { dryRun: true });
    const rendered = JSON.stringify(report) + formatLedgerReconciliationReport(report);

    expect(rendered).not.toContain('a-memo-that-should-not-travel');
    expect(rendered).not.toContain('another-private-memo');
  });
});

// ---------------------------------------------------------------------------
// The lease
// ---------------------------------------------------------------------------

describe('the maintenance lease', () => {
  it('is acquired when nothing holds it', async () => {
    const lease = await acquireLease(context.prisma, 'ledger');
    expect(lease.acquired).toBe(true);
  });

  it('is refused while someone else holds it', async () => {
    await acquireLease(context.prisma, 'ledger', { holder: 'first' });
    const second = await acquireLease(context.prisma, 'ledger', { holder: 'second' });

    expect(second.acquired).toBe(false);
    expect(second.heldBy).toBe('first');
  });

  it('is taken over once it expires, so a killed instance does not block the job', async () => {
    await acquireLease(context.prisma, 'ledger', { holder: 'crashed', leaseMs: 1 });

    const later = new Date(Date.now() + 60_000);
    const taken = await acquireLease(context.prisma, 'ledger', { holder: 'next', now: later });
    expect(taken.acquired).toBe(true);
  });

  it('is per job, so one job does not block another', async () => {
    await acquireLease(context.prisma, 'ledger', { holder: 'a' });
    expect((await acquireLease(context.prisma, 'retention', { holder: 'b' })).acquired).toBe(true);
  });

  it('records success on release', async () => {
    const lease = await acquireLease(context.prisma, 'ledger', { holder: 'runner' });
    await releaseLease(context.prisma, 'ledger', lease.holder, { succeeded: true });

    const row = await context.prisma.maintenanceLease.findUniqueOrThrow({ where: { job: 'ledger' } });
    expect(row.lastSucceededAt).not.toBeNull();
    expect(row.lastFailedAt).toBeNull();
  });

  it('records failure separately', async () => {
    const lease = await acquireLease(context.prisma, 'ledger', { holder: 'runner' });
    await releaseLease(context.prisma, 'ledger', lease.holder, { succeeded: false });

    const row = await context.prisma.maintenanceLease.findUniqueOrThrow({ where: { job: 'ledger' } });
    expect(row.lastFailedAt).not.toBeNull();
    expect(row.lastSucceededAt).toBeNull();
  });

  it('cannot be released by an instance whose lease was taken over', async () => {
    // Otherwise a stalled run would stamp its result over the run that replaced
    // it, and "last succeeded" would describe the wrong execution.
    await acquireLease(context.prisma, 'ledger', { holder: 'stalled', leaseMs: 1 });
    const later = new Date(Date.now() + 60_000);
    await acquireLease(context.prisma, 'ledger', { holder: 'took-over', now: later });

    const released = await releaseLease(context.prisma, 'ledger', 'stalled', { succeeded: true });
    expect(released.released).toBe(false);
  });

  it('releases the lease even when the job throws', async () => {
    await expect(
      withLease(context.prisma, 'ledger', async () => {
        throw new Error('job blew up');
      }),
    ).rejects.toThrow('job blew up');

    // Immediately re-acquirable rather than blocked until expiry.
    expect((await acquireLease(context.prisma, 'ledger', { holder: 'next' })).acquired).toBe(true);
  });

  it('skips the job rather than running it twice', async () => {
    await acquireLease(context.prisma, 'ledger', { holder: 'other' });

    let ran = false;
    const outcome = await withLease(context.prisma, 'ledger', async () => {
      ran = true;
      return 'done';
    });

    expect(outcome.skipped).toBe(true);
    expect(ran).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Staleness — the alert for a job that stopped being run
// ---------------------------------------------------------------------------

describe('staleness', () => {
  it('reports a job that has never run as stale', async () => {
    // "No record of success" and "succeeded long ago" are the same operational
    // fact. Treating the first as healthy is how a scheduler that was never
    // wired up looks fine — which is exactly what happened here for three
    // milestones.
    const staleness = await maintenanceStaleness(context.prisma);

    expect(staleness.length).toBeGreaterThan(0);
    expect(staleness.every((entry) => entry.stale)).toBe(true);
    expect(staleness.map((entry) => entry.job)).toContain('ledger');
  });

  it('reports a job that has just succeeded as fresh', async () => {
    const lease = await acquireLease(context.prisma, 'ledger', { holder: 'runner' });
    await releaseLease(context.prisma, 'ledger', lease.holder, { succeeded: true });

    const staleness = await maintenanceStaleness(context.prisma);
    expect(staleness.find((entry) => entry.job === 'ledger')?.stale).toBe(false);
  });

  it('reports a job that succeeded too long ago as stale', async () => {
    const lease = await acquireLease(context.prisma, 'ledger', { holder: 'runner' });
    await releaseLease(context.prisma, 'ledger', lease.holder, { succeeded: true });

    const muchLater = new Date(Date.now() + 5 * 24 * 60 * 60_000);
    const staleness = await maintenanceStaleness(context.prisma, { now: muchLater });
    expect(staleness.find((entry) => entry.job === 'ledger')?.stale).toBe(true);
  });

  it('does not count a failed run as a success', async () => {
    const lease = await acquireLease(context.prisma, 'ledger', { holder: 'runner' });
    await releaseLease(context.prisma, 'ledger', lease.holder, { succeeded: false });

    expect((await maintenanceStaleness(context.prisma)).find((e) => e.job === 'ledger')?.stale).toBe(
      true,
    );
  });
});

describe('what a job failure reports', () => {
  it('strips a connection string', () => {
    const described = describeJobFailure(
      new Error('connect failed for postgresql://dash:job-pw-4a1c@db.internal:5432/dash'),
    );

    expect(described).not.toContain('job-pw-4a1c');
    expect(described).toContain('db.internal:5432');
  });

  it('is bounded', () => {
    expect(describeJobFailure(new Error('y'.repeat(4_000))).length).toBeLessThanOrEqual(300);
  });
});
