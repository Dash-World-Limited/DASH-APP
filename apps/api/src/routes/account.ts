/**
 * Account deletion and personal-data export — customer-facing routes.
 *
 * Authorization at a glance:
 *
 *   POST   /v1/account/deletion         account:delete:own  + step-up + idempotency
 *   GET    /v1/account/deletion         auth + own customer
 *   DELETE /v1/account/deletion         auth + own customer   (de-escalating; no step-up)
 *
 *   GET    /v1/account/profile          auth (own identity)
 *   PATCH  /v1/account/profile          auth (own identity; location needs own customer)
 *
 *   POST   /v1/account/export           account:export:own  + step-up + idempotency
 *   GET    /v1/account/export           auth + own customer
 *   GET    /v1/account/export/:id       auth + own request
 *   GET    /v1/account/export/:id/download   auth + own request + signed token
 *
 * The write paths sit behind step-up because `account:delete:own` and
 * `account:export:own` are in `STEP_UP_PERMISSIONS`. Reads and cancellation do
 * not — a status check is not sensitive, and cancelling a deletion only ever
 * reduces risk.
 */

import type { FastifyInstance } from 'fastify';
import { effectiveCapabilities } from '../deployment/profile.js';
import { z } from 'zod';
import { writeAudit } from '@dash/db';
import { e164PhoneSchema } from '@dash/domain/phone';
import { describePhone } from '@dash/domain/onboarding';
import { NIGERIAN_STATES } from '@dash/domain/signup';
import { ApiError } from '../http/errors.js';
import { enqueueViaOutbox, flushOutbox } from '../events/outbox.js';
import { actorOf, requireAuth, requirePermission, withIdempotency } from '../http/context.js';
import { phoneVerificationRequired } from './onboarding.js';
import {
  cancelAccountDeletion,
  getAccountDeletion,
  requestAccountDeletion,
} from '../account/deletion.js';
import {
  consumeDataExportDownload,
  getDataExport,
  listDataExports,
  requestDataExport,
} from '../account/export.js';

/** Domain separation for the export download HMAC — never the raw JWT secret. */
function downloadSecret(jwtAccessSecret: string): string {
  return `account-export-download.${jwtAccessSecret}`;
}

