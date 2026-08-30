/**
 * Money ledger.
 *
 * Double-entry bookkeeping (ADR-0006). Nothing in DASH APP has a mutable balance
 * column. Money exists only as `LedgerEntry` rows, every entry belongs to a
 * transaction, and every transaction's entries must sum to exactly zero.
 *
 * The zero-sum rule is the whole point: money cannot be created or destroyed by
 * a bug, only moved. If a transaction does not balance it is rejected before it
 * is written, so the ledger cannot drift out of balance at all.
 *
 * Entries are append-only. There is no update and no delete — a mistake is
 * corrected by posting a reversing transaction, leaving both visible.
 */

import { add, isZero, kobo, negate, ZERO, type Kobo } from '../money/index.js';

/**
 * Account types, following normal accounting sign conventions.
 *
 * `asset` and `expense` accounts increase with a debit (positive entry).
 * `liability`, `equity`, and `revenue` accounts increase with a credit
 * (negative entry). Getting these backwards is the classic error, so the
 * direction is encoded here once rather than reasoned about per call site.
 */
export type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';

export const ACCOUNT_KINDS = [
  /** Money held at the payment provider before payout. */
  'platform_cash',
  /** Owed to vendors for delivered orders. */
  'vendor_payable',
  /** Owed to riders for completed deliveries. */
  'rider_payable',
  /** Customer wallet balances — a liability, never platform money. */
  'customer_wallet',
  /** Tax collected and held for remittance — never revenue. */
  'tax_payable',
  /** Platform's earned commission and fees. */
  'platform_revenue',
  /** Discounts the platform funded — a cost of acquisition. */
  'promotion_expense',
  /** Refunds paid back to customers. */
  'refund_expense',
  /** Cash physically held by riders on COD orders, owed back to the platform. */
  'rider_cash_float',
  /** Payment provider fees. */
  'processing_expense',
] as const;

export type AccountKind = (typeof ACCOUNT_KINDS)[number];

export const ACCOUNT_TYPES: Readonly<Record<AccountKind, AccountType>> = {
  platform_cash: 'asset',
  rider_cash_float: 'asset',
  vendor_payable: 'liability',
  rider_payable: 'liability',
  customer_wallet: 'liability',
  tax_payable: 'liability',
  platform_revenue: 'revenue',
  promotion_expense: 'expense',
  refund_expense: 'expense',
  processing_expense: 'expense',
};

export class LedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerError';
  }
}

/**
 * One side of a transaction.
 *
 * `amount` is signed in the debit-positive convention: a positive amount debits
 * the account, a negative amount credits it. Whether that increases or decreases
 * the account's balance depends on its type — see `balanceOf`.
 */
export interface LedgerEntryDraft {
  readonly accountKind: AccountKind;
  /** Which party's account. Null for platform-wide accounts. */
  readonly ownerId?: string | undefined;
  readonly amount: Kobo;
  /** Short machine-readable reason, e.g. `order_capture`, `commission`. */
  readonly memo: string;
}

export type LedgerTransactionKind =
  | 'order_payment_captured'
  | 'order_settlement'
  | 'order_refund'
  | 'wallet_topup'
  | 'wallet_spend'
  | 'promotion_credit'
  | 'vendor_payout'
  | 'rider_payout'
  | 'rider_cash_remittance'
  | 'manual_adjustment'
  | 'reversal';

export interface LedgerTransactionDraft {
  readonly kind: LedgerTransactionKind;
  /** Required. Makes every money operation safe to retry. */
  readonly idempotencyKey: string;
  /** What this transaction is about — an order, a payout batch, a case. */
  readonly referenceType: string;
  readonly referenceId: string;
  readonly entries: readonly LedgerEntryDraft[];
  /** Who caused it. `system` for automated postings. */
  readonly actorId: string;
  readonly occurredAt: Date;
  /** Free text for finance and support. Never contains card or PII data. */
  readonly note?: string | undefined;
}

/**
 * Validate a transaction before it is written.
 *
 * Throws on anything that would corrupt the ledger. Called by every posting
 * path, with no way around it — this function is the invariant.
 */
