import { describe, expect, it } from 'vitest';
import { kobo, naira, type Kobo } from '../money/index.js';
import {
  buildQuote,
  checkMinimumOrder,
  computeBaseDeliveryFee,
  computeSettlement,
  PRICING_RULE_VERSION,
  PricingError,
  type AppliedDiscount,
  type MembershipBenefits,
  type PricingRules,
  type TripEstimate,
} from './index.js';

const RULES: PricingRules = {
  currency: 'NGN',
  baseDeliveryFee: naira(400),
  includedMetres: 2000,
  perKilometreFee: naira(120),
  perMinuteFee: naira(0),
  minimumDeliveryFee: naira(300),
  maximumDeliveryFee: naira(3500),
  serviceFeeBasisPoints: 500, // 5%
  serviceFeeCap: naira(500),
  smallOrderThreshold: naira(2000),
  smallOrderFee: naira(200),
  taxBasisPoints: 0,
  maximumSurgeMultiplier: 2.0,
};

const TRIP: TripEstimate = {
  distanceMetres: 5000,
  durationMinutes: 18,
  distanceSource: 'haversine_with_detour_factor',
};

/** Sum every line — must always equal the stated total. */
function sumLines(lines: readonly { amount: Kobo }[]): number {
  return lines.reduce((total, line) => total + line.amount, 0);
}

describe('computeBaseDeliveryFee', () => {
  it('charges the base fee within the included distance', () => {
    const fee = computeBaseDeliveryFee(RULES, { ...TRIP, distanceMetres: 1500 });
    expect(fee).toBe(naira(400));
  });

  it('charges per km beyond the included distance, on the exact fraction', () => {
    // 5000m - 2000m included = 3km × ₦120 = ₦360, plus ₦400 base = ₦760
    expect(computeBaseDeliveryFee(RULES, TRIP)).toBe(naira(760));
  });

  it('does not round the overage up — 2.4km is charged as 2.4km', () => {
    // 4400m - 2000m = 2.4km × ₦120 = ₦288, + ₦400 = ₦688 (not ₦760 for 3km)
    const fee = computeBaseDeliveryFee(RULES, { ...TRIP, distanceMetres: 4400 });
    expect(fee).toBe(naira(688));
  });

  it('respects the floor and the ceiling', () => {
    const cheap: PricingRules = { ...RULES, baseDeliveryFee: naira(50) };
    expect(computeBaseDeliveryFee(cheap, { ...TRIP, distanceMetres: 0 })).toBe(naira(300));

    const veryFar = computeBaseDeliveryFee(RULES, { ...TRIP, distanceMetres: 100_000 });
    expect(veryFar).toBe(naira(3500));
  });

  it('rejects impossible trips', () => {
    expect(() => computeBaseDeliveryFee(RULES, { ...TRIP, distanceMetres: -1 })).toThrow(
      PricingError,
    );
    expect(() =>
      computeBaseDeliveryFee(RULES, { ...TRIP, durationMinutes: Number.NaN }),
    ).toThrow(PricingError);
  });
});

describe('checkMinimumOrder', () => {
  it('reports the exact shortfall', () => {
    const result = checkMinimumOrder({
      itemsSubtotal: naira(1500),
      vendorMinimumOrder: naira(2500),
    });
    expect(result.meetsMinimum).toBe(false);
    expect(result.shortfall).toBe(naira(1000));
  });

  it('passes when there is no minimum', () => {
    expect(checkMinimumOrder({ itemsSubtotal: naira(100) }).meetsMinimum).toBe(true);
  });
});

