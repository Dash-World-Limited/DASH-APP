/**
 * Declutters' use of DASH ValueCheck.
 *
 * The marketplace side of the boundary. ValueCheck itself lives in
 * `routes/valuecheck.ts` and knows nothing about any of this; here is where a
 * submission becomes a valuation request, a valuation becomes a proposal, a
 * proposal becomes an authorised price, and a seller answers it.
 *
 * ## The authority chain, and where it is enforced
 *
 * AI recommends. An admin reviews. A super admin approves when policy demands
 * it. The seller accepts that exact price. Each step is a separate route with
 * its own permission, and the transition table in `@dash/domain/valuecheck`
 * refuses anything else — so "the model set the price" is not a bug that could
 * happen here, it is a state the machine has no edge for.
 *
 * ## What reaches a provider
 *
 * A `ValuationRequest` and nothing else. It describes an item and has no field
 * for a person, so no name, identifier, phone, address, bank detail, admin note
 * or KYC document can travel with it — not because this file filters them out,
 * but because there is nowhere to put them. Seller documents are never read on
 * this path at all; only the submission's own item photographs are.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '@dash/db';
import {
  assertTransition,
  assessEvidence,
  escalationReasons,
  isAcceptanceValid,
  looksInconsistent,
  PILOT_POLICY,
  PricingDecisionError,
  reconcileConfidence,
  resolvePricingDecision,
  validateValuationResult,
  ValueCheckTransitionError,
  type Comparable,
  type ValuationPhoto,
  type ValuationRequest,
  type ValuationResult,
  type ValueCheckActor,
  type ValueCheckState,
} from '@dash/domain/valuecheck';
import { ApiError } from '../http/errors.js';
import { actorOf, requireAuth, requirePermission } from '../http/context.js';
import type { Actor } from '@dash/domain/permissions';

function valueCheckActorFor(actor: Actor): ValueCheckActor {
  if (actor.roles.includes('super_admin')) return 'super_admin';
  if (actor.roles.includes('declutter_admin')) return 'admin';
  return 'admin';
}

function auditContext(request: FastifyRequest) {
  return {
    ipAddress: request.ip,
    userAgent: request.headers['user-agent'],
    requestId: request.id,
  };
}

const comparableInput = z.object({
  provenance: z.enum(['admin', 'dash_history', 'partner', 'connector']).default('admin'),
  source: z.string().trim().min(1).max(160),
  description: z.string().trim().min(1).max(400),
  variant: z.string().trim().max(120).optional(),
  condition: z.enum(['new', 'like_new', 'good', 'fair']).optional(),
  market: z.string().trim().max(120).optional(),
  askingPriceKobo: z.number().int().positive().max(100_000_000_000).optional(),
  soldPriceKobo: z.number().int().positive().max(100_000_000_000).optional(),
  observedAt: z.string().datetime(),
  note: z.string().trim().max(500).optional(),
});

const decisionInput = z.object({
  kind: z.enum(['approved', 'adjusted', 'rejected']),
  adminPriceKobo: z.number().int().positive().max(100_000_000_000).optional(),
  reason: z.string().trim().max(1000).optional(),
  /** An admin may always send it upward, whatever the policy says. */
  escalate: z.boolean().default(false),
});

const authorizeInput = z.object({
  kind: z.enum(['approved', 'adjusted', 'rejected', 'returned']),
  priceKobo: z.number().int().positive().max(100_000_000_000).optional(),
  reason: z.string().trim().max(1000).optional(),
});

const sellerResponseInput = z.object({
  response: z.enum(['accept', 'decline']),
  /** Echoed back so a stale screen cannot accept a price nobody is offering. */
  priceKobo: z.number().int().positive(),
  reason: z.string().trim().max(500).optional(),
});

