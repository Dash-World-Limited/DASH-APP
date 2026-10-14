/**
 * Customer payment methods: cards saved through the payment provider.
 *
 * DASH never sees a card. To save one, the customer pays a small verification
 * charge on the provider's own card page — the only way Paystack tokenises a
 * card — and DASH keeps what comes back:
 *
 *   - the provider's reusable token, encrypted and bound to the customer
 *     (purpose `customer_payment_method`), because it can charge the card;
 *   - what a person needs to recognise it: brand, last four, expiry, bank.
 *
 * The verification charge is refunded once the card is saved. Its record,
 * PaymentMethodSetup, says what was charged and refunded.
 */

import { generateReference } from '@dash/domain/crypto';
import { decrypt, encrypt, type Keyring } from '@dash/domain/envelope';
import { kobo, type Kobo } from '@dash/domain/money';
import type { PaymentPort } from '@dash/domain/ports';
import type { PrismaClient } from '@dash/db';

/** ₦50: the smallest card charge Paystack takes, refunded once the card is saved. */
export const CARD_SETUP_AMOUNT: Kobo = kobo(5_000);

/** A setup the customer left half-way is resumed only while it is this fresh. */
const SETUP_RESUME_WINDOW_MS = 60 * 60_000;

export const PAYMENT_METHOD_PURPOSE = 'customer_payment_method';

function tokenContext(customerId: string) {
  return { purpose: PAYMENT_METHOD_PURPOSE, subjectId: customerId };
}

export type PaymentMethodRefusal = 'not_configured' | 'no_email' | 'not_found' | 'provider_unavailable';

export class PaymentMethodError extends Error {
  constructor(
    readonly reason: PaymentMethodRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'PaymentMethodError';
  }
}

export interface MaskedPaymentMethod {
  readonly id: string;
  readonly brand: string;
  readonly last4: string;
  readonly expMonth: number;
  readonly expYear: number;
  readonly bank: string | null;
  readonly isDefault: boolean;
  readonly createdAt: Date;
}

/** Never selects the token. */
const MASKED_SELECT = {
  id: true,
  brand: true,
  last4: true,
  expMonth: true,
  expYear: true,
  bank: true,
  isDefault: true,
  createdAt: true,
} as const;

export async function listPaymentMethods(prisma: PrismaClient, customerId: string): Promise<MaskedPaymentMethod[]> {
  return prisma.paymentMethod.findMany({
    where: { customerId, removedAt: null },
    select: MASKED_SELECT,
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
  });
}

/**
 * The customer's newest setup, if it is still waiting for them to finish on
 * the provider's page. An older one left behind is never offered: starting a
 * new setup settles it (see `startCardSetup`).
 */
