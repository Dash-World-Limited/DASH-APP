import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  allowedTransitions,
  assertTransition,
  assessEvidence,
  canTransition,
  DeterministicValuationAdapter,
  escalationReasons,
  ESCALATION_REASONS,
  isAcceptanceValid,
  isEligibleForPublication,
  looksInconsistent,
  PILOT_POLICY,
  PricingDecisionError,
  reconcileConfidence,
  requiresSuperAdmin,
  resolvePricingDecision,
  validateValuationResult,
  VALUECHECK_STATES,
  ValueCheckTransitionError,
  type Comparable,
  type RiskSignals,
  type ValuationRequest,
  type ValuationResult,
  type ValueCheckActor,
} from './index.js';

const ACTORS: readonly ValueCheckActor[] = ['system', 'admin', 'super_admin', 'seller'];

const FIXED_NOW = () => new Date('2026-09-10T09:00:00.000Z');

function comparable(overrides: Partial<Comparable> = {}): Comparable {
  return {
    id: 'cmp_1',
    provenance: 'admin',
    source: 'Marketplace listing',
    description: 'iPhone 13 Pro 128GB',
    condition: 'good',
    market: 'Lagos',
    currency: 'NGN',
    askingPriceKobo: 45_000_000,
    observedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

function request(overrides: Partial<ValuationRequest> = {}): ValuationRequest {
  return {
    reference: 'sub_1',
    categoryKey: 'phones-tablets',
    brand: 'Apple',
    model: 'iPhone 13 Pro',
    condition: 'good',
    attributes: { storageGb: 128, batteryHealth: 86 },
    declaredDefects: [],
    includedAccessories: ['charger'],
    repairHistory: 'None declared',
    ageMonths: 24,
    marketLocation: 'Lekki, Lagos',
    expectedPriceKobo: 47_000_000,
    photos: [
      { id: 'p1', role: 'front', contentType: 'image/jpeg' },
      { id: 'p2', role: 'label', contentType: 'image/jpeg' },
    ],
    comparables: [comparable(), comparable({ id: 'cmp_2', askingPriceKobo: 43_000_000 })],
    ...overrides,
  };
}

const validResult: ValuationResult = {
  estimatedLowKobo: 40_000_000,
  estimatedHighKobo: 46_000_000,
  recommendedPriceKobo: 43_000_000,
  confidenceBasisPoints: 8_000,
  factors: [{ label: 'Condition', direction: 'lowers', weight: 'high' }],
  warnings: [],
  reasoning: 'Anchored on two asking prices.',
  evidenceSummary: '2 comparables',
  providerName: 'test',
  modelVersion: 'v1',
  algorithmVersion: 'valuecheck-1',
  isLive: false,
  producedAt: '2026-09-10T09:00:00.000Z',
};

// ---------------------------------------------------------------------------
// The boundary
// ---------------------------------------------------------------------------

describe('ValueCheck is its own product', () => {
  it('imports nothing from the marketplace', () => {
    // The architectural claim, enforced. ValueCheck must be liftable into a
    // standalone service without dragging Declutter behind it.
    const here = dirname(fileURLToPath(import.meta.url));
    const sources = readdirSync(here).filter(
      (file) => file.endsWith('.ts') && !file.endsWith('.test.ts'),
    );
    expect(sources.length).toBeGreaterThan(0);

    for (const file of sources) {
      const text = readFileSync(join(here, file), 'utf8');
      expect(text, `${file} imports from declutter`).not.toMatch(/from\s+['"][^'"]*declutter/);
    }
  });

  it('has nowhere to put a person', () => {
    // Data minimisation as a type. If any of these ever becomes a valid key on
    // a ValuationRequest, this test is the thing that should have stopped it.
    const forbidden = [
      'legalName',
      'nationalId',
      'nin',
      'phone',
      'email',
      'address',
      'bankAccount',
      'imei',
      'serialNumber',
      'adminNotes',
      'sellerId',
    ];
    const keys = Object.keys(request());
    for (const field of forbidden) {
      expect(keys).not.toContain(field);
    }
  });
});

// ---------------------------------------------------------------------------
// The deterministic adapter
// ---------------------------------------------------------------------------

describe('the local adapter', () => {
  const adapter = new DeterministicValuationAdapter({ now: FIXED_NOW });

  it('says plainly that it is not live AI', async () => {
    const result = await adapter.value(request());
    expect(result.isLive).toBe(false);
    expect(result.providerName).toBe('local-deterministic');
    expect(result.reasoning).toContain('not a live model');
  });

  it('returns the same answer for the same item, every time', async () => {
    const first = await adapter.value(request());
    const second = await adapter.value(request());
    expect(second).toEqual(first);
  });

  it('produces a result that passes validation', async () => {
    expect(validateValuationResult(await adapter.value(request())).ok).toBe(true);
  });

  it('keeps the recommendation inside its own range', async () => {
    const result = await adapter.value(request());
    expect(result.recommendedPriceKobo).toBeGreaterThanOrEqual(result.estimatedLowKobo);
    expect(result.recommendedPriceKobo).toBeLessThanOrEqual(result.estimatedHighKobo);
  });

  it('returns whole kobo, never a fraction', async () => {
    const result = await adapter.value(request({ ageMonths: 7, includedAccessories: ['a', 'b', 'c'] }));
    for (const value of [result.estimatedLowKobo, result.estimatedHighKobo, result.recommendedPriceKobo]) {
      expect(Number.isInteger(value)).toBe(true);
    }
  });

  it('prefers a confirmed sale over an asking price', async () => {
    const asking = await adapter.value(request());
    const sold = await adapter.value(
      request({
        comparables: [comparable({ soldPriceKobo: 45_000_000, askingPriceKobo: undefined })],
      }),
    );
    // An asking price is discounted because it is a hope, not a transaction.
    expect(sold.recommendedPriceKobo).toBeGreaterThan(asking.recommendedPriceKobo);
  });

  it('marks an item down for declared functional defects', async () => {
    const clean = await adapter.value(request());
    const faulty = await adapter.value(
      request({ declaredDefects: [{ kind: 'functional', description: 'Charging port loose' }] }),
    );
    expect(faulty.recommendedPriceKobo).toBeLessThan(clean.recommendedPriceKobo);
  });

  it('still answers with no evidence at all, and says so', async () => {
    const result = await adapter.value(
      request({ comparables: [], photos: [], expectedPriceKobo: undefined, attributes: {} }),
    );
    expect(validateValuationResult(result).ok).toBe(true);
    // Floor confidence rather than a confident guess.
    expect(result.confidenceBasisPoints).toBeLessThanOrEqual(3_000);
  });
});

// ---------------------------------------------------------------------------
// Validation fails closed
// ---------------------------------------------------------------------------

describe('validation', () => {
  it('accepts a well-formed result', () => {
    expect(validateValuationResult(validResult).ok).toBe(true);
  });

  it('refuses a value that is not an object at all', () => {
    for (const bad of [null, undefined, 'a price', 42, []]) {
      expect(validateValuationResult(bad).ok).toBe(false);
    }
    expect(validateValuationResult('nonsense').rejections).toContain('malformed_structure');
  });

  it('refuses an inverted range', () => {
    expect(
      validateValuationResult({ ...validResult, estimatedLowKobo: 90_000_000 }).rejections,
    ).toContain('range_inverted');
  });

  it('refuses a recommendation outside its own range', () => {
    expect(
      validateValuationResult({ ...validResult, recommendedPriceKobo: 90_000_000 }).rejections,
    ).toContain('recommendation_outside_range');
  });

  it('refuses negative and zero prices', () => {
    expect(validateValuationResult({ ...validResult, recommendedPriceKobo: -1 }).ok).toBe(false);
    expect(validateValuationResult({ ...validResult, estimatedLowKobo: 0 }).rejections).toContain(
      'non_positive_price',
    );
  });

  it('refuses fractional kobo', () => {
    expect(
      validateValuationResult({ ...validResult, recommendedPriceKobo: 43_000_000.5 }).rejections,
    ).toContain('non_integer_kobo');
  });

  it('refuses impossible confidence', () => {
    for (const value of [-1, 10_001, 1.5]) {
      expect(
        validateValuationResult({ ...validResult, confidenceBasisPoints: value }).rejections,
      ).toContain('confidence_out_of_range');
    }
  });

  it('refuses a range too wide to mean anything', () => {
    expect(
      validateValuationResult({
        ...validResult,
        estimatedLowKobo: 1_000_000,
        estimatedHighKobo: 200_000_000,
        recommendedPriceKobo: 43_000_000,
      }).rejections,
    ).toContain('range_implausibly_wide');
  });

  it('refuses a result that cannot say which model produced it', () => {
    expect(validateValuationResult({ ...validResult, modelVersion: '' }).rejections).toContain(
      'missing_provenance',
    );
    expect(validateValuationResult({ ...validResult, providerName: '  ' }).rejections).toContain(
      'missing_provenance',
    );
  });

  it('refuses a warning code nobody defined', () => {
    const result = { ...validResult, warnings: [{ code: 'vibes_are_off', detail: 'hmm' }] };
    expect(validateValuationResult(result).rejections).toContain('unknown_warning_code');
  });

  it('refuses a result with no factors or no reasoning', () => {
    expect(validateValuationResult({ ...validResult, factors: [] }).rejections).toContain('no_factors');
    expect(validateValuationResult({ ...validResult, reasoning: '   ' }).rejections).toContain(
      'empty_reasoning',
    );
  });
});

// ---------------------------------------------------------------------------
// Confidence comes from evidence
// ---------------------------------------------------------------------------

describe('confidence reflects the evidence, not the model’s mood', () => {
  it('caps hard when there is no comparable evidence', () => {
    const assessment = assessEvidence(request({ comparables: [] }));
    expect(assessment.confidenceCeilingBasisPoints).toBeLessThanOrEqual(3_000);
    expect(assessment.warnings.map((w) => w.code)).toContain('few_comparables');
  });

  it('notices that every comparable is an asking price', () => {
    const codes = assessEvidence(request()).warnings.map((w) => w.code);
    expect(codes).toContain('no_confirmed_sales');
  });

  it('notices comparables that disagree wildly', () => {
    const assessment = assessEvidence(
      request({
        comparables: [
          comparable({ askingPriceKobo: 10_000_000 }),
          comparable({ id: 'c2', askingPriceKobo: 60_000_000 }),
        ],
      }),
    );
    expect(assessment.warnings.map((w) => w.code)).toContain('conflicting_comparables');
  });

  it('notices a missing make or model', () => {
    const codes = assessEvidence(request({ brand: undefined })).warnings.map((w) => w.code);
    expect(codes).toContain('uncertain_model');
  });

  it('notices missing specifications and missing photographs', () => {
    const codes = assessEvidence(request({ attributes: {}, photos: [] })).warnings.map((w) => w.code);
    expect(codes).toContain('missing_specifications');
    expect(codes).toContain('poor_photographs');
  });

  it('notices that no photograph shows a label', () => {
    const codes = assessEvidence(
      request({ photos: [{ id: 'p', role: 'front', contentType: 'image/jpeg' }] }),
    ).warnings.map((w) => w.code);
    expect(codes).toContain('poor_photographs');
  });

  it('will not let a photograph stand in for repair history', () => {
    // A picture cannot show a past board-level repair, and the absence has to
    // be said rather than smoothed over.
    const codes = assessEvidence(request({ repairHistory: undefined })).warnings.map((w) => w.code);
    expect(codes).toContain('unknown_repair_history');
  });

  it('flags an owner asking far above or far below the market', () => {
    const above = assessEvidence(request({ expectedPriceKobo: 200_000_000 })).warnings.map((w) => w.code);
    expect(above).toContain('seller_expectation_far_above');

    const below = assessEvidence(request({ expectedPriceKobo: 5_000_000 })).warnings.map((w) => w.code);
    expect(below).toContain('seller_expectation_far_below');
  });

  it('takes the lower of the model’s confidence and the evidence ceiling', () => {
    const confident = { ...validResult, confidenceBasisPoints: 9_800 };
    const reconciled = reconcileConfidence(confident, assessEvidence(request({ comparables: [] })));
    expect(reconciled.confidenceBasisPoints).toBeLessThanOrEqual(3_000);
  });

  it('never raises a modest confidence to meet the ceiling', () => {
    const modest = { ...validResult, confidenceBasisPoints: 4_000 };
    const reconciled = reconcileConfidence(modest, assessEvidence(request()));
    expect(reconciled.confidenceBasisPoints).toBe(4_000);
  });
});

// ---------------------------------------------------------------------------
// Escalation policy
// ---------------------------------------------------------------------------

function signals(overrides: Partial<RiskSignals> = {}): RiskSignals {
  return {
    proposedPriceKobo: 1_000_000,
    recommendedPriceKobo: 1_000_000,
    confidenceBasisPoints: 8_000,
    categoryKey: 'phones-tablets',
    hasOpenFraudFlag: false,
    sellerKycConcern: false,
    comparablesConflict: false,
    evidenceInconsistent: false,
    trustedPartnerException: false,
    manuallyEscalated: false,
    ...overrides,
  };
}

describe('super admin escalation', () => {
  it('lets an ordinary, well-evidenced, low-value price through', () => {
    expect(requiresSuperAdmin(signals(), PILOT_POLICY)).toBe(false);
    expect(escalationReasons(signals(), PILOT_POLICY)).toEqual([]);
  });

  it('escalates at the configured threshold, and not a kobo below it', () => {
    const at = signals({ proposedPriceKobo: 5_000_000, recommendedPriceKobo: 5_000_000 });
    const below = signals({ proposedPriceKobo: 4_999_999, recommendedPriceKobo: 4_999_999 });
    expect(escalationReasons(at, PILOT_POLICY)).toContain('price_at_or_above_threshold');
    expect(escalationReasons(below, PILOT_POLICY)).not.toContain('price_at_or_above_threshold');
  });

  it('takes the threshold from policy rather than a constant', () => {
    // The figure is commercial risk appetite, not a fact about valuation.
    const strict = { ...PILOT_POLICY, superAdminApprovalAtOrAboveKobo: 100_000 };
    // Same price and the same recommendation, so nothing here reads as an
    // admin adjustment — only the policy differs between the two calls.
    const priced = signals({ proposedPriceKobo: 200_000, recommendedPriceKobo: 200_000 });
    expect(requiresSuperAdmin(priced, strict)).toBe(true);
    expect(requiresSuperAdmin(priced, PILOT_POLICY)).toBe(false);
  });

  it('escalates on low confidence however small the price', () => {
    const reasons = escalationReasons(signals({ confidenceBasisPoints: 3_000 }), PILOT_POLICY);
    expect(reasons).toContain('low_confidence');
  });

  it('escalates on a fraud flag or a verification concern', () => {
    expect(escalationReasons(signals({ hasOpenFraudFlag: true }), PILOT_POLICY)).toContain('fraud_flag');
    expect(escalationReasons(signals({ sellerKycConcern: true }), PILOT_POLICY)).toContain('kyc_concern');
  });

  it('escalates when an admin moves the price a long way', () => {
    const reasons = escalationReasons(
      signals({ recommendedPriceKobo: 1_000_000, proposedPriceKobo: 1_400_000 }),
      PILOT_POLICY,
    );
    expect(reasons).toContain('large_admin_adjustment');
  });

  it('does not escalate a small correction', () => {
    const reasons = escalationReasons(
      signals({ recommendedPriceKobo: 1_000_000, proposedPriceKobo: 1_050_000 }),
      PILOT_POLICY,
    );
    expect(reasons).not.toContain('large_admin_adjustment');
  });

  it('escalates a high-risk category, a partner exception and a manual escalation', () => {
    const policy = { ...PILOT_POLICY, highRiskCategoryKeys: ['phones-tablets'] };
    expect(escalationReasons(signals(), policy)).toContain('high_risk_category');
    expect(escalationReasons(signals({ trustedPartnerException: true }), PILOT_POLICY)).toContain(
      'trusted_partner_exception',
    );
    expect(escalationReasons(signals({ manuallyEscalated: true }), PILOT_POLICY)).toContain(
      'manual_escalation',
    );
  });

  it('reports every reason, not the first one it finds', () => {
    const reasons = escalationReasons(
      signals({ proposedPriceKobo: 9_000_000, confidenceBasisPoints: 1_000, hasOpenFraudFlag: true }),
      PILOT_POLICY,
    );
    expect(reasons).toContain('price_at_or_above_threshold');
    expect(reasons).toContain('low_confidence');
    expect(reasons).toContain('fraud_flag');
  });

  it('gives every reason a label a person can read', () => {
    for (const reason of ESCALATION_REASONS) {
      expect(reason.length).toBeGreaterThan(0);
    }
  });

  it('spots a result that contradicts itself', () => {
    const overconfident: ValuationResult = {
      ...validResult,
      confidenceBasisPoints: 9_000,
      warnings: [
        { code: 'conflicting_comparables', detail: 'x' },
        { code: 'uncertain_model', detail: 'y' },
      ],
    };
    expect(looksInconsistent(overconfident)).toBe(true);

    // A recommendation pinned to the very edge of its own range.
    expect(
      looksInconsistent({ ...validResult, recommendedPriceKobo: validResult.estimatedLowKobo }),
    ).toBe(true);

    expect(looksInconsistent(validResult)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Authority
// ---------------------------------------------------------------------------

describe('nothing automated may authorise a price', () => {
  it('never lets system authorise, accept or decline', () => {
    for (const state of VALUECHECK_STATES) {
      const reachable = allowedTransitions(state, 'system');
      expect(reachable).not.toContain('price_authorized');
      expect(reachable).not.toContain('seller_accepted');
      expect(reachable).not.toContain('seller_declined');
    }
  });

  it('never lets a seller move a valuation toward authorisation', () => {
    for (const state of VALUECHECK_STATES) {
      const reachable = allowedTransitions(state, 'seller');
      expect(reachable).not.toContain('price_authorized');
      expect(reachable).not.toContain('super_admin_approval_pending');
      expect(reachable).not.toContain('admin_review_pending');
    }
  });

  it('lets only a super admin authorise once approval is required', () => {
    expect(canTransition('super_admin_approval_pending', 'price_authorized', 'admin')).toBe(false);
    expect(canTransition('super_admin_approval_pending', 'price_authorized', 'system')).toBe(false);
    expect(canTransition('super_admin_approval_pending', 'price_authorized', 'seller')).toBe(false);
    expect(canTransition('super_admin_approval_pending', 'price_authorized', 'super_admin')).toBe(true);
  });

  it('lets only the seller accept or decline', () => {
    for (const actor of ACTORS) {
      const allowed = actor === 'seller';
      expect(canTransition('seller_acceptance_pending', 'seller_accepted', actor)).toBe(allowed);
      expect(canTransition('seller_acceptance_pending', 'seller_declined', actor)).toBe(allowed);
    }
  });

  it('throws a typed error on an illegal move', () => {
    expect(() => assertTransition('valuation_pending', 'seller_accepted', 'super_admin')).toThrow(
      ValueCheckTransitionError,
    );
    expect(() => assertTransition('super_admin_approval_pending', 'price_authorized', 'admin')).toThrow(
      ValueCheckTransitionError,
    );
  });

  it('defines transitions for every declared state', () => {
    for (const state of VALUECHECK_STATES) {
      expect(() => allowedTransitions(state, 'super_admin')).not.toThrow();
    }
  });
});

describe('the pricing decision', () => {
  it('approves the recommendation without a reason', () => {
    const decision = resolvePricingDecision({ kind: 'approved', recommendedPriceKobo: 43_000_000 });
    expect(decision.proposedPriceKobo).toBe(43_000_000);
    expect(decision.reason).toBeNull();
  });

  it('refuses an adjustment with no reason', () => {
    expect(() =>
      resolvePricingDecision({
        kind: 'adjusted',
        recommendedPriceKobo: 43_000_000,
        adminPriceKobo: 40_000_000,
      }),
    ).toThrow(PricingDecisionError);
  });

  it('refuses an adjustment that adjusts nothing', () => {
    expect(() =>
      resolvePricingDecision({
        kind: 'adjusted',
        recommendedPriceKobo: 43_000_000,
        adminPriceKobo: 43_000_000,
        reason: 'no change',
      }),
    ).toThrow(PricingDecisionError);
  });

  it('refuses a rejection with no reason', () => {
    expect(() =>
      resolvePricingDecision({ kind: 'rejected', recommendedPriceKobo: 43_000_000 }),
    ).toThrow(PricingDecisionError);
  });

  it('refuses fractional and negative adjusted prices', () => {
    for (const price of [43_000_000.5, -1, 0]) {
      expect(() =>
        resolvePricingDecision({
          kind: 'adjusted',
          recommendedPriceKobo: 43_000_000,
          adminPriceKobo: price,
          reason: 'because',
        }),
      ).toThrow(PricingDecisionError);
    }
  });
});

// ---------------------------------------------------------------------------
// Seller acceptance
// ---------------------------------------------------------------------------

describe('seller acceptance is tied to an exact price and version', () => {
  const authorized = { priceKobo: 43_000_000, version: 2 };
  const acceptance = {
    acceptedPriceKobo: 43_000_000,
    authorizationVersion: 2,
    acceptedAt: '2026-09-10T09:00:00.000Z',
  };

  it('holds for the price and version that was accepted', () => {
    expect(isAcceptanceValid(acceptance, authorized)).toBe(true);
  });

  it('is invalidated by any change to the authorised price', () => {
    expect(isAcceptanceValid(acceptance, { priceKobo: 44_000_000, version: 3 })).toBe(false);
  });

  it('is invalidated by a re-authorisation at the same figure', () => {
    // A new authorisation is a new decision, and agreeing to the old one is
    // not the same as agreeing to this one.
    expect(isAcceptanceValid(acceptance, { priceKobo: 43_000_000, version: 3 })).toBe(false);
  });

  it('is nothing at all when either side is missing', () => {
    expect(isAcceptanceValid(null, authorized)).toBe(false);
    expect(isAcceptanceValid(acceptance, null)).toBe(false);
  });

  it('gates publication eligibility on a live acceptance', () => {
    expect(isEligibleForPublication('seller_accepted', acceptance, authorized)).toBe(true);
    // Accepted, then re-priced: not publishable until the seller says yes again.
    expect(
      isEligibleForPublication('seller_accepted', acceptance, { priceKobo: 44_000_000, version: 3 }),
    ).toBe(false);
    expect(isEligibleForPublication('price_authorized', acceptance, authorized)).toBe(false);
    expect(isEligibleForPublication('seller_declined', acceptance, authorized)).toBe(false);
  });
});
