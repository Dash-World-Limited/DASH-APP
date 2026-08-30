/**
 * Pricing.
 *
 * A deterministic, versioned, fully-explained quote engine. Given the same
 * inputs it always produces the same output, and it returns not just a total but
 * every line that contributed to it (ADR-0007).
 *
 * The `breakdown` is persisted with the order. Months later, when a customer
 * disputes a delivery fee or a vendor questions a commission, the exact quote
 * can be reconstructed and shown — including which rule version produced it.
 *
 * Nothing here reads a database or a clock. The caller supplies the rules.
 */

import {
  add,
  atLeastZero,
  clamp,
  kobo,
  multiply,
  percentOf,
  subtract,
  ZERO,
  type Kobo,
} from '../money/index.js';

/** Bump when a change alters what a given input produces. Stored on every order. */
export const PRICING_RULE_VERSION = '2026.08.1';

export class PricingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PricingError';
  }
}

export type FulfilmentMode = 'delivery' | 'pickup' | 'vendor_delivery';

/**
 * Fee configuration, held per city and overridable per zone or vendor.
 * All of this is data in the database, not constants in code — a city manager
 * changes Lagos pricing without a deploy.
 */
export interface PricingRules {
  readonly currency: 'NGN';
  /** Flat fee charged on every delivery before distance. */
  readonly baseDeliveryFee: Kobo;
  /** Distance included in the base fee before per-km charging starts. */
  readonly includedMetres: number;
  /** Charged per kilometre beyond `includedMetres`. */
  readonly perKilometreFee: Kobo;
  /** Charged per minute of estimated ride time. Set to 0 to price on distance only. */
  readonly perMinuteFee: Kobo;
  /** Delivery fee can never fall below this, even with a discount. */
  readonly minimumDeliveryFee: Kobo;
  /** Delivery fee is capped here, protecting customers on long or surged trips. */
  readonly maximumDeliveryFee: Kobo;
  /** Platform service fee, as basis points of the item subtotal. */
  readonly serviceFeeBasisPoints: number;
  /** Service fee never exceeds this, so large baskets are not punished. */
  readonly serviceFeeCap: Kobo;
  /** Baskets under this attract `smallOrderFee`. */
  readonly smallOrderThreshold: Kobo;
  readonly smallOrderFee: Kobo;
  /** Consumption tax in basis points, applied to fees. 0 disables it. */
  readonly taxBasisPoints: number;
  /** Surge is never allowed past this multiplier regardless of configuration. */
  readonly maximumSurgeMultiplier: number;
}

/** Trip geometry and timing, resolved before pricing runs. */
export interface TripEstimate {
  readonly distanceMetres: number;
  readonly durationMinutes: number;
  /** How the distance was obtained — recorded so a quote can be defended. */
  readonly distanceSource: 'routing_provider' | 'haversine_with_detour_factor';
}

/**
 * A discount that has already been validated (eligibility, quota, dates, scope).
 * Pricing applies it; it does not decide whether the customer qualifies.
 */
export interface AppliedDiscount {
  readonly code: string;
  readonly promotionId: string;
  readonly kind: 'percentage_off_items' | 'fixed_off_items' | 'free_delivery' | 'fixed_off_total';
  /** Basis points for percentage kinds; ignored otherwise. */
  readonly basisPoints?: number;
  /** Fixed amount for fixed kinds; ignored otherwise. */
  readonly amount?: Kobo;
  /** A percentage discount never exceeds this. Guards against a 100%-off typo. */
  readonly maximumDiscount?: Kobo;
  /** Who absorbs the cost. Drives the vendor settlement split, not the customer total. */
  readonly fundedBy: 'platform' | 'vendor' | 'shared';
  /** For `shared`, the vendor's share in basis points. */
  readonly vendorShareBasisPoints?: number;
}

/** Membership benefits, resolved from the customer's active subscription. */
export interface MembershipBenefits {
  readonly freeDeliveryEligible: boolean;
  /** Basket must reach this for free delivery to apply. */
  readonly freeDeliveryMinimumSubtotal: Kobo;
  /** Reduction on the service fee, in basis points of the fee itself. */
  readonly serviceFeeDiscountBasisPoints: number;
  /** Whether surge is waived for this member. */
  readonly surgeExempt: boolean;
}