describe('buildQuote — totals', () => {
  it('stamps the rule version so a quote can be reconstructed later', () => {
    const quote = buildQuote({ rules: RULES, mode: 'delivery', itemsSubtotal: naira(5000), trip: TRIP });
    expect(quote.ruleVersion).toBe(PRICING_RULE_VERSION);
  });

  it('produces a total that equals the sum of its explained lines', () => {
    const quote = buildQuote({
      rules: RULES,
      mode: 'delivery',
      itemsSubtotal: naira(5000),
      trip: TRIP,
      tip: naira(500),
    });
    expect(sumLines(quote.lines)).toBe(quote.total);
  });

  it('computes a plain delivery order correctly', () => {
    const quote = buildQuote({
      rules: RULES,
      mode: 'delivery',
      itemsSubtotal: naira(5000),
      trip: TRIP,
    });
    // items 5000 + delivery 760 + service 5% of 5000 = 250 → 6010
    expect(quote.itemsSubtotal).toBe(naira(5000));
    expect(quote.deliveryFee).toBe(naira(760));
    expect(quote.serviceFee).toBe(naira(250));
    expect(quote.smallOrderFee).toBe(0);
    expect(quote.total).toBe(naira(6010));
  });

  it('charges no delivery fee on pickup orders', () => {
    const quote = buildQuote({ rules: RULES, mode: 'pickup', itemsSubtotal: naira(5000) });
    expect(quote.deliveryFee).toBe(0);
    expect(quote.smallOrderFee).toBe(0);
    expect(quote.total).toBe(naira(5250));
  });

  it('requires a trip estimate for delivery modes', () => {
    expect(() => buildQuote({ rules: RULES, mode: 'delivery', itemsSubtotal: naira(5000) })).toThrow(
      PricingError,
    );
  });

  it('caps the service fee', () => {
    const quote = buildQuote({
      rules: RULES,
      mode: 'delivery',
      itemsSubtotal: naira(100_000), // 5% would be ₦5,000
      trip: TRIP,
    });
    expect(quote.serviceFee).toBe(naira(500));
  });

  it('rejects a negative subtotal or tip', () => {
    expect(() =>
      buildQuote({ rules: RULES, mode: 'pickup', itemsSubtotal: kobo(-1) }),
    ).toThrow(PricingError);
    expect(() =>
      buildQuote({ rules: RULES, mode: 'pickup', itemsSubtotal: naira(100), tip: kobo(-1) }),
    ).toThrow(PricingError);
  });
});

describe('buildQuote — surge policy', () => {
  it('applies surge to the delivery fee only, never to the food', () => {
    const quote = buildQuote({
      rules: RULES,
      mode: 'delivery',
      itemsSubtotal: naira(5000),
      trip: TRIP,
      surgeMultiplier: 1.5,
    });
    // Food is untouched.
    expect(quote.itemsSubtotal).toBe(naira(5000));
    // Delivery 760 × 1.5 = 1140, so surge is 380.
    expect(quote.surgeAmount).toBe(naira(380));
    expect(quote.deliveryFee).toBe(naira(1140));
  });

  it('never exceeds the configured maximum surge', () => {
    const quote = buildQuote({
      rules: RULES,
      mode: 'delivery',
      itemsSubtotal: naira(5000),
      trip: TRIP,
      surgeMultiplier: 9, // an ops mistake
    });
    expect(quote.inputs.surgeMultiplier).toBe(2.0);
  });

  it('rejects a surge below 1 rather than silently clamping a data error', () => {
    expect(() =>
      buildQuote({
        rules: RULES,
        mode: 'delivery',
        itemsSubtotal: naira(5000),
        trip: TRIP,
        surgeMultiplier: 0.5,
      }),
    ).toThrow(PricingError);
  });

  it('exempts members from surge entirely', () => {
    const membership: MembershipBenefits = {
      freeDeliveryEligible: false,
      freeDeliveryMinimumSubtotal: naira(0),
      serviceFeeDiscountBasisPoints: 0,
      surgeExempt: true,
    };
    const quote = buildQuote({
      rules: RULES,
      mode: 'delivery',
      itemsSubtotal: naira(5000),
      trip: TRIP,
      surgeMultiplier: 1.8,
      membership,
    });
    expect(quote.surgeAmount).toBe(0);
    expect(quote.inputs.surgeMultiplier).toBe(1);
  });
});

