/**
 * Account deletion and personal-data export — customer-facing routes.
 *
 * Authorization at a glance:
 *
 *   POST   /v1/account/deletion         account:delete:own  + step-up + idempotency
 *   GET    /v1/account/deletion         auth + own customer
 *   DELETE /v1/account/deletion         auth + own customer   (de-escalating; no step-up)
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
import { ApiError } from '../http/errors.js';
import { enqueueViaOutbox, flushOutbox } from '../events/outbox.js';
import { actorOf, requireAuth, requirePermission, withIdempotency } from '../http/context.js';
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
