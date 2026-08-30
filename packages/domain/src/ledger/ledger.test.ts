import { describe, expect, it } from 'vitest';
import { kobo, naira, ZERO } from '../money/index.js';
import {
  buildQuote,
  computeSettlement,
  type AppliedDiscount,
  type MembershipBenefits,
  type PricingRules,
} from '../pricing/index.js';
import {
  ACCOUNT_KINDS,
  ACCOUNT_TYPES,
  assertBalanced,
  balanceOf,
  buildOrderCapture,
  buildPayout,
  buildRefund,
  buildReversal,
  buildWalletCredit,
  isBalanced,
  LedgerError,
  verifyLedgerIntegrity,
  type LedgerTransactionDraft,
} from './index.js';

const AT = new Date('2026-08-30T12:00:00Z');

/** Every draft must satisfy this, always. */
function expectBalances(draft: LedgerTransactionDraft): void {
  const sum = draft.entries.reduce((total, entry) => total + entry.amount, 0);
  expect(sum, `entries sum to ${sum}, must be 0`).toBe(0);
}

describe('account definitions', () => {
  it('assigns every account kind a type', () => {
    for (const kind of ACCOUNT_KINDS) {
      expect(ACCOUNT_TYPES[kind]).toBeTruthy();
    }
  });
});

describe('assertBalanced', () => {
  const base = {
    kind: 'manual_adjustment' as const,
    idempotencyKey: 'key-1',
    referenceType: 'test',
    referenceId: 'ref-1',
    actorId: 'system',
    occurredAt: AT,
  };

  it('accepts a balanced transaction', () => {
    expect(
      isBalanced({
        ...base,
        entries: [
          { accountKind: 'platform_cash', amount: naira(100), memo: 'in' },
          { accountKind: 'platform_revenue', amount: naira(-100), memo: 'out' },
        ],
      }),
    ).toBe(true);
  });

  it('rejects an unbalanced transaction — this is the core invariant', () => {
    expect(() =>
      assertBalanced({
        ...base,
        entries: [
          { accountKind: 'platform_cash', amount: naira(100), memo: 'in' },
          { accountKind: 'platform_revenue', amount: naira(-99), memo: 'out' },
        ],
      }),
    ).toThrow(LedgerError);
  });

  it('rejects a single-entry transaction — money must come from somewhere', () => {
    expect(() =>
      assertBalanced({
        ...base,
        entries: [{ accountKind: 'platform_cash', amount: naira(100), memo: 'in' }],
      }),
    ).toThrow(LedgerError);
  });

  it('rejects an empty transaction', () => {
    expect(() => assertBalanced({ ...base, entries: [] })).toThrow(LedgerError);
  });

  it('rejects a zero-value entry rather than storing a no-op row', () => {
    expect(() =>
      assertBalanced({
        ...base,
        entries: [
          { accountKind: 'platform_cash', amount: ZERO, memo: 'nothing' },
          { accountKind: 'platform_revenue', amount: ZERO, memo: 'nothing' },
        ],
      }),
    ).toThrow(LedgerError);
  });

  it('requires an idempotency key on every transaction', () => {
    expect(() =>
      assertBalanced({
        ...base,
        idempotencyKey: '   ',
        entries: [
          { accountKind: 'platform_cash', amount: naira(100), memo: 'in' },
          { accountKind: 'platform_revenue', amount: naira(-100), memo: 'out' },
        ],
      }),
    ).toThrow(LedgerError);
  });

  it('rejects an unknown account kind', () => {
    expect(() =>
      assertBalanced({
        ...base,
        entries: [
          // @ts-expect-error deliberately invalid to prove the runtime guard
          { accountKind: 'imaginary_account', amount: naira(100), memo: 'in' },
          { accountKind: 'platform_revenue', amount: naira(-100), memo: 'out' },
        ],
      }),
    ).toThrow(LedgerError);
  });
});