export interface QuoteInput {
  readonly rules: PricingRules;
  readonly mode: FulfilmentMode;
  /** Sum of line totals after modifiers, before any discount. */
  readonly itemsSubtotal: Kobo;
  /** Vendor's declared minimum order value, if any. */
  readonly vendorMinimumOrder?: Kobo;
  /** Required for `delivery`; ignored for `pickup`. */
  readonly trip?: TripEstimate;
  /** Demand multiplier ≥ 1. 1 = no surge. */
  readonly surgeMultiplier?: number;
  readonly discounts?: readonly AppliedDiscount[];
  readonly membership?: MembershipBenefits;
  /** Customer-chosen tip, added after everything else and never taxed. */
  readonly tip?: Kobo;
  /** Wallet credit to consume, capped at the payable total. */
  readonly walletCredit?: Kobo;
}

export type QuoteLineKind =
  | 'items_subtotal'
  | 'discount'
  | 'delivery_fee'
  | 'service_fee'
  | 'small_order_fee'
  | 'surge'
  | 'tax'
  | 'tip'
  | 'wallet_credit';

/** One explained line of the quote. */
export interface QuoteLine {
  readonly kind: QuoteLineKind;
  /** Customer-facing label. */
  readonly label: string;
  /** Signed: negative reduces the total. */
  readonly amount: Kobo;
  /** Plain-language reason this line exists. Shown on tap in the app. */
  readonly explanation: string;
}

export interface Quote {
  readonly ruleVersion: string;
  readonly currency: 'NGN';
  readonly lines: readonly QuoteLine[];
  readonly itemsSubtotal: Kobo;
  readonly discountTotal: Kobo;
  readonly deliveryFee: Kobo;
  readonly serviceFee: Kobo;
  readonly smallOrderFee: Kobo;
  readonly surgeAmount: Kobo;
  readonly tax: Kobo;
  readonly tip: Kobo;
  readonly walletCreditApplied: Kobo;
  /** What the customer pays through a payment method. */
  readonly total: Kobo;
  /** Portion of discounts the vendor absorbs — feeds vendor settlement. */
  readonly vendorFundedDiscount: Kobo;
  readonly platformFundedDiscount: Kobo;
  /** Inputs echoed back so the quote is self-describing in storage. */
  readonly inputs: {
    readonly mode: FulfilmentMode;
    readonly distanceMetres: number;
    readonly durationMinutes: number;
    readonly distanceSource: TripEstimate['distanceSource'] | 'not_applicable';
    readonly surgeMultiplier: number;
    readonly appliedCodes: readonly string[];
  };
}

export interface MinimumOrderCheck {
  readonly meetsMinimum: boolean;
  readonly shortfall: Kobo;
}

export function checkMinimumOrder(input: {
  itemsSubtotal: Kobo;
  vendorMinimumOrder?: Kobo | undefined;
}): MinimumOrderCheck {
  const minimum = input.vendorMinimumOrder ?? ZERO;
  const shortfall = atLeastZero(subtract(minimum, input.itemsSubtotal));
  return { meetsMinimum: shortfall === 0, shortfall };
}

/**
 * Delivery fee before surge and before any free-delivery benefit.
 *
 * Distance beyond the included allowance is charged per kilometre on the exact
 * fraction — a 2.4km overage is charged as 2.4, not rounded up to 3. Rounding up
 * is the kind of small dishonesty that customers notice and resent.
 */
export function computeBaseDeliveryFee(rules: PricingRules, trip: TripEstimate): Kobo {
  if (!Number.isFinite(trip.distanceMetres) || trip.distanceMetres < 0) {
    throw new PricingError(`Invalid trip distance ${trip.distanceMetres}`);
  }
  if (!Number.isFinite(trip.durationMinutes) || trip.durationMinutes < 0) {
    throw new PricingError(`Invalid trip duration ${trip.durationMinutes}`);
  }

  const chargeableMetres = Math.max(0, trip.distanceMetres - rules.includedMetres);
  const distanceComponent = multiply(rules.perKilometreFee, chargeableMetres / 1000);
  const timeComponent = multiply(rules.perMinuteFee, trip.durationMinutes);

  const raw = add(rules.baseDeliveryFee, distanceComponent, timeComponent);
  return clamp(raw, rules.minimumDeliveryFee, rules.maximumDeliveryFee);
}