export async function registerDeclutterPricingRoutes(app: FastifyInstance): Promise<void> {
  const { prisma } = app.services;

  async function submissionOr404(id: string) {
    const submission = await prisma.declutterSubmission.findUnique({
      where: { id },
      include: {
        category: true,
        seller: true,
        comparables: true,
        photos: true,
        fraudFlags: { where: { status: { in: ['open', 'reviewing'] } } },
      },
    });
    if (!submission) throw ApiError.notFound();
    return submission;
  }

  /** Move the submission's ValueCheck state, refusing anything illegal. */
  function nextState(
    from: string,
    to: ValueCheckState,
    actor: ValueCheckActor,
  ): ValueCheckState {
    try {
      return assertTransition(from as ValueCheckState, to, actor);
    } catch (error) {
      if (error instanceof ValueCheckTransitionError) {
        throw error.reason === 'actor_not_permitted'
          ? ApiError.forbidden('Your role cannot make that decision.')
          : ApiError.conflict(`This submission cannot move from ${from} to ${to}.`);
      }
      throw error;
    }
  }

  // =========================================================================
  // Comparables
  // =========================================================================

  app.post(
    '/v1/admin/declutter/submissions/:id/comparables',
    { preHandler: requirePermission('declutter:submission:write') },
    async (request, reply) => {
      const actor = actorOf(request);
      const { id } = z.object({ id: z.string().min(1).max(40) }).parse(request.params);
      const body = comparableInput.parse(request.body);

      if (body.askingPriceKobo === undefined && body.soldPriceKobo === undefined) {
        throw ApiError.badRequest('A comparable needs an asking price, a sold price, or both.');
      }

      await submissionOr404(id);

      const comparable = await prisma.declutterComparable.create({
        data: {
          submissionId: id,
          provenance: body.provenance,
          source: body.source,
          description: body.description,
          variant: body.variant ?? null,
          condition: body.condition ?? null,
          market: body.market ?? null,
          askingPriceKobo: body.askingPriceKobo ?? null,
          soldPriceKobo: body.soldPriceKobo ?? null,
          observedAt: new Date(body.observedAt),
          note: body.note ?? null,
          createdBy: actor.identityId,
        },
      });

      reply.code(201);
      return { comparable };
    },
  );

  app.delete(
    '/v1/admin/declutter/comparables/:id',
    { preHandler: requirePermission('declutter:submission:write') },
    async (request) => {
      const { id } = z.object({ id: z.string().min(1).max(40) }).parse(request.params);
      const existing = await prisma.declutterComparable.findUnique({ where: { id } });
      if (!existing) throw ApiError.notFound();
      await prisma.declutterComparable.delete({ where: { id } });
      return { deleted: true };
    },
  );

  // =========================================================================
  // Running a ValueCheck
  // =========================================================================

  /**
   * POST /v1/admin/declutter/submissions/:id/valuecheck
   *
   * Build a sanitised request from the submission, run it, validate the
   * answer, and store the run. A failed or malformed answer is recorded as a
   * failed run and changes nothing else: the submission's authoritative state,
   * its authorised price and any seller acceptance are all left exactly as
   * they were.
   */
  app.post(
    '/v1/admin/declutter/submissions/:id/valuecheck',
    { preHandler: requirePermission('declutter:valuation:run') },
    async (request) => {
      const actor = actorOf(request);
      const { id } = z.object({ id: z.string().min(1).max(40) }).parse(request.params);
      const submission = await submissionOr404(id);

      const valuationRequest = buildValuationRequest(submission);

      let raw: unknown;
      let failure: string | null = null;
      try {
        raw = await app.services.valuation.value(valuationRequest);
      } catch (error) {
        failure = error instanceof Error ? `provider_error: ${error.message}` : 'provider_error';
      }

      if (!failure) {
        const validation = validateValuationResult(raw);
        if (!validation.ok) failure = `invalid_result: ${validation.rejections.join(',')}`;
      }

      if (failure) {
        // Recorded, so a reviewer can see the engine was tried and what it
        // said. Nothing authoritative moves.
        const failed = await prisma.declutterValuation.create({
          data: {
            submissionId: id,
            status: 'failed',
            requestPayload: JSON.stringify(valuationRequest),
            providerName: app.services.valuation.providerName,
            modelVersion: app.services.valuation.modelVersion,
            isLive: app.services.valuation.isLive,
            failureReason: failure.slice(0, 500),
          },
        });

        await writeAudit(prisma, {
          identityId: actor.identityId,
          action: 'declutter.valuecheck.failed',
          resourceType: 'DeclutterValuation',
          resourceId: failed.id,
          after: { submissionId: id, failureReason: failed.failureReason },
          ...auditContext(request),
        });

        throw ApiError.unprocessable(
          'ValueCheck could not produce a usable valuation. Nothing on this submission has changed.',
          { failureReason: failed.failureReason },
        );
      }

      const result = reconcileConfidence(raw as ValuationResult, assessEvidence(valuationRequest));

      const valuation = await prisma.declutterValuation.create({
        data: {
          submissionId: id,
          status: 'succeeded',
          requestPayload: JSON.stringify(valuationRequest),
          providerName: result.providerName,
          modelVersion: result.modelVersion,
          algorithmVersion: result.algorithmVersion,
          estimatedMinKobo: result.estimatedLowKobo,
          estimatedMaxKobo: result.estimatedHighKobo,
          recommendedPriceKobo: result.recommendedPriceKobo,
          confidenceBasisPoints: result.confidenceBasisPoints,
          factors: JSON.stringify(result.factors),
          warnings: JSON.stringify(result.warnings),
          reasoning: result.reasoning,
          evidenceSummary: result.evidenceSummary,
          isLive: result.isLive,
          producedAt: new Date(result.producedAt),
        },
      });

      // A completed run is not a completed ValueCheck. It moves the submission
      // as far as a human's desk and no further.
      const to = nextState(
        submission.valueCheckStatus === 'valuation_pending'
          ? 'valuation_pending'
          : submission.valueCheckStatus,
        'valuation_completed',
        'system',
      );

      await prisma.declutterSubmission.update({
        where: { id },
        data: { valueCheckStatus: to },
      });

      await writeAudit(prisma, {
        identityId: actor.identityId,
        action: 'declutter.valuecheck.completed',
        resourceType: 'DeclutterValuation',
        resourceId: valuation.id,
        after: {
          submissionId: id,
          provider: result.providerName,
          isLive: result.isLive,
          recommendedPriceKobo: result.recommendedPriceKobo,
          confidenceBasisPoints: result.confidenceBasisPoints,
        },
        ...auditContext(request),
      });

      return { valuation: valuationView(valuation), result };
    },
  );

  /**
   * GET /v1/admin/declutter/submissions/:id/valuecheck
   *
   * Everything a reviewer needs on one screen: the item, its structured
   * answers, the comparables gathered so far, the latest run with its range,
   * confidence, factors, reasoning and warnings, and the decisions taken.
   *
   * The AI recommendation and every human decision are returned side by side
   * rather than merged, so a screen cannot accidentally present an adjusted
   * figure as the model's own.
   */
  app.get(
    '/v1/admin/declutter/submissions/:id/valuecheck',
    { preHandler: requirePermission('declutter:submission:read') },
    async (request) => {
      const { id } = z.object({ id: z.string().min(1).max(40) }).parse(request.params);
      const submission = await submissionOr404(id);

      const valuations = await prisma.declutterValuation.findMany({
        where: { submissionId: id },
        orderBy: { createdAt: 'desc' },
        take: 5,
      });
      const decisions = await prisma.declutterPricingDecision.findMany({
        where: { submissionId: id },
        orderBy: { createdAt: 'asc' },
      });

      const latest = valuations.find((row) => row.status === 'succeeded') ?? null;

      return {
        submission: {
          id: submission.id,
          code: submission.code,
          title: submission.title,
          description: submission.description,
          condition: submission.condition,
          categoryKey: submission.category?.key ?? null,
          expectedPriceKobo: submission.expectedPriceKobo,
          attributes: submission.attributes ? JSON.parse(submission.attributes) : {},
          photoCount: submission.photos.length,
          valueCheckStatus: submission.valueCheckStatus,
          escalationReasons: submission.escalationReasons
            ? (JSON.parse(submission.escalationReasons) as string[])
            : [],
          authorizedPriceKobo: submission.authorizedPriceKobo,
          authorizationVersion: submission.authorizationVersion,
          sellerAcceptedPriceKobo: submission.sellerAcceptedPriceKobo,
          acceptanceValid: isEligible(submission),
          seller: {
            displayName: submission.seller.displayName,
            kycStatus: submission.seller.kycStatus,
            sellerType: submission.seller.sellerType,
          },
          openFraudFlags: submission.fraudFlags.length,
        },
        comparables: submission.comparables,
        valuation: latest
          ? {
              ...valuationView(latest),
              estimatedLowKobo: latest.estimatedMinKobo,
              estimatedHighKobo: latest.estimatedMaxKobo,
              factors: latest.factors ? JSON.parse(latest.factors) : [],
              warnings: parseWarnings(latest.warnings),
              reasoning: latest.reasoning,
              evidenceSummary: latest.evidenceSummary,
            }
          : null,
        runs: valuations.map(valuationView),
        decisions,
      };
    },
  );

  // =========================================================================
  // Admin pricing decision
  // =========================================================================

  app.post(
    '/v1/admin/declutter/submissions/:id/pricing-decision',
    { preHandler: requirePermission('declutter:pricing:decide') },
    async (request) => {
      const actor = actorOf(request);
      const { id } = z.object({ id: z.string().min(1).max(40) }).parse(request.params);
      const body = decisionInput.parse(request.body);
      const submission = await submissionOr404(id);
      const acting = valueCheckActorFor(actor);

      const latest = await prisma.declutterValuation.findFirst({
        where: { submissionId: id, status: 'succeeded' },
        orderBy: { createdAt: 'desc' },
      });
      if (!latest?.recommendedPriceKobo) {
        throw ApiError.conflict('Run a ValueCheck before deciding a price.');
      }

      // An admin recording a decision has, by definition, reviewed it — so the
      // submission passes through `admin_review_pending` first, whatever it was
      // doing before.
      //
      // The machine insists on that step rather than letting a completed run,
      // or an already-accepted price, jump straight to a new authorisation. It
      // is what makes re-pricing visible in the history instead of a number
      // quietly changing underneath a seller who had already agreed to it.
      const reviewing: ValueCheckState =
        submission.valueCheckStatus === 'admin_review_pending'
          ? 'admin_review_pending'
          : nextState(submission.valueCheckStatus, 'admin_review_pending', acting);

      let decision;
      try {
        decision = resolvePricingDecision({
          kind: body.kind,
          recommendedPriceKobo: latest.recommendedPriceKobo,
          adminPriceKobo: body.adminPriceKobo,
          reason: body.reason,
        });
      } catch (error) {
        if (error instanceof PricingDecisionError) throw ApiError.badRequest(error.message);
        throw error;
      }

      // Recorded before anything else moves. The model's recommendation stays
      // on its own row, untouched — the pair is what makes the history honest.
      await prisma.declutterPricingDecision.create({
        data: {
          submissionId: id,
          valuationId: latest.id,
          actorRole: acting,
          actorId: actor.identityId,
          kind: body.kind,
          recommendedPriceKobo: latest.recommendedPriceKobo,
          proposedPriceKobo: decision.proposedPriceKobo,
          reason: decision.reason,
        },
      });

      if (body.kind === 'rejected' || decision.proposedPriceKobo === null) {
        const to = nextState(reviewing, 'rejected', acting);
        await prisma.declutterSubmission.update({
          where: { id },
          data: { valueCheckStatus: to },
        });
        await auditDecision(request, actor.identityId, id, 'rejected', decision.reason);
        return { valueCheckStatus: to, escalation: [] };
      }

      const warnings = parseWarnings(latest.warnings);
      const reasons = escalationReasons(
        {
          proposedPriceKobo: decision.proposedPriceKobo,
          recommendedPriceKobo: latest.recommendedPriceKobo,
          confidenceBasisPoints: latest.confidenceBasisPoints,
          categoryKey: submission.category?.key ?? null,
          hasOpenFraudFlag: submission.fraudFlags.length > 0,
          sellerKycConcern: submission.seller.kycStatus !== 'verified',
          comparablesConflict: warnings.some((w) => w.code === 'conflicting_comparables'),
          evidenceInconsistent: looksInconsistent(toResult(latest, warnings)),
          trustedPartnerException: submission.seller.sellerType === 'trusted_partner',
          manuallyEscalated: body.escalate,
        },
        PILOT_POLICY,
      );

      if (reasons.length > 0) {
        const to = nextState(reviewing, 'super_admin_approval_pending', acting);
        await prisma.declutterSubmission.update({
          where: { id },
          data: {
            valueCheckStatus: to,
            escalationReasons: JSON.stringify(reasons),
            finalPriceKobo: decision.proposedPriceKobo,
          },
        });
        await auditDecision(request, actor.identityId, id, 'escalated', decision.reason, reasons);
        return { valueCheckStatus: to, escalation: reasons };
      }

      // Below every threshold and clear of every risk signal: the admin's
      // decision is the authority, and the price becomes authoritative here.
      const authorized = await authorize(id, decision.proposedPriceKobo, actor.identityId, acting, reviewing);
      await auditDecision(request, actor.identityId, id, 'authorized', decision.reason, []);
      return { valueCheckStatus: authorized.valueCheckStatus, escalation: [] };
    },
  );

  // =========================================================================
  // Super admin authorisation
  // =========================================================================

  /** The queue of prices waiting on a super admin, with why each is here. */
  app.get(
    '/v1/admin/declutter/approvals',
    { preHandler: requirePermission('declutter:pricing:authorize') },
    async () => {
      const submissions = await prisma.declutterSubmission.findMany({
        where: { valueCheckStatus: 'super_admin_approval_pending' },
        orderBy: { updatedAt: 'asc' },
        take: 100,
        include: { seller: { select: { displayName: true, kycStatus: true, sellerType: true } } },
      });

      return {
        approvals: submissions.map((submission) => ({
          id: submission.id,
          code: submission.code,
          title: submission.title,
          proposedPriceKobo: submission.finalPriceKobo,
          escalationReasons: submission.escalationReasons
            ? (JSON.parse(submission.escalationReasons) as string[])
            : [],
          seller: submission.seller,
          updatedAt: submission.updatedAt,
        })),
      };
    },
  );

  app.post(
    '/v1/admin/declutter/submissions/:id/authorize',
    { preHandler: requirePermission('declutter:pricing:authorize') },
    async (request) => {
      const actor = actorOf(request);
      const { id } = z.object({ id: z.string().min(1).max(40) }).parse(request.params);
      const body = authorizeInput.parse(request.body);
      const submission = await submissionOr404(id);

      if (body.kind === 'rejected' || body.kind === 'returned') {
        if (!body.reason) throw ApiError.badRequest('Say why, so the reviewer below you knows.');
        const to = nextState(
          submission.valueCheckStatus,
          body.kind === 'rejected' ? 'rejected' : 'admin_review_pending',
          'super_admin',
        );
        await prisma.declutterSubmission.update({ where: { id }, data: { valueCheckStatus: to } });
        await prisma.declutterPricingDecision.create({
          data: {
            submissionId: id,
            actorRole: 'super_admin',
            actorId: actor.identityId,
            kind: body.kind === 'rejected' ? 'rejected' : 'returned_for_review',
            proposedPriceKobo: null,
            reason: body.reason,
          },
        });
        await auditDecision(request, actor.identityId, id, body.kind, body.reason);
        return { valueCheckStatus: to };
      }

      const proposed = submission.finalPriceKobo;
      let price = proposed;
      if (body.kind === 'adjusted') {
        if (body.priceKobo === undefined) throw ApiError.badRequest('An adjustment needs a price.');
        if (!body.reason) throw ApiError.badRequest('Changing the price requires a reason.');
        if (body.priceKobo === proposed) {
          throw ApiError.badRequest('That is the proposed price — approve it instead.');
        }
        price = body.priceKobo;
      }
      if (!price) throw ApiError.conflict('There is no proposed price to authorise.');

      await prisma.declutterPricingDecision.create({
        data: {
          submissionId: id,
          actorRole: 'super_admin',
          actorId: actor.identityId,
          kind: body.kind,
          recommendedPriceKobo: proposed,
          proposedPriceKobo: price,
          reason: body.reason ?? null,
        },
      });

      const authorized = await authorize(
        id,
        price,
        actor.identityId,
        'super_admin',
        submission.valueCheckStatus,
      );
      await auditDecision(request, actor.identityId, id, 'authorized', body.reason);
      return { valueCheckStatus: authorized.valueCheckStatus, authorizedPriceKobo: price };
    },
  );

  // =========================================================================
  // The seller answers
  // =========================================================================

  app.post('/v1/declutter/submissions/:id/price-response', { preHandler: requireAuth }, async (request) => {
    const actor = actorOf(request);
    const { id } = z.object({ id: z.string().min(1).max(40) }).parse(request.params);
    const body = sellerResponseInput.parse(request.body);

    const submission = await prisma.declutterSubmission.findUnique({
      where: { id },
      include: { seller: true },
    });
    // Scoped to the owner, and 404 rather than 403 — a 403 would confirm the
    // submission exists.
    if (!submission || submission.seller.customerId !== actor.customerId) throw ApiError.notFound();

    if (submission.authorizedPriceKobo === null) {
      throw ApiError.conflict('There is no price to answer yet.');
    }
    if (body.priceKobo !== submission.authorizedPriceKobo) {
      // A stale screen. The seller must answer the price that is actually on
      // the table, not the one they were shown before it moved.
      throw ApiError.conflict('That price is no longer the one being offered. Reload and check.');
    }

    const to = nextState(
      submission.valueCheckStatus,
      body.response === 'accept' ? 'seller_accepted' : 'seller_declined',
      'seller',
    );

    const updated = await prisma.declutterSubmission.update({
      where: { id },
      data:
        body.response === 'accept'
          ? {
              valueCheckStatus: to,
              sellerAcceptedAt: new Date(),
              sellerAcceptanceBy: actor.identityId,
              sellerAcceptedPriceKobo: submission.authorizedPriceKobo,
              sellerAcceptedVersion: submission.authorizationVersion,
              sellerDeclinedAt: null,
              sellerDeclineReason: null,
            }
          : {
              valueCheckStatus: to,
              sellerDeclinedAt: new Date(),
              sellerDeclineReason: body.reason ?? null,
            },
    });

    await writeAudit(prisma, {
      identityId: actor.identityId,
      action: `declutter.price.${body.response === 'accept' ? 'accepted' : 'declined'}`,
      resourceType: 'DeclutterSubmission',
      resourceId: id,
      after: {
        priceKobo: submission.authorizedPriceKobo,
        authorizationVersion: submission.authorizationVersion,
      },
      ...auditContext(request),
    });

    return { valueCheckStatus: updated.valueCheckStatus, eligibleForPublication: isEligible(updated) };
  });

  /** What a seller sees about the price on the table. */
  app.get('/v1/declutter/submissions/:id/price', { preHandler: requireAuth }, async (request) => {
    const actor = actorOf(request);
    const { id } = z.object({ id: z.string().min(1).max(40) }).parse(request.params);
    const submission = await prisma.declutterSubmission.findUnique({
      where: { id },
      include: { seller: true },
    });
    if (!submission || submission.seller.customerId !== actor.customerId) throw ApiError.notFound();

    return {
      status: submission.valueCheckStatus,
      // The final price only. A seller is not shown the model's range, the
      // confidence, the comparables or the internal reasoning — that is DASH's
      // working, and publishing it would invite negotiation of a fixed price.
      priceKobo:
        submission.valueCheckStatus === 'seller_acceptance_pending' ||
        submission.valueCheckStatus === 'seller_accepted' ||
        submission.valueCheckStatus === 'price_authorized'
          ? submission.authorizedPriceKobo
          : null,
      acceptedPriceKobo: submission.sellerAcceptedPriceKobo,
      acceptanceValid: isEligible(submission),
    };
  });

  // -------------------------------------------------------------------------

  /** Make a price authoritative, and present it to the seller. */
  async function authorize(
    submissionId: string,
    priceKobo: number,
    identityId: string,
    acting: ValueCheckActor,
    from: string,
  ) {
    const authorizedState = nextState(from, 'price_authorized', acting);
    const presented = assertTransition(authorizedState, 'seller_acceptance_pending', 'system');

    return prisma.declutterSubmission.update({
      where: { id: submissionId },
      data: {
        valueCheckStatus: presented,
        authorizedPriceKobo: priceKobo,
        finalPriceKobo: priceKobo,
        // Every authorisation is a new version, so an acceptance of the
        // previous one stops being valid even at the same figure.
        authorizationVersion: { increment: 1 },
        authorizedAt: new Date(),
        authorizedBy: identityId,
        // A price that moved invalidates what the seller agreed to. Cleared
        // rather than left to look current.
        sellerAcceptedAt: null,
        sellerAcceptedPriceKobo: null,
        sellerAcceptedVersion: null,
      },
    });
  }

  async function auditDecision(
    request: FastifyRequest,
    identityId: string,
    submissionId: string,
    outcome: string,
    reason?: string | null,
    reasons?: readonly string[],
  ) {
    await writeAudit(prisma, {
      identityId,
      action: `declutter.pricing.${outcome}`,
      resourceType: 'DeclutterSubmission',
      resourceId: submissionId,
      after: { outcome, reason: reason ?? null, escalation: reasons ?? [] },
      ...auditContext(request),
    });
  }
}

