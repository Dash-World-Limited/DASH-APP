/**
 * The finance console's refund queue.
 *
 * Approving a refund (`POST /v1/finance/orders/:id/refund`, or a customer's
 * cancellation) records what is owed and books the ledger. The money goes
 * back when a person refunds it in the Paystack dashboard. These routes close
 * that loop: list what is owed, and link each one to the Paystack refund that
 * returned it — at which point Paystack, not the person, says whether it is
 * done. See `payments/refund-confirmation.ts`.
 *
 * There is deliberately no route that sets a refund to `refunded` directly.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { describeRefund, refundAwaitingPerson, REFUND_STATES } from '@dash/domain/orders';
import { ApiError } from '../http/errors.js';
import { actorOf, requirePermission } from '../http/context.js';
import {
  confirmRefundWithProvider,
  type RefundConfirmationRefusal,
} from '../payments/refund-confirmation.js';

/** What a finance person is told when Paystack's answer does not fit. */
function refusalError(reason: RefundConfirmationRefusal): ApiError {
  switch (reason) {
    case 'not_found':
      return ApiError.notFound();
    case 'no_reference':
      return ApiError.unprocessable('Enter the Paystack refund ID.');
    case 'not_confirmable':
      return ApiError.conflict('This refund is already confirmed, or cannot be confirmed from its current state.');
    case 'wrong_provider':
      return ApiError.unprocessable('This payment was not taken through Paystack, so Paystack cannot confirm a refund of it.');
    case 'not_this_payment':
      return ApiError.unprocessable(
        "Paystack has no refund with that ID for this payment. Check the ID on this order's transaction in the Paystack dashboard.",
      );
    case 'currency_mismatch':
      return ApiError.unprocessable('That Paystack refund is not in naira. Nothing was changed.');
    case 'amount_mismatch':
      return ApiError.unprocessable(
        'That Paystack refund is for a different amount from this refund. Nothing was changed.',
      );
    case 'linked_to_other_refund':
      return ApiError.conflict(
        'This refund is linked to another Paystack refund that is still processing. Check that one before linking a new one.',
      );
    case 'already_linked_elsewhere':
      return ApiError.conflict('That Paystack refund already settles a different DASH refund.');
    case 'concurrent_change':
      return ApiError.conflict('This refund changed while Paystack was being asked. Reload and try again.');
  }
}

export async function registerFinanceRefundRoutes(app: FastifyInstance): Promise<void> {
  const { prisma, payments, queue } = app.services;

  // -------------------------------------------------------------------------
  // GET /v1/finance/refunds
  // -------------------------------------------------------------------------
  app.get('/v1/finance/refunds', { preHandler: requirePermission('finance:payment:read') }, async (request) => {
    const query = z
      .object({ status: z.enum([...REFUND_STATES, 'open', 'all']).default('open') })
      .parse(request.query);

    const refunds = await prisma.refund.findMany({
      where:
        query.status === 'all'
          ? {}
          : query.status === 'open'
            ? { status: { notIn: ['refunded'] } }
            : { status: query.status },
      orderBy: { createdAt: 'asc' },
      take: 200,
      select: {
        id: true,
        amount: true,
        reason: true,
        status: true,
        providerReference: true,
        providerStatus: true,
        providerCheckedAt: true,
        refundedAt: true,
        createdAt: true,
        payment: {
          select: {
            provider: true,
            // Our reference — what to search for in the Paystack dashboard.
            providerReference: true,
            order: { select: { id: true, code: true } },
          },
        },
      },
    });

    const now = new Date();
    return {
      refunds: refunds.map((refund) => ({
        id: refund.id,
        amount: refund.amount,
        reason: refund.reason,
        status: refund.status,
        label: describeRefund(refund.status).label,
        providerRefundReference: refund.providerReference,
        providerStatus: refund.providerStatus,
        providerCheckedAt: refund.providerCheckedAt,
        refundedAt: refund.refundedAt,
        createdAt: refund.createdAt,
        paymentProvider: refund.payment.provider,
        paymentReference: refund.payment.providerReference,
        order: refund.payment.order,
        // Why a person has to act on it now, if they do: overdue, failed, or
        // needs-attention at Paystack. The same rule the maintenance job reports.
        awaitingPerson: refundAwaitingPerson(refund, now),
      })),
    };
  });

  // -------------------------------------------------------------------------
  // POST /v1/finance/refunds/:id/confirm
  // -------------------------------------------------------------------------
  // Link a refund to the Paystack refund that returned it, or re-check the one
  // already linked. Step-up gated through `finance:refund:approve`.
  app.post<{ Params: { id: string } }>(
    '/v1/finance/refunds/:id/confirm',
    { preHandler: requirePermission('finance:refund:approve') },
    async (request) => {
      const actor = actorOf(request);
      const { id } = z.object({ id: z.string().min(1).max(40) }).parse(request.params);
      const body = z
        .object({
          // A Paystack refund id as the dashboard shows it. Letters, digits,
          // `_` and `-` only: it is never put into a URL unchecked.
          refundReference: z
            .string()
            .trim()
            .min(1)
            .max(64)
            .regex(/^[A-Za-z0-9_-]+$/, 'Enter the refund ID exactly as Paystack shows it')
            .optional(),
        })
        .parse(request.body ?? {});

      let result;
      try {
        result = await confirmRefundWithProvider(
          { prisma, payments, queue },
          { refundId: id, refundReference: body.refundReference, actorId: actor.identityId, source: 'finance' },
        );
      } catch (error) {
        request.log.error({ refundId: id, err: error }, 'refund confirmation could not reach the provider');
        throw ApiError.serviceUnavailable('Paystack could not be asked. Nothing was changed; try again shortly.');
      }

      if (!result.ok) throw refusalError(result.reason);

      return {
        status: result.status,
        label: describeRefund(result.status).label,
        providerStatus: result.providerStatus,
        changed: result.changed,
      };
    },
  );
}