function computeDiscount(
  discount: AppliedDiscount,
  itemsSubtotal: Kobo,
  deliveryFee: Kobo,
): Kobo {
  let value: Kobo;

  switch (discount.kind) {
    case 'percentage_off_items':
      if (discount.basisPoints === undefined) {
        throw new PricingError(`Discount ${discount.code} is a percentage but has no basisPoints`);
      }
      value = percentOf(itemsSubtotal, discount.basisPoints);
      break;

    case 'fixed_off_items':
    case 'fixed_off_total':
      if (discount.amount === undefined) {
        throw new PricingError(`Discount ${discount.code} is fixed but has no amount`);
      }
      value = discount.amount;
      break;

    case 'free_delivery':
      value = deliveryFee;
      break;
  }

  if (discount.maximumDiscount !== undefined && value > discount.maximumDiscount) {
    value = discount.maximumDiscount;
  }
  // A discount can never exceed what is being discounted.
  const ceiling = discount.kind === 'free_delivery' ? deliveryFee : itemsSubtotal;
  return value > ceiling ? ceiling : value;
}

/** Split a discount between platform and vendor for later settlement. */
function splitFunding(discount: AppliedDiscount, amount: Kobo): { vendor: Kobo; platform: Kobo } {
  switch (discount.fundedBy) {
    case 'vendor':
      return { vendor: amount, platform: ZERO };
    case 'platform':
      return { vendor: ZERO, platform: amount };
    case 'shared': {
      const share = discount.vendorShareBasisPoints ?? 5_000;
      const vendor = percentOf(amount, share);
      return { vendor, platform: subtract(amount, vendor) };
    }
  }
}

/**
 * Build a complete, explained quote.
 *
 * Order of operations matters and is fixed:
 *   1. delivery fee from distance/time
 *   2. surge on the delivery fee only — never on the food
 *   3. discounts, item discounts before delivery discounts
 *   4. service fee on the *discounted* subtotal
 *   5. small-order fee on the *pre-discount* subtotal
 *   6. tax on fees
 *   7. tip
 *   8. wallet credit last
 *
 * Two of these are deliberate policy choices worth stating:
 *   - Surge never touches the food price. Multiplying a jollof rice by 1.8x
 *     because it is raining is indefensible; multiplying the delivery fee is.
 *   - The small-order fee uses the pre-discount subtotal, so a promo code cannot
 *     be used to push a basket under the threshold and dodge the fee.
 */
