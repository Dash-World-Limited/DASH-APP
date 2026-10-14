/**
 * Rider payout account: the bank account a rider is paid into.
 *
 * Built the same way as vendor payout details (vendor/payout.ts), for the same
 * reason: whoever can change this account redirects a rider's earnings, and
 * nothing would look wrong until the rider asked where their money went.
 *
 *   1. **The bank confirms the name.** The rider picks a bank from the payment
 *      provider's own list and types the account number; the account name is
 *      what the bank reports through the provider, never what anyone typed.
 *      Saving resolves it again on the server, so a client cannot submit a
 *      name the bank did not give.
 *   2. **Encrypted and bound to the rider.** The full record is one envelope
 *      whose additional data is this rider's id, so a row copied to another
 *      rider fails to decrypt rather than paying the wrong person.
 *   3. **Masked everywhere else.** Reads return the bank, the account name and
 *      the last four digits — enough to recognise the account, not enough to
 *      use it. No route returns the full number.
 */

import { encrypt, type Keyring } from '@dash/domain/envelope';
import type { PaymentPort, PayoutBank } from '@dash/domain/ports';
import type { PrismaClient } from '@dash/db';

export const RIDER_PAYOUT_PURPOSE = 'rider_bank_account';

/** Bind every rider payout envelope to this rider and this field. */
export function riderPayoutContext(riderId: string) {
  return { purpose: RIDER_PAYOUT_PURPOSE, subjectId: riderId };
}

export type RiderPayoutRefusal =
  | 'not_configured'
  | 'invalid_account'
  | 'unknown_bank'
  | 'account_not_found'
  | 'name_changed'
  | 'provider_unavailable';

export class RiderPayoutError extends Error {
  constructor(
    readonly reason: RiderPayoutRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'RiderPayoutError';
  }
}

/** Nigerian account numbers (NUBAN) are exactly ten digits. */
const NUBAN_PATTERN = /^\d{10}$/;

export function normaliseAccountNumber(raw: string): string {
  return raw.replace(/[\s-]/g, '');
}

// ---------------------------------------------------------------------------
// Banks
// ---------------------------------------------------------------------------

/** The provider's bank list changes rarely; asking for it on every screen open is waste. */
const BANK_LIST_TTL_MS = 6 * 60 * 60_000;
const bankLists = new WeakMap<PaymentPort, { at: number; banks: readonly PayoutBank[] }>();

export async function payoutBanks(payments: PaymentPort): Promise<readonly PayoutBank[]> {
  const cached = bankLists.get(payments);
  if (cached && Date.now() - cached.at < BANK_LIST_TTL_MS) return cached.banks;
  let banks: readonly PayoutBank[];
  try {
    banks = await payments.listBanks();
  } catch {
    // Not cached: the next request asks again.
    throw new RiderPayoutError('provider_unavailable', 'The list of banks is not available right now. Please try again shortly.');
  }
  bankLists.set(payments, { at: Date.now(), banks });
  return banks;
}

// ---------------------------------------------------------------------------
// Verifying an account
// ---------------------------------------------------------------------------

export interface VerifiedAccount {
  readonly bank: PayoutBank;
  readonly accountNumber: string;
  readonly accountName: string;
}

export async function verifyRiderAccount(
  payments: PaymentPort,
  input: { bankCode: string; accountNumber: string },
): Promise<VerifiedAccount> {
  const accountNumber = normaliseAccountNumber(input.accountNumber);
  if (!NUBAN_PATTERN.test(accountNumber)) {
    throw new RiderPayoutError('invalid_account', 'Enter your 10-digit account number.');
  }

  const bank = (await payoutBanks(payments)).find((candidate) => candidate.code === input.bankCode);
  if (!bank) throw new RiderPayoutError('unknown_bank', 'Choose your bank from the list.');

  let resolved: { accountName: string } | null;
  try {
    resolved = await payments.resolveBankAccount({ bankCode: bank.code, accountNumber });
  } catch {
    throw new RiderPayoutError(
      'provider_unavailable',
      'Your bank could not be checked right now. Please try again shortly.',
    );
  }
  if (!resolved) {
    throw new RiderPayoutError(
      'account_not_found',
      `${bank.name} did not recognise that account number. Check it and try again.`,
    );
  }
  return { bank, accountNumber, accountName: resolved.accountName };
}

