/**
 * DASH ValueCheck — the contract.
 *
 * ValueCheck is a DASH product in its own right that happens to have DASH World
 * Declutters as its first customer. Nothing in this module knows what a
 * listing, a seller or a marketplace is, and that is the point: the same engine
 * should be able to serve the Declutters website, DASH APP, a standalone
 * ValueCheck site, an internal tool, or an external API consumer, without any
 * of them inheriting each other's assumptions.
 *
 * The boundary is enforced rather than described — `valuecheck.test.ts` asserts
 * that nothing under `valuecheck/` imports from `declutter/`. A valuation is
 * not a listing and not a sale, and keeping those three apart here is what
 * makes a standalone product possible later without a rewrite.
 *
 * ## What a request may carry, and what it structurally cannot
 *
 * `ValuationRequest` describes an *item*. It has no field for a person. There
 * is nowhere to put a name, a national identifier, a phone number, an address,
 * a bank account, an admin note or a KYC document, so a provider payload cannot
 * carry one by accident — a caller would have to change this type first, and a
 * reviewer would see it. That is data minimisation expressed as a type rather
 * than as a rule somebody remembers.
 *
 * IMEIs and serial numbers are likewise absent. They are ownership evidence
 * held for DASH to check, not valuation inputs, and there is no approved use
 * that sends them to a third party today.
 *
 * ## Money
 *
 * Integer minor units throughout — kobo, as everywhere else in DASH. Never a
 * float, at any layer.
 */

export type ItemCondition = 'new' | 'like_new' | 'good' | 'fair';

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

/**
 * Which view of the item a photograph is.
 *
 * Named rather than free-text because the roles are what let a model reason
 * about completeness — "no label photo" is a different kind of uncertainty
 * from "no damage photo", and both should lower confidence differently.
 */
export const PHOTO_ROLES = [
  'front',
  'back',
  'side',
  'label',
  'screen',
  'accessories',
  'damage',
  'other',
] as const;

export type PhotoRole = (typeof PHOTO_ROLES)[number];

/**
 * A photograph of the actual physical item.
 *
 * Real photographs of the real object, always. A generated or stock image is
 * not evidence about a specific second-hand item, and treating one as evidence
 * would make every downstream number a fiction.
 *
 * Carries a fetchable reference or inline bytes, never a storage key: the
 * caller resolves storage, so ValueCheck never needs to know where DASH keeps
 * its objects.
 */
export interface ValuationPhoto {
  readonly id: string;
  readonly role: PhotoRole;
  readonly contentType: string;
  /** A short-lived URL a provider may fetch, when the transport allows it. */
  readonly url?: string;
  /** Inline bytes, for providers that take images in the request body. */
  readonly dataBase64?: string;
}

/**
 * A comparable observed in the market.
 *
 * `askingPriceKobo` and `soldPriceKobo` are separate fields on purpose. An
 * asking price is what somebody hoped for; a sold price is what somebody paid.
 * Treating the first as the second is the single most common way a valuation
 * ends up above the market, so the model is never handed a number that has
 * quietly changed meaning.
 */
export interface Comparable {
  readonly id: string;
  /** Where it came from: an admin, DASH's own history, a future connector. */
  readonly provenance: 'admin' | 'dash_history' | 'partner' | 'connector';
  /** Free text naming the source, e.g. a marketplace name or a reference. */
  readonly source: string;
  readonly description: string;
  readonly variant?: string;
  readonly condition?: ItemCondition;
  /** Where it was observed, as a general market rather than an address. */
  readonly market?: string;
  readonly currency: 'NGN';
  readonly askingPriceKobo?: number;
  /**
   * Only set when a sale is genuinely evidenced. A confirmed sale is worth
   * more than an asking price and should eventually be weighted as such.
   */
  readonly soldPriceKobo?: number;
  readonly observedAt: string;
  readonly note?: string;
}