describe('balanceOf', () => {
  it('reads an asset account debit-positive', () => {
    expect(
      balanceOf('platform_cash', [{ amount: naira(500) }, { amount: naira(-200) }]),
    ).toBe(naira(300));
  });

  it('reads a customer wallet as a positive balance despite being a liability', () => {
    // The wallet was credited ₦500 (a credit, stored negative). The customer
    // should see +₦500, not -₦500.
    expect(balanceOf('customer_wallet', [{ amount: naira(-500) }])).toBe(naira(500));
  });

  it('reduces the wallet when it is spent', () => {
    expect(
      balanceOf('customer_wallet', [{ amount: naira(-500) }, { amount: naira(200) }]),
    ).toBe(naira(300));
  });
});

describe('buildOrderCapture', () => {
  const input = {
    orderId: 'ord_1',
    idempotencyKey: 'cap_1',
    actorId: 'system',
    occurredAt: AT,
    cashReceived: naira(6010),
    walletApplied: ZERO,
    customerId: 'cus_1',
    vendorId: 'ven_1',
    vendorPayable: naira(4100),
    riderPayable: naira(600),
    riderId: 'rid_1',
    platformRevenue: naira(1310),
    taxCollected: ZERO,
    platformFundedItemDiscount: ZERO,
  };

  it('balances a straightforward capture', () => {
    const draft = buildOrderCapture(input);
    expectBalances(draft);
    expect(draft.kind).toBe('order_payment_captured');
    expect(draft.referenceId).toBe('ord_1');
  });

  it('records what is owed to each party as a liability', () => {
    const draft = buildOrderCapture(input);
    const vendorEntry = draft.entries.find((e) => e.accountKind === 'vendor_payable');
    const riderEntry = draft.entries.find((e) => e.accountKind === 'rider_payable');
    // Liabilities are credited, so negative in debit-positive convention.
    expect(vendorEntry?.amount).toBe(naira(-4100));
    expect(riderEntry?.amount).toBe(naira(-600));
    expect(vendorEntry?.ownerId).toBe('ven_1');
    expect(riderEntry?.ownerId).toBe('rid_1');
  });

  it('balances when part is paid from the wallet', () => {
    const draft = buildOrderCapture({
      ...input,
      cashReceived: naira(5010),
      walletApplied: naira(1000),
    });
    expectBalances(draft);
    const walletEntry = draft.entries.find((e) => e.accountKind === 'customer_wallet');
    // Drawing down a liability is a debit — positive.
    expect(walletEntry?.amount).toBe(naira(1000));
  });

  it('balances when the platform funds an item discount', () => {
    // A ₦500 platform-funded item discount means two things at once: the
    // customer pays ₦500 less (6010 → 5510), and the platform's NET revenue
    // falls by ₦500 (1310 → 810) because it covered the gap while the vendor
    // was still paid full menu price.
    const draft = buildOrderCapture({
      ...input,
      cashReceived: naira(5510),
      platformFundedItemDiscount: naira(500),
      platformRevenue: naira(810),
      vendorPayable: naira(4100),
    });
    expectBalances(draft);

    // The promotion is booked as its own expense…
    expect(draft.entries.find((e) => e.accountKind === 'promotion_expense')?.amount).toBe(
      naira(500),
    );
    // …and revenue is credited GROSS, so acquisition spend stays visible rather
    // than being silently netted away.
    expect(draft.entries.find((e) => e.accountKind === 'platform_revenue')?.amount).toBe(
      naira(-1310),
    );
  });

  it('books no promotion expense for a delivery waiver', () => {
    // The regression that unbalanced the first real checkout. A free-delivery
    // benefit is not a cost: the fee was never charged, so `deliveryFee` is
    // already zero in the quote and there is nothing to expense. Passing it
    // here as though it were an item discount is what broke the ledger.
    const draft = buildOrderCapture({
      ...input,
      cashReceived: naira(5250), // no delivery fee charged
      platformRevenue: naira(550),
      vendorPayable: naira(4100),
      riderPayable: naira(600),
      platformFundedItemDiscount: ZERO,
    });
    expectBalances(draft);
    expect(draft.entries.find((e) => e.accountKind === 'promotion_expense')).toBeUndefined();
  });

  it('balances when tax is collected', () => {
    const draft = buildOrderCapture({
      ...input,
      cashReceived: naira(6086),
      taxCollected: naira(76),
    });
    expectBalances(draft);
  });

  it('refuses to post a capture whose parts do not add up', () => {
    expect(() =>
      buildOrderCapture({ ...input, platformRevenue: naira(9999) }),
    ).toThrow(LedgerError);
  });
});

