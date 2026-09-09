/**
 * DASH ValueCheck — the valuation boundary.
 *
 * ValueCheck is AI-assisted pricing reviewed by DASH. Both halves of that
 * sentence are load-bearing, and this module exists to make the second half
 * true in code rather than in policy:
 *
 *   * **The model is advisory.** Nothing here returns a price that anyone is
 *     obliged to use. A valuation produces a *recommendation* plus the evidence
 *     behind it; a human sets the number that goes on the listing.
 *   * **A bad model answer must never reach a buyer.** Providers time out,
 *     return prose where a number was asked for, hallucinate a range that does
 *     not contain its own recommendation, or quote ₦4 for a laptop.
 *     `validateValuationResult` is the gate, and it fails closed.
 *
 * ## Why the provider is behind a port
 *
 * The marketplace understands `ValuationRequest` and `ValuationResult` and
 * nothing else. No provider's response shape reaches a route, a database column
 * or a screen. Swapping model or vendor is then an adapter change, and the
 * stored history stays comparable across that swap because the shape it was
 * stored in never depended on who produced it.
 *
 * ## Why the request is structured
 *
 * Asking a language model "what is this worth?" and trusting the number is not
 * a valuation system; it is a plausible-sounding number generator. The request
 * below carries structured evidence — specifications, condition, defects,
 * accessories, comparables, location — so the model is reasoning over facts we
 * hold and can later replay. It is also why §57's dataset is worth keeping: the
 * inputs, the recommendation, the human's decision and the eventual sale
 * outcome are all in one shape.
 *
 * Money is integer kobo everywhere, as everywhere else in DASH.
 */

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

export type ItemCondition = 'new' | 'like_new' | 'good' | 'fair';

/** A price seen on a comparable item. Supplied by an admin, or from DASH history. */
export interface Comparable {
  readonly source: 'admin' | 'dash_history' | 'partner';
  readonly label: string;
  readonly priceKobo: number;
  readonly condition?: ItemCondition;
  /** Days since observed. Older comparables should weigh less. */
  readonly ageDays?: number;
}