/** A defect somebody has declared, as distinct from one a photo suggests. */
export interface DeclaredDefect {
  readonly kind: 'cosmetic' | 'functional';
  readonly description: string;
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

export interface ValuationRequest {
  /** Caller's own reference. Opaque to ValueCheck. */
  readonly reference: string;
  readonly categoryKey: string;
  readonly brand?: string;
  readonly model?: string;
  readonly variant?: string;
  readonly condition: ItemCondition;
  /**
   * Category-specific answers: storage and battery health for a phone, hours
   * run for a generator, size and authenticity evidence for fashion. A bag
   * rather than columns, because a sofa and a laptop do not share a schema.
   */
  readonly attributes: Readonly<Record<string, string | number | boolean | null>>;
  readonly declaredDefects: readonly DeclaredDefect[];
  readonly includedAccessories: readonly string[];
  readonly repairHistory?: string;
  readonly ageMonths?: number;
  /**
   * A general market, never a street address — "Lekki, Lagos".
   * ValueCheck has no use for a precise location and no field to hold one.
   */
  readonly marketLocation: string;
  /** What the owner hopes for. An input and a signal, never an output. */
  readonly expectedPriceKobo?: number;
  readonly photos: readonly ValuationPhoto[];
  readonly comparables: readonly Comparable[];
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface ValuationFactor {
  readonly label: string;
  readonly direction: 'raises' | 'lowers' | 'neutral';
  readonly weight: 'high' | 'medium' | 'low';
}

/** Something the reviewer should know the valuation could not establish. */
export interface ValuationWarning {
  readonly code: ValuationWarningCode;
  readonly detail: string;
}

export const VALUATION_WARNING_CODES = [
  'few_comparables',
  'conflicting_comparables',
  'no_confirmed_sales',
  'missing_specifications',
  'uncertain_model',
  'poor_photographs',
  'unknown_functional_state',
  'unknown_repair_history',
  'authenticity_uncertain',
  'rare_item',
  'seller_expectation_far_above',
  'seller_expectation_far_below',
] as const;

export type ValuationWarningCode = (typeof VALUATION_WARNING_CODES)[number];

export interface ValuationResult {
  readonly estimatedLowKobo: number;
  readonly estimatedHighKobo: number;
  readonly recommendedPriceKobo: number;
  /** Basis points, 0–10000. Integers, like every other proportion in DASH. */
  readonly confidenceBasisPoints: number;
  readonly factors: readonly ValuationFactor[];
  readonly warnings: readonly ValuationWarning[];
  /** Prose a reviewer reads. Never shown to the public verbatim. */
  readonly reasoning: string;
  /** A short account of what evidence was actually available. */
  readonly evidenceSummary: string;
  readonly providerName: string;
  readonly modelVersion: string;
  /** Our own prompt and scoring version, so our changes are attributable. */
  readonly algorithmVersion: string;
  /** Whether a real provider produced this, or the local test adapter did. */
  readonly isLive: boolean;
  readonly producedAt: string;
}

/**
 * A provider of valuations.
 *
 * The only thing DASH code knows about any model vendor. Nothing that speaks
 * to a provider returns the provider's own JSON — an adapter maps it into
 * `ValuationResult` or throws, so swapping vendor never reaches the domain.
 */
export interface ValuationPort {
  readonly providerName: string;
  readonly modelVersion: string;
  /** False for the deterministic local adapter. Surfaced, never hidden. */
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
  | 'missing_provenance'
  | 'unknown_warning_code'
  | 'malformed_structure';

export interface ValuationValidation {
  readonly ok: boolean;
  readonly rejections: readonly ValuationRejectionCode[];
}

/**
 * A range wider than this multiple of its own floor is not an estimate.
 *
 * Five leaves room for a genuinely uncertain second-hand estimate with two
 * comparables, and refuses the classic model failure of "₦10,000 to
 * ₦2,000,000" — a spread that tells a reviewer nothing while inviting them to
 * anchor on the midpoint of noise.
 */
const MAX_RANGE_MULTIPLE = 5;

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

const WARNING_CODES: ReadonlySet<string> = new Set(VALUATION_WARNING_CODES);

/**
 * Decide whether a provider's answer is usable at all.
 *
 * Fails closed: anything not positively verified is rejected. This runs before
 * a result is stored, so an unusable valuation never becomes a row a later
 * query might treat as authoritative — and a provider that returns prose,
 * nulls or a shape nobody expected is refused rather than coerced.
 */
export function validateValuationResult(result: unknown): ValuationValidation {
  const rejections: ValuationRejectionCode[] = [];

  if (typeof result !== 'object' || result === null) {
    return { ok: false, rejections: ['malformed_structure'] };
  }

  const candidate = result as Partial<ValuationResult>;
  const prices = [
    candidate.estimatedLowKobo,
    candidate.estimatedHighKobo,
    candidate.recommendedPriceKobo,
  ];

  if (!prices.every((value) => typeof value === 'number' && Number.isInteger(value))) {
    rejections.push('non_integer_kobo');
  }
  if (!prices.every(isPositiveInteger)) {
    rejections.push('non_positive_price');
  }

  const low = candidate.estimatedLowKobo;
  const high = candidate.estimatedHighKobo;
  const recommended = candidate.recommendedPriceKobo;

  if (typeof low === 'number' && typeof high === 'number' && low > high) {
    rejections.push('range_inverted');
  }
  if (
    typeof low === 'number' &&
    typeof high === 'number' &&
    typeof recommended === 'number' &&
    (recommended < low || recommended > high)
  ) {
    rejections.push('recommendation_outside_range');
  }
  if (
    !Number.isInteger(candidate.confidenceBasisPoints) ||
    (candidate.confidenceBasisPoints ?? -1) < 0 ||
    (candidate.confidenceBasisPoints ?? 10_001) > 10_000
  ) {
    rejections.push('confidence_out_of_range');
  }
  if (isPositiveInteger(low) && typeof high === 'number' && high > low * MAX_RANGE_MULTIPLE) {
    rejections.push('range_implausibly_wide');
  }
  if (!Array.isArray(candidate.factors) || candidate.factors.length === 0) {
    rejections.push('no_factors');
  }
  if (typeof candidate.reasoning !== 'string' || candidate.reasoning.trim().length === 0) {
    rejections.push('empty_reasoning');
  }
  if (
    typeof candidate.providerName !== 'string' ||
    candidate.providerName.trim().length === 0 ||
    typeof candidate.modelVersion !== 'string' ||
    candidate.modelVersion.trim().length === 0 ||
    typeof candidate.algorithmVersion !== 'string' ||
    candidate.algorithmVersion.trim().length === 0
  ) {
    rejections.push('missing_provenance');
  }
  if (
    Array.isArray(candidate.warnings) &&
    candidate.warnings.some((warning) => !WARNING_CODES.has(warning?.code))
  ) {
    // A warning code nobody defined cannot be reasoned about downstream, and a
    // model inventing its own vocabulary is a sign the mapping has drifted.
    rejections.push('unknown_warning_code');
  }

  return { ok: rejections.length === 0, rejections };
}

// ---------------------------------------------------------------------------
// Confidence, derived from evidence rather than asserted
// ---------------------------------------------------------------------------

/** Below this, a reviewer should be told plainly that the estimate is weak. */
export const LOW_CONFIDENCE_BASIS_POINTS = 6_000;

export interface EvidenceAssessment {
  readonly confidenceCeilingBasisPoints: number;
  readonly warnings: readonly ValuationWarning[];
}

/**
 * How much confidence the *evidence* can support, regardless of what a model
 * says about itself.
 *
 * A model asked for a confidence score will happily produce 92% for an item it
 * has two conflicting comparables and one blurry photograph of. So confidence
 * is capped here, from things that can be counted: how many comparables there
 * are, whether any is a confirmed sale, whether they agree, how many photo
 * roles are covered, and whether the functional state and repair history are
 * known.
 *
 * The result is a ceiling and a set of warnings, not a score — the provider
 * still offers its own number, and the caller takes the lower of the two.
 */
export function assessEvidence(request: ValuationRequest): EvidenceAssessment {
  const warnings: ValuationWarning[] = [];
  let ceiling = 10_000;

  const priced = request.comparables.filter(
    (comparable) => comparable.soldPriceKobo !== undefined || comparable.askingPriceKobo !== undefined,
  );
  const confirmed = request.comparables.filter((comparable) => comparable.soldPriceKobo !== undefined);

  if (priced.length === 0) {
    ceiling = Math.min(ceiling, 3_000);
    warnings.push({ code: 'few_comparables', detail: 'No comparable market evidence was supplied.' });
  } else if (priced.length < 3) {
    ceiling = Math.min(ceiling, 6_500);
    warnings.push({
      code: 'few_comparables',
      detail: `Only ${priced.length} comparable${priced.length === 1 ? '' : 's'} were supplied.`,
    });
  }

  if (priced.length > 0 && confirmed.length === 0) {
    ceiling = Math.min(ceiling, 8_000);
    warnings.push({
      code: 'no_confirmed_sales',
      detail: 'Every comparable is an asking price. None is a confirmed sale.',
    });
  }

  // Comparables that disagree by more than a factor of two are not describing
  // the same market, and averaging them produces a number that matches nothing.
  const values = priced.map(
    (comparable) => comparable.soldPriceKobo ?? comparable.askingPriceKobo ?? 0,
  );
  if (values.length >= 2) {
    const low = Math.min(...values);
    const high = Math.max(...values);
    if (low > 0 && high / low > 2) {
      ceiling = Math.min(ceiling, 6_000);
      warnings.push({
        code: 'conflicting_comparables',
        detail: 'Comparable prices differ by more than a factor of two.',
      });
    }
  }

  if (!request.brand || !request.model) {
    ceiling = Math.min(ceiling, 6_500);
    warnings.push({
      code: 'uncertain_model',
      detail: 'The exact make or model was not established.',
    });
  }

  if (Object.keys(request.attributes).length === 0) {
    ceiling = Math.min(ceiling, 5_500);
    warnings.push({
      code: 'missing_specifications',
      detail: 'No category-specific specifications were provided.',
    });
  }

  const roles = new Set(request.photos.map((photo) => photo.role));
  if (request.photos.length === 0) {
    ceiling = Math.min(ceiling, 4_000);
    warnings.push({ code: 'poor_photographs', detail: 'No photographs were supplied.' });
  } else if (!roles.has('label') && !roles.has('screen')) {
    ceiling = Math.min(ceiling, 8_000);
    warnings.push({
      code: 'poor_photographs',
      detail: 'No photograph shows a label or model marking.',
    });
  }

  // A photograph cannot show battery health, an intermittent fault, a past
  // board-level repair or whether an appliance actually runs. Where the
  // declared answers do not cover it either, that is genuine uncertainty and
  // has to be said rather than smoothed over.
  if (request.repairHistory === undefined) {
    ceiling = Math.min(ceiling, 8_500);
    warnings.push({
      code: 'unknown_repair_history',
      detail: 'Repair history was not declared, and no photograph can establish it.',
    });
  }

  if (request.expectedPriceKobo !== undefined && priced.length > 0) {
    const midpoint = values.reduce((sum, value) => sum + value, 0) / values.length;
    if (request.expectedPriceKobo > midpoint * 1.6) {
      warnings.push({
        code: 'seller_expectation_far_above',
        detail: 'The owner expects materially more than comparable evidence supports.',
      });
    }
    if (request.expectedPriceKobo > 0 && request.expectedPriceKobo < midpoint * 0.5) {
      // Surfaced deliberately: an owner pricing far under the market is
      // sometimes in a hurry and sometimes selling something that is not
      // theirs, and a reviewer should look at ownership evidence before this
      // is published cheaply.
      warnings.push({
        code: 'seller_expectation_far_below',
        detail: 'The owner expects materially less than comparable evidence supports.',
      });
    }
  }

  return { confidenceCeilingBasisPoints: ceiling, warnings };
}

/**
 * Reconcile what a provider claimed with what the evidence can support.
 *
 * Takes the lower of the two and merges the warning sets, so a confident model
 * cannot talk its way past thin evidence. Warnings are de-duplicated by code —
 * the provider and the evidence check often notice the same thing.
 */
export function reconcileConfidence(
  result: ValuationResult,
  evidence: EvidenceAssessment,
): ValuationResult {
  const seen = new Set<string>();
  const warnings = [...evidence.warnings, ...result.warnings].filter((warning) => {
    if (seen.has(warning.code)) return false;
    seen.add(warning.code);
    return true;
  });

  return {
    ...result,
    confidenceBasisPoints: Math.min(
      result.confidenceBasisPoints,
      evidence.confidenceCeilingBasisPoints,
    ),
    warnings,
  };
}