export function assertBalanced(draft: LedgerTransactionDraft): void {
  if (draft.entries.length === 0) {
    throw new LedgerError('A ledger transaction must have at least one entry');
  }
  if (draft.entries.length === 1) {
    throw new LedgerError(
      'A ledger transaction needs at least two entries — money must come from somewhere',
    );
  }
  if (!draft.idempotencyKey || draft.idempotencyKey.trim().length === 0) {
    throw new LedgerError('Every ledger transaction requires an idempotency key');
  }

  for (const entry of draft.entries) {
    if (!Number.isSafeInteger(entry.amount)) {
      throw new LedgerError(`Entry amount ${entry.amount} is not a safe integer of kobo`);
    }
    if (!ACCOUNT_TYPES[entry.accountKind]) {
      throw new LedgerError(`Unknown account kind "${entry.accountKind}"`);
    }
    if (isZero(entry.amount)) {
      throw new LedgerError(`Entry "${entry.memo}" posts zero — remove it instead`);
    }
  }

  const sum = draft.entries.reduce<number>((total, entry) => total + entry.amount, 0);
  if (sum !== 0) {
    throw new LedgerError(
      `Transaction does not balance: entries sum to ${sum} kobo, must be 0. ` +
        `Entries: ${draft.entries.map((e) => `${e.accountKind}:${e.amount}`).join(', ')}`,
    );
  }
}

export function isBalanced(draft: LedgerTransactionDraft): boolean {
  try {
    assertBalanced(draft);
    return true;
  } catch {
    return false;
  }
}

/**
 * Sum entries into a balance, applying the account's sign convention so the
 * result reads naturally: a customer wallet with ₦500 in it returns +50000, not
 * -50000, even though it is a liability stored as credits.
 */
export function balanceOf(
  accountKind: AccountKind,
  entries: readonly { amount: Kobo }[],
): Kobo {
  const raw = entries.reduce<number>((total, entry) => total + entry.amount, 0);
  const type = ACCOUNT_TYPES[accountKind];
  const debitPositive = type === 'asset' || type === 'expense';
  return kobo(debitPositive ? raw : -raw);
}

// ---------------------------------------------------------------------------
// Transaction builders
//
// Each builder produces a balanced draft for one business event. Routes call
// these rather than assembling entries by hand, so the accounting treatment of
// each event is defined exactly once.
// ---------------------------------------------------------------------------

/**
 * A customer's payment is captured.
 *
 * Cash comes in as an asset; against it we recognise what we owe out — the
 * vendor, the rider, the tax authority — and what we keep. Wallet credit spent
 * is drawn down from the customer's liability balance rather than arriving as
 * new cash.
 */
export function buildOrderCapture(input: {
  orderId: string;
  idempotencyKey: string;
  actorId: string;
  occurredAt: Date;
  /** Charged to a card/bank. */
  cashReceived: Kobo;
  /** Consumed from the customer's wallet. */
  walletApplied: Kobo;
  customerId: string;
  vendorId: string;
  vendorPayable: Kobo;
  /** Held until the rider is assigned and completes; posted to rider_payable. */
  riderPayable: Kobo;
  riderId?: string | undefined;
  platformRevenue: Kobo;
  taxCollected: Kobo;
  /** Discount the platform funded — an expense recognised at capture. */
  platformFundedDiscount: Kobo;
}): LedgerTransactionDraft {
  const entries: LedgerEntryDraft[] = [];

  if (input.cashReceived > 0) {
    entries.push({
      accountKind: 'platform_cash',
      amount: input.cashReceived,
      memo: 'order_capture',
    });
  }

  if (input.walletApplied > 0) {
    // Drawing down a liability is a debit.
    entries.push({
      accountKind: 'customer_wallet',
      ownerId: input.customerId,
      amount: input.walletApplied,
      memo: 'wallet_applied_to_order',
    });
  }

  if (input.platformFundedDiscount > 0) {
    entries.push({
      accountKind: 'promotion_expense',
      amount: input.platformFundedDiscount,
      memo: 'platform_funded_discount',
    });
  }

  if (input.vendorPayable > 0) {
    entries.push({
      accountKind: 'vendor_payable',
      ownerId: input.vendorId,
      amount: negate(input.vendorPayable),
      memo: 'owed_to_vendor',
    });
  }

  if (input.riderPayable > 0) {
    entries.push({
      accountKind: 'rider_payable',
      ownerId: input.riderId,
      amount: negate(input.riderPayable),
      memo: 'owed_to_rider',
    });
  }

  if (input.taxCollected > 0) {
    entries.push({
      accountKind: 'tax_payable',
      amount: negate(input.taxCollected),
      memo: 'tax_collected',
    });
  }

  if (input.platformRevenue !== 0) {
    entries.push({
      accountKind: 'platform_revenue',
      amount: negate(input.platformRevenue),
      memo: 'platform_revenue',
    });
  }

  const draft: LedgerTransactionDraft = {
    kind: 'order_payment_captured',
    idempotencyKey: input.idempotencyKey,
    referenceType: 'order',
    referenceId: input.orderId,
    entries,
    actorId: input.actorId,
    occurredAt: input.occurredAt,
  };

  assertBalanced(draft);
  return draft;
}

