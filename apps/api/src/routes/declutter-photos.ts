/**
 * Item photographs.
 *
 * A second-hand marketplace is photographs. The price, the condition grade and
 * the description are all claims; the photographs are the closest a buyer gets
 * to holding the thing before they pay for it. So this path does three jobs
 * that a generic upload endpoint would not.
 *
 * **It asks what the photograph shows.** `role` is required, not inferred. A
 * valuation that cannot tell a box shot from a photograph of the serial label
 * has to assume the worst about both, and a screen reader announcing "image"
 * six times is not a listing anyone can use.
 *
 * **It fingerprints every byte, globally.** A seller re-using their own
 * photograph across two submissions is untidy. A *second account* uploading the
 * first account's photograph is the oldest fraud in second-hand selling, and it
 * is invisible unless fingerprints are shared across the whole marketplace
 * rather than kept per seller. That upload is refused and a human is told.
 *
 * **It never makes an object public.** Bytes go to the same private bucket as
 * everything else, under a random key, and leave only through a signed URL
 * minted per request.
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

/** Base64 inflates by about a third over the adapter's 8 MB object cap. */
const PHOTO_BODY_LIMIT = 12 * 1024 * 1024;

/** Enough to describe an item honestly; past this it is a gallery, not a listing. */
const MAX_PHOTOS_PER_SUBMISSION = 12;

/**
 * States in which a seller may still change their photographs.
 *
 * Not simply "anything before published". Once a price has been put to the
 * seller, the item DASH valued and the item on the page have to stay the same
 * item — otherwise a seller could accept a price for one thing and publish
 * photographs of another.
 */
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
  /** Raw base64, no data: prefix. */
  data: z.string().min(1),
});

export async function registerDeclutterPhotoRoutes(app: FastifyInstance): Promise<void> {
  const { prisma } = app.services;

  /** The caller's own submission, or a 404 that does not confirm it exists. */
  async function ownSubmissionOr404(actor: ReturnType<typeof actorOf>, id: string) {
    const seller = await prisma.declutterSeller.findUnique({
      where: { customerId: customerIdOf(actor) },
    });
    if (!seller) throw ApiError.notFound();

    const submission = await prisma.declutterSubmission.findUnique({
      where: { id },
      include: { photos: { orderBy: { position: 'asc' } } },
    });
    // Ownership and existence answered with the same response. A 403 here
    // would confirm that somebody else's submission id is real.
    if (!submission || submission.sellerId !== seller.id) throw ApiError.notFound();

    return { seller, submission };
  }

  /**
   * POST /v1/declutter/submissions/:id/photos
   *
   * Base64 in JSON, matching the document upload path, because the API
   * registers no multipart parser and two endpoints do not justify adding a
   * body parser to every route in the service.
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

      // --- duplicate handling ------------------------------------------------
      if (existing) {
        const sameSubmission = existing.submissionPhotos.some(
          (photo) => photo.submissionId === submission.id,
        );
        if (sameSubmission) {
          throw ApiError.conflict('That photograph is already on this item.');
        }

        if (existing.firstSellerId && existing.firstSellerId !== seller.id) {
          // The signal worth keeping. Recorded even though the upload is
          // refused: a blocked attempt to reuse another seller's photograph is
          // exactly what an investigator wants to find later.
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

          // Deliberately vague. Naming the other account, or even confirming
          // there is one, would turn this endpoint into a way to test whether
          // a given image is already on the marketplace.
          throw ApiError.conflict(
            'That photograph cannot be used. Upload your own photographs of the item.',
          );
        }
      }

      // --- store -------------------------------------------------------------
      let stored;
      try {
        stored = await app.services.storage.put({
          body: bytes,
          contentType: body.contentType,
          // Its own prefix. Item photographs are published; KYC evidence is
          // not, and the two must never share a place in the bucket.
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
        // Never the storage key: an audit row carrying it would be a second
        // place to find the object.
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

  /**
   * DELETE /v1/declutter/submissions/:id/photos/:photoId
   *
   * The row goes; the fingerprint stays. Deleting the fingerprint would let a
   * seller launder a blocked image by uploading it, deleting it and uploading
   * it again from another account.
   */
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

      // The object itself goes too. A photograph a seller withdrew before it
      // was ever published is not evidence of anything, and keeping the bytes
      // would be keeping a picture of someone's home they asked us to drop.
      try {
        await app.services.storage.delete(photo.storageKey);
      } catch {
        // A storage provider that cannot delete right now must not fail the
        // request: the row is gone, the object is unreachable without the key,
        // and retrying deletion is a maintenance concern.
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
