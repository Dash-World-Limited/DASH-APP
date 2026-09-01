/**
 * Vendor payout details.
 *
 * The account number a vendor is paid into is the highest-value single field in
 * the database that is not money itself: changing it redirects every future
 * settlement without touching a ledger entry, so nothing would look wrong until
 * a vendor complained about a missing payment.
 *
 * Three decisions follow from that:
 *
 *   1. **Write-only.** There is no route that returns the account number in
 *      clear, and no permission that would allow one. Settlement will hand the
 *      decrypted value straight to the payment provider when that integration
 *      exists; until then nothing needs to read it, so nothing may.
 *   2. **Encrypted and bound to the vendor.** The ciphertext carries the vendor
 *      id as additional authenticated data, so a row copied between vendors
 *      fails to decrypt rather than silently redirecting someone else's money.
 *   3. **Masked everywhere else.** Reads return the bank name and last four
 *      digits, which is enough for a human to confirm "yes, that is my account"
 *      and not enough for anyone to use.
 */

import { decrypt, encrypt, type Keyring } from '@dash/domain/envelope';
import type { PrismaClient } from '@dash/db';

/** Bind every payout envelope to this vendor and this field. */
function payoutContext(vendorId: string) {
  return { purpose: 'vendor_bank_account', subjectId: vendorId };
}

export class PayoutDetailsError extends Error {
  constructor(
    readonly reason: 'not_configured' | 'invalid_account' | 'not_set',
    message: string,
  ) {
    super(message);
    this.name = 'PayoutDetailsError';
  }
}

/**
 * Nigerian bank account numbers are exactly 10 digits (NUBAN).
 *
 * Validated rather than accepted freely: an account number with a typo is
 * money sent to a stranger, and the check is one line.
 */
const NUBAN_PATTERN = /^\d{10}$/;

export interface PayoutDetailsInput {
  readonly vendorId: string;
  readonly bankName: string;
  readonly accountNumber: string;
  readonly accountName: string;
}

export interface MaskedPayoutDetails {
  readonly configured: boolean;
  readonly bankName: string | null;
  /** Last four digits only. Never the whole number. */
  readonly accountNumberMasked: string | null;
  readonly updatedAt: Date | null;
}

export async function setPayoutDetails(
  prisma: PrismaClient,
  keyring: Keyring | null,
  input: PayoutDetailsInput,
): Promise<MaskedPayoutDetails> {
  if (!keyring) {
    // Storing an account number in clear because a key is missing would be
    // worse than refusing. `config.ts` makes this unreachable in production.
    throw new PayoutDetailsError(
      'not_configured',
      'Payout details cannot be stored because encryption is not configured.',
    );
  }

  const accountNumber = input.accountNumber.replace(/[\s-]/g, '');
  if (!NUBAN_PATTERN.test(accountNumber)) {
    throw new PayoutDetailsError(
      'invalid_account',
      'Enter a valid 10-digit Nigerian account number.',
    );
  }

  // The whole record is encrypted as one value, not just the number: the
  // account *name* is personal data, and pairing it with a bank is exactly the
  // combination worth protecting.
  const payload = JSON.stringify({
    bankName: input.bankName,
    accountNumber,
    accountName: input.accountName,
  });

  const updated = await prisma.vendor.update({
    where: { id: input.vendorId },
    data: {
      bankAccountCipher: encrypt(payload, keyring, payoutContext(input.vendorId)),
      // Kept in clear deliberately: a vendor needs to recognise their own
      // account, and four digits identifies nothing on its own.
      bankAccountLast4: accountNumber.slice(-4),
      bankName: input.bankName,
    },
    select: { bankName: true, bankAccountLast4: true, updatedAt: true },
  });

  return {
    configured: true,
    bankName: updated.bankName,
    accountNumberMasked: updated.bankAccountLast4 ? `••••••${updated.bankAccountLast4}` : null,
    updatedAt: updated.updatedAt,
  };
}

export async function readMaskedPayoutDetails(
  prisma: PrismaClient,
  vendorId: string,
): Promise<MaskedPayoutDetails> {
  const vendor = await prisma.vendor.findUnique({
    where: { id: vendorId },
    // Note what is not selected: bankAccountCipher never leaves this module.
    select: { bankName: true, bankAccountLast4: true, bankAccountCipher: true, updatedAt: true },
  });

  if (!vendor?.bankAccountCipher) {
    return { configured: false, bankName: null, accountNumberMasked: null, updatedAt: null };
  }

  return {
    configured: true,
    bankName: vendor.bankName,
    accountNumberMasked: vendor.bankAccountLast4 ? `••••••${vendor.bankAccountLast4}` : null,
    updatedAt: vendor.updatedAt,
  };
}

/**
 * Decrypt payout details for a settlement run.
 *
 * **Not reachable from any HTTP route, and deliberately so.** This exists for
 * the payout integration Codex will build: that job decrypts, hands the value
 * to the provider, and never returns it to a caller. Exposing it through an
 * endpoint would undo the whole design above.
 *
 * Returns which key opened the record so a rotation job can find rows still
 * sitting under a retired key.
 */
export async function decryptPayoutDetailsForSettlement(
  prisma: PrismaClient,
  keyring: Keyring | null,
  vendorId: string,
): Promise<{
  bankName: string;
  accountNumber: string;
  accountName: string;
  keyId: string;
  needsReEncryption: boolean;
}> {
  if (!keyring) {
    throw new PayoutDetailsError('not_configured', 'Encryption is not configured.');
  }

  const vendor = await prisma.vendor.findUnique({
    where: { id: vendorId },
    select: { bankAccountCipher: true },
  });

  if (!vendor?.bankAccountCipher) {
    throw new PayoutDetailsError('not_set', 'This vendor has no payout details.');
  }

  const opened = decrypt(vendor.bankAccountCipher, keyring, payoutContext(vendorId));
  const parsed = JSON.parse(opened.plaintext) as {
    bankName: string;
    accountNumber: string;
    accountName: string;
  };

  return {
    ...parsed,
    keyId: opened.keyId,
    needsReEncryption: !opened.usedActiveKey,
  };
}