// ---------------------------------------------------------------------------
// Building the request
// ---------------------------------------------------------------------------

interface SubmissionForValuation {
  id: string;
  title: string | null;
  condition: string | null;
  attributes: string | null;
  expectedPriceKobo: number | null;
  category: { key: string } | null;
  comparables: {
    id: string;
    provenance: string;
    source: string;
    description: string;
    variant: string | null;
    condition: string | null;
    market: string | null;
    askingPriceKobo: number | null;
    soldPriceKobo: number | null;
    observedAt: Date;
    note: string | null;
  }[];
  photos: { id: string }[];
}

/**
 * Turn a submission into a `ValuationRequest`.
 *
 * Every field is chosen here explicitly rather than spread from the row, which
 * is what keeps a future column off the wire by default. Nothing about the
 * seller is read: not their record, not their documents, not their notes.
 *
 * Photo roles are `other` for now, because the upload path does not yet capture
 * which view a photograph is. That is honest rather than convenient — the
 * evidence assessment will report "no photograph shows a label" and lower
 * confidence accordingly, which is exactly right when DASH genuinely does not
 * know.
 */
function buildValuationRequest(submission: SubmissionForValuation): ValuationRequest {
  const attributes =
    submission.attributes === null
      ? {}
      : (JSON.parse(submission.attributes) as Record<string, string | number | boolean | null>);

  const comparables: Comparable[] = submission.comparables.map((row) => ({
    id: row.id,
    provenance: row.provenance as Comparable['provenance'],
    source: row.source,
    description: row.description,
    ...(row.variant ? { variant: row.variant } : {}),
    ...(row.condition ? { condition: row.condition as Comparable['condition'] } : {}),
    ...(row.market ? { market: row.market } : {}),
    currency: 'NGN' as const,
    ...(row.askingPriceKobo !== null ? { askingPriceKobo: row.askingPriceKobo } : {}),
    ...(row.soldPriceKobo !== null ? { soldPriceKobo: row.soldPriceKobo } : {}),
    observedAt: row.observedAt.toISOString(),
    ...(row.note ? { note: row.note } : {}),
  }));

  const photos: ValuationPhoto[] = submission.photos.map((photo) => ({
    id: photo.id,
    role: 'other' as const,
    contentType: 'image/jpeg',
  }));

  return {
    reference: submission.id,
    categoryKey: submission.category?.key ?? 'unknown',
    condition: (submission.condition ?? 'good') as ValuationRequest['condition'],
    attributes,
    declaredDefects: [],
    includedAccessories: [],
    marketLocation: 'Nigeria',
    ...(submission.expectedPriceKobo !== null
      ? { expectedPriceKobo: submission.expectedPriceKobo }
      : {}),
    photos,
    comparables,
  };
}