describe('buildQuote — discounts', () => {
  const tenPercentOff: AppliedDiscount = {
    code: 'DASH10',
    promotionId: 'promo_1',
    kind: 'percentage_off_items',
    basisPoints: 1000,
    fundedBy: 'platform',
  };

  it('applies a percentage discount to items', () => {
    const quote = buildQuote({
      rules: RULES,
      mode: 'delivery',
      itemsSubtotal: naira(5000),
      trip: TRIP,
      discounts: [tenPercentOff],
    });
    expect(quote.discountTotal).toBe(naira(500));
    // Service fee is charged on the DISCOUNTED subtotal: 5% of 4500 = 225.
    expect(quote.serviceFee).toBe(naira(225));
    expect(quote.total).toBe(naira(5485)); // 4500 + 760 + 225
  });

  it('honours a maximum discount cap', () => {
    const capped: AppliedDiscount = { ...tenPercentOff, maximumDiscount: naira(300) };
    const quote = buildQuote({
      rules: RULES,
      mode: 'delivery',
      itemsSubtotal: naira(5000),
      trip: TRIP,
      discounts: [capped],
    });
    expect(quote.discountTotal).toBe(naira(300));
  });

  it('never lets a discount exceed what it discounts', () => {
    const absurd: AppliedDiscount = {
      code: 'OOPS',
      promotionId: 'promo_2',
      kind: 'fixed_off_items',
      amount: naira(999_999),
      fundedBy: 'platform',
    };
    const quote = buildQuote({
      rules: RULES,
      mode: 'delivery',
      itemsSubtotal: naira(5000),
      trip: TRIP,
      discounts: [absurd],
    });
    expect(quote.discountTotal).toBe(naira(5000));
    expect(quote.total).toBeGreaterThanOrEqual(0);
  });

  it('zeroes the delivery fee for a free-delivery promo', () => {
    const freeDelivery: AppliedDiscount = {
      code: 'FREESHIP',
      promotionId: 'promo_3',
      kind: 'free_delivery',
      fundedBy: 'platform',
    };
    const quote = buildQuote({
      rules: RULES,
      mode: 'delivery',
      itemsSubtotal: naira(5000),
      trip: TRIP,
      discounts: [freeDelivery],
    });
    expect(quote.deliveryFee).toBe(0);
    expect(quote.total).toBe(naira(5250));
  });

  it('splits funding between platform and vendor for settlement', () => {
    const shared: AppliedDiscount = {
      code: 'SHARED',
      promotionId: 'promo_4',
      kind: 'fixed_off_items',
      amount: naira(1000),
      fundedBy: 'shared',
      vendorShareBasisPoints: 4000, // vendor pays 40%
    };
    const quote = buildQuote({
      rules: RULES,
      mode: 'delivery',
      itemsSubtotal: naira(5000),
      trip: TRIP,
      discounts: [shared],
    });
    expect(quote.vendorFundedDiscount).toBe(naira(400));
    expect(quote.platformFundedDiscount).toBe(naira(600));
    // The customer's total is unaffected by who funds it.
    expect(quote.discountTotal).toBe(naira(1000));
  });

  it('rejects a malformed discount instead of guessing', () => {
    const broken: AppliedDiscount = {
      code: 'BROKEN',
      promotionId: 'promo_5',
      kind: 'percentage_off_items',
      fundedBy: 'platform',
      // basisPoints missing
    };
    expect(() =>
      buildQuote({ rules: RULES, mode: 'delivery', itemsSubtotal: naira(5000), trip: TRIP, discounts: [broken] }),
    ).toThrow(PricingError);
  });
});