/**
 * Refund a customer, in whole or in part.
 *
 * The counterparty reversals are supplied explicitly rather than derived,
 * because who bears the cost of a refund is a business decision that varies:
 * a vendor who burnt the food bears it, a rider who lost the bag does not, and
 * a goodwill gesture is borne by the platform.
 */
export function buildRefund(input: {
  orderId: string;
  idempotencyKey: string;
  actorId: string;
  occurredAt: Date;
  customerId: string;
  /** Returned to the original payment method. */
  toPaymentMethod: Kobo;
  /** Returned as wallet credit instead. */
  toWallet: Kobo;
  /** Clawed back from what we owe the vendor. */
  fromVendorPayable?: Kobo | undefined;
  vendorId?: string | undefined;
  /** Absorbed by the platform. */
  fromPlatformRevenue?: Kobo | undefined;
  /** Tax reversed proportionally. */
  taxReversed?: Kobo | undefined;
  note?: string | undefined;
}): LedgerTransactionDraft {
  const entries: LedgerEntryDraft[] = [];

  const fromVendor = input.fromVendorPayable ?? ZERO;
  const fromPlatform = input.fromPlatformRevenue ?? ZERO;
  const taxReversed = input.taxReversed ?? ZERO;

  if (fromVendor > 0) {
    entries.push({
      accountKind: 'vendor_payable',
      ownerId: input.vendorId,
      amount: fromVendor,
      memo: 'refund_recovered_from_vendor',
    });
  }
  if (fromPlatform > 0) {
    entries.push({
      accountKind: 'platform_revenue',
      amount: fromPlatform,
      memo: 'refund_absorbed_by_platform',
    });
  }
  if (taxReversed > 0) {
    entries.push({
      accountKind: 'tax_payable',
      amount: taxReversed,
      memo: 'tax_reversed_on_refund',
    });
  }

  const covered = add(fromVendor, fromPlatform, taxReversed);
  const returned = add(input.toPaymentMethod, input.toWallet);

  // Anything not clawed back from a counterparty is a platform expense.
  const shortfall = returned - covered;
  if (shortfall > 0) {
    entries.push({
      accountKind: 'refund_expense',
      amount: kobo(shortfall),
      memo: 'refund_expense',
    });
  } else if (shortfall < 0) {
    throw new LedgerError(
      `Refund recovers ${covered} kobo but only returns ${returned} — the excess has nowhere to go`,
    );
  }

  if (input.toPaymentMethod > 0) {
    entries.push({
      accountKind: 'platform_cash',
      amount: negate(input.toPaymentMethod),
      memo: 'refund_to_payment_method',
    });
  }
  if (input.toWallet > 0) {
    entries.push({
      accountKind: 'customer_wallet',
      ownerId: input.customerId,
      amount: negate(input.toWallet),
      memo: 'refund_to_wallet',
    });
  }

  const draft: LedgerTransactionDraft = {
    kind: 'order_refund',
    idempotencyKey: input.idempotencyKey,
    referenceType: 'order',
    referenceId: input.orderId,
    entries,
    actorId: input.actorId,
    occurredAt: input.occurredAt,
    note: input.note,
  };

  assertBalanced(draft);
  return draft;
}

