/**
 * Customer wallet.
 *
 * The ledger is the source of truth. There is deliberately no mutable
 * "balance" column to drift away from the entries Paystack-backed money events
 * post. Customer-facing amounts reverse the ledger's liability sign so a
 * credit reads positive and a spend reads negative.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { readBalance, writeAudit } from '@dash/db';
import { ApiError } from '../http/errors.js';
import { actorOf, requirePermission } from '../http/context.js';
import {
  confirmCardSetup,
  listPaymentMethods,
  pendingSetup,
  removePaymentMethod,
  setDefaultPaymentMethod,
  startCardSetup,
} from '../wallet/payment-methods.js';

export async function registerWalletRoutes(app: FastifyInstance): Promise<void> {
  const { prisma, payments } = app.services;

  function customerIdOf(request: FastifyRequest): string {
    const actor = actorOf(request);
    if (!actor.customerId) throw ApiError.forbidden('Only customer accounts can save payment cards.');
    return actor.customerId;
  }

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

  // -------------------------------------------------------------------------
  // Saved cards. Every response is masked: brand, last four, expiry, bank.
  // The provider's token for a card never leaves the server.
  // -------------------------------------------------------------------------

  // GET /v1/wallet/payment-methods — saved cards, and a setup still waiting
  app.get(
    '/v1/wallet/payment-methods',
    { preHandler: requirePermission('payment:method:manage:own') },
    async (request, reply) => {
      const customerId = customerIdOf(request);
      reply.header('cache-control', 'no-store');
      const [methods, pending] = await Promise.all([listPaymentMethods(prisma, customerId), pendingSetup(prisma, customerId)]);
      return { methods, pendingSetup: pending };
    },
  );

  // POST /v1/wallet/payment-methods/setup — start adding a card on the
  // provider's own page. Returns where to send the customer.
  app.post(
    '/v1/wallet/payment-methods/setup',
    {
      preHandler: requirePermission('payment:method:manage:own'),
      config: { rateLimit: { max: 5, timeWindow: '10 minutes' } },
    },
    async (request) => {
      const actor = actorOf(request);
      const customerId = customerIdOf(request);
      const identity = await prisma.identity.findUnique({ where: { id: actor.identityId }, select: { email: true } });
      const setup = await startCardSetup(prisma, app.services.keyring, payments, { customerId, email: identity?.email ?? null });
      return { setup };
    },
  );

  // POST /v1/wallet/payment-methods/setup/:reference/confirm — the customer is
  // back from the provider's page; ask the provider how it went.
  app.post<{ Params: { reference: string } }>(
    '/v1/wallet/payment-methods/setup/:reference/confirm',
    {
      preHandler: requirePermission('payment:method:manage:own'),
      config: { rateLimit: { max: 30, timeWindow: '10 minutes' } },
    },
    async (request) => {
      const actor = actorOf(request);
      const customerId = customerIdOf(request);
      const reference = z.string().trim().regex(/^[A-Za-z0-9-]{4,40}$/).safeParse(request.params.reference);
      if (!reference.success) throw ApiError.notFound();
      const outcome = await confirmCardSetup(prisma, app.services.keyring, payments, { customerId, reference: reference.data });
      if (outcome.status === 'saved') {
        await writeAudit(prisma, {
          identityId: actor.identityId,
          action: 'customer.payment_method.saved',
          resourceType: 'payment_method',
          resourceId: outcome.method.id,
          after: { brand: outcome.method.brand, last4: outcome.method.last4 },
          ipAddress: request.ip,
          requestId: request.id,
        });
      }
      return { outcome };
    },
  );

  // POST /v1/wallet/payment-methods/:id/default
  app.post<{ Params: { id: string } }>(
    '/v1/wallet/payment-methods/:id/default',
    { preHandler: requirePermission('payment:method:manage:own') },
    async (request) => {
      await setDefaultPaymentMethod(prisma, { customerId: customerIdOf(request), id: request.params.id });
      return { methods: await listPaymentMethods(prisma, customerIdOf(request)) };
    },
  );

  // DELETE /v1/wallet/payment-methods/:id
  app.delete<{ Params: { id: string } }>(
    '/v1/wallet/payment-methods/:id',
    { preHandler: requirePermission('payment:method:manage:own') },
    async (request) => {
      const actor = actorOf(request);
      const customerId = customerIdOf(request);
      const result = await removePaymentMethod(prisma, app.services.keyring, payments, { customerId, id: request.params.id });
      await writeAudit(prisma, {
        identityId: actor.identityId,
        action: 'customer.payment_method.removed',
        resourceType: 'payment_method',
        resourceId: request.params.id,
        after: { providerDeactivated: result.providerDeactivated },
        ipAddress: request.ip,
        requestId: request.id,
      });
      return { removed: true, methods: await listPaymentMethods(prisma, customerId) };
    },
  );
}
