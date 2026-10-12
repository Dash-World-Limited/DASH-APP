/**
 * Nightly ledger reconciliation.
 *
 * `verifyLedgerIntegrity` in `@dash/domain/ledger` already describes itself as
 * "the check a nightly reconciliation job runs across the whole ledger". This
 * is that job. Until now the only caller was `GET /v1/finance/ledger/integrity`,
 * which takes the most recent 5 000 transactions — fine for a human asking a
 * question, useless as an assurance that the books balance, because the
 * transaction that does not balance is exactly the one nobody looked at.
 *
 * Three things this does that the endpoint does not:
 *
 *   1. **Covers everything.** Keyset pagination by id over the entire table, one
 *      bounded page at a time. Never `take: 5000`, never the whole table in
 *      memory.
 *   2. **Checks the ledger's other invariant.** Every transaction must sum to
 *      zero — that is `verifyLedgerIntegrity` — *and* every transaction must
 *      have entries at all. A transaction with no entries sums to zero
 *      vacuously and would pass a balance check while representing money that
 *      was recorded as moving and did not.
 *   3. **Leaves a trace.** A run writes an audit entry, so "the books were
 *      checked on the night of the incident" is answerable from the database
 *      rather than from someone's memory of a cron log.
 *
 * **A failure here is SEV1.** `docs/RUNBOOKS.md` says a ledger integrity
 * failure is always SEV1 even if no customer has noticed, because the ledger is
 * the record that says what happened; if it disagrees with itself, every
 * downstream number is suspect. The job reports rather than throws so a partial
 * result is still visible, and the CLI exits non-zero so a scheduler notices.
 *
 * ## What it deliberately does not do
 *
 * It does not repair anything. Corrections to the ledger are reversing
 * transactions posted by a human who understands the discrepancy (ADR-0006);
 * a job that silently "fixed" an imbalance would destroy the evidence of
 * whatever caused it.
 */

import { verifyLedgerIntegrity, type LedgerTransactionDraft } from '@dash/domain/ledger';
import { kobo } from '@dash/domain/money';
import { writeAudit, type PrismaClient } from '@dash/db';

/** Transactions loaded per database round trip. */
const DEFAULT_PAGE_SIZE = 500;

/**
 * The shape one page of the walk returns.
 *
 * Written out rather than inferred because the `where` clause references the
 * cursor the loop is assigning, and TypeScript cannot infer a type that depends
 * on its own initializer.
 */
type LedgerTransactionPage = {
  id: string;
  kind: string;
  idempotencyKey: string;
  referenceType: string;
  referenceId: string;
  actorId: string;
  occurredAt: Date;
  entries: { accountKind: string; ownerId: string | null; amount: number; memo: string }[];
}[];

/**
 * How many offending references are kept.
 *
 * Enough to act on, bounded so a systemic fault does not turn the report — and
 * the audit row it writes — into a dump of the entire ledger.
 */
const MAX_REPORTED_OFFENDERS = 50;

export interface LedgerReconciliationOptions {
  readonly pageSize?: number;
  readonly now?: Date;
  /**
   * Stop after this many transactions and report `complete: false`.
   *
   * A bound on one run, not a bound on correctness: an incomplete run says so,
   * and `balanced` from an incomplete run is not a clean bill of health.
   */
  readonly maxTransactions?: number;
  /** Skip the audit write. Used by the dry run and by tests. */
  readonly dryRun?: boolean;
}

export interface LedgerReconciliationReport {
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly transactionsChecked: number;
  readonly entriesChecked: number;
  readonly balanced: boolean;
  readonly totalDriftKobo: number;
  /** `referenceType:referenceId` for transactions that do not sum to zero. */
  readonly offending: readonly string[];
  /** Transactions with no entries at all — vacuously balanced, actually wrong. */
  readonly empty: readonly string[];
  /** True when the whole table was covered. */
  readonly complete: boolean;
  readonly dryRun: boolean;
}

/**
 * Reconcile the ledger.
 *
 * Returns a report. Never throws for an imbalance — an imbalance is the finding,
 * not an error — and never repairs one.
 */
