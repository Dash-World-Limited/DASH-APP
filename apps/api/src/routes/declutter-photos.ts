/**
 * Item photographs and the completion boundary for seller submissions.
 *
 * A second-hand marketplace is photographs. The price, the condition grade and
 * the description are all claims; photographs are the closest a buyer gets to
 * holding the thing before they pay for it.
 *
 * Notification happens only after the browser says the submission is complete,
 * and that endpoint refuses an item with no photographs. This prevents DASH
 * from emailing "we received your item" while the upload is still half-finished.
 */

import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { writeAudit } from '@dash/db';
import { PHOTO_ROLES } from '@dash/domain/valuecheck';
import { photoAlt } from '@dash/domain/declutter';
import { ApiError } from '../http/errors.js';
import { actorOf, requireAuth } from '../http/context.js';
import { auditContext, customerIdOf, PHOTO_LINK_SECONDS } from './declutter-shared.js';
import {
  notifyDeclutterSubmissionCreated,
  notifySellerVerificationSubmitted,
} from '../declutter/notifications.js';

/** Base64 inflates by about a third over the adapter's 8 MB object cap. */
const PHOTO_BODY_LIMIT = 12 * 1024 * 1024;

/** Enough to describe an item honestly; past this it is a gallery, not a listing. */
const MAX_PHOTOS_PER_SUBMISSION = 12;

const PHOTO_EDITABLE_STATES = new Set([
  'draft',
  'intake',
  'kyc_pending',
  'details_pending',
  'fraud_review',
  'valuation_pending',
]);

const uploadSchema = z.object({
  contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  role: z.enum(PHOTO_ROLES),
  caption: z.string().trim().max(200).optional(),
  data: z.string().min(1),
});