export async function registerAccountRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Whether personal-data export is offered.
   *
   * Deletion is always available — it is a right the Privacy Policy promises,
   * and it needs no archive. Export needs somewhere durable to put the file,
   * and the archive adapter still writes to local disk: an archive built in
   * production would be lost on the next deploy. Rather than offer a download
   * that quietly disappears, the endpoints are not registered at all.
   */
  const exportEnabled = effectiveCapabilities(app.services.config).has('dataExport');
  const { prisma, config, queue } = app.services;

  // This edits the canonical account contact, never seller KYC evidence. SMS
  // identities need a proved-number change flow; Declutters uses email sign-in.
  app.patch('/v1/account/phone', {
    preHandler: requireAuth,
    config: { rateLimit: { max: 5, timeWindow: '10 minutes' } },
  }, async (request, reply) => {
    const actor = actorOf(request);
    customerIdOrForbid(request);
    if (effectiveCapabilities(config).has('sms')) {
      throw ApiError.forbidden('Phone changes require a verified-number flow when SMS sign-in is enabled.');
    }
    const { phone } = z.object({ phone: e164PhoneSchema }).strict().parse(request.body);
    try {
      await prisma.$transaction(async tx => {
        await tx.identity.update({ where: { id: actor.identityId }, data: { phone } });
        await writeAudit(tx, {
          identityId: actor.identityId, action: 'account.phone.updated',
          resourceType: 'identity', resourceId: actor.identityId,
          ipAddress: request.ip, requestId: request.id,
        });
      });
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') {
        throw ApiError.conflict('That number cannot be used. Please use another number or contact DASH support.');
      }
      throw error;
    }
    return reply.header('cache-control', 'no-store').send({ saved: true });
  });

  // -------------------------------------------------------------------------
  // Personal details
  // -------------------------------------------------------------------------
  //
  // The same columns sign-up writes — `Identity.displayName`, and the
  // customer's `state` and `cityArea` — read and edited in place. No second
  // copy of anyone's details exists anywhere.
  //
  // Email is how this person signs in, so it is shown and never edited here.
  // The phone keeps its own route above (and its SMS guard); this one says
  // whether that route will accept a change, so the app does not offer an
  // edit the server would refuse.

  app.get('/v1/account/profile', { preHandler: requireAuth }, async (request, reply) => {
    const actor = actorOf(request);
    const identity = await prisma.identity.findUnique({
      where: { id: actor.identityId },
      select: {
        displayName: true,
        email: true,
        phone: true,
        customer: { select: { state: true, cityArea: true } },
      },
    });
    if (!identity) throw ApiError.unauthorized();

    const hasCustomer = Boolean(actor.customerId && identity.customer);
    const phone = describePhone(identity.phone, await phoneVerificationRequired(prisma));
    return reply.header('cache-control', 'no-store').send({
      profile: {
        name: identity.displayName,
        email: identity.email,
        phone: identity.phone,
        phoneNotice: phone.notice,
        state: identity.customer?.state ?? null,
        cityArea: identity.customer?.cityArea ?? null,
      },
      editable: {
        name: true,
        phone: hasCustomer && !effectiveCapabilities(config).has('sms'),
        location: hasCustomer,
      },
    });
  });

  const profileUpdateSchema = z
    .object({
      // The rules sign-up applies, so an edit can never store what sign-up
      // would have refused.
      name: z.string().trim().min(2, 'Enter your full name').max(80),
      state: z.enum(NIGERIAN_STATES, { errorMap: () => ({ message: 'Choose your state' }) }),
      cityArea: z.string().trim().min(2, 'Enter your city, town or area').max(80),
    })
    .partial()
    .strict()
    .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to update.' });

  app.patch('/v1/account/profile', {
    preHandler: requireAuth,
    config: { rateLimit: { max: 20, timeWindow: '10 minutes' } },
  }, async (request, reply) => {
    const actor = actorOf(request);
    const body = profileUpdateSchema.parse(request.body);
    const changesLocation = body.state !== undefined || body.cityArea !== undefined;
    if (changesLocation && !actor.customerId) {
      throw ApiError.forbidden('Location details belong to a customer account.');
    }

    await prisma.$transaction(async (tx) => {
      if (body.name !== undefined) {
        await tx.identity.update({ where: { id: actor.identityId }, data: { displayName: body.name } });
      }
      if (changesLocation && actor.customerId) {
        await tx.customer.update({
          where: { id: actor.customerId },
          data: {
            ...(body.state !== undefined ? { state: body.state } : {}),
            ...(body.cityArea !== undefined ? { cityArea: body.cityArea } : {}),
          },
        });
      }
      // Which fields changed, never their values: an audit trail is not a
      // second place to keep somebody's name and address.
      await writeAudit(tx, {
        identityId: actor.identityId,
        action: 'account.profile.updated',
        resourceType: 'identity',
        resourceId: actor.identityId,
        after: { fields: Object.keys(body).sort() },
        ipAddress: request.ip,
        requestId: request.id,
      });
    });
    return reply.header('cache-control', 'no-store').send({ saved: true });
  });

  /** Deletion and export are a customer flow. Staff/vendor/rider are out of scope. */
  function customerIdOrForbid(request: Parameters<typeof actorOf>[0]): string {
    const actor = actorOf(request);
    if (!actor.customerId) {
      throw ApiError.forbidden('Account deletion and export are available to customer accounts.');
    }
    return actor.customerId;
  }

  // -------------------------------------------------------------------------
  // Deletion
  // -------------------------------------------------------------------------

  app.post(
    '/v1/account/deletion',
    {
      preHandler: requirePermission('account:delete:own'),
      config: { rateLimit: { max: 5, timeWindow: '60 minutes' } },
    },
    async (request) => {
      const actor = actorOf(request);
      const customerId = customerIdOrForbid(request);
      const body = z
        .object({ reason: z.string().trim().max(1000).optional() })
        .parse(request.body ?? {});

      return withIdempotency(request, 'POST /v1/account/deletion', async () => {
        const view = await requestAccountDeletion(prisma, {
          identityId: actor.identityId,
          customerId,
          requestedBy: actor.identityId,
          coolingOffDays: config.ACCOUNT_DELETION_COOLING_OFF_DAYS,
          ipAddress: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
          reason: body.reason ?? null,
          requestId: request.id,
        });

        return {
          deletion: {
            status: view.status,
            requestedAt: view.requestedAt,
            scheduledPurgeAt: view.scheduledPurgeAt,
            cancellable: view.cancellable,
          },
          message:
            'Your account is scheduled for deletion. You can cancel any time before the date shown.',
        };
      });
    },
  );

  app.get('/v1/account/deletion', { preHandler: requireAuth }, async (request) => {
    const actor = actorOf(request);
    customerIdOrForbid(request);

    const view = await getAccountDeletion(prisma, actor.identityId);
    if (!view) return { deletion: null };

    return {
      deletion: {
        status: view.status,
        requestedAt: view.requestedAt,
        scheduledPurgeAt: view.scheduledPurgeAt,
        cancelledAt: view.cancelledAt,
        completedAt: view.completedAt,
        cancellable: view.cancellable,
      },
    };
  });

  app.delete('/v1/account/deletion', { preHandler: requireAuth }, async (request) => {
    const actor = actorOf(request);
    customerIdOrForbid(request);

    const view = await cancelAccountDeletion(prisma, {
      identityId: actor.identityId,
      cancelledBy: actor.identityId,
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
      requestId: request.id,
    });

    return {
      deletion: { status: view.status, cancelledAt: view.cancelledAt },
      message: 'Your account deletion has been cancelled.',
    };
  });

  // -------------------------------------------------------------------------
  // Export
  // -------------------------------------------------------------------------

  if (!exportEnabled) return;

  app.post(
    '/v1/account/export',
    {
      preHandler: requirePermission('account:export:own'),
      config: { rateLimit: { max: 5, timeWindow: '60 minutes' } },
    },
    async (request) => {
      const actor = actorOf(request);
      customerIdOrForbid(request);

      return withIdempotency(request, 'POST /v1/account/export', async () => {
        // The request row and the instruction to build it commit together, so
        // a queue outage can no longer strand an export in `pending` with
        // nothing scheduled to pick it up.
        const { view } = await prisma.$transaction(async (tx) => {
          const created = await requestDataExport(tx, {
            identityId: actor.identityId,
            ipAddress: request.ip,
            requestId: request.id,
          });

          if (created.jobRequestId) {
            await enqueueViaOutbox(tx, {
              name: 'account.export.build',
              payload: { requestId: created.jobRequestId },
              idempotencyKey: `export_build_${created.jobRequestId}`,
            });
          }

          return created;
        });

        // Publish now if the queue is reachable; the scheduled relay covers it
        // if not. Never raises — the row is already durable.
        await flushOutbox(prisma, queue);

        return {
          export: { id: view.id, status: view.status, requestedAt: view.requestedAt },
          message:
            'We are preparing your data. Check back shortly for a download link, which is valid for a limited time.',
        };
      });
    },
  );

  app.get('/v1/account/export', { preHandler: requireAuth }, async (request) => {
    const actor = actorOf(request);
    customerIdOrForbid(request);

    const views = await listDataExports(prisma, actor.identityId);
    return {
      exports: views.map((view) => ({
        id: view.id,
        status: view.status,
        requestedAt: view.requestedAt,
        readyAt: view.readyAt,
        expiresAt: view.expiresAt,
        deliveredAt: view.deliveredAt,
        sizeBytes: view.sizeBytes,
      })),
    };
  });

  app.get<{ Params: { id: string } }>(
    '/v1/account/export/:id',
    { preHandler: requireAuth },
    async (request) => {
      const actor = actorOf(request);
      customerIdOrForbid(request);

      const view = await getDataExport(prisma, {
        requestId: request.params.id,
        identityId: actor.identityId,
        downloadSecret: downloadSecret(config.JWT_ACCESS_SECRET),
      });
      if (!view) throw ApiError.notFound();

      return {
        export: {
          id: view.id,
          status: view.status,
          requestedAt: view.requestedAt,
          readyAt: view.readyAt,
          expiresAt: view.expiresAt,
          deliveredAt: view.deliveredAt,
          sizeBytes: view.sizeBytes,
          // The signed capability, present only while the archive is ready and
          // unread. Downloading it is single-use; asking again re-issues one
          // for the same window, which is fine — the download is what is
          // metered, not the token.
          ...(view.downloadToken ? { downloadToken: view.downloadToken } : {}),
        },
      };
    },
  );

  app.get<{ Params: { id: string }; Querystring: { token?: string } }>(
    '/v1/account/export/:id/download',
    {
      preHandler: requireAuth,
      config: { rateLimit: { max: 20, timeWindow: '10 minutes' } },
    },
    async (request, reply) => {
      const actor = actorOf(request);
      customerIdOrForbid(request);

      const token = z.string().min(10).max(400).parse(request.query.token);

      const { body, filename } = await consumeDataExportDownload(prisma, app.services.exportArchive, {
        requestId: request.params.id,
        identityId: actor.identityId,
        token,
        downloadSecret: downloadSecret(config.JWT_ACCESS_SECRET),
        ipAddress: request.ip,
        httpRequestId: request.id,
      });

      return reply
        .header('content-type', 'application/json')
        .header('content-disposition', `attachment; filename="${filename}"`)
        .header('cache-control', 'no-store')
        .send(body);
    },
  );
}
