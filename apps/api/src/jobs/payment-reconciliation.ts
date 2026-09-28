/**
 * Payment reconciliation.
 *
 * Two things normally settle a payment: Paystack's webhook and the customer
 * returning from checkout. Either can be lost — a webhook that never arrives,
 * an app closed on Paystack's page — and then a paid order would sit in
 * `payment_pending` for ever while the customer waits for food. This job asks
 * Paystack about every payment still pending, through `settlePayment`, the one
 * definition of "paid" the webhook and the app also use.
 *
 * A checkout still unpaid a day later is closed: its payment is `cancelled`
 * and its order `cancelled` with the reason `payment_not_completed`. Nothing
 * is claimed and no money moves. If the customer somehow completes that old
 * checkout afterwards, `settlePayment` records it as money captured for a
 * closed order — audited for a refund decision, never silently placed.
 *
 * Refunds are returned by a person in the Paystack dashboard, so the failure
 * that matters most is a person not doing it. Every run therefore also counts
 * what is still waiting for a person, however it got there: a refund owed for
 * longer than `REFUND_OVERDUE_MS` and not yet returned at Paystack, a refund
 * Paystack reported failed, and one Paystack has marked `needs-attention`. The
 * run reports them until someone acts; the customer is owed that money.
 *
 * Only payments made through the configured provider are examined, so a mock
 * row is never sent to Paystack. `--dry-run` reports what it would look at
 * and changes nothing.
 */

import { writeAudit, type PrismaClient } from '@dash/db';
import { OWED_REFUND_STATES, PROVIDER_REFUND_NEEDS_ATTENTION, REFUND_OVERDUE_MS } from '@dash/domain/orders';
import type { PaymentPort, QueuePort } from '@dash/domain/ports';
import { settlePayment, type SettleOutcome } from '../payments/settle.js';
import { confirmRefundWithProvider } from '../payments/refund-confirmation.js';

/** Give the webhook and the app their chance first. */
export const RECONCILE_AFTER_MS = 10 * 60_000;
/** An unpaid checkout older than this is closed. */
export const ABANDON_AFTER_MS = 24 * 60 * 60_000;
/** Checked in batches; a backlog is worked down over successive runs. */
const BATCH = 200;
/** How many refund ids a report names; the counts are always complete. */
const NAMED_REFUNDS = 10;

export interface PaymentReconciliationReport {
  examined: number;
  outcomes: Partial<Record<SettleOutcome, number>>;
  unreachable: number;
  closedUnpaid: number;
  /** Refunds linked to a Paystack refund that was still processing. */
  refunds: {
    examined: number;
    refunded: number;
    failed: number;
    unreachable: number;
    /** What is still waiting for a person after this run, whatever path it came by. */
    awaitingPerson: RefundsAwaitingPerson;
  };
  dryRun: boolean;
}

export interface RefundsAwaitingPerson {
  /** Owed for longer than `REFUND_OVERDUE_MS` and not yet returned at Paystack. */
  overdue: number;
  /** Paystack reported the refund failed; a new one has to be issued and linked. */
  failed: number;
  /** Paystack has marked the refund `needs-attention`. */
  providerNeedsAttention: number;
  /** The oldest few of all of these, to start from. Internal ids only. */
  refundIds: string[];
}

export async function runPaymentReconciliation(
  deps: { prisma: PrismaClient; payments: PaymentPort; queue?: QueuePort | undefined },
  options: { dryRun: boolean; now?: Date },
): Promise<PaymentReconciliationReport> {
  const { prisma, payments } = deps;
  const now = options.now ?? new Date();

  const pending = await prisma.payment.findMany({
    where: {
      provider: payments.providerName,
      status: 'pending',
      createdAt: { lt: new Date(now.getTime() - RECONCILE_AFTER_MS) },
    },
    orderBy: { createdAt: 'asc' },
    take: BATCH,
    select: { id: true, orderId: true, providerReference: true, createdAt: true },
  });

  // Refunds a person has linked to a Paystack refund that had not finished
  // when last checked. Paystack's `refund.*` webhook normally completes them;
  // this is for the one that never arrived.
  const processingRefunds = await prisma.refund.findMany({
    where: {
      status: 'refund_processing',
      providerReference: { not: null },
      payment: { provider: payments.providerName },
      OR: [
        { providerCheckedAt: null },
        { providerCheckedAt: { lt: new Date(now.getTime() - RECONCILE_AFTER_MS) } },
      ],
    },
    orderBy: { createdAt: 'asc' },
    take: BATCH,
    select: { id: true },
  });

  const report: PaymentReconciliationReport = {
    examined: pending.length,
    outcomes: {},
    unreachable: 0,
    closedUnpaid: 0,
    refunds: {
      examined: processingRefunds.length,
      refunded: 0,
      failed: 0,
      unreachable: 0,
      awaitingPerson: { overdue: 0, failed: 0, providerNeedsAttention: 0, refundIds: [] },
    },
    dryRun: options.dryRun,
  };
  if (options.dryRun) {
    report.refunds.awaitingPerson = await refundsAwaitingPerson(prisma, payments.providerName, now);
    return report;
  }

  for (const refund of processingRefunds) {
    try {
      const result = await confirmRefundWithProvider(
        { prisma, payments },
        { refundId: refund.id, actorId: null, source: 'reconciliation', now },
      );
      if (result.ok && result.status === 'refunded') report.refunds.refunded += 1;
      if (result.ok && result.status === 'refund_failed') report.refunds.failed += 1;
    } catch {
      report.refunds.unreachable += 1;
    }
  }
  // Counted after the re-checks above, so it reflects what Paystack just said.
  report.refunds.awaitingPerson = await refundsAwaitingPerson(prisma, payments.providerName, now);

  for (const payment of pending) {
    let outcome: SettleOutcome;
    try {
      outcome = await settlePayment(deps, payment.providerReference, 'reconciliation');
    } catch {
      // Paystack unreachable: nothing is changed, and the next run tries again.
      report.unreachable += 1;
      continue;
    }
    report.outcomes[outcome] = (report.outcomes[outcome] ?? 0) + 1;

    const stale = now.getTime() - payment.createdAt.getTime() > ABANDON_AFTER_MS;
    if (stale && (outcome === 'pending' || outcome === 'failed' || outcome === 'unknown_payment')) {
      const closed = await prisma.$transaction(async (tx) => {
        await tx.payment.updateMany({
          where: { id: payment.id, status: { in: ['pending', 'failed'] } },
          data: { status: 'cancelled', failureReason: 'payment_not_completed' },
        });
        const moved = await tx.order.updateMany({
          where: { id: payment.orderId, status: 'payment_pending' },
          data: { status: 'cancelled', cancelledAt: now, cancellationReason: 'payment_not_completed' },
        });
        if (moved.count === 1) {
          await tx.orderStatusEvent.create({
            data: {
              orderId: payment.orderId,
              fromStatus: 'payment_pending',
              toStatus: 'cancelled',
              actorType: 'system',
              reason: 'payment_not_completed',
            },
          });
        }
        return moved.count === 1;
      });
      if (closed) {
        report.closedUnpaid += 1;
        await writeAudit(prisma, {
          identityId: null,
          action: 'payment.closed_unpaid',
          resourceType: 'payment',
          resourceId: payment.id,
          after: { orderId: payment.orderId, reason: 'payment_not_completed' },
        });
      }
    }
  }
  return report;
}

