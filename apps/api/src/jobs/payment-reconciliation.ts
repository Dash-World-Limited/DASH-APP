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
 * Only payments made through the configured provider are examined, so a mock
 * row is never sent to Paystack. `--dry-run` reports what it would look at
 * and changes nothing.
 */

import { writeAudit, type PrismaClient } from '@dash/db';
import type { PaymentPort, QueuePort } from '@dash/domain/ports';
import { settlePayment, type SettleOutcome } from '../payments/settle.js';

/** Give the webhook and the app their chance first. */
export const RECONCILE_AFTER_MS = 10 * 60_000;
/** An unpaid checkout older than this is closed. */
export const ABANDON_AFTER_MS = 24 * 60 * 60_000;
/** Checked in batches; a backlog is worked down over successive runs. */
const BATCH = 200;

export interface PaymentReconciliationReport {
  examined: number;
  outcomes: Partial<Record<SettleOutcome, number>>;
  unreachable: number;
  closedUnpaid: number;
  dryRun: boolean;
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

  const report: PaymentReconciliationReport = { examined: pending.length, outcomes: {}, unreachable: 0, closedUnpaid: 0, dryRun: options.dryRun };
  if (options.dryRun) return report;

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

export function formatPaymentReconciliationReport(report: PaymentReconciliationReport): string {
  if (report.dryRun) return `would examine ${report.examined} pending payment(s)`;
  const outcomes = Object.entries(report.outcomes)
    .map(([outcome, count]) => `${outcome} ${count}`)
    .join(', ');
  return [
    `examined ${report.examined}${outcomes ? ` (${outcomes})` : ''}`,
    `closed unpaid ${report.closedUnpaid}`,
    `provider unreachable ${report.unreachable}`,
  ].join('\n');
}

/**
 * What needs a person. An unreachable provider is retried next run and is
 * not a failure; money captured for a closed order or for the wrong amount is.
 */
export function paymentReconciliationNeedsAttention(report: PaymentReconciliationReport): boolean {
  return (report.outcomes.amount_mismatch ?? 0) > 0 || (report.outcomes.captured_for_closed_order ?? 0) > 0;
}
