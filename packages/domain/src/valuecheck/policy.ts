/**
 * DASH ValueCheck — authority, risk policy, and the price a seller accepts.
 *
 * The hierarchy this file exists to make unbreakable:
 *
 *     AI recommends → DASH Admin reviews → Super Admin approves when policy
 *     requires → the seller accepts that exact price.
 *
 * No automated actor appears on any transition that authorises a price,
 * accepts on somebody's behalf, or publishes. That is asserted by tests over
 * the transition table rather than trusted to the routes that call it.
 *
 * ## Why the threshold is not a constant here
 *
 * The pilot escalates anything at or above ₦50,000 to a Super Admin. That
 * number will change — it is a commercial risk appetite, not a fact about
 * valuation — so it lives in `ValueCheckPolicy`, which is configuration a
 * caller supplies. Nothing in this module reads an environment variable or
 * imports a config, and no threshold is written into the logic. Changing the
 * figure is a config change, not a migration and not a domain rewrite.
 */

import type { ValuationResult } from './contract.js';

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export interface ValueCheckPolicy {
  /**
   * At or above this proposed final price, a Super Admin must approve.
   * Integer kobo. The pilot value is supplied by configuration, not by this
   * module.
   */
  readonly superAdminApprovalAtOrAboveKobo: number;
  /** Below this confidence, escalate however small the price. */
  readonly escalateBelowConfidenceBasisPoints: number;
  /**
   * How far an admin may move the recommendation before it is treated as a
   * different valuation rather than a correction. Basis points of the
   * recommendation.
   */
  readonly escalateAdjustmentOverBasisPoints: number;
  /** Categories that always escalate, whatever the number says. */
  readonly highRiskCategoryKeys: readonly string[];
  /**
   * Whether a partner-sourced item needs its source business to confirm the
   * item and price before it may be published. Never a substitute for DASH
   * approval — an additional gate, and an optional one.
   */
  readonly requirePartnerApproval: boolean;
}

/**
 * The pilot policy.
 *
 * Exported as a named default so a caller can pass it explicitly, and so the
 * figure appears in exactly one place. Callers that load policy from
 * configuration override it wholesale; nothing here reaches for the value on
 * its own.
 */
export const PILOT_POLICY: ValueCheckPolicy = {
  superAdminApprovalAtOrAboveKobo: 5_000_000, // ₦50,000
  escalateBelowConfidenceBasisPoints: 6_000,
  escalateAdjustmentOverBasisPoints: 2_000, // a 20% move from the recommendation
  highRiskCategoryKeys: [],
  requirePartnerApproval: false,
};

// ---------------------------------------------------------------------------
// Escalation
// ---------------------------------------------------------------------------

export const ESCALATION_REASONS = [
  'price_at_or_above_threshold',
  'low_confidence',
  'fraud_flag',
  'kyc_concern',
  'large_admin_adjustment',
  'suspicious_comparables',
  'high_risk_category',
  'trusted_partner_exception',
  'manual_escalation',
  'evidence_inconsistent',
] as const;

export type EscalationReason = (typeof ESCALATION_REASONS)[number];

export const ESCALATION_LABELS: Readonly<Record<EscalationReason, string>> = {
  price_at_or_above_threshold: 'At or above the approval threshold',
  low_confidence: 'ValueCheck confidence is low',
  fraud_flag: 'An open fraud or duplicate-image flag',
  kyc_concern: 'A concern on the seller’s verification',
  large_admin_adjustment: 'The admin moved the price a long way',
  suspicious_comparables: 'The comparable evidence looks unreliable',
  high_risk_category: 'A category that always needs approval',
  trusted_partner_exception: 'A Trusted Partner exception was applied',
  manual_escalation: 'Escalated by hand',
  evidence_inconsistent: 'The valuation evidence contradicts itself',
};

/** What the caller knows about the submission when deciding escalation. */
export interface RiskSignals {
  readonly proposedPriceKobo: number;
  readonly recommendedPriceKobo: number | null;
  readonly confidenceBasisPoints: number | null;
  readonly categoryKey: string | null;
  readonly hasOpenFraudFlag: boolean;
  readonly sellerKycConcern: boolean;
  readonly comparablesConflict: boolean;
  readonly evidenceInconsistent: boolean;
  readonly trustedPartnerException: boolean;
  readonly manuallyEscalated: boolean;
}

