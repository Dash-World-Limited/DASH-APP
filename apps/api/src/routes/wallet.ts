/**
 * Customer wallet.
 *
 * The ledger is the source of truth. There is deliberately no mutable
 * "balance" column to drift away from the entries Paystack-backed money events
 * post. Customer-facing amounts reverse the ledger's liability sign so a
 * credit reads positive and a spend reads negative.
 */
import type { FastifyInstance } from 'fastify';
import { readBalance } from '@dash/db';
import { ApiError } from '../http/errors.js';
import { actorOf, requirePermission } from '../http/context.js';

export async function registerWalletRoutes(app: FastifyInstance): Promise<void> {
  const { prisma } = app.services;

  app.get(
    '/v1/wallet',
    { preHandler: requirePermission('wallet:read:own') },
    async (request) => {
      const actor = actorOf(request);
      if (!actor.customerId) {
        throw ApiError.forbidden('Only customer accounts have a DASH Wallet.');
      }

      const customerId = actor.customerId;
      const [balance, entries] = await Promise.all([
        readBalance(prisma, 'customer_wallet', customerId),
        prisma.ledgerEntry.findMany({
          where: { accountKind: 'customer_wallet', ownerId: customerId },
          orderBy: { createdAt: 'desc' },
          take: 50,
          select: {
            id: true,
            amount: true,
            memo: true,
            createdAt: true,
            transaction: {
              select: {
                kind: true,
                referenceType: true,
                referenceId: true,
                occurredAt: true,
              },
            },
          },
        }),
      ]);

      return {
        currency: 'NGN' as const,
        balance,
        transactions: entries.map((entry) => ({
          id: entry.id,
          // customer_wallet is a liability: ledger credits are negative.
          amount: -entry.amount,
          memo: entry.memo,
          kind: entry.transaction.kind,
          referenceType: entry.transaction.referenceType,
          referenceId: entry.transaction.referenceId,
          occurredAt: entry.transaction.occurredAt,
          createdAt: entry.createdAt,
        })),
      };
    },
  );
}