describe('buildQuote — small order fee cannot be dodged with a promo', () => {
  it('charges the fee on a genuinely small basket', () => {
    const quote = buildQuote({
      rules: RULES,
      mode: 'delivery',
      itemsSubtotal: naira(1500),
      trip: TRIP,
    });
    expect(quote.smallOrderFee).toBe(naira(200));
  });

  it('does not charge it on a basket above the threshold', () => {
    const quote = buildQuote({
      rules: RULES,
      mode: 'delivery',
      itemsSubtotal: naira(2500),
      trip: TRIP,
    });
    expect(quote.smallOrderFee).toBe(0);
  });

  it('still does not charge it when a promo pushes the basket under the threshold', () => {
    // ₦2,500 basket with ₦1,000 off would be ₦1,500 — under the ₦2,000
    // threshold. The fee is assessed on the PRE-discount subtotal, so it stays
    // off. A customer cannot use a promo code to trigger a fee.
    const quote = buildQuote({
      rules: RULES,
      mode: 'delivery',
      itemsSubtotal: naira(2500),
      trip: TRIP,
      discounts: [
        {
          code: 'BIG',
          promotionId: 'promo_6',
          kind: 'fixed_off_items',
          amount: naira(1000),
          fundedBy: 'platform',
        },
      ],
    });
    expect(quote.smallOrderFee).toBe(0);
  });
});

describe('buildQuote — membership', () => {
  const membership: MembershipBenefits = {
    freeDeliveryEligible: true,
    freeDeliveryMinimumSubtotal: naira(3000),
    serviceFeeDiscountBasisPoints: 5000, // half off the service fee
    surgeExempt: false,
  };

  it('grants free delivery above the minimum basket', () => {
    const quote = buildQuote({
      rules: RULES,
      mode: 'delivery',
      itemsSubtotal: naira(5000),
      trip: TRIP,
      membership,
    });
    expect(quote.deliveryFee).toBe(0);
    expect(quote.serviceFee).toBe(naira(125)); // 250 halved
  });

  it('does not grant free delivery below the minimum basket', () => {
    const quote = buildQuote({
      rules: RULES,
      mode: 'delivery',
      itemsSubtotal: naira(2500),
      trip: TRIP,
      membership,
    });
    expect(quote.deliveryFee).toBe(naira(760));
  });

  it('does not stack a free-delivery promo and membership past the fee itself', () => {
    const quote = buildQuote({
      rules: RULES,
      mode: 'delivery',
      itemsSubtotal: naira(5000),
      trip: TRIP,
      membership,
      discounts: [
        { code: 'FREESHIP', promotionId: 'p', kind: 'free_delivery', fundedBy: 'platform' },
      ],
    });
    expect(quote.deliveryFee).toBe(0);
    expect(quote.total).toBeGreaterThanOrEqual(0);
    expect(sumLines(quote.lines)).toBe(quote.total);
  });
});

describe('buildQuote — wallet credit', () => {
  it('applies credit and never produces a negative total', () => {
    const quote = buildQuote({
      rules: RULES,
      mode: 'pickup',
      itemsSubtotal: naira(1000),
      walletCredit: naira(99_999),
    });
    expect(quote.total).toBe(0);
    // Only what was actually needed is consumed.
    expect(quote.walletCreditApplied).toBe(naira(1050));
  });

  it('applies partial credit', () => {
    const quote = buildQuote({
      rules: RULES,
      mode: 'pickup',
      itemsSubtotal: naira(1000),
      walletCredit: naira(500),
    });
    expect(quote.walletCreditApplied).toBe(naira(500));
    expect(quote.total).toBe(naira(550));
  });

  it('rejects negative credit', () => {
    expect(() =>
      buildQuote({ rules: RULES, mode: 'pickup', itemsSubtotal: naira(1000), walletCredit: kobo(-1) }),
    ).toThrow(PricingError);
  });
});