export async function runLedgerReconciliation(
  prisma: PrismaClient,
  options: LedgerReconciliationOptions = {},
): Promise<LedgerReconciliationReport> {
  const startedAt = options.now ?? new Date();
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxTransactions = options.maxTransactions ?? Number.POSITIVE_INFINITY;
  const dryRun = options.dryRun ?? false;

  let cursor: string | null = null;
  let transactionsChecked = 0;
  let entriesChecked = 0;
  let totalDrift = 0;
  const offending: string[] = [];
  const empty: string[] = [];
  let complete = false;

  for (;;) {
    if (transactionsChecked >= maxTransactions) break;

    const page: LedgerTransactionPage = await prisma.ledgerTransaction.findMany({
      where: cursor === null ? {} : { id: { gt: cursor } },
      select: {
        id: true,
        kind: true,
        idempotencyKey: true,
        referenceType: true,
        referenceId: true,
        actorId: true,
        occurredAt: true,
        entries: { select: { accountKind: true, ownerId: true, amount: true, memo: true } },
      },
      orderBy: { id: 'asc' },
      take: pageSize,
    });

    if (page.length === 0) {
      complete = true;
      break;
    }

    const drafts: LedgerTransactionDraft[] = page.map((transaction) => ({
      kind: transaction.kind as never,
      idempotencyKey: transaction.idempotencyKey,
      referenceType: transaction.referenceType,
      referenceId: transaction.referenceId,
      actorId: transaction.actorId,
      occurredAt: transaction.occurredAt,
      entries: transaction.entries.map((entry) => ({
        accountKind: entry.accountKind as never,
        ownerId: entry.ownerId ?? undefined,
        amount: kobo(entry.amount),
        memo: entry.memo,
      })),
    }));

    // The zero-sum check, from the domain. No arithmetic is reimplemented here.
    const result = verifyLedgerIntegrity(drafts);
    totalDrift += result.totalDrift;
    for (const reference of result.offending) {
      if (offending.length < MAX_REPORTED_OFFENDERS) offending.push(reference);
    }

    // The check `verifyLedgerIntegrity` cannot make: an empty entry list sums
    // to zero and is therefore "balanced", while recording a transaction that
    // moved nothing. That is a posting bug, not a balanced book.
    for (const transaction of page) {
      entriesChecked += transaction.entries.length;
      if (transaction.entries.length === 0 && empty.length < MAX_REPORTED_OFFENDERS) {
        empty.push(`${transaction.referenceType}:${transaction.referenceId}`);
      }
    }

    transactionsChecked += page.length;
    cursor = page[page.length - 1]!.id;

    if (page.length < pageSize) {
      complete = true;
      break;
    }
  }

  const balanced = offending.length === 0 && empty.length === 0 && totalDrift === 0;

  const report: LedgerReconciliationReport = {
    startedAt,
    finishedAt: new Date(),
    transactionsChecked,
    entriesChecked,
    balanced,
    totalDriftKobo: totalDrift,
    offending,
    empty,
    complete,
    dryRun,
  };

  // Every real run is recorded, balanced or not — "we checked and it was fine"
  // is exactly as valuable as "we checked and it was not" when an incident is
  // being reconstructed afterwards. A dry run writes nothing, because it is not
  // evidence of anything having been verified in earnest.
  if (!dryRun) {
    await writeAudit(prisma, {
      identityId: null,
      action: balanced
        ? 'maintenance.ledger.reconciled'
        : 'maintenance.ledger.imbalance_detected',
      resourceType: 'system',
      resourceId: 'ledger',
      // Counts and reference ids. No amounts per party, no owner ids, no memos.
      after: {
        transactionsChecked,
        entriesChecked,
        balanced,
        totalDriftKobo: totalDrift,
        complete,
        offending: offending.slice(0, 10),
        empty: empty.slice(0, 10),
      },
    });
  }

  return report;
}

/** One-line summary for a scheduler's log. Counts only. */
export function formatLedgerReconciliationReport(report: LedgerReconciliationReport): string {
  const lines = [
    `ledger reconciliation — ${report.transactionsChecked} transaction(s), ${report.entriesChecked} entrie(s)`,
    `  balanced        ${report.balanced ? 'yes' : 'NO'}`,
    `  drift           ${report.totalDriftKobo} kobo`,
    `  coverage        ${report.complete ? 'whole ledger' : 'PARTIAL — bounded run, rerun to finish'}`,
  ];

  if (report.offending.length > 0) {
    lines.push(`  not balancing   ${report.offending.join(', ')}`);
  }
  if (report.empty.length > 0) {
    lines.push(`  no entries      ${report.empty.join(', ')}`);
  }
  if (report.dryRun) lines.push('  (dry run — nothing was recorded)');

  return lines.join('\n');
}

/**
 * Did this run find something a human must look at?
 *
 * An incomplete run counts: a bounded pass that has not covered the ledger has
 * not established that it balances, and reporting success on that basis is how
 * a reconciliation job becomes decorative.
 */
export function ledgerReconciliationFailed(report: LedgerReconciliationReport): boolean {
  return !report.balanced || !report.complete;
}
