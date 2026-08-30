import { describe, expect, it } from 'vitest';
import { kobo, naira, ZERO } from '../money/index.js';
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
    platformFundedDiscount: ZERO,
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

  it('balances when the platform funds a discount', () => {
    const draft = buildOrderCapture({
      ...input,
      cashReceived: naira(5510),
      platformFundedDiscount: naira(500),
      platformRevenue: naira(1310),
      vendorPayable: naira(4100),
    });
    expectBalances(draft);
    expect(
      draft.entries.find((e) => e.accountKind === 'promotion_expense')?.amount,
    ).toBe(naira(500));
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
        platformFundedDiscount: ZERO,
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