describe('buildQuote — tax', () => {
  it('taxes fees but never the food', () => {
    const taxed: PricingRules = { ...RULES, taxBasisPoints: 750 }; // 7.5%
    const quote = buildQuote({
      rules: taxed,
      mode: 'delivery',
      itemsSubtotal: naira(5000),
      trip: TRIP,
    });
    // Taxable = delivery 760 + service 250 = 1010 → 7.5% = 75.75 → ₦75.75
    expect(quote.tax).toBe(kobo(7575));
    expect(sumLines(quote.lines)).toBe(quote.total);
  });

  it('does not tax the tip', () => {
    const taxed: PricingRules = { ...RULES, taxBasisPoints: 750 };
    const withTip = buildQuote({
      rules: taxed,
      mode: 'delivery',
      itemsSubtotal: naira(5000),
      trip: TRIP,
      tip: naira(1000),
    });
    const withoutTip = buildQuote({
      rules: taxed,
      mode: 'delivery',
      itemsSubtotal: naira(5000),
      trip: TRIP,
    });
    expect(withTip.tax).toBe(withoutTip.tax);
  });
});

describe('determinism', () => {
  it('produces byte-identical quotes for identical inputs', () => {
    const input = {
      rules: RULES,
      mode: 'delivery' as const,
      itemsSubtotal: naira(7350),
      trip: TRIP,
      surgeMultiplier: 1.35,
      tip: naira(300),
      discounts: [
        {
          code: 'DASH10',
          promotionId: 'p',
          kind: 'percentage_off_items' as const,
          basisPoints: 1000,
          fundedBy: 'platform' as const,
        },
      ],
    };
    expect(JSON.stringify(buildQuote(input))).toBe(JSON.stringify(buildQuote(input)));
  });

  it('keeps lines summing to the total across randomised baskets', () => {
    for (let i = 0; i < 300; i += 1) {
      const quote = buildQuote({
        rules: RULES,
        mode: 'delivery',
        itemsSubtotal: kobo(Math.floor(Math.random() * 2_000_000)),
        trip: { ...TRIP, distanceMetres: Math.floor(Math.random() * 20_000) },
        surgeMultiplier: 1 + Math.random(),
        tip: kobo(Math.floor(Math.random() * 100_000)),
      });
      expect(sumLines(quote.lines)).toBe(quote.total);
      expect(quote.total).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('computeSettlement', () => {
  it('pays the vendor their food revenue less commission', () => {
    const quote = buildQuote({
      rules: RULES,
      mode: 'delivery',
      itemsSubtotal: naira(5000),
      trip: TRIP,
    });
    const split = computeSettlement({
      quote,
      commissionBasisPoints: 1800, // 18%
      riderDeliveryPay: naira(600),
    });
    expect(split.vendorCommission).toBe(naira(900));
    expect(split.vendorPayable).toBe(naira(4100));
  });

  it('passes the tip to the rider in full, with no platform cut', () => {
    const quote = buildQuote({
      rules: RULES,
      mode: 'delivery',
      itemsSubtotal: naira(5000),
      trip: TRIP,
      tip: naira(1000),
    });
    const split = computeSettlement({
      quote,
      commissionBasisPoints: 1800,
      riderDeliveryPay: naira(600),
    });
    expect(split.riderPayable).toBe(naira(1600));
  });

  it('charges the vendor only for the discount share they agreed to fund', () => {
    const quote = buildQuote({
      rules: RULES,
      mode: 'delivery',
      itemsSubtotal: naira(5000),
      trip: TRIP,
      discounts: [
        {
          code: 'VENDORPROMO',
          promotionId: 'p',
          kind: 'fixed_off_items',
          amount: naira(1000),
          fundedBy: 'vendor',
        },
      ],
    });
    const split = computeSettlement({
      quote,
      commissionBasisPoints: 1800,
      riderDeliveryPay: naira(600),
    });
    // Vendor gross = 5000 - 1000 = 4000; commission 18% = 720; payable 3280.
    expect(split.vendorPayable).toBe(naira(3280));
  });

  it('conserves money — every kobo the customer paid is accounted for', () => {
    // The invariant, stated exactly:
    //
    //   vendor + rider + platform + tax  =  card charge + wallet credit
    //
    // No correction term. A platform-funded discount does not appear on either
    // side, because `computeSettlement` already deducts the subsidy from
    // `platformRevenue` — the platform pays the vendor full menu price out of
    // its own margin. The subsidy nets to zero across the equation, which is
    // precisely what makes it a subsidy rather than a leak.
    //
    // If this assertion ever fails, money is being created or destroyed
    // somewhere between the quote and the settlement. Nothing ships past it.
    const quote = buildQuote({
      rules: RULES,
      mode: 'delivery',
      itemsSubtotal: naira(8000),
      trip: TRIP,
      tip: naira(500),
      discounts: [
        {
          code: 'DASH10',
          promotionId: 'p',
          kind: 'percentage_off_items',
          basisPoints: 1000,
          fundedBy: 'platform',
        },
      ],
    });
    const split = computeSettlement({
      quote,
      commissionBasisPoints: 1800,
      riderDeliveryPay: naira(700),
    });

    const distributed =
      split.vendorPayable + split.riderPayable + split.platformRevenue + split.taxCollected;
    const collected = quote.total + quote.walletCreditApplied;

    expect(distributed).toBe(collected);
  });

  /**
   * The regression suite for the bug that unbalanced the ledger on the first
   * real checkout.
   *
   * The original `computeSettlement` subtracted the whole platform-funded
   * discount from platform revenue. That is right for an item discount and
   * wrong for a delivery waiver: the delivery fee was never charged, so
   * deducting it again counted the same waiver twice and invented money.
   *
   * Only the item-discount case was covered before, so the suite passed while
   * the free-delivery path was broken. All four combinations are pinned now.
   */
  describe('money conservation across every discount shape', () => {
    const cases = [
      { label: 'no discount at all', discounts: [] as AppliedDiscount[], membership: undefined },
      {
        label: 'platform-funded item discount',
        discounts: [
          {
            code: 'P_ITEM',
            promotionId: 'p',
            kind: 'percentage_off_items',
            basisPoints: 1000,
            fundedBy: 'platform',
          } satisfies AppliedDiscount,
        ],
        membership: undefined,
      },
      {
        label: 'vendor-funded item discount',
        discounts: [
          {
            code: 'V_ITEM',
            promotionId: 'p',
            kind: 'fixed_off_items',
            amount: naira(800),
            fundedBy: 'vendor',
          } satisfies AppliedDiscount,
        ],
        membership: undefined,
      },
      {
        label: 'platform-funded free delivery',
        discounts: [
          {
            code: 'P_SHIP',
            promotionId: 'p',
            kind: 'free_delivery',
            fundedBy: 'platform',
          } satisfies AppliedDiscount,
        ],
        membership: undefined,
      },
      {
        label: 'vendor-funded free delivery',
        discounts: [
          {
            code: 'V_SHIP',
            promotionId: 'p',
            kind: 'free_delivery',
            fundedBy: 'vendor',
          } satisfies AppliedDiscount,
        ],
        membership: undefined,
      },
      {
        label: 'shared-funding item discount',
        discounts: [
          {
            code: 'S_ITEM',
            promotionId: 'p',
            kind: 'fixed_off_items',
            amount: naira(1000),
            fundedBy: 'shared',
            vendorShareBasisPoints: 3500,
          } satisfies AppliedDiscount,
        ],
        membership: undefined,
      },
      {
        label: 'membership free delivery (the case that broke)',
        discounts: [] as AppliedDiscount[],
        membership: {
          freeDeliveryEligible: true,
          freeDeliveryMinimumSubtotal: naira(1000),
          serviceFeeDiscountBasisPoints: 5000,
          surgeExempt: true,
        } satisfies MembershipBenefits,
      },
      {
        label: 'membership plus a platform item discount',
        discounts: [
          {
            code: 'P_ITEM',
            promotionId: 'p',
            kind: 'percentage_off_items',
            basisPoints: 1500,
            fundedBy: 'platform',
          } satisfies AppliedDiscount,
        ],
        membership: {
          freeDeliveryEligible: true,
          freeDeliveryMinimumSubtotal: naira(1000),
          serviceFeeDiscountBasisPoints: 5000,
          surgeExempt: false,
        } satisfies MembershipBenefits,
      },
    ];

    for (const scenario of cases) {
      it(`balances with ${scenario.label}`, () => {
        const quote = buildQuote({
          rules: { ...RULES, taxBasisPoints: 750 },
          mode: 'delivery',
          itemsSubtotal: naira(8000),
          trip: TRIP,
          tip: naira(500),
          discounts: scenario.discounts,
          ...(scenario.membership ? { membership: scenario.membership } : {}),
        });

        const split = computeSettlement({
          quote,
          commissionBasisPoints: 1800,
          riderDeliveryPay: naira(600),
        });

        const distributed =
          split.vendorPayable + split.riderPayable + split.platformRevenue + split.taxCollected;
        const collected = quote.total + quote.walletCreditApplied;

        expect(distributed, `${scenario.label} drifted by ${distributed - collected} kobo`).toBe(
          collected,
        );
      });
    }

    it('splits funded discounts by what they discount', () => {
      const quote = buildQuote({
        rules: RULES,
        mode: 'delivery',
        itemsSubtotal: naira(8000),
        trip: TRIP,
        discounts: [
          { code: 'A', promotionId: 'a', kind: 'free_delivery', fundedBy: 'platform' },
          {
            code: 'B',
            promotionId: 'b',
            kind: 'fixed_off_items',
            amount: naira(500),
            fundedBy: 'vendor',
          },
        ],
      });

      expect(quote.platformFundedDeliveryDiscount).toBe(naira(760));
      expect(quote.platformFundedItemDiscount).toBe(0);
      expect(quote.vendorFundedItemDiscount).toBe(naira(500));
      expect(quote.vendorFundedDeliveryDiscount).toBe(0);

      // The totals still add up to the split parts.
      expect(quote.platformFundedDiscount).toBe(
        quote.platformFundedItemDiscount + quote.platformFundedDeliveryDiscount,
      );
      expect(quote.vendorFundedDiscount).toBe(
        quote.vendorFundedItemDiscount + quote.vendorFundedDeliveryDiscount,
      );
    });

    it('charges a vendor who funded free delivery for it', () => {
      const platformFunded = buildQuote({
        rules: RULES,
        mode: 'delivery',
        itemsSubtotal: naira(8000),
        trip: TRIP,
        discounts: [{ code: 'P', promotionId: 'p', kind: 'free_delivery', fundedBy: 'platform' }],
      });
      const vendorFunded = buildQuote({
        rules: RULES,
        mode: 'delivery',
        itemsSubtotal: naira(8000),
        trip: TRIP,
        discounts: [{ code: 'V', promotionId: 'v', kind: 'free_delivery', fundedBy: 'vendor' }],
      });

      const settle = (quote: ReturnType<typeof buildQuote>) =>
        computeSettlement({ quote, commissionBasisPoints: 1800, riderDeliveryPay: naira(600) });

      // The customer pays the same either way.
      expect(platformFunded.total).toBe(vendorFunded.total);
      // But the vendor is out of pocket by exactly the waived fee.
      expect(settle(platformFunded).vendorPayable - settle(vendorFunded).vendorPayable).toBe(
        naira(760),
      );
    });
  });

  it('conserves money across randomised orders', () => {
    for (let i = 0; i < 200; i += 1) {
      const quote = buildQuote({
        rules: { ...RULES, taxBasisPoints: 750 },
        mode: 'delivery',
        itemsSubtotal: kobo(Math.floor(Math.random() * 1_000_000) + 1000),
        trip: { ...TRIP, distanceMetres: Math.floor(Math.random() * 15_000) },
        tip: kobo(Math.floor(Math.random() * 50_000)),
      });
      const split = computeSettlement({
        quote,
        commissionBasisPoints: 1800,
        riderDeliveryPay: kobo(Math.floor(Math.random() * 100_000)),
      });

      const distributed =
        split.vendorPayable + split.riderPayable + split.platformRevenue + split.taxCollected;
      const collected = quote.total + quote.walletCreditApplied;
      expect(distributed).toBe(collected);
    }
  });
});