describe('buildRefund', () => {
  it('balances a full refund absorbed by the platform', () => {
    const draft = buildRefund({
      orderId: 'ord_1',
      idempotencyKey: 'ref_1',
      actorId: 'agent_1',
      occurredAt: AT,
      customerId: 'cus_1',
      toPaymentMethod: naira(6010),
      toWallet: ZERO,
    });
    expectBalances(draft);
    expect(draft.entries.find((e) => e.accountKind === 'refund_expense')?.amount).toBe(
      naira(6010),
    );
  });

  it('balances a refund clawed back from the vendor', () => {
    const draft = buildRefund({
      orderId: 'ord_1',
      idempotencyKey: 'ref_2',
      actorId: 'agent_1',
      occurredAt: AT,
      customerId: 'cus_1',
      vendorId: 'ven_1',
      toPaymentMethod: naira(4100),
      toWallet: ZERO,
      fromVendorPayable: naira(4100),
    });
    expectBalances(draft);
    // Fully recovered from the vendor, so no platform expense at all.
    expect(draft.entries.find((e) => e.accountKind === 'refund_expense')).toBeUndefined();
  });

  it('balances a partial refund issued as wallet credit', () => {
    const draft = buildRefund({
      orderId: 'ord_1',
      idempotencyKey: 'ref_3',
      actorId: 'agent_1',
      occurredAt: AT,
      customerId: 'cus_1',
      toPaymentMethod: ZERO,
      toWallet: naira(1000),
    });
    expectBalances(draft);
  });

  it('refuses to recover more than it returns — the excess has nowhere to go', () => {
    expect(() =>
      buildRefund({
        orderId: 'ord_1',
        idempotencyKey: 'ref_4',
        actorId: 'agent_1',
        occurredAt: AT,
        customerId: 'cus_1',
        vendorId: 'ven_1',
        toPaymentMethod: naira(100),
        toWallet: ZERO,
        fromVendorPayable: naira(5000),
      }),
    ).toThrow(LedgerError);
  });
});

describe('buildPayout', () => {
  it('clears the liability and moves cash out', () => {
    const draft = buildPayout({
      kind: 'vendor_payout',
      payeeId: 'ven_1',
      batchId: 'batch_1',
      idempotencyKey: 'pay_1',
      actorId: 'finance_1',
      occurredAt: AT,
      amount: naira(50_000),
    });
    expectBalances(draft);
    expect(draft.entries.find((e) => e.accountKind === 'vendor_payable')?.amount).toBe(
      naira(50_000),
    );
  });

  it('balances with a processing fee', () => {
    const draft = buildPayout({
      kind: 'rider_payout',
      payeeId: 'rid_1',
      batchId: 'batch_2',
      idempotencyKey: 'pay_2',
      actorId: 'finance_1',
      occurredAt: AT,
      amount: naira(20_000),
      processingFee: naira(100),
    });
    expectBalances(draft);
    expect(draft.entries.find((e) => e.accountKind === 'processing_expense')?.amount).toBe(
      naira(100),
    );
  });

  it('rejects a non-positive payout', () => {
    const base = {
      kind: 'vendor_payout' as const,
      payeeId: 'ven_1',
      batchId: 'b',
      idempotencyKey: 'k',
      actorId: 'f',
      occurredAt: AT,
    };
    expect(() => buildPayout({ ...base, amount: ZERO })).toThrow(LedgerError);
    expect(() => buildPayout({ ...base, amount: naira(-100) })).toThrow(LedgerError);
  });
});

