import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { writeAudit } from '@dash/db';
import {
  approvePublishBlockers,
  HUB_BLOCKER_LABELS,
  hubBlockers,
} from '@dash/domain/declutter';
import { PHOTO_ROLES } from '@dash/domain/valuecheck';
import {
  hubInclude,
  hubView,
  facts,
  reconcileHub,
  deliverHubNotifications,
} from '../declutter/hub.js';
import { authorizeSubmissionPrice } from '../declutter/price-authority.js';
import {
  publishSnapshot,
  sendPublicationEmail,
  publishRecordedDecision,
} from '../declutter/publication.js';
import { actorOf, requireAuth, requirePermission } from '../http/context.js';
import { ApiError } from '../http/errors.js';
import { auditContext, customerIdOf } from './declutter-shared.js';
import { notifyDeclutterAdminMessage } from '../declutter/notifications.js';

const idParam = z.object({ id: z.string().min(1).max(60) });
const editInput = z
  .object({
    title: z.string().trim().min(3).max(160),
    description: z.string().trim().min(10).max(4000),
    condition: z.enum(['new', 'like_new', 'good', 'fair']),
    keepPhotoIds: z.array(z.string()).max(12).optional(),
  })
  .strict();
export async function registerDeclutterHubRoutes(app: FastifyInstance) {
  const { prisma, email, config } = app.services;
  async function row(id: string) {
    const s = await prisma.declutterSubmission.findUnique({
      where: { id },
      include: hubInclude,
    });
    if (!s) throw ApiError.notFound();
    return s;
  }
  async function own(request: Parameters<typeof actorOf>[0], id: string) {
    const s = await row(id);
    if (s.seller.customerId !== customerIdOf(actorOf(request)))
      throw ApiError.notFound();
    return s;
  }
  // Facts are reconciled only after a successful backend action, never on GET.
  app.addHook('preSerialization', async (request, reply, payload) => {
    if (
      request.method !== 'POST' ||
      reply.statusCode >= 400 ||
      !request.url.includes('/declutter/')
    )
      return payload;
    const id = (request.params as { id?: string }).id;
    if (id && /\/submissions\//.test(request.url)) {
      await reconcileHub(prisma, id);
      if (/\/price-response$/.test(request.url))
        await publishRecordedDecision(app, id, auditContext(request));
    }
    if (/\/sellers\/[^/]+\/decision/.test(request.url) && id) {
      const items = await prisma.declutterSubmission.findMany({
        where: { sellerId: id },
        select: { id: true },
      });
      for (const s of items) {
        await reconcileHub(prisma, s.id);
        await publishRecordedDecision(app, s.id, auditContext(request));
      }
    }
    await deliverHubNotifications(app);
    return payload;
  });
  let timer: ReturnType<typeof setInterval> | undefined;
  app.addHook('onReady', async () => {
    timer = setInterval(() => {
      void deliverHubNotifications(app).catch((error) =>
        app.log.warn({ error }, 'Declutters email retry failed'),
      );
    }, 30_000);
    timer.unref();
  });
  app.addHook('onClose', async () => {
    if (timer) clearInterval(timer);
  });

  app.get(
    '/v1/declutter/hub',
    { preHandler: requireAuth },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const identityId = actorOf(request).identityId;
      const seller = await prisma.declutterSeller.findUnique({
        where: { customerId: customerIdOf(actorOf(request)) },
        select: { id: true, kycStatus: true },
      });
      const rows = seller
        ? await prisma.declutterSubmission.findMany({
            where: { sellerId: seller.id },
            orderBy: { createdAt: 'desc' },
            include: hubInclude,
          })
        : [];
      const items = await Promise.all(rows.map((s) => hubView(app, s)));
      const unreadCount = await prisma.declutterMessage.count({
        where: {
          conversation: { sellerIdentityId: identityId },
          senderType: 'staff',
          readAt: null,
        },
      });
      return {
        seller: seller
          ? {
              kycStatus: seller.kycStatus,
              canSubmit: !['suspended'].includes(seller.kycStatus),
            }
          : null,
        items,
        unreadCount,
        totals: {
          total: items.filter((i) => i.status !== 'Removed').length,
          underReview: items.filter((i) =>
            ['Under Review', 'Changes under review'].includes(i.status),
          ).length,
          actionRequired: items.filter((i) => i.actions.length).length,
          approved: items.filter((i) => i.status === 'Approved').length,
          live: items.filter((i) => i.status === 'Live').length,
        },
      };
    },
  );
  app.get(
    '/v1/declutter/account/items/:id',
    { preHandler: requireAuth },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      return {
        item: await hubView(
          app,
          await own(request, idParam.parse(request.params).id),
        ),
      };
    },
  );
  app.post(
    '/v1/declutter/account/items/:id/remove',
    { preHandler: requireAuth },
    async (request) => {
      const id = idParam.parse(request.params).id;
      z.object({ confirmed: z.literal(true) })
        .strict()
        .parse(request.body);
      await own(request, id);
      await prisma.$transaction(async (tx) => {
        await tx.declutterSubmission.update({
          where: { id },
          data: { updatedAt: new Date() },
        });
        const s = await tx.declutterSubmission.findUniqueOrThrow({
          where: { id },
          include: hubInclude,
        });
        if (s.seller.customerId !== customerIdOf(actorOf(request)))
          throw ApiError.notFound();
        if (s.listing?.availability === 'sold')
          throw ApiError.conflict(
            'Sold items stay in your sales history and cannot be removed.',
          );
        if (
          s.status === 'withdrawn' &&
          (!s.listing || s.listing.availability === 'archived')
        )
          return;
        const identityId = actorOf(request).identityId;
        if (s.listing)
          await tx.declutterListing.update({
            where: { id: s.listing.id },
            data: {
              availability: 'archived',
              events: {
                create: {
                  axis: 'availability',
                  fromStatus: s.listing.availability,
                  toStatus: 'archived',
                  actorType: 'seller',
                  actorId: identityId,
                  note: 'Seller removed listing.',
                },
              },
            },
          });
        await tx.declutterSubmission.update({
          where: { id },
          data: {
            status: 'withdrawn',
            events: {
              create: {
                fromStatus: s.status,
                toStatus: 'withdrawn',
                actorType: 'seller',
                actorId: identityId,
              },
            },
          },
        });
        await tx.declutterSubmissionUpdate.updateMany({
          where: { submissionId: id, status: { in: ['draft', 'pending'] } },
          data: {
            status: 'discarded',
            activeKey: null,
            sellerMessage:
              'This item was removed; its proposed changes will not be published.',
          },
        });
        await writeAudit(tx, {
          identityId,
          action: 'declutter.submission.removed',
          resourceType: 'DeclutterSubmission',
          resourceId: id,
          after: { listingId: s.listing?.id ?? null },
          ...auditContext(request),
        });
      });
      return { ok: true, item: await hubView(app, await row(id)) };
    },
  );
  app.post(
    '/v1/admin/declutter/submissions/:id/approve-publish',
    {
      preHandler: [
        requirePermission('declutter:pricing:authorize'),
        requirePermission('declutter:listing:publish'),
      ],
    },
    async (request) => {
      const id = idParam.parse(request.params).id;
      const body = z
        .object({
          priceKobo: z
            .number()
            .int()
            .positive()
            .max(100_000_000_000)
            .optional(),
          reason: z.string().trim().max(500).optional(),
        })
        .strict()
        .parse(request.body);
      await row(id);
      const result = await prisma.$transaction(async (tx) => {
        await tx.declutterSubmission.update({
          where: { id },
          data: { updatedAt: new Date() },
        });
        let s = await tx.declutterSubmission.findUniqueOrThrow({
          where: { id },
          include: hubInclude,
        });
        if (
          s.status === 'withdrawn' ||
          ['archived', 'sold'].includes(s.listing?.availability ?? '')
        )
          throw ApiError.conflict('Removed or sold items cannot be published.');
        // A retry never changes a previously published listing or its price.
        if (s.listing) {
          if (
            s.listing.moderationStatus !== 'approved' ||
            !['available', 'reserved'].includes(s.listing.availability)
          )
            throw ApiError.conflict(
              'Use the existing listing moderation controls to review this listing.',
            );
          return {
            published: true,
            listing: s.listing,
            created: false,
            blockers: [] as string[],
          };
        }
        const identityId = actorOf(request).identityId;
        const price =
          body.priceKobo ??
          s.authorizedPriceKobo ??
          s.finalPriceKobo ??
          s.expectedPriceKobo;
        if (!price) throw ApiError.unprocessable('Enter the final DASH price.');
        const contentGaps = approvePublishBlockers(facts(s)).filter(
          (b) =>
            ![
              'seller_not_verified',
              'price_not_authorized',
              'seller_has_not_accepted',
              'acceptance_stale',
            ].includes(b),
        );
        if (contentGaps.length)
          throw ApiError.unprocessable(
            'Complete the item details before approving publication.',
            { blockers: contentGaps },
          );
        if (
          s.authorizedPriceKobo !== price ||
          ![
            'seller_acceptance_pending',
            'seller_accepted',
            'seller_declined',
          ].includes(s.valueCheckStatus)
        ) {
          await authorizeSubmissionPrice(tx, id, price, identityId);
          s = await tx.declutterSubmission.findUniqueOrThrow({
            where: { id },
            include: hubInclude,
          });
        }
        const overridden = hubBlockers(facts(s)).filter(
          (b) =>
            ![
              'seller_not_verified',
              'price_not_authorized',
              'seller_has_not_accepted',
              'acceptance_stale',
            ].includes(b),
        );
        await tx.declutterFraudFlag.updateMany({
          where: {
            submissionId: id,
            status: { in: ['open', 'reviewing', 'upheld'] },
          },
          data: {
            status: 'dismissed',
            resolvedAt: new Date(),
            resolvedBy: identityId,
            resolutionReason:
              body.reason ||
              'Super Admin final approval and publication decision.',
          },
        });
        await tx.declutterSubmission.update({
          where: { id },
          data: {
            fullyApprovedAt: new Date(),
            fullyApprovedBy: identityId,
            status: 'pricing_review',
            events: {
              create: {
                fromStatus: s.status,
                toStatus: 'final_approval',
                actorType: 'super_admin',
                actorId: identityId,
              },
            },
          },
        });
        await writeAudit(tx, {
          identityId,
          action: 'declutter.submission.approve_publish',
          resourceType: 'DeclutterSubmission',
          resourceId: id,
          after: {
            priceKobo: price,
            overridden,
            fraudFlagIds: s.fraudFlags.map((f) => f.id),
            pendingUpdatePreserved: s.updates.some(
              (u) => u.status === 'pending',
            ),
            reason: body.reason ?? null,
          },
          ...auditContext(request),
        });
        s = await tx.declutterSubmission.findUniqueOrThrow({
          where: { id },
          include: hubInclude,
        });
        const blockers = approvePublishBlockers(facts(s));
        if (blockers.length)
          return { published: false, listing: null, created: false, blockers };
        return {
          published: true,
          listing: await publishSnapshot(
            tx,
            s,
            identityId,
            'super_admin',
            true,
            auditContext(request),
          ),
          created: true,
          blockers: [] as string[],
        };
      });
      if (result.created && result.listing)
        await sendPublicationEmail(app, result.listing);
      return {
        published: result.published,
        listing: result.listing
          ? {
              id: result.listing.id,
              slug: result.listing.slug,
              priceKobo: result.listing.priceKobo,
            }
          : null,
        blockers: result.blockers.map((b) => HUB_BLOCKER_LABELS[b] ?? b),
        message: result.published
          ? 'Your item is approved and live.'
          : 'DASH approval is recorded. Publication will follow when the seller completes the required action.',
      };
    },
  );
  app.get(
    '/v1/admin/declutter/submissions/:id/workspace',
    { preHandler: requirePermission('declutter:submission:read') },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const s = await row(idParam.parse(request.params).id);
      return {
        sellerId: s.sellerId,
        item: await hubView(app, s, true),
        fraudFlags: s.fraudFlags.map((f) => ({
          id: f.id,
          kind: f.kind,
          severity: f.severity,
        })),
        pricing: {
          proposedPriceKobo: s.finalPriceKobo,
          valueCheckStatus: s.valueCheckStatus,
          escalationReasons: s.escalationReasons
            ? JSON.parse(s.escalationReasons)
            : [],
        },
      };
    },
  );
  app.post(
    '/v1/admin/declutter/submissions/:id/checks',
    { preHandler: requirePermission('declutter:pricing:decide') },
    async (request) => {
      const id = idParam.parse(request.params).id;
      const body = z
        .object({
          kind: z.enum(['safety', 'item']),
          passed: z.boolean(),
          sellerMessage: z.string().trim().min(5).max(500).optional(),
        })
        .parse(request.body);
      const s = await row(id);
      if (body.passed && body.kind === 'safety' && s.fraudFlags.length)
        throw ApiError.conflict(
          'Resolve the recorded safety flags before passing safety review.',
        );
      if (
        body.passed &&
        body.kind === 'item' &&
        (!s.title ||
          !s.description ||
          !s.photos.length ||
          !s.categoryId ||
          !s.locationId)
      )
        throw ApiError.conflict(
          'Item title, description, category, location and photos are required.',
        );
      if (!body.passed && !body.sellerMessage)
        throw ApiError.badRequest('Explain what the seller needs to provide.');
      const field =
        body.kind === 'safety' ? 'safetyReviewedAt' : 'itemReviewedAt';
      await prisma.declutterSubmission.update({
        where: { id },
        data: {
          [field]: body.passed ? new Date() : null,
          fullyApprovedAt: null,
          fullyApprovedBy: null,
          ...(!body.passed
            ? { status: 'details_pending' }
            : s.status === 'details_pending'
              ? { status: 'intake' }
              : {}),
          events: {
            create: {
              toStatus: body.passed
                ? `${body.kind}_review_passed`
                : 'details_pending',
              actorType: 'admin',
              actorId: actorOf(request).identityId,
            },
          },
        },
      });
      await writeAudit(prisma, {
        identityId: actorOf(request).identityId,
        action: `declutter.${body.kind}.reviewed`,
        resourceType: 'DeclutterSubmission',
        resourceId: id,
        after: { passed: body.passed },
        ...auditContext(request),
      });
      if (body.sellerMessage)
        await staffMessageToSeller(
          id,
          actorOf(request).identityId,
          body.sellerMessage,
        );
      return { ok: true };
    },
  );
  app.post(
    '/v1/admin/declutter/submissions/:id/fully-approve',
    {
      preHandler: [
        requirePermission('declutter:pricing:authorize'),
        requirePermission('declutter:listing:publish'),
      ],
    },
    async (request) => {
      const id = idParam.parse(request.params).id;
      await prisma.$transaction(async (tx) => {
        await tx.declutterSubmission.update({
          where: { id },
          data: { updatedAt: new Date() },
        });
        const s = await tx.declutterSubmission.findUniqueOrThrow({
          where: { id },
          include: hubInclude,
        });
        const blockers = hubBlockers(facts(s));
        if (blockers.length)
          throw ApiError.unprocessable(
            'Mandatory item checks are still outstanding.',
            { blockers },
          );
        if (!s.fullyApprovedAt) {
          await tx.declutterSubmission.update({
            where: { id },
            data: {
              fullyApprovedAt: new Date(),
              fullyApprovedBy: actorOf(request).identityId,
              status: s.listing ? 'published' : 'approved',
              events: {
                create: {
                  toStatus: 'fully_approved',
                  actorType: 'super_admin',
                  actorId: actorOf(request).identityId,
                },
              },
            },
          });
          await writeAudit(tx, {
            identityId: actorOf(request).identityId,
            action: 'declutter.fully_approved',
            resourceType: 'DeclutterSubmission',
            resourceId: id,
            ...auditContext(request),
          });
        }
      });
      return { ok: true };
    },
  );
  app.post(
    '/v1/admin/declutter/fraud-flags/:id/resolve',
    { preHandler: requirePermission('declutter:fraud:override') },
    async (request) => {
      const id = idParam.parse(request.params).id;
      const body = z
        .object({ reason: z.string().trim().min(10).max(500) })
        .parse(request.body);
      const flag = await prisma.declutterFraudFlag.findUnique({
        where: { id },
      });
      if (!flag) throw ApiError.notFound();
      await prisma.declutterFraudFlag.update({
        where: { id },
        data: {
          status: 'dismissed',
          resolvedAt: new Date(),
          resolvedBy: actorOf(request).identityId,
          resolutionReason: body.reason,
        },
      });
      await writeAudit(prisma, {
        identityId: actorOf(request).identityId,
        action: 'declutter.fraud.dismissed',
        resourceType: 'DeclutterFraudFlag',
        resourceId: id,
        after: { reason: body.reason },
        ...auditContext(request),
      });
      if (flag.submissionId) await reconcileHub(prisma, flag.submissionId);
      return { ok: true };
    },
  );

  app.post(
    '/v1/declutter/account/items/:id/updates',
    { preHandler: requireAuth },
    async (request, reply) => {
      const id = idParam.parse(request.params).id;
      const s = await own(request, id);
      const body = editInput.parse(request.body);
      if (
        s.seller.kycStatus === 'suspended' ||
        ['withdrawn', 'rejected'].includes(s.status)
      )
        throw ApiError.conflict(
          'This item is paused. Chat with DASH before editing.',
        );
      const retained = body.keepPhotoIds
        ? body.keepPhotoIds.map((photoId) => {
            const p = s.photos.find((p) => p.id === photoId);
            if (!p)
              throw ApiError.badRequest(
                'Choose photos belonging to this item.',
              );
            return p;
          })
        : s.photos;
      if (new Set(retained.map((p) => p.id)).size !== retained.length)
        throw ApiError.badRequest('Choose each photo once.');
      if (s.updates.some((u) => ['draft', 'pending'].includes(u.status)))
        throw ApiError.conflict(
          'Finish or discard your existing update first.',
        );
      const update = await prisma.declutterSubmissionUpdate.create({
        data: {
          submissionId: id,
          submittedBy: actorOf(request).identityId,
          activeKey: id,
          baseRevision: s.contentRevision,
          title: body.title,
          description: body.description,
          condition: body.condition,
          photos: {
            create: retained.map((p, position) => ({
              fingerprintId: p.fingerprintId,
              storageKey: p.storageKey,
              position,
              role: p.role,
              caption: p.caption,
            })),
          },
        },
      });
      reply.code(201);
      return { updateId: update.id };
    },
  );
  async function ownUpdate(request: Parameters<typeof actorOf>[0], id: string) {
    const u = await prisma.declutterSubmissionUpdate.findUnique({
      where: { id },
      include: { photos: { orderBy: { position: 'asc' } } },
    });
    if (!u) throw ApiError.notFound();
    await own(request, u.submissionId);
    return u;
  }
  app.post(
    '/v1/declutter/updates/:id/photos',
    { preHandler: requireAuth, bodyLimit: 12 * 1024 * 1024 },
    async (request, reply) => {
      const u = await ownUpdate(request, idParam.parse(request.params).id);
      if (u.status !== 'draft')
        throw ApiError.conflict('This update has already been submitted.');
      if (u.photos.length >= 12)
        throw ApiError.conflict('Use at most 12 photos.');
      const body = z
        .object({
          data: z
            .string()
            .min(1)
            .max(12 * 1024 * 1024),
          contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
          role: z.enum(PHOTO_ROLES).default('other'),
        })
        .parse(request.body);
      const s = await row(u.submissionId);
      const bytes = Buffer.from(body.data, 'base64');
      if (!bytes.length || bytes.length > 8 * 1024 * 1024)
        throw ApiError.badRequest('Choose an image under 8 MB.');
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const existing = await prisma.declutterImageFingerprint.findUnique({
        where: { sha256 },
      });
      if (existing?.firstSellerId && existing.firstSellerId !== s.sellerId) {
        await prisma.declutterFraudFlag.create({
          data: {
            kind: 'exact_duplicate_cross_account',
            severity: 'high',
            sellerId: s.sellerId,
            submissionId: s.id,
            fingerprintId: existing.id,
            detail: 'Duplicate detected during proposed photo update.',
          },
        });
        await prisma.declutterImageUsage.create({
          data: {
            fingerprintId: existing.id,
            sellerId: s.sellerId,
            submissionId: s.id,
            outcome: 'blocked_duplicate',
          },
        });
        throw ApiError.conflict('Upload your own photographs of the item.');
      }
      if (u.photos.some((p) => p.fingerprintId === existing?.id))
        throw ApiError.conflict('That photo is already in this update.');
      const stored = await app.services.storage
        .put({
          body: bytes,
          contentType: body.contentType,
          prefix: 'declutter-items',
        })
        .catch(() => {
          throw ApiError.badRequest(
            'Photo upload failed. Your draft is saved; please try again.',
          );
        });
      const fingerprint =
        existing ??
        (await prisma.declutterImageFingerprint.upsert({
          where: { sha256 },
          create: { sha256, firstSellerId: s.sellerId },
          update: {},
        }));
      if (fingerprint.firstSellerId && fingerprint.firstSellerId !== s.sellerId)
        throw ApiError.conflict('Upload your own photographs.');
      const photo = await prisma.$transaction(async (tx) => {
        const current = await tx.declutterSubmissionUpdate.findUniqueOrThrow({
          where: { id: u.id },
          include: { photos: true },
        });
        if (current.status !== 'draft' || current.photos.length >= 12)
          throw ApiError.conflict(
            'This update changed. Refresh and try again.',
          );
        return tx.declutterUpdatePhoto.create({
          data: {
            updateId: u.id,
            fingerprintId: fingerprint.id,
            storageKey: stored.key,
            position: current.photos.length,
            role: body.role,
          },
        });
      });
      await prisma.declutterImageUsage.create({
        data: {
          fingerprintId: fingerprint.id,
          sellerId: s.sellerId,
          submissionId: s.id,
          outcome: 'accepted',
        },
      });
      reply.code(201);
      return { photoId: photo.id };
    },
  );
  app.post(
    '/v1/declutter/updates/:id/submit',
    { preHandler: requireAuth },
    async (request) => {
      const u = await ownUpdate(request, idParam.parse(request.params).id);
      if (u.status === 'pending') return { ok: true };
      if (u.status !== 'draft' || !u.photos.length)
        throw ApiError.conflict(
          'Add at least one photo before submitting this update.',
        );
      await prisma.$transaction(async (tx) => {
        await tx.declutterSubmission.update({
          where: { id: u.submissionId },
          data: { updatedAt: new Date() },
        });
        await tx.declutterSubmissionUpdate.update({
          where: { id: u.id, status: 'draft' },
          data: { status: 'pending', submittedAt: new Date() },
        });
        await tx.declutterSubmissionEvent.create({
          data: {
            submissionId: u.submissionId,
            toStatus: 'update_submitted',
            actorType: 'seller',
            actorId: actorOf(request).identityId,
          },
        });
        await writeAudit(tx, {
          identityId: actorOf(request).identityId,
          action: 'declutter.update.submitted',
          resourceType: 'DeclutterSubmissionUpdate',
          resourceId: u.id,
          ...auditContext(request),
        });
      });
      return { ok: true };
    },
  );
  app.post(
    '/v1/declutter/updates/:id/discard',
    { preHandler: requireAuth },
    async (request) => {
      const u = await ownUpdate(request, idParam.parse(request.params).id);
      if (u.status !== 'draft')
        throw ApiError.conflict('Only unfinished drafts can be discarded.');
      await prisma.declutterSubmissionUpdate.update({
        where: { id: u.id, status: 'draft' },
        data: { status: 'discarded', activeKey: null },
      });
      return { ok: true };
    },
  );
  app.post(
    '/v1/admin/declutter/updates/:id/review',
    { preHandler: requirePermission('declutter:pricing:authorize') },
    async (request) => {
      const id = idParam.parse(request.params).id;
      const body = z
        .object({
          decision: z.enum(['approved', 'rejected', 'changes_requested']),
          sellerMessage: z.string().trim().min(5).max(500).optional(),
        })
        .parse(request.body);
      if (body.decision !== 'approved' && !body.sellerMessage)
        throw ApiError.badRequest('Explain the decision to the seller.');
      let submissionId = '';
      let reviewed = false;
      await prisma.$transaction(async (tx) => {
        const u = await tx.declutterSubmissionUpdate.findUniqueOrThrow({
          where: { id },
          include: {
            photos: { orderBy: { position: 'asc' } },
            submission: { include: hubInclude },
          },
        });
        submissionId = u.submissionId;
        if (u.status === body.decision) return;
        if (u.status !== 'pending')
          throw ApiError.conflict('This update is not awaiting review.');
        const s = u.submission;
        if (body.decision === 'approved') {
          if (s.contentRevision !== u.baseRevision)
            throw ApiError.conflict(
              'The approved item changed. Ask the seller for a fresh update.',
            );
          if (
            s.fraudFlags.length ||
            s.seller.kycStatus !== 'verified' ||
            ['rejected', 'withdrawn'].includes(s.status)
          )
            throw ApiError.conflict(
              'Resolve verification and safety blockers before approving changes.',
            );
          await tx.declutterSubmissionPhoto.deleteMany({
            where: { submissionId: s.id },
          });
          await tx.declutterSubmission.update({
            where: { id: s.id, contentRevision: u.baseRevision },
            data: {
              title: u.title,
              description: u.description,
              condition: u.condition,
              itemReviewedAt: new Date(),
              ...(s.status === 'details_pending' ? { status: 'intake' } : {}),
              contentRevision: { increment: 1 },
              photos: {
                create: u.photos.map((p) => ({
                  storageKey: p.storageKey,
                  fingerprintId: p.fingerprintId,
                  position: p.position,
                  role: p.role,
                  caption: p.caption,
                })),
              },
            },
          });
          if (s.listing) {
            await tx.declutterListingPhoto.deleteMany({
              where: { listingId: s.listing.id },
            });
            await tx.declutterListing.update({
              where: { id: s.listing.id },
              data: {
                title: u.title,
                description: u.description,
                condition: u.condition,
                revision: { increment: 1 },
                photos: {
                  create: u.photos.map((p) => ({
                    storageKey: p.storageKey,
                    fingerprintId: p.fingerprintId,
                    position: p.position,
                    role: p.role,
                    caption: p.caption,
                  })),
                },
                events: {
                  create: {
                    axis: 'moderation',
                    fromStatus: s.listing.moderationStatus,
                    toStatus: s.listing.moderationStatus,
                    actorType: 'super_admin',
                    actorId: actorOf(request).identityId,
                    note: 'Reviewed seller update applied.',
                  },
                },
              },
            });
          }
        }
        await tx.declutterSubmissionUpdate.update({
          where: { id, status: 'pending' },
          data: {
            status: body.decision,
            activeKey: null,
            reviewedAt: new Date(),
            reviewedBy: actorOf(request).identityId,
            sellerMessage:
              body.sellerMessage ?? 'Your item update was approved.',
          },
        });
        await tx.declutterSubmissionEvent.create({
          data: {
            submissionId: s.id,
            toStatus: `update_${body.decision}`,
            actorType: 'super_admin',
            actorId: actorOf(request).identityId,
          },
        });
        await writeAudit(tx, {
          identityId: actorOf(request).identityId,
          action: `declutter.update.${body.decision}`,
          resourceType: 'DeclutterSubmissionUpdate',
          resourceId: id,
          after: { submissionId: s.id },
          ...auditContext(request),
        });
        reviewed = true;
      });
      if (reviewed)
        await staffMessageToSeller(
          submissionId,
          actorOf(request).identityId,
          body.sellerMessage ?? 'Your item update was approved.',
        );
      await reconcileHub(prisma, submissionId);
      return { ok: true };
    },
  );
  app.get(
    '/v1/admin/declutter/updates',
    { preHandler: requirePermission('declutter:submission:read') },
    async () => {
      const updates = await prisma.declutterSubmissionUpdate.findMany({
        where: { status: 'pending' },
        orderBy: { submittedAt: 'asc' },
        include: {
          submission: {
            select: {
              title: true,
              code: true,
              seller: { select: { displayName: true } },
            },
          },
        },
      });
      return {
        total: await prisma.declutterSubmissionUpdate.count({
          where: { status: 'pending' },
        }),
        updates: updates.map((u) => ({
          id: u.id,
          submissionId: u.submissionId,
          title: u.submission.title,
          code: u.submission.code,
          sellerName: u.submission.seller.displayName,
          submittedAt: u.submittedAt,
        })),
      };
    },
  );
  app.post(
    '/v1/admin/declutter/submissions/:id/partner-approval',
    { preHandler: requirePermission('declutter:pricing:authorize') },
    async (request) => {
      const id = idParam.parse(request.params).id;
      const body = z
        .object({ reason: z.string().trim().min(10).max(500) })
        .parse(request.body);
      const s = await row(id);
      if (!s.partnerApprovalRequired)
        throw ApiError.conflict(
          'This item does not require source-partner approval.',
        );
      await prisma.declutterSubmission.update({
        where: { id },
        data: {
          partnerApprovedAt: new Date(),
          partnerApprovedBy: actorOf(request).identityId,
          partnerApprovalNote: body.reason,
        },
      });
      await writeAudit(prisma, {
        identityId: actorOf(request).identityId,
        action: 'declutter.partner_approval.recorded',
        resourceType: 'DeclutterSubmission',
        resourceId: id,
        ...auditContext(request),
      });
      return { ok: true };
    },
  );

  async function conversation(
    request: Parameters<typeof actorOf>[0],
    id: string,
    staff: boolean,
  ) {
    const c = await prisma.declutterConversation.findUnique({
      where: { id },
      include: { submission: true },
    });
    if (!c || (!staff && c.sellerIdentityId !== actorOf(request).identityId))
      throw ApiError.notFound();
    return c;
  }
  app.post(
    '/v1/declutter/conversations',
    { preHandler: requireAuth },
    async (request, reply) => {
      const body = z
        .object({ submissionId: z.string().optional() })
        .strict()
        .parse(request.body);
      if (body.submissionId) await own(request, body.submissionId);
      const identityId = actorOf(request).identityId;
      const scopeKey = `${identityId}:${body.submissionId ?? 'support'}`;
      const c = await prisma.declutterConversation.upsert({
        where: { scopeKey },
        create: {
          scopeKey,
          sellerIdentityId: identityId,
          submissionId: body.submissionId ?? null,
        },
        update: {},
      });
      reply.code(201);
      return { conversationId: c.id };
    },
  );
  async function listConversations(identityId?: string) {
    const cs = await prisma.declutterConversation.findMany({
      where: identityId ? { sellerIdentityId: identityId } : {},
      orderBy: { updatedAt: 'desc' },
      include: {
        seller: { select: { displayName: true } },
        submission: { include: hubInclude },
        messages: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
    });
    return Promise.all(
      cs.map(async (c) => ({
        id: c.id,
        status: c.status,
        kind: c.scopeKey.includes(':contact:')
          ? 'buyer_enquiry'
          : c.submissionId
            ? 'seller_support'
            : 'account_support',
        sellerName: c.seller.displayName,
        submissionId: c.submissionId,
        title: c.submission?.title ?? 'Account support',
        code: c.submission?.code ?? null,
        workflowStatus: c.submission
          ? (await hubView(app, c.submission)).status
          : 'Support',
        priceState: c.submission?.valueCheckStatus ?? null,
        lastMessage: c.messages[0]?.body.slice(0, 120) ?? null,
        updatedAt: c.updatedAt,
        unreadCount: await prisma.declutterMessage.count({
          where: {
            conversationId: c.id,
            senderType: identityId ? 'staff' : { in: ['seller', 'buyer'] },
            readAt: null,
          },
        }),
      })),
    );
  }
  app.get(
    '/v1/declutter/conversations',
    { preHandler: requireAuth },
    async (request) => ({
      conversations: await listConversations(actorOf(request).identityId),
    }),
  );
  app.get(
    '/v1/admin/declutter/conversations',
    { preHandler: requirePermission('declutter:submission:read') },
    async () => ({ conversations: await listConversations() }),
  );
  app.post(
    '/v1/admin/declutter/conversations',
    { preHandler: requirePermission('declutter:submission:write') },
    async (request, reply) => {
      const body = z
        .object({ submissionId: z.string() })
        .strict()
        .parse(request.body);
      const s = await row(body.submissionId);
      const identityId = s.seller.customer?.identityId;
      if (!identityId)
        throw ApiError.conflict('This seller has not linked an account.');
      const scopeKey = `${identityId}:${s.id}`;
      const c = await prisma.declutterConversation.upsert({
        where: { scopeKey },
        create: { scopeKey, sellerIdentityId: identityId, submissionId: s.id },
        update: {},
      });
      reply.code(201);
      return { conversationId: c.id };
    },
  );
  app.get(
    '/v1/declutter/unread-count',
    { preHandler: requireAuth },
    async (request) => ({
      unreadCount: await prisma.declutterMessage.count({
        where: {
          conversation: { sellerIdentityId: actorOf(request).identityId },
          senderType: 'staff',
          readAt: null,
        },
      }),
    }),
  );
  app.get(
    '/v1/admin/declutter/unread-count',
    { preHandler: requirePermission('declutter:submission:read') },
    async () => ({
      unreadCount: await prisma.declutterMessage.count({
        where: { senderType: { in: ['seller', 'buyer'] }, readAt: null },
      }),
    }),
  );
  async function staffMessageToSeller(
    submissionId: string,
    staffId: string,
    body: string,
  ) {
    const s = await row(submissionId);
    if (!s.seller.customer?.identityId) return;
    const identityId = s.seller.customer.identityId;
    const scopeKey = `${identityId}:${submissionId}`;
    const c = await prisma.declutterConversation.upsert({
      where: { scopeKey },
      create: { scopeKey, sellerIdentityId: identityId, submissionId },
      update: { status: 'open' },
    });
    const m = await prisma.declutterMessage.create({
      data: {
        conversationId: c.id,
        senderIdentityId: staffId,
        senderType: 'staff',
        clientMessageId: createHash('sha256')
          .update(`${Date.now()}:${body}`)
          .digest('hex'),
        body,
      },
    });
    await queueMessage(c, m.id);
  }
  async function queueMessage(
    c: {
      id: string;
      sellerIdentityId: string;
      submissionId: string | null;
      sellerViewedAt: Date | null;
    },
    messageId: string,
    client: Prisma.TransactionClient = prisma,
  ) {
    if (c.sellerViewedAt && Date.now() - c.sellerViewedAt.getTime() < 35_000)
      return;
    const eventKey = `message:${messageId}`;
    await client.declutterHubNotification.upsert({
      where: { eventKey },
      create: {
        eventKey,
        kind: 'message',
        messageId,
        submissionId: c.submissionId,
        recipientIdentityId: c.sellerIdentityId,
      },
      update: {},
    });
  }
  for (const staff of [false, true]) {
    const prefix = staff ? '/v1/admin/declutter' : '/v1/declutter';
    const readGuard = staff
      ? requirePermission('declutter:submission:read')
      : requireAuth;
    const writeGuard = staff
      ? requirePermission('declutter:submission:write')
      : requireAuth;
    app.get(
      `${prefix}/conversations/:id`,
      { preHandler: readGuard },
      async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        const c = await conversation(
          request,
          idParam.parse(request.params).id,
          staff,
        );
        const query = z
          .object({ before: z.string().max(60).optional() })
          .parse(request.query);
        if (
          query.before &&
          !(await prisma.declutterMessage.findFirst({
            where: { id: query.before, conversationId: c.id },
          }))
        )
          throw ApiError.notFound();
        const batch = await prisma.declutterMessage.findMany({
          where: { conversationId: c.id },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 101,
          ...(query.before ? { cursor: { id: query.before }, skip: 1 } : {}),
          select: {
            id: true,
            body: true,
            senderType: true,
            createdAt: true,
            readAt: true,
          },
        });
        return {
          conversation: {
            id: c.id,
            status: c.status,
            submissionId: c.submissionId,
          },
          messages: batch.slice(0, 100).reverse(),
          nextCursor: batch.length > 100 ? batch[99]!.id : null,
        };
      },
    );
    app.post(
      `${prefix}/conversations/:id/read`,
      { preHandler: readGuard },
      async (request) => {
        const c = await conversation(
          request,
          idParam.parse(request.params).id,
          staff,
        );
        const cutoff = new Date();
        await prisma.$transaction(async (tx) => {
          await tx.declutterMessage.updateMany({
            where: {
              conversationId: c.id,
              senderType: staff ? { in: ['seller', 'buyer'] } : 'staff',
              readAt: null,
              createdAt: { lte: cutoff },
            },
            data: { readAt: cutoff },
          });
          if (!staff)
            await tx.declutterConversation.update({
              where: { id: c.id },
              data: { sellerViewedAt: cutoff },
            });
        });
        return { ok: true };
      },
    );
    app.post(
      `${prefix}/conversations/:id/messages`,
      { preHandler: writeGuard },
      async (request) => {
        const c = await conversation(
          request,
          idParam.parse(request.params).id,
          staff,
        );
        const body = z
          .object({
            body: z.string().trim().min(1).max(4000),
            clientMessageId: z.string().min(8).max(100),
          })
          .strict()
          .parse(request.body);
        const senderIdentityId = actorOf(request).identityId;
        const m = await prisma
          .$transaction(async (tx) => {
            const existing = await tx.declutterMessage.findUnique({
              where: {
                conversationId_senderIdentityId_clientMessageId: {
                  conversationId: c.id,
                  senderIdentityId,
                  clientMessageId: body.clientMessageId,
                },
              },
            });
            if (existing) {
              if (existing.body !== body.body)
                throw ApiError.conflict(
                  'That retry key belongs to a different message.',
                );
              return existing;
            }
            await tx.declutterConversation.update({
              where: { id: c.id },
              data: { status: 'open', updatedAt: new Date() },
            });
            const message = await tx.declutterMessage.create({
              data: {
                conversationId: c.id,
                senderIdentityId,
                senderType: staff ? 'staff' : c.scopeKey.includes(':contact:') ? 'buyer' : 'seller',
                clientMessageId: body.clientMessageId,
                body: body.body,
              },
            });
            await writeAudit(tx, {
              identityId: senderIdentityId,
              action: 'declutter.message.sent',
              resourceType: 'DeclutterConversation',
              resourceId: c.id,
              after: { messageId: message.id, senderType: message.senderType },
              ...auditContext(request),
            });
            if (staff) await queueMessage(c, message.id, tx);
            return message;
          })
          .catch(async (error: unknown) => {
            if ((error as { code?: string }).code !== 'P2002') throw error;
            const winner = await prisma.declutterMessage.findUnique({
              where: {
                conversationId_senderIdentityId_clientMessageId: {
                  conversationId: c.id,
                  senderIdentityId,
                  clientMessageId: body.clientMessageId,
                },
              },
            });
            if (!winner) throw error;
            if (winner.body !== body.body)
              throw ApiError.conflict(
                'That retry key belongs to a different message.',
              );
            return winner;
          });
        if (staff) {
          await queueMessage(c, m.id);
        } else {
          // Customer messages always alert both Declutters mailboxes. The
          // durable email wrapper deduplicates request retries by message ID.
          try {
            const sender = await prisma.identity.findUnique({
              where: { id: senderIdentityId },
              select: { displayName: true },
            });
            const result = await notifyDeclutterAdminMessage(prisma, email, {
              messageId: m.id,
              senderName: sender?.displayName,
              listingTitle: c.submission?.title ?? null,
              listingCode: c.submission?.code ?? null,
              message: m.body,
              publicWebUrl: config.PUBLIC_WEB_URL,
              contactRequest: c.scopeKey.includes(':contact:'),
            });
            if (result.failed) {
              app.log.warn(
                { messageId: m.id, failed: result.failed },
                'Declutters admin message alert delivery failed',
              );
            }
          } catch (error) {
            // The saved message remains available in the inbox; an email
            // provider issue must not turn a successful send into a lost chat.
            app.log.warn(
              { error, messageId: m.id },
              'Declutters admin message alert delivery failed',
            );
          }
        }
        return { messageId: m.id };
      },
    );
  }
  app.post(
    '/v1/admin/declutter/conversations/:id/status',
    { preHandler: requirePermission('declutter:submission:write') },
    async (request) => {
      const c = await conversation(
        request,
        idParam.parse(request.params).id,
        true,
      );
      const body = z
        .object({ status: z.enum(['open', 'resolved']) })
        .parse(request.body);
      await prisma.declutterConversation.update({
        where: { id: c.id },
        data: { status: body.status },
      });
      await writeAudit(prisma, {
        identityId: actorOf(request).identityId,
        action: `declutter.conversation.${body.status}`,
        resourceType: 'DeclutterConversation',
        resourceId: c.id,
        ...auditContext(request),
      });
      return { ok: true };
    },
  );
}