export async function registerDeclutterPhotoRoutes(app: FastifyInstance): Promise<void> {
  const { prisma, config, email } = app.services;

  async function sellerForActor(actor: ReturnType<typeof actorOf>) {
    const seller = await prisma.declutterSeller.findUnique({
      where: { customerId: customerIdOf(actor) },
    });
    if (!seller) throw ApiError.notFound();
    return seller;
  }

  /** The caller's own submission, or a 404 that does not confirm it exists. */
  async function ownSubmissionOr404(actor: ReturnType<typeof actorOf>, id: string) {
    const seller = await sellerForActor(actor);

    const submission = await prisma.declutterSubmission.findUnique({
      where: { id },
      include: { photos: { orderBy: { position: 'asc' } } },
    });
    if (!submission || submission.sellerId !== seller.id) throw ApiError.notFound();

    return { seller, submission };
  }

  async function accountEmail(identityId: string): Promise<string | null> {
    const identity = await prisma.identity.findUnique({
      where: { id: identityId },
      select: { email: true },
    });
    return identity?.email ?? null;
  }

  /**
   * POST /v1/declutter/submissions/:id/photos
   */
  app.post(
    '/v1/declutter/submissions/:id/photos',
    { preHandler: requireAuth, bodyLimit: PHOTO_BODY_LIMIT },
    async (request, reply) => {
      const actor = actorOf(request);
      const { id } = z.object({ id: z.string().min(1).max(40) }).parse(request.params);
      const body = uploadSchema.parse(request.body);
      const { seller, submission } = await ownSubmissionOr404(actor, id);

      if (!PHOTO_EDITABLE_STATES.has(submission.status)) {
        throw ApiError.conflict(
          'Photographs cannot be changed at this stage. Contact DASH support if something is wrong.',
        );
      }
      if (submission.photos.length >= MAX_PHOTOS_PER_SUBMISSION) {
        throw ApiError.conflict(`A submission can carry ${MAX_PHOTOS_PER_SUBMISSION} photographs.`);
      }

      const bytes = Buffer.from(body.data, 'base64');
      if (bytes.length === 0) throw ApiError.badRequest('That image is empty.');

      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const existing = await prisma.declutterImageFingerprint.findUnique({
        where: { sha256 },
        include: { submissionPhotos: { select: { submissionId: true } } },
      });

      if (existing) {
        const sameSubmission = existing.submissionPhotos.some(
          (photo) => photo.submissionId === submission.id,
        );
        if (sameSubmission) {
          throw ApiError.conflict('That photograph is already on this item.');
        }

        if (existing.firstSellerId && existing.firstSellerId !== seller.id) {
          await prisma.declutterImageUsage.create({
            data: {
              fingerprintId: existing.id,
              sellerId: seller.id,
              submissionId: submission.id,
              outcome: 'blocked_duplicate',
            },
          });
          await prisma.declutterFraudFlag.create({
            data: {
              kind: 'exact_duplicate_cross_account',
              severity: 'high',
              sellerId: seller.id,
              submissionId: submission.id,
              fingerprintId: existing.id,
              detail: JSON.stringify({
                sha256,
                firstSellerId: existing.firstSellerId,
                firstSeenAt: existing.firstSeenAt.toISOString(),
              }),
            },
          });
          await writeAudit(prisma, {
            identityId: actor.identityId,
            action: 'declutter.photo.blocked_duplicate',
            resourceType: 'DeclutterSubmission',
            resourceId: submission.id,
            after: { sha256 },
            ...auditContext(request),
          });

          throw ApiError.conflict(
            'That photograph cannot be used. Upload your own photographs of the item.',
          );
        }
      }

      let stored;
      try {
        stored = await app.services.storage.put({
          body: bytes,
          contentType: body.contentType,
          prefix: 'declutter-items',
        });
      } catch {
        throw ApiError.badRequest('That image was rejected. Use a JPEG, PNG or WebP under 8 MB.');
      }

      const fingerprint =
        existing ??
        (await prisma.declutterImageFingerprint.create({
          data: { sha256, firstSellerId: seller.id },
        }));

      const position = submission.photos.reduce(
        (highest, photo) => Math.max(highest, photo.position + 1),
        0,
      );

      const photo = await prisma.declutterSubmissionPhoto.create({
        data: {
          submissionId: submission.id,
          fingerprintId: fingerprint.id,
          storageKey: stored.key,
          position,
          role: body.role,
          caption: body.caption ?? null,
          bytes: bytes.length,
        },
      });

      await prisma.declutterImageUsage.create({
        data: {
          fingerprintId: fingerprint.id,
          sellerId: seller.id,
          submissionId: submission.id,
          outcome: 'accepted',
        },
      });

      await writeAudit(prisma, {
        identityId: actor.identityId,
        action: 'declutter.photo.uploaded',
        resourceType: 'DeclutterSubmission',
        resourceId: submission.id,
        after: { role: photo.role, position, sizeBytes: stored.sizeBytes },
        ...auditContext(request),
      });

      reply.code(201);
      return {
        photo: {
          id: photo.id,
          role: photo.role,
          position: photo.position,
          caption: photo.caption,
          url: await app.services.storage.signedUrl(photo.storageKey, PHOTO_LINK_SECONDS),
        },
      };
    },
  );

  /**
   * POST /v1/declutter/submissions/:id/complete
   *
   * The browser calls this only after every selected image has uploaded. It is
   * idempotent and is the point at which both the seller receipt and the two
   * independent DASH review inboxes are notified.
   */
  app.post(
    '/v1/declutter/submissions/:id/complete',
    { preHandler: requireAuth },
    async (request) => {
      const actor = actorOf(request);
      const { id } = z.object({ id: z.string().min(1).max(40) }).parse(request.params);
      const { seller, submission } = await ownSubmissionOr404(actor, id);

      if (submission.photos.length === 0) {
        throw ApiError.badRequest('Upload at least one photograph before finishing this item.');
      }

      const alreadyNotified = await prisma.auditLog.findFirst({
        where: {
          action: 'declutter.submission.notification_sent',
          resourceType: 'DeclutterSubmission',
          resourceId: submission.id,
        },
        select: { id: true },
      });
      if (alreadyNotified) return { completed: true, notified: true };

      const result = await notifyDeclutterSubmissionCreated(email, {
        sellerEmail: await accountEmail(actor.identityId),
        sellerName: seller.displayName,
        sellerId: seller.id,
        kycStatus: seller.kycStatus,
        submissionId: submission.id,
        submissionCode: submission.code,
        itemTitle: submission.title ?? 'Your item',
        publicWebUrl: config.PUBLIC_WEB_URL,
      });

      await writeAudit(prisma, {
        identityId: actor.identityId,
        action: 'declutter.submission.notification_sent',
        resourceType: 'DeclutterSubmission',
        resourceId: submission.id,
        after: { attempted: result.attempted, failed: result.failed },
        ...auditContext(request),
      });

      if (result.failed > 0) {
        request.log.warn(
          { attempted: result.attempted, failed: result.failed },
          'one or more declutter submission notifications failed',
        );
      }

      return { completed: true, notified: result.failed === 0 };
    },
  );

  /**
   * POST /v1/declutter/seller/me/verification/complete
   *
   * Seller KYC itself is handled by the core Declutters route. This completion
   * boundary exists only for notification and is idempotent. It never receives
   * an ID number, address or document bytes.
   */
  app.post(
    '/v1/declutter/seller/me/verification/complete',
    { preHandler: requireAuth },
    async (request) => {
      const actor = actorOf(request);
      const seller = await sellerForActor(actor);

      if (seller.kycStatus !== 'pending') {
        throw ApiError.conflict('Seller verification is not waiting for review.');
      }

      const evidenceCount = await prisma.declutterSellerDocument.count({
        where: { sellerId: seller.id },
      });
      if (evidenceCount === 0) {
        throw ApiError.badRequest('Upload a government ID document before finishing verification.');
      }

      const alreadyNotified = await prisma.auditLog.findFirst({
        where: {
          action: 'declutter.seller.verification_notification_sent',
          resourceType: 'DeclutterSeller',
          resourceId: seller.id,
        },
        select: { id: true },
      });
      if (alreadyNotified) return { completed: true, notified: true };

      const result = await notifySellerVerificationSubmitted(email, {
        sellerEmail: await accountEmail(actor.identityId),
        sellerName: seller.displayName,
        sellerId: seller.id,
        publicWebUrl: config.PUBLIC_WEB_URL,
      });

      await writeAudit(prisma, {
        identityId: actor.identityId,
        action: 'declutter.seller.verification_notification_sent',
        resourceType: 'DeclutterSeller',
        resourceId: seller.id,
        after: { attempted: result.attempted, failed: result.failed },
        ...auditContext(request),
      });

      if (result.failed > 0) {
        request.log.warn(
          { attempted: result.attempted, failed: result.failed },
          'one or more declutter seller-verification notifications failed',
        );
      }

      return { completed: true, notified: result.failed === 0 };
    },
  );

  /** GET /v1/declutter/submissions/:id/photos — the seller's own, with links. */
  app.get(
    '/v1/declutter/submissions/:id/photos',
    { preHandler: requireAuth },
    async (request) => {
      const actor = actorOf(request);
      const { id } = z.object({ id: z.string().min(1).max(40) }).parse(request.params);
      const { submission } = await ownSubmissionOr404(actor, id);

      return {
        photos: await Promise.all(
          submission.photos.map(async (photo) => ({
            id: photo.id,
            role: photo.role,
            position: photo.position,
            caption: photo.caption,
            alt: photoAlt(submission.title ?? 'Item', photo.role, photo.caption),
            url: await app.services.storage.signedUrl(photo.storageKey, PHOTO_LINK_SECONDS),
          })),
        ),
      };
    },
  );

  app.delete(
    '/v1/declutter/submissions/:id/photos/:photoId',
    { preHandler: requireAuth },
    async (request, reply) => {
      const actor = actorOf(request);
      const { id, photoId } = z
        .object({ id: z.string().min(1).max(40), photoId: z.string().min(1).max(40) })
        .parse(request.params);
      const { submission } = await ownSubmissionOr404(actor, id);

      if (!PHOTO_EDITABLE_STATES.has(submission.status)) {
        throw ApiError.conflict('Photographs cannot be changed at this stage.');
      }

      const photo = submission.photos.find((candidate) => candidate.id === photoId);
      if (!photo) throw ApiError.notFound();

      await prisma.declutterSubmissionPhoto.delete({ where: { id: photo.id } });

      try {
        await app.services.storage.delete(photo.storageKey);
      } catch {
        // The row is gone and the object is unreachable without its private key.
      }

      await writeAudit(prisma, {
        identityId: actor.identityId,
        action: 'declutter.photo.deleted',
        resourceType: 'DeclutterSubmission',
        resourceId: submission.id,
        before: { role: photo.role, position: photo.position },
        ...auditContext(request),
      });

      reply.code(204);
      return null;
    },
  );
}