export interface ValuationRequest {
  readonly submissionId: string;
  readonly categoryKey: string;
  readonly brand?: string;
  readonly model?: string;
  readonly variant?: string;
  readonly condition: ItemCondition;
  /**
   * Category-aware structured attributes: storage, battery health, processor,
   * mileage. Kept as a bag rather than columns because a sofa and a phone do
   * not share a schema, and forcing them to would put `batteryHealth` on
   * furniture.
   */
  readonly attributes: Readonly<Record<string, string | number | boolean | null>>;
  readonly visibleDefects: readonly string[];
  readonly includedAccessories: readonly string[];
  readonly ageMonths?: number;
  readonly locationKey: string;
  readonly sellerExpectedPriceKobo: number;
  readonly comparables: readonly Comparable[];
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface ValuationFactor {
  readonly label: string;
  /** Which way it pushed the number, so an admin can read the reasoning. */
  readonly direction: 'raises' | 'lowers' | 'neutral';
  readonly weight: 'high' | 'medium' | 'low';
}

export interface ValuationResult {
  readonly estimatedMinKobo: number;
  readonly estimatedMaxKobo: number;
  readonly recommendedPriceKobo: number;
  /** Basis points, 0–10000. Integers, like every other proportion in DASH. */
  readonly confidenceBasisPoints: number;
  readonly factors: readonly ValuationFactor[];
  /** Prose an admin reads. Never shown to the public verbatim. */
  readonly reasoning: string;
  readonly providerName: string;
  readonly modelVersion: string;
  /** Our own prompt/scoring version, so a change on our side is attributable. */
  readonly algorithmVersion: string;
}

/**
 * What the valuation engine may do to a submission.
 *
 * Note what is missing: there is no outcome that publishes anything, and no
 * outcome that sets a price. The best a successful run can do is move a
 * submission in front of a human.
 */
export interface ValuationPort {
  readonly providerName: string;
  readonly isLive: boolean;
  value(request: ValuationRequest): Promise<ValuationResult>;
}

// ---------------------------------------------------------------------------
// Validation — the gate
// ---------------------------------------------------------------------------

export type ValuationRejectionCode =
  | 'range_inverted'
  | 'recommendation_outside_range'
  | 'non_integer_kobo'
  | 'non_positive_price'
  | 'confidence_out_of_range'
  | 'range_implausibly_wide'
  | 'no_factors'
  | 'empty_reasoning'
  | 'missing_provenance';

export interface ValuationValidation {
  readonly ok: boolean;
  readonly rejections: readonly ValuationRejectionCode[];
}

/**
 * A range wider than this multiple of its own floor is not an estimate.
 *
 * Five was chosen because a genuinely uncertain second-hand estimate — a rare
 * item with two comparables — still lands well inside it, while the classic
 * model failure of "₦10,000 to ₦2,000,000" does not. A result this wide is
 * rejected rather than shown, because an admin reading it would learn nothing
 * and might anchor on the midpoint of noise.
 */
const MAX_RANGE_MULTIPLE = 5;

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

/**
 * Decide whether a provider's answer is usable at all.
 *
 * Fails closed: anything not positively verified is rejected. This runs before
 * the result is stored, so an unusable valuation never becomes a row that a
 * later query might treat as authoritative.
 */
export function validateValuationResult(result: ValuationResult): ValuationValidation {
  const rejections: ValuationRejectionCode[] = [];

  const prices = [
    result.estimatedMinKobo,
    result.estimatedMaxKobo,
    result.recommendedPriceKobo,
  ];

  if (!prices.every((value) => Number.isInteger(value))) {
    rejections.push('non_integer_kobo');
  }
  if (!prices.every(isPositiveInteger)) {
    rejections.push('non_positive_price');
  }
  if (result.estimatedMinKobo > result.estimatedMaxKobo) {
    rejections.push('range_inverted');
  }
  if (
    result.recommendedPriceKobo < result.estimatedMinKobo ||
    result.recommendedPriceKobo > result.estimatedMaxKobo
  ) {
    rejections.push('recommendation_outside_range');
  }
  if (
    !Number.isInteger(result.confidenceBasisPoints) ||
    result.confidenceBasisPoints < 0 ||
    result.confidenceBasisPoints > 10_000
  ) {
    rejections.push('confidence_out_of_range');
  }
  if (
    isPositiveInteger(result.estimatedMinKobo) &&
    result.estimatedMaxKobo > result.estimatedMinKobo * MAX_RANGE_MULTIPLE
  ) {
    rejections.push('range_implausibly_wide');
  }
  if (result.factors.length === 0) {
    rejections.push('no_factors');
  }
  if (result.reasoning.trim().length === 0) {
    rejections.push('empty_reasoning');
  }
  if (
    result.providerName.trim().length === 0 ||
    result.modelVersion.trim().length === 0 ||
    result.algorithmVersion.trim().length === 0
  ) {
    rejections.push('missing_provenance');
  }

  return { ok: rejections.length === 0, rejections };
}

// ---------------------------------------------------------------------------
// Advisory signals for the admin screen
// ---------------------------------------------------------------------------

/** Below this, the screen should say plainly that the estimate is weak. */
export const LOW_CONFIDENCE_BASIS_POINTS = 6_000;

export interface ValuationAdvisory {
  readonly lowConfidence: boolean;
  /** Seller wants materially more than the model thinks it is worth. */
  readonly sellerExpectationHigh: boolean;
  /** Seller is asking below the range — often a sign of a rushed or stolen sale. */
  readonly sellerExpectationLow: boolean;
  readonly thinComparables: boolean;
}

/**
 * Flags for the pricing screen.
 *
 * These are prompts for attention, not decisions. `sellerExpectationLow` in
 * particular is deliberately surfaced: an owner pricing well under the market
 * is sometimes in a hurry and sometimes selling something that is not theirs,
 * and an admin should be looking at ownership evidence before that item is
 * published cheaply.
 */
export function advise(
  request: ValuationRequest,
  result: ValuationResult,
): ValuationAdvisory {
  return {
    lowConfidence: result.confidenceBasisPoints < LOW_CONFIDENCE_BASIS_POINTS,
    sellerExpectationHigh: request.sellerExpectedPriceKobo > result.estimatedMaxKobo,
    sellerExpectationLow: request.sellerExpectedPriceKobo < result.estimatedMinKobo,
    thinComparables: request.comparables.length < 3,
  };
}

// ---------------------------------------------------------------------------
// The human decision
// ---------------------------------------------------------------------------

export type PricingDecisionKind = 'approved' | 'adjusted' | 'rejected';

export interface PricingDecisionInput {
  readonly kind: PricingDecisionKind;
  readonly recommendedPriceKobo: number;
  /** Required for `adjusted`; ignored otherwise. */
  readonly adminPriceKobo?: number;
  /** Required for `adjusted` and `rejected`. */
  readonly reason?: string;
}

export class PricingDecisionError extends Error {
  constructor(
    readonly code:
      | 'reason_required'
      | 'price_required'
      | 'price_must_differ'
      | 'non_positive_price'
      | 'non_integer_kobo',
    message: string,
  ) {
    super(message);
    this.name = 'PricingDecisionError';
  }
}

/**
 * Turn an admin's decision into the final fixed price.
 *
 * The rules this enforces are the ones §11 asks for, and they are enforced here
 * so that every caller — the API route, a future bulk tool, a script — gets the
 * same answer:
 *
 *   * Adjusting the model's number **requires a reason**, and the reason is
 *     stored. "Adjusted ₦445,000 → ₦430,000" is not an audit trail; "because
 *     two comparable Lagos listings are currently under ₦440,000" is.
 *   * An "adjustment" that does not change the price is an approval, and is
 *     refused as an adjustment so the history does not fill with adjustments
 *     that adjusted nothing.
 *   * Rejecting also requires a reason, because the seller is owed one.
 */
export function resolvePricingDecision(input: PricingDecisionInput): {
  readonly finalPriceKobo: number | null;
  readonly reason: string | null;
} {
  if (input.kind === 'approved') {
    if (!isPositiveInteger(input.recommendedPriceKobo)) {
      throw new PricingDecisionError(
        'non_positive_price',
        'Cannot approve a recommendation that is not a positive whole number of kobo.',
      );
    }
    return { finalPriceKobo: input.recommendedPriceKobo, reason: null };
  }

  if (input.kind === 'rejected') {
    if (!input.reason || input.reason.trim().length === 0) {
      throw new PricingDecisionError(
        'reason_required',
        'Rejecting a valuation requires a reason the seller can be told.',
      );
    }
    return { finalPriceKobo: null, reason: input.reason.trim() };
  }

  // adjusted
  if (input.adminPriceKobo === undefined) {
    throw new PricingDecisionError('price_required', 'An adjustment needs a price.');
  }
  if (!Number.isInteger(input.adminPriceKobo)) {
    throw new PricingDecisionError('non_integer_kobo', 'Prices are whole kobo.');
  }
  if (!isPositiveInteger(input.adminPriceKobo)) {
    throw new PricingDecisionError('non_positive_price', 'A price must be above zero.');
  }
  if (input.adminPriceKobo === input.recommendedPriceKobo) {
    throw new PricingDecisionError(
      'price_must_differ',
      'That is the recommended price — approve it rather than recording an adjustment.',
    );
  }
  if (!input.reason || input.reason.trim().length === 0) {
    throw new PricingDecisionError(
      'reason_required',
      'Changing the recommended price requires a reason.',
    );
  }

  return { finalPriceKobo: input.adminPriceKobo, reason: input.reason.trim() };
}
