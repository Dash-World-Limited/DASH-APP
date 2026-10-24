/**
 * Confirming a refund with the payment provider.
 *
 * A refund owed to a customer is recorded as `refund_pending_manual_review`
 * and the ledger is booked at that moment. The money itself goes back when a
 * person refunds it in the Paystack dashboard. This is the step after that:
 * the person links Paystack's refund id to our refund, and Paystack — not the
 * person — says whether it is done.
 *
 * Three callers, one definition, the same shape as `settlePayment`:
 *
 *   - the finance console, when a person links or re-checks a refund;
 *   - the Paystack webhook, when a `refund.*` event arrives for a payment;
 *   - reconciliation, for refunds still processing after a while.
 *
 * Nothing a caller says about the outcome is used. The refund reference is the
 * only input; whether it belongs to this payment, its amount, its currency and
 * its state all come from `payments.lookupRefund`, and the decision is the
 * pure `decideRefundConfirmation`.
 */

import { writeAudit, type PrismaClient } from '@dash/db';
import { decideRefundConfirmation } from '@dash/domain/orders';
import type { PaymentPort } from '@dash/domain/ports';

export type RefundConfirmationResult =
  | {
      readonly ok: true;
      readonly status: 'refunded' | 'refund_processing' | 'refund_failed';
      readonly providerStatus: string;
      /** False when the refund was already in this state with this link. */
      readonly changed: boolean;
    }
  | { readonly ok: false; readonly reason: RefundConfirmationRefusal };

export type RefundConfirmationRefusal =
  /** No refund with that id. */
  | 'not_found'
  /** Nothing to check: no provider refund linked and none given. */
  | 'no_reference'
  /** Already refunded, or in a state that cannot be confirmed. */
  | 'not_confirmable'
  /** The payment was not taken through the configured provider. */
  | 'wrong_provider'
  /** The provider has no such refund, or it is for a different payment. */
  | 'not_this_payment'
  | 'currency_mismatch'
  | 'amount_mismatch'
  /** Linked to a different provider refund that is still in progress. */
  | 'linked_to_other_refund'
  /** That provider refund already settles a different refund of ours. */
  | 'already_linked_elsewhere'
  /** Something else changed the refund while the provider was being asked. */
  | 'concurrent_change';

export async function confirmRefundWithProvider(
  deps: { prisma: PrismaClient; payments: PaymentPort },
  input: {
    refundId: string;
    /** What a person copied from the provider. Omitted to re-check the linked one. */
    refundReference?: string | undefined;
    actorId: string | null;
    source: 'finance' | 'webhook' | 'reconciliation';
    now?: Date | undefined;
  },
): Promise<RefundConfirmationResult> {
  const { prisma, payments } = deps;
  const now = input.now ?? new Date();

  const refund = await prisma.refund.findUnique({
    where: { id: input.refundId },
    select: {
      id: true,
      amount: true,
      status: true,
      providerReference: true,
      payment: { select: { id: true, orderId: true, provider: true, providerReference: true } },
    },
  });
  if (!refund) return { ok: false, reason: 'not_found' };

  const reference = input.refundReference ?? refund.providerReference;
  if (!reference) return { ok: false, reason: 'no_reference' };
  if (refund.payment.provider !== payments.providerName) return { ok: false, reason: 'wrong_provider' };

  // Throws when the provider cannot be asked. The caller must treat that as
  // "unknown" and change nothing.
  const lookup = await payments.lookupRefund({
    refundReference: reference,
    providerReference: refund.payment.providerReference,
  });

  const refuse = async (reason: RefundConfirmationRefusal): Promise<RefundConfirmationResult> => {
    await writeAudit(prisma, {
      identityId: input.actorId,
      action: 'payment.refund.confirmation_refused',
      resourceType: 'refund',
      resourceId: refund.id,
      after: {
        reason,
        source: input.source,
        refundReference: lookup.refundReference,
        providerStatus: lookup.providerStatus,
      },
    });
    return { ok: false, reason };
  };

  // Already done. Pointing at the same provider refund again is a harmless
  // repeat; pointing at a different one is a mistake worth refusing loudly.
  if (refund.status === 'refunded') {
    return refund.providerReference === lookup.refundReference
      ? { ok: true, status: 'refunded', providerStatus: lookup.providerStatus, changed: false }
      : refuse('not_confirmable');
  }

  // One provider refund in flight at a time. A second may be linked only once
  // the first has failed — otherwise the same money could go back twice.
  if (
    refund.status === 'refund_processing' &&
    refund.providerReference !== null &&
    refund.providerReference !== lookup.refundReference
  ) {
    return refuse('linked_to_other_refund');
  }

  const decision = decideRefundConfirmation({ status: refund.status, amount: refund.amount }, lookup);
  if (decision.kind === 'refuse') return refuse(decision.reason);

  const changed = decision.to !== refund.status || refund.providerReference !== lookup.refundReference;

  let moved: number;
  try {
    // Conditional on what was read. A concurrent confirmation, or a refund
    // re-linked in between, finds zero rows and is reported rather than
    // overwritten.
    const result = await prisma.refund.updateMany({
      where: { id: refund.id, status: refund.status, providerReference: refund.providerReference },
      data: {
        status: decision.to,
        providerReference: lookup.refundReference,
        providerStatus: lookup.providerStatus,
        providerCheckedAt: now,
        refundedAt: decision.to === 'refunded' ? now : null,
      },
    });
    moved = result.count;
  } catch (error) {
    // The unique index on `providerReference`: this provider refund already
    // settles another refund of ours.
    if ((error as { code?: string }).code === 'P2002') return refuse('already_linked_elsewhere');
    throw error;
  }
  if (moved === 0) return { ok: false, reason: 'concurrent_change' };

  if (changed) {
    await writeAudit(prisma, {
      identityId: input.actorId,
      action: decision.to === 'refunded' ? 'payment.refund.confirmed' : 'payment.refund.linked',
      resourceType: 'refund',
      resourceId: refund.id,
      before: { status: refund.status, providerReference: refund.providerReference },
      after: {
        status: decision.to,
        providerReference: lookup.refundReference,
        providerStatus: lookup.providerStatus,
        source: input.source,
        orderId: refund.payment.orderId,
      },
    });
  }

  return { ok: true, status: decision.to, providerStatus: lookup.providerStatus, changed };
}
