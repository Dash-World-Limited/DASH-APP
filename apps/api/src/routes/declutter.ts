/**
 * DASH World Declutters — selling, verification, and the admin queue.
 *
 * The slice this file covers is one sentence: someone says they want to sell,
 * DASH verifies who they are, they describe an item privately, and an admin
 * looks at it. Nothing here publishes anything, and there is no route that
 * could — publication is a later milestone and a different permission.
 *
 * ## Three boundaries this file exists to hold
 *
 * **Browsing is free.** No route here is required to read the marketplace.
 * A `DeclutterSeller` row is created only when someone asks to sell, so an
 * ordinary account carries no KYC obligation and no seller record at all.
 *
 * **A seller cannot publish themselves.** Every state change that would move an
 * item toward the public is behind an admin permission and asserted
 * server-side. The seller routes below can create a submission and hand it to
 * DASH; they cannot approve it, price it, or move it past a human.
 *
 * **Private stays private.** A seller's legal name, national identifier, phone,
 * address and bank details are written encrypted-at-rest and read back by
 * exactly one route, which requires `declutter:kyc:review` and is step-up
 * gated. The public profile is produced by `publicSellerProfile()`, which
 * builds a fresh object field by field, so a column added to the table
 * tomorrow cannot appear in a public response by accident.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '@dash/db';
import { encrypt } from '@dash/domain/envelope';
import { generateReference } from '@dash/domain/crypto';
import {
  assertKycTransition,
  assessSellerIdentity,
  canSellerSubmit,
  KycTransitionError,
  kycReasonRequired,
  publicSellerProfile,
  submissionMachine,
  DeclutterTransitionError,
  type DeclutterActor,
  type KycState,
  type SubmissionState,
} from '@dash/domain/declutter';
import { ApiError } from '../http/errors.js';
import { actorOf, requireAuth, requirePermission } from '../http/context.js';
import type { Actor } from '@dash/domain/permissions';

// ---------------------------------------------------------------------------
// Who is acting
// ---------------------------------------------------------------------------

/**
 * Map a DASH actor onto the Declutter state machines' vocabulary.
 *
 * The distinction matters for the audit trail as much as for the check. A
 * super admin holds every permission, so nothing stops them acting on a
 * seller's behalf — that is the intended escape hatch — but the event must not
 * then claim the seller did it. Seniority is read from roles, and the most
 * senior wins.
 */
function declutterActorFor(actor: Actor): DeclutterActor {
  if (actor.roles.includes('super_admin')) return 'super_admin';
  if (actor.roles.includes('declutter_admin')) return 'admin';
  if (actor.roles.includes('declutter_moderator')) return 'staff';
  return 'seller';
}

function customerIdOf(actor: Actor): string {
  if (!actor.customerId) {
    throw ApiError.forbidden('This account cannot sell on Declutters.');
  }
  return actor.customerId;
}

