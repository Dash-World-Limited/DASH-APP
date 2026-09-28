/**
 * Operations, support, and finance routes.
 *
 * The staff console. Everything here is permission-gated, most of it is
 * audit-logged, and the financial actions additionally require a recent step-up
 * authentication (enforced inside `assertPermission`).
 */

import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { kobo } from '@dash/domain/money';
import { enqueueViaOutbox, flushOutbox } from '../events/outbox.js';
import { recordOrderChange } from '../realtime/notify.js';
import { ACTIVE_STATUSES, assertTransition, type OrderStatus } from '@dash/domain/orders';
import { buildRefund, buildWalletCredit, verifyLedgerIntegrity } from '@dash/domain/ledger';
import { postLedgerTransaction, writeAudit } from '@dash/db';
import { ApiError } from '../http/errors.js';
import { actorOf, requirePermission, requireScope } from '../http/context.js';
import { effectiveCapabilities } from '../deployment/profile.js';
import { PHONE_VERIFICATION_FLAG } from '@dash/domain/onboarding';
import {
  cancelAccountDeletion,
  getAccountDeletion,
  requestAccountDeletion,
} from '../account/deletion.js';

export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  const { prisma, queue, config } = app.services;

  // -------------------------------------------------------------------------
  // GET /v1/ops/live — the dispatch board
  // -------------------------------------------------------------------------
  app.get('/v1/ops/live', { preHandler: requirePermission('ops:livemap:read') }, async (request) => {
    const actor = actorOf(request);

    const orders = await prisma.order.findMany({
      where: {
        status: { in: [...ACTIVE_STATUSES] },
        // A city-scoped dispatcher sees only their own cities.
        ...(actor.cityIds && actor.cityIds.length > 0
          ? { vendor: { cityId: { in: [...actor.cityIds] } } }
          : {}),
      },
      select: {
        id: true,
        code: true,
        status: true,
        total: true,
        createdAt: true,
        placedAt: true,
        estimatedReadyAt: true,
        riderId: true,
        vendor: { select: { name: true } },
        branch: { select: { name: true, latitude: true, longitude: true } },
        zone: { select: { name: true } },
        rider: {
          select: {
            id: true,
            lastLatitude: true,
            lastLongitude: true,
            locationReportedAt: true,
            identity: { select: { displayName: true } },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
      take: 200,
    });

    const now = Date.now();

    return {
      orders: orders.map((order) => {
        const ageMinutes = Math.round((now - order.createdAt.getTime()) / 60_000);
        const locationAge = order.rider?.locationReportedAt
          ? Math.round((now - order.rider.locationReportedAt.getTime()) / 1000)
          : null;

        return {
          id: order.id,
          code: order.code,
          status: order.status,
          vendor: order.vendor.name,
          zone: order.zone?.name ?? null,
          ageMinutes,
          // The three things a dispatcher actually scans for.
          alerts: [
            ...(!order.riderId && ageMinutes > 12 ? ['unassigned_too_long' as const] : []),
            ...(order.estimatedReadyAt && order.estimatedReadyAt.getTime() < now - 600_000
              ? ['preparation_overdue' as const]
              : []),
            ...(locationAge !== null && locationAge > 120 ? ['rider_location_stale' as const] : []),
          ],
          rider: order.rider
            ? {
                id: order.rider.id,
                name: order.rider.identity.displayName,
                latitude: order.rider.lastLatitude,
                longitude: order.rider.lastLongitude,
                locationAgeSeconds: locationAge,
              }
            : null,
          pickup: { latitude: order.branch.latitude, longitude: order.branch.longitude },
        };
      }),
    };
  });

  // -------------------------------------------------------------------------
  // POST /v1/ops/orders/:id/reassign
  // -------------------------------------------------------------------------
  app.post<{ Params: { id: string } }>(
    '/v1/ops/orders/:id/reassign',
    { preHandler: requirePermission('ops:dispatch:reassign') },
    async (request) => {
      const body = z
        .object({
          // Mandatory. An intervention without a recorded reason is not
          // auditable, and this is the escape hatch most open to abuse.
          reasonCode: z.enum([
            'rider_unresponsive',
            'rider_incident',
            'wrong_vehicle',
            'customer_request',
            'other',
          ]),
          note: z.string().trim().max(280).optional(),
        })
        .parse(request.body);

      const actor = actorOf(request);
      const order = await prisma.order.findUnique({
        where: { id: request.params.id },
        select: { id: true, status: true, riderId: true, vendor: { select: { cityId: true } } },
      });
      if (!order) throw ApiError.notFound();
      requireScope(actor, { cityId: order.vendor.cityId });

      assertTransition(order.status as OrderStatus, 'ready', 'ops');

      await prisma.$transaction(async (tx) => {
        // Created first so its id can key the dispatch job below.
        const event = await tx.orderStatusEvent.create({
          data: {
            orderId: order.id,
            fromStatus: order.status,
            toStatus: 'ready',
            actorType: 'ops',
            actorId: actor.identityId,
            reasonCode: body.reasonCode,
            reason: body.note ?? null,
          },
          select: { id: true },
        });

        await tx.order.update({
          where: { id: order.id },
          data: { status: 'ready', riderId: null },
        });

        if (order.riderId) {
          await tx.rider.update({
            where: { id: order.riderId },
            data: { availability: 'idle' },
          });
          await tx.dispatchOffer.updateMany({
            where: { orderId: order.id, riderId: order.riderId, status: 'accepted' },
            data: { status: 'withdrawn' },
          });
        }

        // Recorded with the reassignment, in the same transaction. The key is
        // the event id, so a genuine second reassignment still dispatches while
        // a retried publish of this one does not.
        await enqueueViaOutbox(tx, {
          name: 'dispatch.find_rider',
          payload: { orderId: order.id },
          idempotencyKey: `dispatch_${order.id}_reassign_${event.id}`,
        });

        // Recorded after the rider is cleared, so the fan-out is computed from
        // the order as it now stands. That matters here more than anywhere
        // else: the reassigned rider is no longer on the order, so the
        // `rider:` topic in this notification is absent rather than naming
        // someone who has just been taken off the job.
        await recordOrderChange(tx, order.id);
      });

      // Publish now if the queue is reachable; the scheduled relay covers it
      // if not. Never raises — the row is already durable.
      await flushOutbox(prisma, queue);

      // Keyed on the reassignment itself rather than the clock.
      //
      // `Date.now()` here meant every call produced a fresh key, so a
      // double-clicked reassign enqueued two dispatch jobs and two expiry
      // sweeps — offers going to more riders than intended, for an order only
      // one of them can claim. Not a money bug (the claim is an atomic
      // updateMany guarded on riderId: null), but wasteful and confusing for
      // the riders who receive a dead offer.
      //
      // The event id is unique per real reassignment, so a genuine second
      // reassignment still dispatches, and the key traces back to the audited
      // action that caused it.
      //
      // Note this does not make the *endpoint* idempotent: two requests create
      // two events. Request-level double-submit protection would mean requiring
      // an Idempotency-Key header here, as order creation does. Recorded as an
      // open item rather than changed silently, because it alters the contract
      // for every existing ops client.
      await writeAudit(prisma, {
        identityId: actor.identityId,
        action: 'ops.order.reassigned',
        resourceType: 'order',
        resourceId: order.id,
        before: { riderId: order.riderId },
        after: { reasonCode: body.reasonCode },
        ipAddress: request.ip,
        requestId: request.id,
      });

      return { reassigned: true };
    },
  );

  // -------------------------------------------------------------------------
  // POST /v1/ops/zones/:id/pause
  // -------------------------------------------------------------------------
  app.post<{ Params: { id: string } }>(
    '/v1/ops/zones/:id/pause',
    { preHandler: requirePermission('ops:zone:pause') },
    async (request) => {
      const body = z
        .object({
          paused: z.boolean(),
          reason: z.string().trim().min(3).max(200),
        })
        .parse(request.body);

      const actor = actorOf(request);
      const zone = await prisma.zone.findUnique({
        where: { id: request.params.id },
        select: { id: true, cityId: true, isActive: true, name: true },
      });
      if (!zone) throw ApiError.notFound();
      requireScope(actor, { cityId: zone.cityId });

      await prisma.zone.update({
        where: { id: zone.id },
        data: {
          isActive: !body.paused,
          pausedAt: body.paused ? new Date() : null,
          pausedReason: body.paused ? body.reason : null,
        },
      });

      await writeAudit(prisma, {
        identityId: actor.identityId,
        action: body.paused ? 'ops.zone.paused' : 'ops.zone.resumed',
        resourceType: 'zone',
        resourceId: zone.id,
        before: { isActive: zone.isActive },
        after: { isActive: !body.paused, reason: body.reason },
        ipAddress: request.ip,
        requestId: request.id,
      });

      return { zone: zone.name, paused: body.paused };
    },
  );

  // -------------------------------------------------------------------------
  // POST /v1/ops/zones/:id/surge
  // -------------------------------------------------------------------------
  app.post<{ Params: { id: string } }>(
    '/v1/ops/zones/:id/surge',
    { preHandler: requirePermission('ops:surge:write') },
    async (request) => {
      const body = z
        .object({
          multiplier: z.number().min(1).max(3),
          reason: z.string().trim().min(3).max(200),
        })
        .parse(request.body);

      const actor = actorOf(request);
      const zone = await prisma.zone.findUnique({
        where: { id: request.params.id },
        select: { id: true, cityId: true, surgeMultiplier: true, name: true },
      });
      if (!zone) throw ApiError.notFound();
      requireScope(actor, { cityId: zone.cityId });

      // The city's configured ceiling is the real limit; the schema bound above
      // is only a first filter. Pricing applies the cap again at quote time, so
      // a bad value here can never reach a customer.
      const rule = await prisma.pricingRule.findFirst({
        where: { cityId: zone.cityId },
        orderBy: { effectiveFrom: 'desc' },
        select: { maximumSurgeMultiplier: true },
      });
      const ceiling = rule?.maximumSurgeMultiplier ?? 2;
      if (body.multiplier > ceiling) {
        throw ApiError.unprocessable(`Surge in this city is capped at ${ceiling}×.`);
      }

      await prisma.zone.update({
        where: { id: zone.id },
        data: { surgeMultiplier: body.multiplier },
      });

      await writeAudit(prisma, {
        identityId: actor.identityId,
        action: 'ops.zone.surge_changed',
        resourceType: 'zone',
        resourceId: zone.id,
        before: { surgeMultiplier: zone.surgeMultiplier },
        after: { surgeMultiplier: body.multiplier, reason: body.reason },
        ipAddress: request.ip,
        requestId: request.id,
      });

      return { zone: zone.name, surgeMultiplier: body.multiplier };
    },
  );

  // -------------------------------------------------------------------------
  // GET /v1/support/cases
  // -------------------------------------------------------------------------
  app.get('/v1/support/cases', { preHandler: requirePermission('support:case:read') }, async (request) => {
    const query = z
      .object({
        status: z.enum(['open', 'pending', 'resolved', 'closed', 'all']).default('open'),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      })
      .parse(request.query);

    const cases = await prisma.supportCase.findMany({
      where: query.status === 'all' ? {} : { status: query.status },
      select: {
        id: true,
        code: true,
        subject: true,
        category: true,
        priority: true,
        status: true,
        assignedTo: true,
        createdAt: true,
        firstResponseDueAt: true,
        orderId: true,
      },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
      take: query.limit,
    });

    return {
      cases: cases.map((supportCase) => ({
        ...supportCase,
        slaBreached:
          supportCase.firstResponseDueAt !== null &&
          supportCase.firstResponseDueAt.getTime() < Date.now(),
      })),
    };
  });

  // -------------------------------------------------------------------------
  // POST /v1/support/cases/:id/compensate
  //
  // Issues wallet credit. Requires step-up (enforced by assertPermission) and
  // is capped, because a compromised support account is a direct route to
  // draining money.
  // -------------------------------------------------------------------------
  app.post<{ Params: { id: string } }>(
    '/v1/support/cases/:id/compensate',
    { preHandler: requirePermission('support:compensation:issue') },
    async (request) => {
      const body = z
        .object({
          amount: z.number().int().min(100).max(50_000_00),
          reason: z.string().trim().min(5).max(280),
        })
        .parse(request.body);

      const actor = actorOf(request);

      const supportCase = await prisma.supportCase.findUnique({
        where: { id: request.params.id },
        select: { id: true, customerId: true, code: true },
      });
      if (!supportCase?.customerId) throw ApiError.notFound();

      // The idempotency key must be derived from the request, never from the
      // clock. `Date.now()` made every call unique, so the ledger's replay
      // protection could never fire and a double-clicked button credited the
      // customer twice — real money, silently doubled.
      //
      // Keyed on the case, the amount, and the reason: issuing the same
      // compensation for the same case twice is a duplicate. A genuinely
      // separate goodwill payment on the same case will differ in at least one
      // of those, and if it does not, it is indistinguishable from a double
      // click and should be refused.
      const compensationKey = createHash('sha256')
        .update(`${supportCase.id}|${body.amount}|${body.reason}`)
        .digest('hex')
        .slice(0, 32);

      const draft = buildWalletCredit({
        customerId: supportCase.customerId,
        idempotencyKey: `compensation_${compensationKey}`,
        actorId: actor.identityId,
        occurredAt: new Date(),
        amount: kobo(body.amount),
        reason: 'goodwill',
        note: body.reason,
      });

      const posted = await postLedgerTransaction(prisma, draft);

      // A replayed credit posts no money, so it must not leave a second action
      // on the case either — otherwise the case history shows two payments the
      // customer never received.
      if (!posted.replayed) {
        await prisma.supportAction.create({
          data: {
            caseId: supportCase.id,
            actorId: actor.identityId,
            kind: 'compensation',
            body: body.reason,
            amount: body.amount,
            ledgerTransactionId: posted.id,
          },
        });
      }

      await writeAudit(prisma, {
        identityId: actor.identityId,
        action: 'support.compensation.issued',
        resourceType: 'support_case',
        resourceId: supportCase.id,
        after: { amount: body.amount, reason: body.reason, ledgerTransactionId: posted.id },
        ipAddress: request.ip,
        requestId: request.id,
      });

      return {
        credited: true,
        amount: body.amount,
        ledgerTransactionId: posted.id,
        replayed: posted.replayed,
      };
    },
  );

  // -------------------------------------------------------------------------
  // POST /v1/finance/orders/:id/refund
  // -------------------------------------------------------------------------
  app.post<{ Params: { id: string } }>(
    '/v1/finance/orders/:id/refund',
    { preHandler: requirePermission('finance:refund:approve') },
    async (request) => {
      const body = z
        .object({
          amount: z.number().int().min(1),
          destination: z.enum(['payment_method', 'wallet']).default('payment_method'),
          bearer: z.enum(['platform', 'vendor']).default('platform'),
          reason: z.string().trim().min(5).max(280),
        })
        .parse(request.body);

      const actor = actorOf(request);

      const order = await prisma.order.findUnique({
        where: { id: request.params.id },
        select: {
          id: true,
          total: true,
          customerId: true,
          vendorId: true,
          payments: { select: { id: true, amount: true, status: true, providerReference: true } },
        },
      });
      if (!order) throw ApiError.notFound();

      const captured = order.payments.find((payment) => payment.status === 'captured');
      if (!captured) throw ApiError.conflict('This order has no captured payment to refund.');

      // --- The cumulative cap --------------------------------------------------
      // Checking this refund against the captured amount on its own is not
      // enough, and the gap is not theoretical: several refunds each under the
      // ceiling can exceed it together. Two ways that happened here —
      //
      //   * two calls for the same amount with different `destination` values
      //     (one to the card, one to the wallet), and
      //   * two calls for different amounts,
      //
      // both of which produced distinct idempotency keys and therefore posted
      // twice. A full refund could be taken twice over.
      //
      // The fix is to bound the TOTAL. Everything already refunded against this
      // payment is counted, whatever route it took out.
      const previousRefunds = await prisma.refund.aggregate({
        where: { paymentId: captured.id, status: { not: 'failed' } },
        _sum: { amount: true },
      });
      const alreadyRefunded = previousRefunds._sum.amount ?? 0;
      const remaining = captured.amount - alreadyRefunded;

      if (body.amount > remaining) {
        throw ApiError.unprocessable(
          remaining <= 0
            ? 'This payment has already been fully refunded.'
            : `Only ₦${(remaining / 100).toFixed(2)} of this payment remains refundable.`,
          { capturedAmount: captured.amount, alreadyRefunded, remaining },
        );
      }

      const amount = kobo(body.amount);
      const draft = buildRefund({
        orderId: order.id,
        // The destination is deliberately NOT part of the key. Refunding the
        // same amount to a different destination is the same refund taking a
        // different route out, not a second entitlement.
        idempotencyKey: `refund_${order.id}_${body.amount}`,
        actorId: actor.identityId,
        occurredAt: new Date(),
        customerId: order.customerId,
        vendorId: order.vendorId,
        toPaymentMethod: body.destination === 'payment_method' ? amount : kobo(0),
        toWallet: body.destination === 'wallet' ? amount : kobo(0),
        ...(body.bearer === 'vendor' ? { fromVendorPayable: amount } : {}),
        note: body.reason,
      });

      const posted = await postLedgerTransaction(prisma, draft);

      // A replayed posting must not create a second Refund row. `idempotencyKey`
      // is unique on the table, so a bare `create` would throw and return a 500
      // after the ledger had already been (correctly) deduplicated — leaving the
      // caller unable to tell a duplicate from a failure.
      if (!posted.replayed) {
        await prisma.refund.create({
          data: {
            paymentId: captured.id,
            amount: body.amount,
            reason: body.reason,
            status: 'pending',
            idempotencyKey: draft.idempotencyKey,
            requestedBy: actor.identityId,
            approvedBy: actor.identityId,
            approvedAt: new Date(),
          },
        });
      }

      await writeAudit(prisma, {
        identityId: actor.identityId,
        action: 'finance.refund.approved',
        resourceType: 'order',
        resourceId: order.id,
        after: { amount: body.amount, destination: body.destination, bearer: body.bearer },
        ipAddress: request.ip,
        requestId: request.id,
      });

      return { refunded: true, amount: body.amount, replayed: posted.replayed };
    },
  );

  // -------------------------------------------------------------------------
  // GET /v1/finance/ledger/integrity
  //
  // The check that must never fail. Run nightly in production; exposed here so
  // finance can confirm on demand.
  // -------------------------------------------------------------------------
  app.get(
    '/v1/finance/ledger/integrity',
    { preHandler: requirePermission('finance:ledger:read') },
    async () => {
      const transactions = await prisma.ledgerTransaction.findMany({
        select: {
          referenceType: true,
          referenceId: true,
          kind: true,
          idempotencyKey: true,
          actorId: true,
          occurredAt: true,
          entries: { select: { accountKind: true, ownerId: true, amount: true, memo: true } },
        },
        take: 5000,
        orderBy: { createdAt: 'desc' },
      });

      const result = verifyLedgerIntegrity(
        transactions.map((transaction) => ({
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
        })),
      );

      return {
        transactionsChecked: transactions.length,
        balanced: result.balanced,
        totalDriftKobo: result.totalDrift,
        offending: result.offending,
      };
    },
  );

  // -------------------------------------------------------------------------
  // GET /v1/admin/audit
  // -------------------------------------------------------------------------
  app.get('/v1/admin/audit', { preHandler: requirePermission('admin:audit:read') }, async (request) => {
    const query = z
      .object({
        resourceType: z.string().max(40).optional(),
        resourceId: z.string().max(64).optional(),
        action: z.string().max(60).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      })
      .parse(request.query);

    const logs = await prisma.auditLog.findMany({
      where: {
        ...(query.resourceType ? { resourceType: query.resourceType } : {}),
        ...(query.resourceId ? { resourceId: query.resourceId } : {}),
        ...(query.action ? { action: { contains: query.action } } : {}),
      },
      select: {
        id: true,
        action: true,
        resourceType: true,
        resourceId: true,
        before: true,
        after: true,
        ipAddress: true,
        createdAt: true,
        identity: { select: { id: true, displayName: true, email: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: query.limit,
    });

    return { logs };
  });

  // -------------------------------------------------------------------------
  // GET /v1/admin/feature-flags
  // -------------------------------------------------------------------------
  app.get(
    '/v1/admin/feature-flags',
    { preHandler: requirePermission('admin:featureflag:write') },
    async () => {
      const flags = await prisma.featureFlag.findMany({ orderBy: { key: 'asc' } });
      return { flags };
    },
  );

  // -------------------------------------------------------------------------
  // PATCH /v1/admin/feature-flags/:key
  // -------------------------------------------------------------------------
  app.patch<{ Params: { key: string } }>(
    '/v1/admin/feature-flags/:key',
    { preHandler: requirePermission('admin:featureflag:write') },
    async (request) => {
      const body = z
        .object({
          isEnabled: z.boolean().optional(),
          rolloutPercent: z.number().int().min(0).max(100).optional(),
        })
        .parse(request.body);

      const actor = actorOf(request);
      const existing = await prisma.featureFlag.findUnique({ where: { key: request.params.key } });
      if (!existing) throw ApiError.notFound();

      // Requiring phone verification while no SMS can be sent would ask every
      // account for a code that can never arrive.
      if (
        existing.key === PHONE_VERIFICATION_FLAG &&
        body.isEnabled === true &&
        !effectiveCapabilities(app.services.config).has('sms')
      ) {
        throw ApiError.conflict('Phone verification cannot be required while SMS is disabled (SMS_ENABLED=false).');
      }

      const updated = await prisma.featureFlag.update({
        where: { key: request.params.key },
        data: {
          ...(body.isEnabled !== undefined ? { isEnabled: body.isEnabled } : {}),
          ...(body.rolloutPercent !== undefined ? { rolloutPercent: body.rolloutPercent } : {}),
          updatedBy: actor.identityId,
        },
      });

      await writeAudit(prisma, {
        identityId: actor.identityId,
        action: 'admin.feature_flag.updated',
        resourceType: 'feature_flag',
        resourceId: existing.key,
        before: { isEnabled: existing.isEnabled, rolloutPercent: existing.rolloutPercent },
        after: { isEnabled: updated.isEnabled, rolloutPercent: updated.rolloutPercent },
        ipAddress: request.ip,
        requestId: request.id,
      });

      return { flag: updated };
    },
  );

  // -------------------------------------------------------------------------
  // POST /v1/admin/identities/:id/deletion
  //
  // The staff path to schedule deletion of a customer's account. Separate from
  // the self-service route: its own permission (`admin:account:delete`, which
  // is step-up-gated), a mandatory reason, and an on-behalf-of audit entry so
  // it can never be exercised silently.
  // -------------------------------------------------------------------------
  app.post<{ Params: { id: string } }>(
    '/v1/admin/identities/:id/deletion',
    {
      preHandler: requirePermission('admin:account:delete'),
      config: { rateLimit: { max: 20, timeWindow: '60 minutes' } },
    },
    async (request) => {
      const actor = actorOf(request);
      const body = z
        .object({ reason: z.string().trim().min(10).max(1000) })
        .parse(request.body);

      const target = await prisma.identity.findUnique({
        where: { id: request.params.id },
        select: { id: true, customer: { select: { id: true } } },
      });
      // A 404 whether the identity is missing or is not a customer — no oracle
      // for which ids exist.
      if (!target || !target.customer) throw ApiError.notFound();

      const view = await requestAccountDeletion(prisma, {
        identityId: target.id,
        customerId: target.customer.id,
        requestedBy: actor.identityId,
        onBehalfOf: target.id,
        coolingOffDays: config.ACCOUNT_DELETION_COOLING_OFF_DAYS,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
        reason: body.reason,
        requestId: request.id,
      });

      return {
        deletion: {
          status: view.status,
          requestedAt: view.requestedAt,
          scheduledPurgeAt: view.scheduledPurgeAt,
          cancellable: view.cancellable,
        },
      };
    },
  );

  // -------------------------------------------------------------------------
  // DELETE /v1/admin/identities/:id/deletion  — cancel on the customer's behalf
  // -------------------------------------------------------------------------
  app.delete<{ Params: { id: string } }>(
    '/v1/admin/identities/:id/deletion',
    { preHandler: requirePermission('admin:account:delete') },
    async (request) => {
      const actor = actorOf(request);

      const target = await prisma.identity.findUnique({
        where: { id: request.params.id },
        select: { id: true, customer: { select: { id: true } } },
      });
      if (!target || !target.customer) throw ApiError.notFound();

      const view = await cancelAccountDeletion(prisma, {
        identityId: target.id,
        cancelledBy: actor.identityId,
        onBehalfOf: target.id,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
        requestId: request.id,
      });

      return { deletion: { status: view.status, cancelledAt: view.cancelledAt } };
    },
  );

  // -------------------------------------------------------------------------
  // GET /v1/admin/identities/:id/deletion
  // -------------------------------------------------------------------------
  app.get<{ Params: { id: string } }>(
    '/v1/admin/identities/:id/deletion',
    { preHandler: requirePermission('admin:user:read') },
    async (request) => {
      const view = await getAccountDeletion(prisma, request.params.id);
      return { deletion: view };
    },
  );
}