export function buildQuote(input: QuoteInput): Quote {
  const { rules, mode } = input;
  const lines: QuoteLine[] = [];

  if (input.itemsSubtotal < 0) {
    throw new PricingError('Items subtotal cannot be negative');
  }

  const surgeMultiplier = resolveSurge(input);

  lines.push({
    kind: 'items_subtotal',
    label: 'Items',
    amount: input.itemsSubtotal,
    explanation: 'The total for everything in your basket, including any extras you chose.',
  });

  // --- 1 & 2. Delivery fee, then surge on it --------------------------------
  const requiresTrip = mode === 'delivery' || mode === 'vendor_delivery';
  if (requiresTrip && !input.trip) {
    throw new PricingError(`Fulfilment mode "${mode}" requires a trip estimate`);
  }

  let deliveryFee = ZERO;
  let surgeAmount = ZERO;

  if (requiresTrip && input.trip) {
    const base = computeBaseDeliveryFee(rules, input.trip);
    const surged = clamp(
      multiply(base, surgeMultiplier),
      rules.minimumDeliveryFee,
      rules.maximumDeliveryFee,
    );
    surgeAmount = subtract(surged, base);
    deliveryFee = base;

    lines.push({
      kind: 'delivery_fee',
      label: 'Delivery',
      amount: base,
      explanation: `${(input.trip.distanceMetres / 1000).toFixed(1)}km to your address.`,
    });

    if (surgeAmount > 0) {
      lines.push({
        kind: 'surge',
        label: 'Busy period',
        amount: surgeAmount,
        explanation:
          'Demand is high right now, so riders are paid more to keep deliveries moving. This never changes the price of your food.',
      });
    }
  }

  const deliveryFeeWithSurge = add(deliveryFee, surgeAmount);

  // --- 3. Discounts ---------------------------------------------------------
  let itemDiscountTotal = ZERO;
  let deliveryDiscountTotal = ZERO;
  let vendorFundedDiscount = ZERO;
  let platformFundedDiscount = ZERO;
  const appliedCodes: string[] = [];

  for (const discount of input.discounts ?? []) {
    const remainingItems = atLeastZero(subtract(input.itemsSubtotal, itemDiscountTotal));
    const remainingDelivery = atLeastZero(subtract(deliveryFeeWithSurge, deliveryDiscountTotal));

    const amount = computeDiscount(discount, remainingItems, remainingDelivery);
    if (amount === 0) continue;

    if (discount.kind === 'free_delivery') {
      deliveryDiscountTotal = add(deliveryDiscountTotal, amount);
    } else {
      itemDiscountTotal = add(itemDiscountTotal, amount);
    }

    const split = splitFunding(discount, amount);
    vendorFundedDiscount = add(vendorFundedDiscount, split.vendor);
    platformFundedDiscount = add(platformFundedDiscount, split.platform);
    appliedCodes.push(discount.code);

    lines.push({
      kind: 'discount',
      label: discount.kind === 'free_delivery' ? 'Free delivery' : `Promo ${discount.code}`,
      amount: kobo(-amount),
      explanation: `Discount applied from ${discount.code}.`,
    });
  }

  // Membership free delivery, applied after promos so the two cannot stack past
  // the fee itself.
  const membership = input.membership;
  if (membership?.freeDeliveryEligible && requiresTrip) {
    const remainingDelivery = atLeastZero(subtract(deliveryFeeWithSurge, deliveryDiscountTotal));
    if (input.itemsSubtotal >= membership.freeDeliveryMinimumSubtotal && remainingDelivery > 0) {
      deliveryDiscountTotal = add(deliveryDiscountTotal, remainingDelivery);
      platformFundedDiscount = add(platformFundedDiscount, remainingDelivery);
      lines.push({
        kind: 'discount',
        label: 'Dash+ free delivery',
        amount: kobo(-remainingDelivery),
        explanation: 'Free delivery included with your Dash+ membership.',
      });
    }
  }

  const discountedSubtotal = atLeastZero(subtract(input.itemsSubtotal, itemDiscountTotal));
  const payableDelivery = atLeastZero(subtract(deliveryFeeWithSurge, deliveryDiscountTotal));

  // --- 4. Service fee on the discounted subtotal ----------------------------
  let serviceFee = clamp(
    percentOf(discountedSubtotal, rules.serviceFeeBasisPoints),
    ZERO,
    rules.serviceFeeCap,
  );

  if (membership && membership.serviceFeeDiscountBasisPoints > 0 && serviceFee > 0) {
    const reduction = percentOf(serviceFee, membership.serviceFeeDiscountBasisPoints);
    serviceFee = atLeastZero(subtract(serviceFee, reduction));
  }

  if (serviceFee > 0) {
    lines.push({
      kind: 'service_fee',
      label: 'Service fee',
      amount: serviceFee,
      explanation: 'Covers running the platform, payments, and support.',
    });
  }

  // --- 5. Small-order fee on the PRE-discount subtotal ----------------------
  let smallOrderFee = ZERO;
  if (
    requiresTrip &&
    rules.smallOrderFee > 0 &&
    input.itemsSubtotal < rules.smallOrderThreshold
  ) {
    smallOrderFee = rules.smallOrderFee;
    lines.push({
      kind: 'small_order_fee',
      label: 'Small order fee',
      amount: smallOrderFee,
      explanation:
        'Applied to smaller baskets so short trips remain worthwhile for riders. Add more items to remove it.',
    });
  }

  // --- 6. Tax on fees only --------------------------------------------------
  let tax = ZERO;
  if (rules.taxBasisPoints > 0) {
    const taxableFees = add(payableDelivery, serviceFee, smallOrderFee);
    tax = percentOf(taxableFees, rules.taxBasisPoints);
    if (tax > 0) {
      lines.push({
        kind: 'tax',
        label: 'Tax',
        amount: tax,
        explanation: 'Applicable tax on delivery and service fees.',
      });
    }
  }

  // --- 7. Tip ---------------------------------------------------------------
  const tip = input.tip ?? ZERO;
  if (tip < 0) throw new PricingError('Tip cannot be negative');
  if (tip > 0) {
    lines.push({
      kind: 'tip',
      label: 'Rider tip',
      amount: tip,
      explanation: 'Goes to your rider in full. DASH APP takes nothing from tips.',
    });
  }

  const beforeWallet = add(discountedSubtotal, payableDelivery, serviceFee, smallOrderFee, tax, tip);

  // --- 8. Wallet credit, capped at what is owed ----------------------------
  const requestedCredit = input.walletCredit ?? ZERO;
  if (requestedCredit < 0) throw new PricingError('Wallet credit cannot be negative');
  const walletCreditApplied = requestedCredit > beforeWallet ? beforeWallet : requestedCredit;

  if (walletCreditApplied > 0) {
    lines.push({
      kind: 'wallet_credit',
      label: 'Wallet credit',
      amount: kobo(-walletCreditApplied),
      explanation: 'Applied from your DASH APP wallet balance.',
    });
  }

  const total = atLeastZero(subtract(beforeWallet, walletCreditApplied));

  return {
    ruleVersion: PRICING_RULE_VERSION,
    currency: rules.currency,
    lines,
    itemsSubtotal: input.itemsSubtotal,
    discountTotal: add(itemDiscountTotal, deliveryDiscountTotal),
    deliveryFee: payableDelivery,
    serviceFee,
    smallOrderFee,
    surgeAmount,
    tax,
    tip,
    walletCreditApplied,
    total,
    vendorFundedDiscount,
    platformFundedDiscount,
    inputs: {
      mode,
      distanceMetres: input.trip?.distanceMetres ?? 0,
      durationMinutes: input.trip?.durationMinutes ?? 0,
      distanceSource: input.trip?.distanceSource ?? 'not_applicable',
      surgeMultiplier,
      appliedCodes,
    },
  };
}