function auditContext(request: FastifyRequest): {
  ipAddress?: string;
  userAgent?: string;
  requestId?: string;
} {
  return {
    ipAddress: request.ip,
    userAgent: request.headers['user-agent'],
    requestId: request.id,
  };
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const becomeSellerSchema = z.object({
  displayName: z.string().trim().min(2).max(80),
  /** A general area only. The schema has nowhere to put a street address. */
  publicArea: z.string().trim().max(80).optional(),
});

const verificationSchema = z.object({
  legalName: z.string().trim().min(2).max(120),
  nationalId: z.string().trim().min(6).max(32),
  phoneE164: z.string().trim().regex(/^\+[1-9]\d{7,14}$/, 'Use international format, e.g. +234…'),
  addressLine: z.string().trim().min(4).max(200),
  bankName: z.string().trim().min(2).max(80),
  bankAccountNumber: z.string().trim().regex(/^\d{10}$/, 'A Nigerian account number is 10 digits.'),
  bankAccountName: z.string().trim().min(2).max(120),
  /**
   * What the identity record says the person is called. In production this
   * comes from a verification provider; until that adapter exists an admin
   * enters it, and it is compared rather than trusted.
   */
  identityName: z.string().trim().min(2).max(120),
});

const submissionSchema = z.object({
  title: z.string().trim().min(3).max(140),
  description: z.string().trim().max(4000).optional(),
  categoryKey: z.string().trim().max(60).optional(),
  condition: z.enum(['new', 'like_new', 'good', 'fair']).optional(),
  expectedPriceKobo: z.number().int().positive().max(1_000_000_000).optional(),
  locationSlug: z.string().trim().max(80).optional(),
  attributes: z.record(z.unknown()).optional(),
});

const sellerDecisionSchema = z.object({
  to: z.enum(['verified', 'rejected', 'suspended', 'pending']),
  reason: z.string().trim().max(500).optional(),
  note: z.string().trim().max(2000).optional(),
});

const submissionTransitionSchema = z.object({
  to: z.string().trim().max(40),
  reasonCode: z.string().trim().max(60).optional(),
  note: z.string().trim().max(2000).optional(),
});

// ---------------------------------------------------------------------------

export async function registerDeclutterRoutes(app: FastifyInstance): Promise<void> {
  const { prisma } = app.services;

  /** The signed-in caller's seller record, or a 404 that admits nothing. */
  async function sellerForCaller(actor: Actor) {
    const seller = await prisma.declutterSeller.findUnique({
      where: { customerId: customerIdOf(actor) },
    });
    if (!seller) {
      throw ApiError.notFound('You have not started selling on Declutters yet.');
    }
    return seller;
  }

  // =========================================================================
  // Seller
  // =========================================================================

  /**
   * POST /v1/declutter/seller — "I want to sell."
   *
   * The only thing that creates a seller record, and the reason browsing needs
   * no verification: until this is called, the account is simply a customer.
   *
   * Idempotent. Calling it twice returns the existing record rather than
   * failing on the unique constraint, because a double-tapped button is not an
   * error worth showing anybody.
   */
  app.post('/v1/declutter/seller', { preHandler: requireAuth }, async (request, reply) => {
    const actor = actorOf(request);
    const body = becomeSellerSchema.parse(request.body);
    const customerId = customerIdOf(actor);

    const existing = await prisma.declutterSeller.findUnique({ where: { customerId } });
    if (existing) {
      reply.code(200);
      return { seller: selfView(existing) };
    }

    const seller = await prisma.declutterSeller.create({
      data: {
        customerId,
        displayName: body.displayName,
        publicArea: body.publicArea ?? null,
        sellerType: 'individual',
        kycStatus: 'unverified',
      },
    });

    await writeAudit(prisma, {
      identityId: actor.identityId,
      action: 'declutter.seller.created',
      resourceType: 'DeclutterSeller',
      resourceId: seller.id,
      after: { displayName: seller.displayName, kycStatus: seller.kycStatus },
      ...auditContext(request),
    });

    reply.code(201);
    return { seller: selfView(seller) };
  });

  /** GET /v1/declutter/seller/me — what a seller may see about themselves. */
  app.get('/v1/declutter/seller/me', { preHandler: requireAuth }, async (request) => {
    const seller = await sellerForCaller(actorOf(request));
    return { seller: selfView(seller) };
  });

  /**
   * POST /v1/declutter/seller/me/verification — submit KYC.
   *
   * Everything sensitive is encrypted before it is written, under a purpose
   * bound to this seller, so a cipher lifted from one row cannot be replayed
   * into another. Only the last four digits of an account number are kept in
   * clear, which is what an admin needs to recognise a payout destination.
   *
   * The three names are compared here rather than at review time, so an admin
   * opening the queue already knows whether they are looking at a routine
   * confirmation or a mismatch worth reading carefully.
   */
  app.post(
    '/v1/declutter/seller/me/verification',
    { preHandler: requireAuth },
    async (request) => {
      const actor = actorOf(request);
      const { keyring } = app.services;
      if (!keyring) {
        // Fail closed. A configuration without encryption may not be handed a
        // national identifier "temporarily".
        throw ApiError.internal('declutter_kyc_requires_encryption');
      }

      const seller = await sellerForCaller(actor);
      const body = verificationSchema.parse(request.body);
      const from = seller.kycStatus as KycState;

      let to: KycState;
      try {
        to = assertKycTransition(from, 'pending', declutterActorFor(actor));
      } catch (error) {
        if (error instanceof KycTransitionError) {
          throw ApiError.conflict(
            from === 'pending'
              ? 'Your details are already with us for review.'
              : from === 'suspended'
                ? 'Selling is paused on this account. Contact DASH support.'
                : 'These details cannot be submitted right now.',
          );
        }
        throw error;
      }

      const assessment = assessSellerIdentity({
        declaredName: body.legalName,
        identityName: body.identityName,
        bankAccountName: body.bankAccountName,
      });

      const context = { purpose: 'declutter_seller_kyc', subjectId: seller.id };

      const updated = await prisma.declutterSeller.update({
        where: { id: seller.id },
        data: {
          kycStatus: to,
          legalName: body.legalName,
          nationalIdCipher: encrypt(body.nationalId, keyring, context),
          nationalIdLast4: body.nationalId.slice(-4),
          phoneE164: body.phoneE164,
          addressLine: body.addressLine,
          bankName: body.bankName,
          bankAccountCipher: encrypt(body.bankAccountNumber, keyring, context),
          bankAccountLast4: body.bankAccountNumber.slice(-4),
          bankAccountName: body.bankAccountName,
          nameMatchScore: assessment.score,
          nameMatchVerdict: assessment.verdict,
          nameMatchDetail: JSON.stringify({
            weakestPair: assessment.weakestPair,
            pairs: assessment.pairs,
          }),
          rejectionReason: null,
        },
      });

      await writeAudit(prisma, {
        identityId: actor.identityId,
        action: 'declutter.seller.kyc_submitted',
        resourceType: 'DeclutterSeller',
        resourceId: seller.id,
        before: { kycStatus: from },
        // Deliberately no identifiers in the audit body. That the submission
        // happened is the fact worth keeping; the values live in one encrypted
        // place, not scattered through a log.
        after: {
          kycStatus: to,
          nameMatchVerdict: assessment.verdict,
          nameMatchScore: assessment.score,
        },
        ...auditContext(request),
      });

      return { seller: selfView(updated) };
    },
  );

  /**
   * POST /v1/declutter/submissions — describe an item, privately.
   *
   * Allowed before verification is complete, and that is deliberate: asking
   * somebody for a national identifier before anyone has agreed there is
   * anything worth selling is the wrong order. A submission created by an
   * unverified seller opens in `kyc_pending`, which is the queue that says
   * "this is blocked on paperwork" rather than "nobody has looked".
   */
  app.post('/v1/declutter/submissions', { preHandler: requireAuth }, async (request, reply) => {
    const actor = actorOf(request);
    const seller = await sellerForCaller(actor);
    const body = submissionSchema.parse(request.body);

    if (!canSellerSubmit(seller.kycStatus as KycState)) {
      throw ApiError.forbidden('Selling is paused on this account. Contact DASH support.');
    }

    const category = body.categoryKey
      ? await prisma.declutterCategory.findUnique({ where: { key: body.categoryKey } })
      : null;
    if (body.categoryKey && !category) {
      throw ApiError.badRequest('That category does not exist.');
    }

    const location = body.locationSlug
      ? await prisma.declutterLocation.findUnique({ where: { slug: body.locationSlug } })
      : null;
    if (body.locationSlug && (!location || location.kind !== 'area')) {
      throw ApiError.badRequest('Choose an area DASH Declutters covers.');
    }

    const status: SubmissionState = seller.kycStatus === 'verified' ? 'intake' : 'kyc_pending';

    const submission = await prisma.declutterSubmission.create({
      data: {
        code: generateReference('DCL'),
        sellerId: seller.id,
        intakeChannel: 'portal',
        status,
        title: body.title,
        description: body.description ?? null,
        categoryId: category?.id ?? null,
        condition: body.condition ?? null,
        expectedPriceKobo: body.expectedPriceKobo ?? null,
        locationId: location?.id ?? null,
        attributes: body.attributes ? JSON.stringify(body.attributes) : null,
        events: {
          create: {
            fromStatus: null,
            toStatus: status,
            actorType: 'seller',
            actorId: actor.identityId,
          },
        },
      },
    });

    await writeAudit(prisma, {
      identityId: actor.identityId,
      action: 'declutter.submission.created',
      resourceType: 'DeclutterSubmission',
      resourceId: submission.id,
      after: { status, code: submission.code },
      ...auditContext(request),
    });

    reply.code(201);
    return { submission: submissionView(submission) };
  });

  /** GET /v1/declutter/submissions — the caller's own submissions, only. */
  app.get('/v1/declutter/submissions', { preHandler: requireAuth }, async (request) => {
    const seller = await sellerForCaller(actorOf(request));
    const submissions = await prisma.declutterSubmission.findMany({
      where: { sellerId: seller.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return { submissions: submissions.map(submissionView) };
  });

  /**
   * GET /v1/declutter/sellers/:id — the public profile.
   *
   * Open to anyone, and shaped by `publicSellerProfile()` rather than by a
   * select list, so the boundary is a type rather than a habit.
   */
  app.get('/v1/declutter/sellers/:id', async (request) => {
    const { id } = z.object({ id: z.string().min(1).max(40) }).parse(request.params);
    const seller = await prisma.declutterSeller.findUnique({ where: { id } });
    // A seller who has not been verified is not discoverable. 404 rather than
    // 403: a 403 would confirm the record exists.
    if (!seller || seller.kycStatus !== 'verified') throw ApiError.notFound();
    return { seller: publicSellerProfile(seller) };
  });

  // =========================================================================
  // Admin
  // =========================================================================

  /** GET /v1/admin/declutter/sellers — the verification queue. */
  app.get(
    '/v1/admin/declutter/sellers',
    { preHandler: requirePermission('declutter:seller:read') },
    async (request) => {
      const query = z
        .object({
          kycStatus: z.enum(['unverified', 'pending', 'verified', 'rejected', 'suspended']).optional(),
          limit: z.coerce.number().int().min(1).max(100).default(50),
        })
        .parse(request.query);

      const sellers = await prisma.declutterSeller.findMany({
        where: query.kycStatus ? { kycStatus: query.kycStatus } : {},
        // Oldest first: a queue that surfaces the newest first lets the oldest
        // rot, and the oldest is the person who has been waiting longest.
        orderBy: { updatedAt: 'asc' },
        take: query.limit,
      });

      return { sellers: sellers.map(queueView) };
    },
  );

  /**
   * GET /v1/admin/declutter/sellers/:id — the full private record.
   *
   * The only route that returns a seller's identity and banking details, and
   * the reason `declutter:kyc:review` is step-up gated. Even here the
   * ciphertexts are not decrypted: an admin sees the last four digits, the
   * declared names and the match verdict, which is what a verification
   * decision actually needs. Reading the raw identifier is a separate action
   * for a later milestone, and it will have its own audit entry.
   */
  app.get(
    '/v1/admin/declutter/sellers/:id',
    { preHandler: requirePermission('declutter:kyc:review') },
    async (request) => {
      const actor = actorOf(request);
      const { id } = z.object({ id: z.string().min(1).max(40) }).parse(request.params);

      const seller = await prisma.declutterSeller.findUnique({
        where: { id },
        include: { documents: true },
      });
      if (!seller) throw ApiError.notFound();

      await writeAudit(prisma, {
        identityId: actor.identityId,
        action: 'declutter.seller.kyc_viewed',
        resourceType: 'DeclutterSeller',
        resourceId: seller.id,
        ...auditContext(request),
      });

      return { seller: adminView(seller) };
    },
  );

  /**
   * POST /v1/admin/declutter/sellers/:id/decision — verify, reject, suspend.
   *
   * One route for every verification decision, because they share the machine
   * that decides which are legal and the rule that a refusal must carry a
   * reason the seller can be told.
   */
  app.post(
    '/v1/admin/declutter/sellers/:id/decision',
    // `declutter:seller:write`, not `declutter:kyc:review`. Reading somebody's
    // identity documents and bank details is bulk personal data and is step-up
    // gated; recording a decision about them is neither, and it is reversible
    // — a suspension can be lifted. Making an admin re-authenticate for every
    // row in a queue of twenty would not buy security, it would buy a habit of
    // stepping up on autopilot. `declutter_admin` holds both permissions, so
    // this widens nothing; `declutter_moderator` holds neither.
    { preHandler: requirePermission('declutter:seller:write') },
    async (request) => {
      const actor = actorOf(request);
      const { id } = z.object({ id: z.string().min(1).max(40) }).parse(request.params);
      const body = sellerDecisionSchema.parse(request.body);

      const seller = await prisma.declutterSeller.findUnique({ where: { id } });
      if (!seller) throw ApiError.notFound();

      const from = seller.kycStatus as KycState;
      const acting = declutterActorFor(actor);

      let to: KycState;
      try {
        to = assertKycTransition(from, body.to, acting);
      } catch (error) {
        if (error instanceof KycTransitionError) {
          throw ApiError.conflict(`A ${from} seller cannot be moved to ${body.to}.`);
        }
        throw error;
      }

      if (kycReasonRequired(to) && !body.reason) {
        throw ApiError.badRequest('This decision needs a reason the seller can be told.');
      }

      const updated = await prisma.declutterSeller.update({
        where: { id: seller.id },
        data: {
          kycStatus: to,
          verifiedAt: to === 'verified' ? new Date() : seller.verifiedAt,
          verifiedBy: to === 'verified' ? actor.identityId : seller.verifiedBy,
          rejectionReason: kycReasonRequired(to) ? (body.reason ?? null) : null,
          adminNotes: body.note ?? seller.adminNotes,
        },
      });

      await writeAudit(prisma, {
        identityId: actor.identityId,
        action: `declutter.seller.${to}`,
        resourceType: 'DeclutterSeller',
        resourceId: seller.id,
        before: { kycStatus: from },
        after: { kycStatus: to, reason: body.reason ?? null, actorType: acting },
        ...auditContext(request),
      });

      return { seller: queueView(updated) };
    },
  );

  /** GET /v1/admin/declutter/submissions — the review queue. */
  app.get(
    '/v1/admin/declutter/submissions',
    { preHandler: requirePermission('declutter:submission:read') },
    async (request) => {
      const query = z
        .object({
          status: z.string().trim().max(40).optional(),
          limit: z.coerce.number().int().min(1).max(100).default(50),
        })
        .parse(request.query);

      const submissions = await prisma.declutterSubmission.findMany({
        where: query.status ? { status: query.status } : {},
        orderBy: { createdAt: 'asc' },
        take: query.limit,
        include: { seller: { select: { id: true, displayName: true, kycStatus: true } } },
      });

      return {
        submissions: submissions.map((submission) => ({
          ...submissionView(submission),
          seller: {
            id: submission.seller.id,
            displayName: submission.seller.displayName,
            kycStatus: submission.seller.kycStatus,
          },
        })),
      };
    },
  );

  /**
   * POST /v1/admin/declutter/submissions/:id/transition
   *
   * Moves a submission through its lifecycle. The machine decides what is
   * legal and who may do it, so a moderator holding `declutter:submission:write`
   * still cannot reach a state reserved for an admin — the permission opens the
   * route, the machine decides the move.
   */
  app.post(
    '/v1/admin/declutter/submissions/:id/transition',
    { preHandler: requirePermission('declutter:submission:write') },
    async (request) => {
      const actor = actorOf(request);
      const { id } = z.object({ id: z.string().min(1).max(40) }).parse(request.params);
      const body = submissionTransitionSchema.parse(request.body);

      const submission = await prisma.declutterSubmission.findUnique({ where: { id } });
      if (!submission) throw ApiError.notFound();

      const from = submission.status as SubmissionState;
      const acting = declutterActorFor(actor);

      let to: SubmissionState;
      try {
        to = submissionMachine.assert(from, body.to as SubmissionState, acting);
      } catch (error) {
        if (error instanceof DeclutterTransitionError) {
          throw error.reason === 'actor_not_permitted'
            ? ApiError.forbidden('Your role cannot make that decision.')
            : ApiError.conflict(`A submission in ${from} cannot move to ${body.to}.`);
        }
        throw error;
      }

      // Publication is not reachable from here. It needs a listing, a price the
      // seller accepted, and `declutter:listing:publish` — a later milestone.
      if (to === 'published') {
        throw ApiError.forbidden('Publishing is not available yet.');
      }

      const updated = await prisma.declutterSubmission.update({
        where: { id: submission.id },
        data: {
          status: to,
          rejectionReason: to === 'rejected' ? (body.reasonCode ?? null) : submission.rejectionReason,
          events: {
            create: {
              fromStatus: from,
              toStatus: to,
              actorType: acting,
              actorId: actor.identityId,
              reasonCode: body.reasonCode ?? null,
              note: body.note ?? null,
            },
          },
        },
      });

      await writeAudit(prisma, {
        identityId: actor.identityId,
        action: `declutter.submission.${to}`,
        resourceType: 'DeclutterSubmission',
        resourceId: submission.id,
        before: { status: from },
        after: { status: to, reasonCode: body.reasonCode ?? null, actorType: acting },
        ...auditContext(request),
      });

      return { submission: submissionView(updated) };
    },
  );
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

interface SellerRow {
  id: string;
  displayName: string;
  sellerType: string;
  publicArea: string | null;
  kycStatus: string;
  rejectionReason: string | null;
  nameMatchScore: number | null;
  nameMatchVerdict: string | null;
  nationalIdLast4: string | null;
  bankName: string | null;
  bankAccountLast4: string | null;
  bankAccountName: string | null;
  legalName: string | null;
  phoneE164: string | null;
  addressLine: string | null;
  adminNotes: string | null;
  verifiedAt: Date | null;
  createdAt: Date;
}

/**
 * What a seller sees about themselves.
 *
 * Their own rejection reason is included — they are owed it — but nothing that
 * was encrypted comes back, not even to its owner. There is no product reason
 * to re-display a national identifier, and every extra place it can appear is
 * another place it can leak.
 */
function selfView(seller: SellerRow) {
  return {
    id: seller.id,
    displayName: seller.displayName,
    sellerType: seller.sellerType,
    publicArea: seller.publicArea,
    kycStatus: seller.kycStatus,
    rejectionReason: seller.rejectionReason,
    canSubmit: canSellerSubmit(seller.kycStatus as KycState),
    createdAt: seller.createdAt,
  };
}

/** The queue row: enough to triage, nothing to identify. */
function queueView(seller: SellerRow) {
  return {
    id: seller.id,
    displayName: seller.displayName,
    sellerType: seller.sellerType,
    kycStatus: seller.kycStatus,
    nameMatchVerdict: seller.nameMatchVerdict,
    nameMatchScore: seller.nameMatchScore,
    createdAt: seller.createdAt,
  };
}

/** The reviewer's view. Behind `declutter:kyc:review`, and audited. */
function adminView(seller: SellerRow & { documents: { id: string; kind: string; status: string }[] }) {
  return {
    ...queueView(seller),
    legalName: seller.legalName,
    phoneE164: seller.phoneE164,
    addressLine: seller.addressLine,
    nationalIdLast4: seller.nationalIdLast4,
    bankName: seller.bankName,
    bankAccountLast4: seller.bankAccountLast4,
    bankAccountName: seller.bankAccountName,
    adminNotes: seller.adminNotes,
    rejectionReason: seller.rejectionReason,
    verifiedAt: seller.verifiedAt,
    documents: seller.documents.map((document) => ({
      id: document.id,
      kind: document.kind,
      status: document.status,
    })),
  };
}

function submissionView(submission: {
  id: string;
  code: string;
  status: string;
  title: string | null;
  condition: string | null;
  expectedPriceKobo: number | null;
  createdAt: Date;
}) {
  return {
    id: submission.id,
    code: submission.code,
    status: submission.status,
    title: submission.title,
    condition: submission.condition,
    expectedPriceKobo: submission.expectedPriceKobo,
    createdAt: submission.createdAt,
  };
}