// ---------------------------------------------------------------------------
// Reading and saving
// ---------------------------------------------------------------------------

export interface MaskedRiderPayoutAccount {
  readonly configured: boolean;
  readonly bankCode: string | null;
  readonly bankName: string | null;
  readonly accountName: string | null;
  /** Last four digits only. Never the whole number. */
  readonly accountNumberMasked: string | null;
  readonly verifiedAt: Date | null;
  readonly verifiedBy: string | null;
  readonly updatedAt: Date | null;
}

const NOT_SET: MaskedRiderPayoutAccount = {
  configured: false,
  bankCode: null,
  bankName: null,
  accountName: null,
  accountNumberMasked: null,
  verifiedAt: null,
  verifiedBy: null,
  updatedAt: null,
};

/** Never selects the ciphertext. */
const MASKED_SELECT = {
  bankCode: true,
  bankName: true,
  accountName: true,
  accountNumberLast4: true,
  verifiedAt: true,
  verifiedBy: true,
  updatedAt: true,
} as const;

function masked(row: {
  bankCode: string;
  bankName: string;
  accountName: string;
  accountNumberLast4: string;
  verifiedAt: Date;
  verifiedBy: string;
  updatedAt: Date;
}): MaskedRiderPayoutAccount {
  return {
    configured: true,
    bankCode: row.bankCode,
    bankName: row.bankName,
    accountName: row.accountName,
    accountNumberMasked: `••••••${row.accountNumberLast4}`,
    verifiedAt: row.verifiedAt,
    verifiedBy: row.verifiedBy,
    updatedAt: row.updatedAt,
  };
}

export async function readRiderPayoutAccount(prisma: PrismaClient, riderId: string): Promise<MaskedRiderPayoutAccount> {
  const row = await prisma.riderPayoutAccount.findUnique({ where: { riderId }, select: MASKED_SELECT });
  return row ? masked(row) : NOT_SET;
}

/**
 * Verify with the bank and save. `confirmAccountName` is the name the rider
 * was shown and accepted; if the bank now reports a different one, nothing is
 * saved and the rider is asked to check again.
 */
export async function saveRiderPayoutAccount(
  prisma: PrismaClient,
  keyring: Keyring | null,
  payments: PaymentPort,
  input: { riderId: string; bankCode: string; accountNumber: string; confirmAccountName: string },
): Promise<MaskedRiderPayoutAccount> {
  if (!keyring) {
    // Storing an account number in clear because a key is missing would be
    // worse than refusing. `config.ts` makes this unreachable in production.
    throw new RiderPayoutError('not_configured', 'Bank accounts cannot be saved right now. Please contact DASH support.');
  }

  const verified = await verifyRiderAccount(payments, input);
  if (sameName(verified.accountName) !== sameName(input.confirmAccountName)) {
    throw new RiderPayoutError(
      'name_changed',
      'Your bank now reports a different account name. Check the account again before saving.',
    );
  }

  const record = {
    bankCode: verified.bank.code,
    bankName: verified.bank.name,
    accountName: verified.accountName,
    accountNumberLast4: verified.accountNumber.slice(-4),
    // The whole record, not just the number: the name and the bank paired
    // with it are exactly the combination worth protecting.
    accountCipher: encrypt(
      JSON.stringify({
        bankCode: verified.bank.code,
        bankName: verified.bank.name,
        accountNumber: verified.accountNumber,
        accountName: verified.accountName,
      }),
      keyring,
      riderPayoutContext(input.riderId),
    ),
    verifiedAt: new Date(),
    verifiedBy: payments.providerName,
  };

  const row = await prisma.riderPayoutAccount.upsert({
    where: { riderId: input.riderId },
    create: { riderId: input.riderId, ...record },
    update: record,
    select: MASKED_SELECT,
  });
  return masked(row);
}

function sameName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toUpperCase();
}