describe('buildWalletCredit', () => {
  it('treats a top-up as incoming cash', () => {
    const draft = buildWalletCredit({
      customerId: 'cus_1',
      idempotencyKey: 'w_1',
      actorId: 'system',
      occurredAt: AT,
      amount: naira(5000),
      reason: 'topup',
    });
    expectBalances(draft);
    expect(draft.entries.find((e) => e.accountKind === 'platform_cash')?.amount).toBe(naira(5000));
  });

  it('treats goodwill as an expense, not as cash', () => {
    const draft = buildWalletCredit({
      customerId: 'cus_1',
      idempotencyKey: 'w_2',
      actorId: 'agent_1',
      occurredAt: AT,
      amount: naira(1000),
      reason: 'goodwill',
    });
    expectBalances(draft);
    expect(draft.entries.find((e) => e.accountKind === 'platform_cash')).toBeUndefined();
    expect(draft.entries.find((e) => e.accountKind === 'promotion_expense')?.amount).toBe(
      naira(1000),
    );
  });

  it('rejects a non-positive credit', () => {
    expect(() =>
      buildWalletCredit({
        customerId: 'cus_1',
        idempotencyKey: 'w_3',
        actorId: 'a',
        occurredAt: AT,
        amount: ZERO,
        reason: 'goodwill',
      }),
    ).toThrow(LedgerError);
  });
});

describe('buildReversal', () => {
  it('produces the exact inverse and nets the pair to zero', () => {
    const original = buildWalletCredit({
      customerId: 'cus_1',
      idempotencyKey: 'w_4',
      actorId: 'agent_1',
      occurredAt: AT,
      amount: naira(2500),
      reason: 'goodwill',
    });

    const reversal = buildReversal({
      original,
      originalTransactionId: 'txn_abc',
      idempotencyKey: 'rev_1',
      actorId: 'agent_2',
      occurredAt: AT,
      reason: 'Credited the wrong customer',
    });

    expectBalances(reversal);
    expect(reversal.entries).toHaveLength(original.entries.length);

    // The pair together must have no net effect on any account.
    const net = new Map<string, number>();
    for (const entry of [...original.entries, ...reversal.entries]) {
      const key = `${entry.accountKind}:${entry.ownerId ?? 'platform'}`;
      net.set(key, (net.get(key) ?? 0) + entry.amount);
    }
    for (const [account, amount] of net) {
      expect(amount, `${account} did not net to zero`).toBe(0);
    }
  });

  it('preserves the reason for the audit trail', () => {
    const original = buildWalletCredit({
      customerId: 'cus_1',
      idempotencyKey: 'w_5',
      actorId: 'a',
      occurredAt: AT,
      amount: naira(100),
      reason: 'goodwill',
    });
    const reversal = buildReversal({
      original,
      originalTransactionId: 'txn_x',
      idempotencyKey: 'rev_2',
      actorId: 'b',
      occurredAt: AT,
      reason: 'duplicate credit',
    });
    expect(reversal.note).toBe('duplicate credit');
    expect(reversal.kind).toBe('reversal');
  });
});

describe('verifyLedgerIntegrity', () => {
  it('passes on a healthy ledger', () => {
    const transactions = [
      buildWalletCredit({
        customerId: 'cus_1',
        idempotencyKey: 'a',
        actorId: 's',
        occurredAt: AT,
        amount: naira(100),
        reason: 'topup',
      }),
      buildPayout({
        kind: 'vendor_payout',
        payeeId: 'v',
        batchId: 'b',
        idempotencyKey: 'c',
        actorId: 'f',
        occurredAt: AT,
        amount: naira(500),
      }),
    ];
    const result = verifyLedgerIntegrity(transactions);
    expect(result.balanced).toBe(true);
    expect(result.totalDrift).toBe(0);
  });

  it('names the offending transaction when drift exists', () => {
    const corrupt: LedgerTransactionDraft = {
      kind: 'manual_adjustment',
      idempotencyKey: 'bad',
      referenceType: 'order',
      referenceId: 'ord_bad',
      actorId: 'x',
      occurredAt: AT,
      entries: [
        { accountKind: 'platform_cash', amount: kobo(100), memo: 'in' },
        { accountKind: 'platform_revenue', amount: kobo(-90), memo: 'out' },
      ],
    };
    const result = verifyLedgerIntegrity([corrupt]);
    expect(result.balanced).toBe(false);
    expect(result.totalDrift).toBe(kobo(10));
    expect(result.offending).toContain('order:ord_bad');
  });
});