export async function pendingSetup(prisma: PrismaClient, customerId: string) {
  const newest = await prisma.paymentMethodSetup.findFirst({
    where: { customerId, createdAt: { gt: new Date(Date.now() - SETUP_RESUME_WINDOW_MS) } },
    select: { reference: true, amount: true, status: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  });
  return newest?.status === 'pending' ? { reference: newest.reference, amount: newest.amount, createdAt: newest.createdAt } : null;
}

// ---------------------------------------------------------------------------
// Adding a card
// ---------------------------------------------------------------------------

export async function startCardSetup(
  prisma: PrismaClient,
  keyring: Keyring | null,
  payments: PaymentPort,
  input: { customerId: string; email: string | null },
): Promise<{ reference: string; authorizationUrl: string; amount: Kobo }> {
  if (!input.email) {
    throw new PaymentMethodError('no_email', 'Add an email address to your account before saving a card.');
  }

  // Settle any setup the customer left half-way before starting another. If
  // they did pay on the provider's page, the card is saved and the charge
  // refunded now; if they never did, it is set aside. One the provider cannot
  // be asked about stays pending for the next attempt.
  const leftBehind = await prisma.paymentMethodSetup.findMany({
    where: { customerId: input.customerId, status: 'pending' },
    select: { reference: true },
    orderBy: { createdAt: 'asc' },
    take: 5,
  });
  for (const earlier of leftBehind) {
    try {
      const outcome = await confirmCardSetup(prisma, keyring, payments, { customerId: input.customerId, reference: earlier.reference });
      if (outcome.status === 'pending') {
        await prisma.paymentMethodSetup.updateMany({
          where: { reference: earlier.reference, status: 'pending' },
          data: { status: 'failed', failureReason: 'superseded' },
        });
      }
    } catch {
      // Left pending.
    }
  }

  const reference = generateReference('CARD', 12);
  await prisma.paymentMethodSetup.create({
    data: { customerId: input.customerId, provider: payments.providerName, reference, amount: CARD_SETUP_AMOUNT },
  });
  try {
    const { authorizationUrl } = await payments.initializeCardSetup({
      reference,
      amount: CARD_SETUP_AMOUNT,
      customerEmail: input.email,
      idempotencyKey: `card-setup:${reference}`,
    });
    return { reference, authorizationUrl, amount: CARD_SETUP_AMOUNT };
  } catch {
    await prisma.paymentMethodSetup.update({ where: { reference }, data: { status: 'failed', failureReason: 'provider_unavailable' } });
    throw new PaymentMethodError('provider_unavailable', 'Cards cannot be added right now. Please try again shortly.');
  }
}

export type SetupOutcome =
  | { status: 'saved'; method: MaskedPaymentMethod; refunded: boolean }
  | { status: 'pending' }
  | { status: 'failed'; reason: string };

/**
 * Ask the provider how a setup went and, if the card was tokenised, save it.
 *
 * Safe to call any number of times, from the app returning or retrying: the
 * move from pending to saved happens once, and only the call that makes it
 * refunds the verification charge. A refund the provider could not take is
 * retried by the next call.
 */
export async function confirmCardSetup(
  prisma: PrismaClient,
  keyring: Keyring | null,
  payments: PaymentPort,
  input: { customerId: string; reference: string },
): Promise<SetupOutcome> {
  const setup = await prisma.paymentMethodSetup.findFirst({
    where: { reference: input.reference, customerId: input.customerId },
  });
  if (!setup) throw new PaymentMethodError('not_found', 'Not found.');

  if (setup.status === 'saved' && setup.paymentMethodId) {
    const refunded = setup.refundReference !== null || (await refundSetup(prisma, payments, setup.reference, setup.amount));
    const method = await prisma.paymentMethod.findUniqueOrThrow({ where: { id: setup.paymentMethodId }, select: MASKED_SELECT });
    return { status: 'saved', method, refunded };
  }
  if (setup.status === 'failed') return { status: 'failed', reason: setup.failureReason ?? 'failed' };

  if (!keyring) {
    throw new PaymentMethodError('not_configured', 'Cards cannot be saved right now. Please contact DASH support.');
  }

  let result;
  try {
    result = await payments.verifyCardSetup(setup.reference);
  } catch {
    throw new PaymentMethodError('provider_unavailable', 'Your card could not be checked just now. Please try again shortly.');
  }

  if (result.status === 'pending') return { status: 'pending' };

  const failure =
    result.status !== 'captured'
      ? 'declined'
      : result.amount !== setup.amount
        ? 'amount_mismatch'
        : result.card === null
          ? 'card_not_reusable'
          : null;

  if (failure || !result.card) {
    const moved = await prisma.paymentMethodSetup.updateMany({
      where: { id: setup.id, status: 'pending' },
      data: { status: 'failed', failureReason: failure ?? 'card_not_reusable' },
    });
    // A captured charge on a card that cannot be saved is still refunded.
    if (moved.count === 1 && result.status === 'captured' && result.amount > 0) {
      await refundSetup(prisma, payments, setup.reference, result.amount);
    }
    return { status: 'failed', reason: failure ?? 'card_not_reusable' };
  }

  const card = result.card;
  const method = await prisma.$transaction(async (tx) => {
    const hasDefault = (await tx.paymentMethod.count({ where: { customerId: input.customerId, removedAt: null, isDefault: true } })) > 0;
    const fields = {
      provider: payments.providerName,
      tokenCipher: encrypt(card.token, keyring, tokenContext(input.customerId)),
      brand: card.brand,
      last4: card.last4,
      expMonth: card.expMonth,
      expYear: card.expYear,
      bank: card.bank,
      removedAt: null,
    };
    // Adding a card already on file refreshes that one row — and makes it the
    // default again if it was removed and nothing replaced it.
    const saved = await tx.paymentMethod.upsert({
      where: { customerId_fingerprint: { customerId: input.customerId, fingerprint: card.fingerprint } },
      create: { customerId: input.customerId, fingerprint: card.fingerprint, isDefault: !hasDefault, ...fields },
      update: hasDefault ? fields : { ...fields, isDefault: true },
      select: { id: true },
    });
    const moved = await tx.paymentMethodSetup.updateMany({
      where: { id: setup.id, status: 'pending' },
      data: { status: 'saved', paymentMethodId: saved.id },
    });
    return { id: saved.id, won: moved.count === 1 };
  });

  // Only the call that saved it refunds; any other finds it saved and checks.
  const refunded = method.won ? await refundSetup(prisma, payments, setup.reference, setup.amount) : false;
  const masked = await prisma.paymentMethod.findUniqueOrThrow({ where: { id: method.id }, select: MASKED_SELECT });
  return { status: 'saved', method: masked, refunded };
}

async function refundSetup(prisma: PrismaClient, payments: PaymentPort, reference: string, amount: number): Promise<boolean> {
  try {
    const refund = await payments.refund({
      providerReference: reference,
      amount: kobo(amount),
      reason: 'Card verification charge',
      idempotencyKey: `card-setup-refund:${reference}`,
    });
    await prisma.paymentMethodSetup.updateMany({
      where: { reference, refundReference: null },
      data: { refundReference: refund.refundReference },
    });
    return true;
  } catch {
    // Left without a refund reference, so the next confirmation tries again.
    return false;
  }
}

// ---------------------------------------------------------------------------
// Managing saved cards
// ---------------------------------------------------------------------------

export async function setDefaultPaymentMethod(prisma: PrismaClient, input: { customerId: string; id: string }): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const found = await tx.paymentMethod.findFirst({ where: { id: input.id, customerId: input.customerId, removedAt: null }, select: { id: true } });
    if (!found) throw new PaymentMethodError('not_found', 'Not found.');
    await tx.paymentMethod.updateMany({ where: { customerId: input.customerId, isDefault: true }, data: { isDefault: false } });
    await tx.paymentMethod.update({ where: { id: found.id }, data: { isDefault: true } });
  });
}