/**
 * Every reason this price needs a Super Admin, or an empty list.
 *
 * Returns all of them rather than the first, because a screen showing "needs
 * approval" without saying why teaches the approver nothing, and because two
 * independent reasons is itself information.
 */
export function escalationReasons(
  signals: RiskSignals,
  policy: ValueCheckPolicy,
): readonly EscalationReason[] {
  const reasons: EscalationReason[] = [];

  if (signals.proposedPriceKobo >= policy.superAdminApprovalAtOrAboveKobo) {
    reasons.push('price_at_or_above_threshold');
  }
  if (
    signals.confidenceBasisPoints !== null &&
    signals.confidenceBasisPoints < policy.escalateBelowConfidenceBasisPoints
  ) {
    reasons.push('low_confidence');
  }
  if (signals.hasOpenFraudFlag) reasons.push('fraud_flag');
  if (signals.sellerKycConcern) reasons.push('kyc_concern');

  if (signals.recommendedPriceKobo !== null && signals.recommendedPriceKobo > 0) {
    const movement =
      Math.abs(signals.proposedPriceKobo - signals.recommendedPriceKobo) /
      signals.recommendedPriceKobo;
    if (movement * 10_000 > policy.escalateAdjustmentOverBasisPoints) {
      reasons.push('large_admin_adjustment');
    }
  }

  if (signals.comparablesConflict) reasons.push('suspicious_comparables');
  if (signals.categoryKey && policy.highRiskCategoryKeys.includes(signals.categoryKey)) {
    reasons.push('high_risk_category');
  }
  if (signals.trustedPartnerException) reasons.push('trusted_partner_exception');
  if (signals.manuallyEscalated) reasons.push('manual_escalation');
  if (signals.evidenceInconsistent) reasons.push('evidence_inconsistent');

  return reasons;
}