describe('settlement feeds the ledger without drift', () => {
  /**
   * The contract test between pricing and the ledger.
   *
   * These two modules were each internally correct while disagreeing with one
   * another: `computeSettlement` treated a delivery waiver as a cost, and
   * `buildOrderCapture` then booked it a second time. Neither module's own
   * tests could catch that, because the bug lived in the handoff.
   *
   * This walks a real quote through settlement into a ledger draft for every
   * discount shape, and asserts the transaction balances — which is exactly the
   * check that failed in production on the first member's order.
   */
  const RULES: PricingRules = {
    currency: 'NGN',
    baseDeliveryFee: naira(400),
    includedMetres: 2000,
    perKilometreFee: naira(120),
    perMinuteFee: naira(0),
    minimumDeliveryFee: naira(300),
    maximumDeliveryFee: naira(3500),
    serviceFeeBasisPoints: 500,
    serviceFeeCap: naira(500),
    smallOrderThreshold: naira(2000),
    smallOrderFee: naira(200),
    taxBasisPoints: 750,
    maximumSurgeMultiplier: 2,
  };

  const TRIP = {
    distanceMetres: 5000,
    durationMinutes: 18,
    distanceSource: 'haversine_with_detour_factor' as const,
  };

  const MEMBER: MembershipBenefits = {
    freeDeliveryEligible: true,
    freeDeliveryMinimumSubtotal: naira(1000),
    serviceFeeDiscountBasisPoints: 5000,
    surgeExempt: true,
  };

  const scenarios: { label: string; discounts: AppliedDiscount[]; membership?: MembershipBenefits }[] =
    [
      { label: 'plain order', discounts: [] },
      {
        label: 'platform item discount',
        discounts: [
          { code: 'A', promotionId: 'a', kind: 'percentage_off_items', basisPoints: 1200, fundedBy: 'platform' },
        ],
      },
      {
        label: 'vendor item discount',
        discounts: [
          { code: 'B', promotionId: 'b', kind: 'fixed_off_items', amount: naira(700), fundedBy: 'vendor' },
        ],
      },
      {
        label: 'platform free delivery',
        discounts: [{ code: 'C', promotionId: 'c', kind: 'free_delivery', fundedBy: 'platform' }],
      },
      {
        label: 'vendor free delivery',
        discounts: [{ code: 'D', promotionId: 'd', kind: 'free_delivery', fundedBy: 'vendor' }],
      },
      { label: 'membership free delivery', discounts: [], membership: MEMBER },
      {
        label: 'membership plus platform item discount',
        discounts: [
          { code: 'E', promotionId: 'e', kind: 'percentage_off_items', basisPoints: 1000, fundedBy: 'platform' },
        ],
        membership: MEMBER,
      },
      {
        label: 'shared-funding discount',
        discounts: [
          {
            code: 'F',
            promotionId: 'f',
            kind: 'fixed_off_items',
            amount: naira(900),
            fundedBy: 'shared',
            vendorShareBasisPoints: 4000,
          },
        ],
      },
    ];

  for (const scenario of scenarios) {
    it(`posts a balanced capture for: ${scenario.label}`, () => {
      const quote = buildQuote({
        rules: RULES,
        mode: 'delivery',
        itemsSubtotal: naira(8000),
        trip: TRIP,
        tip: naira(500),
        discounts: scenario.discounts,
        ...(scenario.membership ? { membership: scenario.membership } : {}),
      });

      const settlement = computeSettlement({
        quote,
        commissionBasisPoints: 1800,
        riderDeliveryPay: naira(600),
      });

      const draft = buildOrderCapture({
        orderId: 'ord_contract',
        idempotencyKey: `contract_${scenario.label}`,
        actorId: 'system',
        occurredAt: AT,
        cashReceived: quote.total,
        walletApplied: quote.walletCreditApplied,
        customerId: 'cus_1',
        vendorId: 'ven_1',
        vendorPayable: settlement.vendorPayable,
        riderPayable: settlement.riderPayable,
        riderId: 'rid_1',
        platformRevenue: settlement.platformRevenue,
        taxCollected: settlement.taxCollected,
        platformFundedItemDiscount: quote.platformFundedItemDiscount,
      });

      expectBalances(draft);
    });
  }

  it('holds across randomised baskets and discount rates', () => {
    for (let i = 0; i < 200; i += 1) {
      const usesFreeDelivery = Math.random() < 0.5;
      const quote = buildQuote({
        rules: RULES,
        mode: 'delivery',
        itemsSubtotal: kobo(Math.floor(Math.random() * 900_000) + 100_000),
        trip: { ...TRIP, distanceMetres: Math.floor(Math.random() * 14_000) + 500 },
        tip: kobo(Math.floor(Math.random() * 60_000)),
        discounts: usesFreeDelivery
          ? [
              {
                code: 'R',
                promotionId: 'r',
                kind: 'free_delivery',
                fundedBy: Math.random() < 0.5 ? 'platform' : 'vendor',
              },
            ]
          : [
              {
                code: 'R',
                promotionId: 'r',
                kind: 'percentage_off_items',
                basisPoints: Math.floor(Math.random() * 3000),
                fundedBy: Math.random() < 0.5 ? 'platform' : 'vendor',
              },
            ],
        ...(Math.random() < 0.4 ? { membership: MEMBER } : {}),
      });

      const settlement = computeSettlement({
        quote,
        commissionBasisPoints: 1800,
        riderDeliveryPay: kobo(Math.floor(Math.random() * 80_000) + 20_000),
      });

      const draft = buildOrderCapture({
        orderId: `ord_${i}`,
        idempotencyKey: `rand_${i}`,
        actorId: 'system',
        occurredAt: AT,
        cashReceived: quote.total,
        walletApplied: quote.walletCreditApplied,
        customerId: 'cus_1',
        vendorId: 'ven_1',
        vendorPayable: settlement.vendorPayable,
        riderPayable: settlement.riderPayable,
        riderId: 'rid_1',
        platformRevenue: settlement.platformRevenue,
        taxCollected: settlement.taxCollected,
        platformFundedItemDiscount: quote.platformFundedItemDiscount,
      });

      expectBalances(draft);
    }
  });
});