/**
 * Resolve the surge multiplier actually used, applying the hard cap and the
 * membership exemption. Surge below 1 is rejected rather than clamped — a
 * configured value of 0.5 is a data-entry error, and silently treating it as 1
 * would hide the mistake.
 */
function resolveSurge(input: QuoteInput): number {
  const requested = input.surgeMultiplier ?? 1;
  if (!Number.isFinite(requested) || requested < 1) {
    throw new PricingError(`Surge multiplier must be >= 1, received ${requested}`);
  }
  if (input.membership?.surgeExempt) return 1;
  return Math.min(requested, input.rules.maximumSurgeMultiplier);
}

// ---------------------------------------------------------------------------
// Settlement — how one order's money divides between the parties
// ---------------------------------------------------------------------------

export interface SettlementSplit {
  /** Owed to the vendor: their food revenue, less commission and their discount share. */
  readonly vendorPayable: Kobo;
  readonly vendorCommission: Kobo;
  /** Owed to the rider: delivery pay plus the full tip. */
  readonly riderPayable: Kobo;
  /** Kept by the platform. */
  readonly platformRevenue: Kobo;
  /** Tax collected, held for remittance. Never platform revenue. */
  readonly taxCollected: Kobo;
}

/**
 * Divide a delivered order's money between vendor, rider, and platform.
 *
 * Invariant asserted by the finance tests: `vendorPayable + riderPayable +
 * platformRevenue + taxCollected` equals what the customer actually paid plus
 * any platform-funded discount (which the platform absorbs as a cost).
 */
export function computeSettlement(input: {
  quote: Quote;
  /** Vendor commission rate in basis points, from the vendor's contract. */
  commissionBasisPoints: number;
  /** What the rider is owed for the trip, from the rider pay rules. */
  riderDeliveryPay: Kobo;
}): SettlementSplit {
  const { quote } = input;

  // The vendor is paid on the food revenue they actually generated: full menu
  // price, less only the portion of discounts they agreed to fund.
  const vendorGross = subtract(quote.itemsSubtotal, quote.vendorFundedDiscount);
  const vendorCommission = percentOf(vendorGross, input.commissionBasisPoints);
  const vendorPayable = atLeastZero(subtract(vendorGross, vendorCommission));

  const riderPayable = add(input.riderDeliveryPay, quote.tip);

  // Platform keeps its fees and commission, pays the rider, and absorbs the
  // discounts it chose to fund.
  const platformRevenue = subtract(
    add(vendorCommission, quote.serviceFee, quote.deliveryFee, quote.smallOrderFee),
    add(input.riderDeliveryPay, quote.platformFundedDiscount),
  );

  return {
    vendorPayable,
    vendorCommission,
    riderPayable,
    platformRevenue,
    taxCollected: quote.tax,
  };
}