export function requiresSuperAdmin(signals: RiskSignals, policy: ValueCheckPolicy): boolean {
  return escalationReasons(signals, policy).length > 0;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Where a valuation is in the controlled process.
 *
 * A raw model run is `valuation_completed` and nothing more. "DASH
 * ValueChecked" means this machine reached `seller_accepted`, which is why the
 * two are different words in different places.
 */
export const VALUECHECK_STATES = [
  'valuation_pending',
  'valuation_completed',
  'admin_review_pending',
  'super_admin_approval_pending',
  /** Authority is complete and the number is final. */
  'price_authorized',
  /** The seller has been shown that number and has not answered. */
  'seller_acceptance_pending',
  'seller_accepted',
  'seller_declined',
  /** The run failed, or a reviewer rejected the valuation outright. */
  'rejected',
] as const;

export type ValueCheckState = (typeof VALUECHECK_STATES)[number];

/** Who may move a valuation. `system` is a job, never a judgement. */
export type ValueCheckActor = 'system' | 'admin' | 'super_admin' | 'seller';

interface Rule {
  readonly to: ValueCheckState;
  readonly actors: readonly ValueCheckActor[];
}

/**
 * The transition table.
 *
 * `system` appears exactly three times, and never on a judgement: it completes
 * a run, it fails one, and it presents an authorised price to a seller. It
 * cannot authorise, cannot adjust, cannot accept and cannot reject on the
 * merits.
 *
 * `seller` appears exactly twice, on accepting and declining. A seller can
 * never move a valuation toward authorisation, and never set a number.
 */
const TRANSITIONS: Readonly<Record<ValueCheckState, readonly Rule[]>> = {
  valuation_pending: [
    { to: 'valuation_completed', actors: ['system'] },
    // A failed or refused provider result returns the submission to a human
    // rather than stalling in a queue.
    { to: 'rejected', actors: ['system', 'admin', 'super_admin'] },
  ],
  valuation_completed: [
    { to: 'admin_review_pending', actors: ['system', 'admin', 'super_admin'] },
    { to: 'rejected', actors: ['admin', 'super_admin'] },
  ],
  admin_review_pending: [
    { to: 'super_admin_approval_pending', actors: ['admin', 'super_admin'] },
    // Only reachable when policy says no approval is required. The route
    // checks that; the table permits it only for an admin.
    { to: 'price_authorized', actors: ['admin', 'super_admin'] },
    { to: 'valuation_pending', actors: ['admin', 'super_admin'] },
    { to: 'rejected', actors: ['admin', 'super_admin'] },
  ],
  super_admin_approval_pending: [
    { to: 'price_authorized', actors: ['super_admin'] },
    { to: 'admin_review_pending', actors: ['super_admin'] },
    { to: 'valuation_pending', actors: ['super_admin'] },
    { to: 'rejected', actors: ['super_admin'] },
  ],
  price_authorized: [
    { to: 'seller_acceptance_pending', actors: ['system', 'admin', 'super_admin'] },
    // Re-pricing before the seller has answered. Any acceptance already held
    // is invalidated by the version check, not by this transition.
    { to: 'admin_review_pending', actors: ['admin', 'super_admin'] },
  ],
  seller_acceptance_pending: [
    { to: 'seller_accepted', actors: ['seller'] },
    { to: 'seller_declined', actors: ['seller'] },
    // A price may be revisited while the seller is deciding.
    { to: 'admin_review_pending', actors: ['admin', 'super_admin'] },
  ],
  seller_accepted: [
    // Re-pricing after acceptance is allowed, and invalidates the acceptance.
    { to: 'admin_review_pending', actors: ['admin', 'super_admin'] },
  ],
  seller_declined: [{ to: 'admin_review_pending', actors: ['admin', 'super_admin'] }],
  rejected: [{ to: 'valuation_pending', actors: ['admin', 'super_admin'] }],
};

export class ValueCheckTransitionError extends Error {
  constructor(
    readonly from: ValueCheckState,
    readonly to: ValueCheckState,
    readonly actor: ValueCheckActor,
    readonly reason: 'illegal_transition' | 'actor_not_permitted',
  ) {
    super(`valuecheck: ${actor} cannot move ${from} → ${to} (${reason})`);
    this.name = 'ValueCheckTransitionError';
  }
}

export function canTransition(
  from: ValueCheckState,
  to: ValueCheckState,
  actor: ValueCheckActor,
): boolean {
  return TRANSITIONS[from].some((rule) => rule.to === to && rule.actors.includes(actor));
}

export function allowedTransitions(
  from: ValueCheckState,
  actor: ValueCheckActor,
): readonly ValueCheckState[] {
  return TRANSITIONS[from].filter((rule) => rule.actors.includes(actor)).map((rule) => rule.to);
}

export function assertTransition(
  from: ValueCheckState,
  to: ValueCheckState,
  actor: ValueCheckActor,
): ValueCheckState {
  const rule = TRANSITIONS[from].find((candidate) => candidate.to === to);
  if (!rule) throw new ValueCheckTransitionError(from, to, actor, 'illegal_transition');
  if (!rule.actors.includes(actor)) {
    throw new ValueCheckTransitionError(from, to, actor, 'actor_not_permitted');
  }
  return to;
}

// ---------------------------------------------------------------------------
// The human decision
// ---------------------------------------------------------------------------

export type PricingDecisionKind = 'approved' | 'adjusted' | 'rejected';

export interface PricingDecisionInput {
  readonly kind: PricingDecisionKind;
  readonly recommendedPriceKobo: number;
  readonly adminPriceKobo?: number;
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
 * Turn a reviewer's decision into a proposed price.
 *
 * "Proposed", not final: this is what the reviewer thinks, and it becomes
 * authoritative only once every approval the policy demands has happened.
 *
 * Adjusting requires a reason, and an adjustment that adjusts nothing is
 * refused so the history does not fill with them. The AI's own recommendation
 * is never overwritten by any of this — the caller stores both, so nothing can
 * later imply the model recommended a figure a person chose.
 */
export function resolvePricingDecision(input: PricingDecisionInput): {
  readonly proposedPriceKobo: number | null;
  readonly reason: string | null;
} {
  if (input.kind === 'approved') {
    if (!Number.isInteger(input.recommendedPriceKobo) || input.recommendedPriceKobo <= 0) {
      throw new PricingDecisionError(
        'non_positive_price',
        'Cannot approve a recommendation that is not a positive whole number of kobo.',
      );
    }
    return { proposedPriceKobo: input.recommendedPriceKobo, reason: null };
  }

  if (input.kind === 'rejected') {
    if (!input.reason?.trim()) {
      throw new PricingDecisionError(
        'reason_required',
        'Rejecting a valuation requires a reason the seller can be told.',
      );
    }
    return { proposedPriceKobo: null, reason: input.reason.trim() };
  }

  if (input.adminPriceKobo === undefined) {
    throw new PricingDecisionError('price_required', 'An adjustment needs a price.');
  }
  if (!Number.isInteger(input.adminPriceKobo)) {
    throw new PricingDecisionError('non_integer_kobo', 'Prices are whole kobo.');
  }
  if (input.adminPriceKobo <= 0) {
    throw new PricingDecisionError('non_positive_price', 'A price must be above zero.');
  }
  if (input.adminPriceKobo === input.recommendedPriceKobo) {
    throw new PricingDecisionError(
      'price_must_differ',
      'That is the recommended price — approve it rather than recording an adjustment.',
    );
  }
  if (!input.reason?.trim()) {
    throw new PricingDecisionError(
      'reason_required',
      'Changing the recommended price requires a reason.',
    );
  }

  return { proposedPriceKobo: input.adminPriceKobo, reason: input.reason.trim() };
}

// ---------------------------------------------------------------------------
// Seller acceptance, tied to an exact price
// ---------------------------------------------------------------------------

/**
 * What a seller actually agreed to.
 *
 * Both fields matter. The price is what they said yes to; the version is which
 * authorisation produced it. Storing only the price would let a re-authorised
 * price that happened to land on the same figure inherit an old agreement,
 * which is not the same thing as the seller agreeing again.
 */
export interface SellerAcceptance {
  readonly acceptedPriceKobo: number;
  readonly authorizationVersion: number;
  readonly acceptedAt: string;
}

export interface AuthorizedPrice {
  readonly priceKobo: number;
  readonly version: number;
}

/**
 * Is this acceptance still good for the price that is currently authorised?
 *
 * Any change to the authorised price — or a fresh authorisation at the same
 * figure — invalidates it, and the seller has to say yes again. A listing may
 * not publish without a valid acceptance for the exact authoritative price,
 * and this is the function that decides it.
 */
export function isAcceptanceValid(
  acceptance: SellerAcceptance | null,
  authorized: AuthorizedPrice | null,
): boolean {
  if (!acceptance || !authorized) return false;
  return (
    acceptance.acceptedPriceKobo === authorized.priceKobo &&
    acceptance.authorizationVersion === authorized.version
  );
}

/** Whether a submission could be published, as far as pricing is concerned. */
export function isEligibleForPublication(
  state: ValueCheckState,
  acceptance: SellerAcceptance | null,
  authorized: AuthorizedPrice | null,
): boolean {
  return state === 'seller_accepted' && isAcceptanceValid(acceptance, authorized);
}

/**
 * Does this result look internally inconsistent?
 *
 * A separate question from validity. A result can be structurally valid and
 * still tell a story that does not hold together — a high confidence on an
 * item with several serious warnings, or a recommendation sitting at the very
 * edge of its own range. Neither is a reason to throw the result away; both
 * are reasons for a person to look, which is why this feeds escalation rather
 * than validation.
 */
export function looksInconsistent(result: ValuationResult): boolean {
  const seriousWarnings = result.warnings.filter(
    (warning) =>
      warning.code === 'conflicting_comparables' ||
      warning.code === 'uncertain_model' ||
      warning.code === 'authenticity_uncertain',
  ).length;

  if (result.confidenceBasisPoints >= 8_000 && seriousWarnings >= 2) return true;

  const span = result.estimatedHighKobo - result.estimatedLowKobo;
  if (span > 0) {
    const position = (result.recommendedPriceKobo - result.estimatedLowKobo) / span;
    if (position <= 0.02 || position >= 0.98) return true;
  }
  return false;
}