describe('end-to-end money conservation', () => {
  it('leaves the ledger balanced across capture, refund, and payout', () => {
    const transactions = [
      buildOrderCapture({
        orderId: 'ord_1',
        idempotencyKey: 'c1',
        actorId: 'system',
        occurredAt: AT,
        cashReceived: naira(6010),
        walletApplied: ZERO,
        customerId: 'cus_1',
        vendorId: 'ven_1',
        vendorPayable: naira(4100),
        riderPayable: naira(600),
        riderId: 'rid_1',
        platformRevenue: naira(1310),
        taxCollected: ZERO,
        platformFundedItemDiscount: ZERO,
      }),
      buildRefund({
        orderId: 'ord_1',
        idempotencyKey: 'r1',
        actorId: 'agent_1',
        occurredAt: AT,
        customerId: 'cus_1',
        vendorId: 'ven_1',
        toPaymentMethod: naira(1000),
        toWallet: ZERO,
        fromVendorPayable: naira(1000),
      }),
      buildPayout({
        kind: 'vendor_payout',
        payeeId: 'ven_1',
        batchId: 'b1',
        idempotencyKey: 'p1',
        actorId: 'finance_1',
        occurredAt: AT,
        amount: naira(3100),
      }),
    ];

    expect(verifyLedgerIntegrity(transactions).balanced).toBe(true);

    // The vendor was owed 4100, refunded 1000 of it, and paid out 3100 — so
    // their liability account must now be exactly zero.
    const vendorEntries = transactions
      .flatMap((t) => t.entries)
      .filter((e) => e.accountKind === 'vendor_payable' && e.ownerId === 'ven_1');
    expect(balanceOf('vendor_payable', vendorEntries)).toBe(0);
  });
});