/** Pay out an accumulated vendor or rider balance. Clears the liability. */
export function buildPayout(input: {
  kind: 'vendor_payout' | 'rider_payout';
  payeeId: string;
  batchId: string;
  idempotencyKey: string;
  actorId: string;
  occurredAt: Date;
  amount: Kobo;
  processingFee?: Kobo | undefined;
}): LedgerTransactionDraft {
  if (input.amount <= 0) {
    throw new LedgerError(`Payout amount must be positive, received ${input.amount}`);
  }

  const accountKind: AccountKind =
    input.kind === 'vendor_payout' ? 'vendor_payable' : 'rider_payable';
  const fee = input.processingFee ?? ZERO;

  const entries: LedgerEntryDraft[] = [
    { accountKind, ownerId: input.payeeId, amount: input.amount, memo: 'payout_clears_liability' },
    { accountKind: 'platform_cash', amount: negate(input.amount), memo: 'payout_cash_out' },
  ];

  if (fee > 0) {
    entries.push({ accountKind: 'processing_expense', amount: fee, memo: 'payout_processing_fee' });
    entries.push({ accountKind: 'platform_cash', amount: negate(fee), memo: 'payout_fee_cash_out' });
  }

  const draft: LedgerTransactionDraft = {
    kind: input.kind,
    idempotencyKey: input.idempotencyKey,
    referenceType: 'payout_batch',
    referenceId: input.batchId,
    entries,
    actorId: input.actorId,
    occurredAt: input.occurredAt,
  };

  assertBalanced(draft);
  return draft;
}

/** Credit a customer's wallet — goodwill, referral reward, or promotion. */
export function buildWalletCredit(input: {
  customerId: string;
  idempotencyKey: string;
  actorId: string;
  occurredAt: Date;
  amount: Kobo;
  reason: 'goodwill' | 'referral' | 'promotion' | 'topup';
  note?: string | undefined;
}): LedgerTransactionDraft {
  if (input.amount <= 0) {
    throw new LedgerError(`Wallet credit must be positive, received ${input.amount}`);
  }

  // A top-up brings real cash in; everything else is the platform giving value
  // away, which is an expense.
  const fundingSide: LedgerEntryDraft =
    input.reason === 'topup'
      ? { accountKind: 'platform_cash', amount: input.amount, memo: 'wallet_topup_received' }
      : { accountKind: 'promotion_expense', amount: input.amount, memo: `wallet_${input.reason}` };

  const draft: LedgerTransactionDraft = {
    kind: input.reason === 'topup' ? 'wallet_topup' : 'promotion_credit',
    idempotencyKey: input.idempotencyKey,
    referenceType: 'customer',
    referenceId: input.customerId,
    entries: [
      fundingSide,
      {
        accountKind: 'customer_wallet',
        ownerId: input.customerId,
        amount: negate(input.amount),
        memo: 'wallet_credited',
      },
    ],
    actorId: input.actorId,
    occurredAt: input.occurredAt,
    note: input.note,
  };

  assertBalanced(draft);
  return draft;
}

/**
 * Reverse a transaction that should not have been posted.
 *
 * This is the *only* correction mechanism. The original stays in the ledger
 * forever; the reversal sits beside it. An auditor sees both, which is the
 * point — a ledger you can edit is not a ledger.
 */
export function buildReversal(input: {
  original: LedgerTransactionDraft;
  originalTransactionId: string;
  idempotencyKey: string;
  actorId: string;
  occurredAt: Date;
  reason: string;
}): LedgerTransactionDraft {
  const draft: LedgerTransactionDraft = {
    kind: 'reversal',
    idempotencyKey: input.idempotencyKey,
    referenceType: 'ledger_transaction',
    referenceId: input.originalTransactionId,
    entries: input.original.entries.map((entry) => ({
      accountKind: entry.accountKind,
      ownerId: entry.ownerId,
      amount: negate(entry.amount),
      memo: `reversal_of_${entry.memo}`,
    })),
    actorId: input.actorId,
    occurredAt: input.occurredAt,
    note: input.reason,
  };

  assertBalanced(draft);
  return draft;
}

/**
 * Verify that a set of transactions balances in aggregate — the check a nightly
 * reconciliation job runs across the whole ledger. If this ever fails, the
 * platform stops posting and pages finance.
 */
export function verifyLedgerIntegrity(
  transactions: readonly LedgerTransactionDraft[],
): { balanced: boolean; totalDrift: Kobo; offending: readonly string[] } {
  const offending: string[] = [];
  let totalDrift = 0;

  for (const transaction of transactions) {
    const sum = transaction.entries.reduce<number>((total, entry) => total + entry.amount, 0);
    if (sum !== 0) {
      offending.push(`${transaction.referenceType}:${transaction.referenceId}`);
      totalDrift += sum;
    }
  }

  return { balanced: offending.length === 0, totalDrift: kobo(totalDrift), offending };
}
