/**
 * DASH ValueCheck — the service.
 *
 * This file is the whole product boundary. It knows nothing about listings,
 * sellers, submissions or marketplaces: it takes a description of an item and
 * returns a valuation. Declutters consumes it through
 * `routes/declutter-pricing.ts`, which adds the marketplace's own context,
 * permissions and persistence — and any future consumer would do the same.
 *
 * That is why a valuation here is **not persisted**. A standalone caller
 * valuing a laptop has not created a listing and has not entered a marketplace
 * process; storing their request against Declutter's tables would invent a
 * relationship neither side asked for. Declutters persists its own runs
 * because it needs them for review, approval and the eventual dataset.
 *
 * It is also why nothing here can authorise, price or publish anything. A
 * valuation is advice. Turning advice into a price a stranger will pay is a
 * marketplace decision made by a named human, and it lives on the other side
 * of this boundary.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  assessEvidence,
  reconcileConfidence,
  validateValuationResult,
  type ValuationRequest,
} from '@dash/domain/valuecheck';
import { ApiError } from '../http/errors.js';
import { requirePermission } from '../http/context.js';

const conditionSchema = z.enum(['new', 'like_new', 'good', 'fair']);

const comparableSchema = z.object({
  id: z.string().max(60).default('cmp'),
  provenance: z.enum(['admin', 'dash_history', 'partner', 'connector']).default('admin'),
  source: z.string().trim().min(1).max(160),
  description: z.string().trim().min(1).max(400),
  variant: z.string().trim().max(120).optional(),
  condition: conditionSchema.optional(),
  market: z.string().trim().max(120).optional(),
  currency: z.literal('NGN').default('NGN'),
  askingPriceKobo: z.number().int().positive().max(100_000_000_000).optional(),
  soldPriceKobo: z.number().int().positive().max(100_000_000_000).optional(),
  observedAt: z.string().datetime(),
  note: z.string().trim().max(500).optional(),
});

const photoSchema = z.object({
  id: z.string().max(60),
  role: z.enum(['front', 'back', 'side', 'label', 'screen', 'accessories', 'damage', 'other']),
  contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  url: z.string().url().max(2000).optional(),
});

/**
 * The request body.
 *
 * Mirrors `ValuationRequest`, which has no field for a person — so there is
 * nothing to strip here, and nothing a caller could smuggle through. That is
 * the point of putting data minimisation in the type rather than in a
 * sanitiser somebody has to remember to call.
 */
const valuationSchema = z.object({
  reference: z.string().trim().min(1).max(120),
  categoryKey: z.string().trim().min(1).max(60),
  brand: z.string().trim().max(80).optional(),
  model: z.string().trim().max(120).optional(),
  variant: z.string().trim().max(120).optional(),
  condition: conditionSchema,
  attributes: z.record(z.union([z.string().max(200), z.number(), z.boolean(), z.null()])).default({}),
  declaredDefects: z
    .array(
      z.object({
        kind: z.enum(['cosmetic', 'functional']),
        description: z.string().trim().min(1).max(300),
      }),
    )
    .max(30)
    .default([]),
  includedAccessories: z.array(z.string().trim().max(80)).max(20).default([]),
  repairHistory: z.string().trim().max(1000).optional(),
  ageMonths: z.number().int().min(0).max(1200).optional(),
  marketLocation: z.string().trim().min(1).max(120),
  expectedPriceKobo: z.number().int().positive().max(100_000_000_000).optional(),
  photos: z.array(photoSchema).max(12).default([]),
  comparables: z.array(comparableSchema).max(40).default([]),
});

export async function registerValueCheckRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /v1/valuecheck/valuations
   *
   * Value an item. Returns a recommendation, a range, a confidence the
   * evidence can actually support, the factors behind it and — importantly —
   * what could not be established.
   *
   * The response carries `isLive` and the provider name, so a caller can never
   * present the deterministic local adapter as live AI without doing so
   * knowingly.
   */
  app.post(
    '/v1/valuecheck/valuations',
    { preHandler: requirePermission('valuecheck:run') },
    async (request) => {
      const body = valuationSchema.parse(request.body);
      const valuationRequest: ValuationRequest = body;

      let raw: unknown;
      try {
        raw = await app.services.valuation.value(valuationRequest);
      } catch {
        // A provider that is down, slow or throwing must not become a 500 with
        // a stack in it, and must leave the caller's world unchanged — there
        // is nothing to roll back here because nothing was written.
        throw ApiError.unprocessable(
          'ValueCheck could not produce a valuation. Nothing has been changed; try again shortly.',
        );
      }

      const validation = validateValuationResult(raw);
      if (!validation.ok) {
        // Refused before it is returned, let alone stored. A malformed model
        // answer is a failed run, not a valuation with odd numbers in it.
        throw ApiError.unprocessable('ValueCheck returned a result that could not be trusted.', {
          rejections: validation.rejections,
        });
      }

      // The provider's own confidence never survives contact with thin
      // evidence. Applied here as well as in the marketplace wrapper so a
      // standalone caller gets the same honesty.
      const result = reconcileConfidence(
        raw as Parameters<typeof reconcileConfidence>[0],
        assessEvidence(valuationRequest),
      );

      return { valuation: result };
    },
  );
}