/**
 * Remove a card: it disappears from DASH at once, and the provider is asked
 * to stop its token working. If the provider cannot be reached, the card is
 * still removed here; `providerDeactivated` says which happened.
 */
export async function removePaymentMethod(
  prisma: PrismaClient,
  keyring: Keyring | null,
  payments: PaymentPort,
  input: { customerId: string; id: string },
): Promise<{ providerDeactivated: boolean }> {
  const method = await prisma.paymentMethod.findFirst({
    where: { id: input.id, customerId: input.customerId, removedAt: null },
    select: { id: true, isDefault: true, tokenCipher: true },
  });
  if (!method) throw new PaymentMethodError('not_found', 'Not found.');

  await prisma.$transaction(async (tx) => {
    await tx.paymentMethod.update({ where: { id: method.id }, data: { removedAt: new Date(), isDefault: false } });
    if (method.isDefault) {
      const next = await tx.paymentMethod.findFirst({
        where: { customerId: input.customerId, removedAt: null },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
      if (next) await tx.paymentMethod.update({ where: { id: next.id }, data: { isDefault: true } });
    }
  });

  if (!keyring) return { providerDeactivated: false };
  try {
    const token = decrypt(method.tokenCipher, keyring, tokenContext(input.customerId)).plaintext;
    await payments.deactivateCard(token);
    return { providerDeactivated: true };
  } catch {
    return { providerDeactivated: false };
  }
}