/**
 * The refunds a person still has to act on — `refundAwaitingPerson` in the
 * domain, as queries. Read-only, so a dry run reports it too. Only refunds on
 * payments taken through the configured provider.
 */
async function refundsAwaitingPerson(
  prisma: PrismaClient,
  providerName: string,
  now: Date,
): Promise<RefundsAwaitingPerson> {
  const payment = { provider: providerName };
  const overdue = { status: { in: [...OWED_REFUND_STATES] }, createdAt: { lt: new Date(now.getTime() - REFUND_OVERDUE_MS) }, payment };
  const failed = { status: 'refund_failed', payment };
  const needsAttention = { status: 'refund_processing', providerStatus: { in: [...PROVIDER_REFUND_NEEDS_ATTENTION] }, payment };
  const [overdueCount, failedCount, attentionCount, oldest] = await Promise.all([
    prisma.refund.count({ where: overdue }),
    prisma.refund.count({ where: failed }),
    prisma.refund.count({ where: needsAttention }),
    prisma.refund.findMany({
      where: { OR: [overdue, failed, needsAttention] },
      orderBy: { createdAt: 'asc' },
      take: NAMED_REFUNDS,
      select: { id: true },
    }),
  ]);
  return {
    overdue: overdueCount,
    failed: failedCount,
    providerNeedsAttention: attentionCount,
    refundIds: oldest.map((refund) => refund.id),
  };
}

function formatRefundsAwaitingPerson(waiting: RefundsAwaitingPerson): string {
  const total = waiting.overdue + waiting.failed + waiting.providerNeedsAttention;
  const line =
    `refunds awaiting a person ${total} (owed over ${REFUND_OVERDUE_MS / 3_600_000}h ${waiting.overdue}, ` +
    `failed at Paystack ${waiting.failed}, needs-attention at Paystack ${waiting.providerNeedsAttention})`;
  return total > 0 ? `${line}\n  oldest: ${waiting.refundIds.join(', ')} — see /ops/refunds` : line;
}

export function formatPaymentReconciliationReport(report: PaymentReconciliationReport): string {
  if (report.dryRun) {
    return [
      `would examine ${report.examined} pending payment(s) and ${report.refunds.examined} processing refund(s)`,
      formatRefundsAwaitingPerson(report.refunds.awaitingPerson),
    ].join('\n');
  }
  const outcomes = Object.entries(report.outcomes)
    .map(([outcome, count]) => `${outcome} ${count}`)
    .join(', ');
  const refunds = report.refunds;
  return [
    `examined ${report.examined}${outcomes ? ` (${outcomes})` : ''}`,
    `closed unpaid ${report.closedUnpaid}`,
    `provider unreachable ${report.unreachable}`,
    `refunds examined ${refunds.examined} (refunded ${refunds.refunded}, failed ${refunds.failed}, unreachable ${refunds.unreachable})`,
    formatRefundsAwaitingPerson(refunds.awaitingPerson),
  ].join('\n');
}

/**
 * What needs a person. An unreachable provider is retried next run and is
 * not a failure; money captured for a closed order or for the wrong amount
 * is, and so is any refund still waiting for a person — owed past the
 * deadline, failed at Paystack, or marked needs-attention there. Those are
 * reported on every run until someone acts: the customer is still owed.
 */
export function paymentReconciliationNeedsAttention(report: PaymentReconciliationReport): boolean {
  const waiting = report.refunds.awaitingPerson;
  return (
    (report.outcomes.amount_mismatch ?? 0) > 0 ||
    (report.outcomes.captured_for_closed_order ?? 0) > 0 ||
    report.refunds.failed > 0 ||
    waiting.overdue + waiting.failed + waiting.providerNeedsAttention > 0
  );
}
