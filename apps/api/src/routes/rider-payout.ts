/**
 * The rider's payout bank account, and its read-only view for a super admin.
 *
 * Kept out of routes/rider.ts on purpose: that file is the dispatch path
 * (availability, offers, deliveries), and nothing here touches it.
 *
 * Every response is masked. The full account number is accepted, verified with
 * the bank through the payment provider, encrypted, and never returned.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '@dash/db';
import { ApiError } from '../http/errors.js';
import { actorOf, requirePermission } from '../http/context.js';
import {
  normaliseAccountNumber,
  payoutBanks,
  readRiderPayoutAccount,
  saveRiderPayoutAccount,
  verifyRiderAccount,
} from '../rider/payout.js';

const bankCode = z.string().trim().regex(/^[0-9A-Za-z]{2,10}$/, 'Choose your bank from the list.');
const accountNumber = z.string().trim().min(10).max(20);

export async function registerRiderPayoutRoutes(app: FastifyInstance): Promise<void> {
  const { prisma, payments } = app.services;

  function riderIdOf(request: FastifyRequest): string {
    const actor = actorOf(request);
    if (!actor.riderId) throw ApiError.forbidden('This account is not a rider account.');
    return actor.riderId;
  }

  // -------------------------------------------------------------------------
  // GET /v1/rider/payout-account — the rider's own account, masked
  // -------------------------------------------------------------------------
  app.get(
    '/v1/rider/payout-account',
    { preHandler: requirePermission('rider:earnings:read:own') },
    async (request, reply) => {
      reply.header('cache-control', 'no-store');
      return { payoutAccount: await readRiderPayoutAccount(prisma, riderIdOf(request)) };
    },
  );

  // -------------------------------------------------------------------------
  // GET /v1/rider/payout-account/banks — the provider's Nigerian banks
  // -------------------------------------------------------------------------
  app.get(
    '/v1/rider/payout-account/banks',
    {
      preHandler: requirePermission('rider:payout:write:own'),
      config: { rateLimit: { max: 30, timeWindow: '10 minutes' } },
    },
    async (request) => {
      riderIdOf(request);
      return { banks: await payoutBanks(payments) };
    },
  );

  // -------------------------------------------------------------------------
  // POST /v1/rider/payout-account/verify — ask the bank whose account it is
  //
  // Saves nothing. The rider sees the name the bank holds before deciding to
  // use the account.
  // -------------------------------------------------------------------------
  app.post(
    '/v1/rider/payout-account/verify',
    {
      preHandler: requirePermission('rider:payout:write:own'),
      config: { rateLimit: { max: 10, timeWindow: '10 minutes' } },
    },
    async (request) => {
      riderIdOf(request);
      const body = z.object({ bankCode, accountNumber }).strict().parse(request.body);
      const verified = await verifyRiderAccount(payments, body);
      return {
        account: {
          bankCode: verified.bank.code,
          bankName: verified.bank.name,
          accountName: verified.accountName,
          accountNumberMasked: `••••••${normaliseAccountNumber(body.accountNumber).slice(-4)}`,
        },
      };
    },
  );

  // -------------------------------------------------------------------------
  // PUT /v1/rider/payout-account — verify again and save
  //
  // `accountName` is the name the rider was shown and accepted. The server
  // asks the bank again and saves only if it still matches; the stored name
  // is always the bank's, never the client's.
  // -------------------------------------------------------------------------
  app.put(
    '/v1/rider/payout-account',
    {
      preHandler: requirePermission('rider:payout:write:own'),
      config: { rateLimit: { max: 5, timeWindow: '60 minutes' } },
    },
    async (request) => {
      const actor = actorOf(request);
      const riderId = riderIdOf(request);
      const body = z
        .object({ bankCode, accountNumber, accountName: z.string().trim().min(2).max(120) })
        .strict()
        .parse(request.body);

      const before = await readRiderPayoutAccount(prisma, riderId);
      const saved = await saveRiderPayoutAccount(prisma, app.services.keyring, payments, {
        riderId,
        bankCode: body.bankCode,
        accountNumber: body.accountNumber,
        confirmAccountName: body.accountName,
      });

      await writeAudit(prisma, {
        identityId: actor.identityId,
        action: before.configured ? 'rider.payout_account.changed' : 'rider.payout_account.added',
        resourceType: 'rider',
        resourceId: riderId,
        // Masked on both sides. The audit log is widely read; an account
        // number written here would have leaked.
        before: before.configured ? { bankName: before.bankName, masked: before.accountNumberMasked } : null,
        after: { bankName: saved.bankName, masked: saved.accountNumberMasked },
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
        requestId: request.id,
      });

      return { payoutAccount: saved };
    },
  );

  // -------------------------------------------------------------------------
  // GET /v1/admin/riders/:id/payout-account — a super admin's view
  //
  // `admin:rider:payout:read` is held by super_admin alone and needs a recent
  // step-up. Every view is audited.
  // -------------------------------------------------------------------------
  app.get<{ Params: { id: string } }>(
    '/v1/admin/riders/:id/payout-account',
    { preHandler: requirePermission('admin:rider:payout:read') },
    async (request, reply) => {
      const actor = actorOf(request);
      const rider = await prisma.rider.findUnique({
        where: { id: request.params.id },
        select: { id: true, status: true, identity: { select: { displayName: true } } },
      });
      if (!rider) throw ApiError.notFound();

      const payoutAccount = await readRiderPayoutAccount(prisma, rider.id);

      await writeAudit(prisma, {
        identityId: actor.identityId,
        action: 'rider.payout_account.viewed',
        resourceType: 'rider',
        resourceId: rider.id,
        after: { configured: payoutAccount.configured },
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
        requestId: request.id,
      });

      reply.header('cache-control', 'no-store');
      return {
        rider: { id: rider.id, name: rider.identity.displayName, status: rider.status },
        payoutAccount,
      };
    },
  );
}
