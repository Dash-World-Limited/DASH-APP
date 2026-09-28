/**
 * Settling a payment: asking the provider what happened and acting on it.
 *
 * Two things arrive claiming a payment finished — Paystack's webhook and the
 * customer's app returning from checkout — in either order, sometimes at the
 * same moment, sometimes one of them never. Both call this, so there is one
 * definition of "paid" rather than two that can drift.
 *
 * Nothing a caller says about the outcome is used. The reference is the only
 * input; the status and amount come from `payments.verify`, and an order is
 * placed only when the provider reports a capture of exactly the amount this
 * system asked for.
 */

import { writeAudit, type PrismaClient } from '@dash/db';
import type { PaymentPort, QueuePort } from '@dash/domain/ports';
import { confirmOrderPaid } from '../routes/orders.js';

export type SettleOutcome =
  /** Captured, and the order is placed (by this call or an earlier one). */
  | 'captured'
  /** The provider has not finished. Nothing changed. */
  | 'pending'
  /** The provider reports a decline, cancellation or failure. */
  | 'failed'
  /** Refunded, wholly or in part. */
  | 'refunded'
  /** Captured, but not for the amount recorded. The order is not placed. */
  | 'amount_mismatch'
  /** Captured for an order that was cancelled or returned to a basket. Needs a refund. */
  | 'captured_for_closed_order'
  /** No payment with that reference exists here. */
  | 'unknown_payment';

/** States a payment never leaves once captured, whatever a later answer says. */
const SETTLED = new Set(['captured', 'refunded', 'partially_refunded']);

export async function settlePayment(
  deps: { prisma: PrismaClient; payments: PaymentPort; queue?: QueuePort | undefined },
  providerReference: string,
  actorId: string,
): Promise<SettleOutcome> {
  const { prisma, payments, queue } = deps;

  const payment = await prisma.payment.findUnique({
    where: { providerReference },
    select: { id: true, orderId: true, amount: true, status: true },
  });
  if (!payment) return 'unknown_payment';

  // Throws when the provider cannot be asked. The caller must treat that as
  // "unknown", never as a failure and never as a success.
  const verified = await payments.verify(providerReference);

  if (verified.status === 'captured' && verified.amount !== payment.amount) {
    await prisma.payment.update({
      where: { id: payment.id },
      data: { failureReason: `amount_mismatch: expected ${payment.amount}, provider reported ${verified.amount}` },
    });
    await writeAudit(prisma, {
      identityId: null,
      action: 'payment.amount_mismatch',
      resourceType: 'payment',
      resourceId: payment.id,
      after: { expected: payment.amount, reported: verified.amount },
    });
    return 'amount_mismatch';
  }

  // A captured payment is never walked back to pending or failed by a later,
  // staler answer. Only a refund moves it on.
  const downgrade = SETTLED.has(payment.status) && !SETTLED.has(verified.status);
  if (!downgrade && verified.status !== payment.status) {
    await prisma.payment.update({
      where: { id: payment.id },
      data: {
        status: verified.status,
        ...(verified.status === 'captured' ? { capturedAt: new Date() } : {}),
        ...(verified.status === 'failed'
          ? { failedAt: new Date(), failureReason: verified.providerMessage ?? null }
          : {}),
      },
    });
  }

  const effective = downgrade ? payment.status : verified.status;

  if (effective === 'captured') {
    const outcome = await confirmOrderPaid(prisma, payment.orderId, actorId, queue);
    if (outcome === 'not_payable') {
      // Money arrived for an order nobody will fulfil. Placing it anyway would
      // cook food for a customer who cancelled; ignoring it would keep their
      // money. It is recorded for a refund decision instead.
      await writeAudit(prisma, {
        identityId: null,
        action: 'payment.captured_for_closed_order',
        resourceType: 'payment',
        resourceId: payment.id,
        after: { orderId: payment.orderId, amount: payment.amount },
      });
      return 'captured_for_closed_order';
    }
    return 'captured';
  }
  if (effective === 'refunded' || effective === 'partially_refunded') return 'refunded';
  if (effective === 'failed' || effective === 'cancelled') return 'failed';
  return 'pending';
}