function parseWarnings(raw: string | null): ValuationResult['warnings'] {
  if (!raw) return [];
  try {
    return JSON.parse(raw) as ValuationResult['warnings'];
  } catch {
    return [];
  }
}

function toResult(
  row: {
    estimatedMinKobo: number | null;
    estimatedMaxKobo: number | null;
    recommendedPriceKobo: number | null;
    confidenceBasisPoints: number | null;
  },
  warnings: ValuationResult['warnings'],
): ValuationResult {
  return {
    estimatedLowKobo: row.estimatedMinKobo ?? 0,
    estimatedHighKobo: row.estimatedMaxKobo ?? 0,
    recommendedPriceKobo: row.recommendedPriceKobo ?? 0,
    confidenceBasisPoints: row.confidenceBasisPoints ?? 0,
    factors: [],
    warnings,
    reasoning: '',
    evidenceSummary: '',
    providerName: '',
    modelVersion: '',
    algorithmVersion: '',
    isLive: false,
    producedAt: new Date(0).toISOString(),
  };
}

function isEligible(submission: {
  valueCheckStatus: string;
  authorizedPriceKobo: number | null;
  authorizationVersion: number;
  sellerAcceptedPriceKobo: number | null;
  sellerAcceptedVersion: number | null;
}): boolean {
  if (submission.valueCheckStatus !== 'seller_accepted') return false;
  return isAcceptanceValid(
    submission.sellerAcceptedPriceKobo !== null && submission.sellerAcceptedVersion !== null
      ? {
          acceptedPriceKobo: submission.sellerAcceptedPriceKobo,
          authorizationVersion: submission.sellerAcceptedVersion,
          acceptedAt: '',
        }
      : null,
    submission.authorizedPriceKobo !== null
      ? { priceKobo: submission.authorizedPriceKobo, version: submission.authorizationVersion }
      : null,
  );
}

function valuationView(valuation: {
  id: string;
  status: string;
  providerName: string | null;
  isLive: boolean;
  recommendedPriceKobo: number | null;
  confidenceBasisPoints: number | null;
  createdAt: Date;
}) {
  return {
    id: valuation.id,
    status: valuation.status,
    provider: valuation.providerName,
    isLive: valuation.isLive,
    recommendedPriceKobo: valuation.recommendedPriceKobo,
    confidenceBasisPoints: valuation.confidenceBasisPoints,
    createdAt: valuation.createdAt,
  };
}
