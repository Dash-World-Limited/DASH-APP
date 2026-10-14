/**
 * Account deletion — the work behind the routes and the finalisation job.
 *
 * The shape:
 *
 *   request   → an AccountDeletionRequest row, status `scheduled`, with a
 *               `scheduledPurgeAt` a cooling-off window in the future
 *   cancel    → status `cancelled`, any time before that instant
 *   finalise  → a job, after the window: anonymise everything the ledger
 *               references, delete the rest, revoke every session
 *
 * The invariant this file exists to hold: **nothing the ledger sums over is
 * ever deleted.** Orders, payments, settlements, and every ledger entry survive
 * with their ids intact; only the fields that name a person are cleared. The
 * policy for what clears and what stays is in `@dash/domain/account`, tested
 * there; this file applies it.
 */

import {
  anonymisedAddress,
  anonymisedIdentity,
  assertCoolingOffDays,
  assertDeletionTransition,
  canOwnerCancelDeletion,
  DELETION_PENDING_STATUSES,
  evaluateLegalHold,
  isDueForFinalisation,
  purgeAfter,
  type DeletionStatus,
  type LegalHold,
  type LegalHoldSignals,
} from '@dash/domain/account';
import { ACTIVE_STATUSES, freezeDeliveryAddress } from '@dash/domain/orders';
import { balanceOf } from '@dash/domain/ledger';
import { kobo } from '@dash/domain/money';
import { writeAudit, type PrismaClient } from '@dash/db';
import { AccountDeletionError } from './errors.js';

/** Support-case categories that must survive on record whatever the customer asks. */
const HELD_CASE_CATEGORIES = new Set(['dispute', 'fraud', 'safety', 'chargeback']);

// ---------------------------------------------------------------------------
// Legal holds
// ---------------------------------------------------------------------------

/**
 * Gather the four signals `evaluateLegalHold` needs.
 *
 * Each is a cheap existence check, not a full load. A hold does not deny the
 * request forever — it blocks acceptance until the underlying matter clears.
 */
export async function gatherLegalHoldSignals(
  prisma: PrismaClient,
  customerId: string,
): Promise<LegalHoldSignals> {
  const [openOrder, unresolvedRefund, heldCase, walletEntries] = await Promise.all([
    prisma.order.findFirst({
      where: { customerId, status: { in: [...ACTIVE_STATUSES] } },
      select: { id: true },
    }),
    prisma.refund.findFirst({
      where: {
        payment: { order: { customerId } },
        status: { in: ['pending', 'processing', 'disputed'] },
      },
      select: { id: true },
    }),
    prisma.supportCase.findFirst({
      where: {
        customerId,
        status: { in: ['open', 'pending'] },
        category: { in: [...HELD_CASE_CATEGORIES] },
      },
      select: { id: true },
    }),
    prisma.ledgerEntry.findMany({
      where: { accountKind: 'customer_wallet', ownerId: customerId },
      select: { amount: true },
    }),
  ]);

  // A wallet balance below zero is money the person owes the platform.
  const walletBalance = balanceOf(
    'customer_wallet',
    walletEntries.map((entry) => ({ amount: kobo(entry.amount) })),
  );

  return {
    hasOpenOrder: openOrder !== null,
    hasUnresolvedPaymentDispute: unresolvedRefund !== null,
    hasOpenDisputeOrSafetyCase: heldCase !== null,
    owesMoney: walletBalance < 0,
  };
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

export interface RequestDeletionInput {
  /** The identity whose account is to be deleted. */
  readonly identityId: string;
  /** Its customer id — deletion is a customer flow; staff/vendor/rider are out of scope. */
  readonly customerId: string;
  /** The acting identity: the account holder, or a staff member acting on their behalf. */
  readonly requestedBy: string;
  readonly coolingOffDays: number;
  readonly ipAddress?: string | null;
  readonly userAgent?: string | null;
  readonly reason?: string | null;
  /** Non-null for the staff path; drives the on-behalf-of audit attribution. */
  readonly onBehalfOf?: string | null;
  readonly requestId?: string | null;
  readonly now?: Date;
}

export interface DeletionRequestView {
  readonly id: string;
  readonly status: DeletionStatus;
  readonly requestedAt: Date;
  readonly scheduledPurgeAt: Date;
  readonly cancelledAt: Date | null;
  readonly completedAt: Date | null;
  readonly cancellable: boolean;
}

function toView(
  row: {
    id: string;
    status: string;
    requestedAt: Date;
    scheduledPurgeAt: Date;
    cancelledAt: Date | null;
    completedAt: Date | null;
  },
  now: Date,
): DeletionRequestView {
  const status = row.status as DeletionStatus;
  return {
    id: row.id,
    status,
    requestedAt: row.requestedAt,
    scheduledPurgeAt: row.scheduledPurgeAt,
    cancelledAt: row.cancelledAt,
    completedAt: row.completedAt,
    cancellable: canOwnerCancelDeletion({ status, scheduledPurgeAt: row.scheduledPurgeAt }, now),
  };
}

/**
 * Create — or return — a scheduled deletion request.
 *
 * Idempotent by shape: there is one row per identity. A second call while a
 * request is already `scheduled` returns it unchanged rather than resetting the
 * clock. A call after `completed` is refused — the account is gone. A call
 * after `cancelled` starts a fresh window (the old terminal row is replaced).
 */
export async function requestAccountDeletion(
  prisma: PrismaClient,
  input: RequestDeletionInput,
): Promise<DeletionRequestView> {
  assertCoolingOffDays(input.coolingOffDays);
  const now = input.now ?? new Date();

  const existing = await prisma.accountDeletionRequest.findUnique({
    where: { identityId: input.identityId },
  });

  if (existing?.status === 'scheduled' || existing?.status === 'held') {
    // A deletion is already in flight (a `held` one is parked on a legal hold
    // but still headed for finalisation). Return it rather than restart the clock.
    return toView(existing, now);
  }
  if (existing?.status === 'completed') {
    throw new AccountDeletionError(
      'already_completed',
      'This account has already been deleted.',
    );
  }

  // A legal hold blocks acceptance. Checked here, not at finalisation, so the
  // person hears about it while they can still act on it.
  const hold = evaluateLegalHold(await gatherLegalHoldSignals(prisma, input.customerId));
  if (hold) {
    throw new AccountDeletionError('legal_hold', hold.message, { hold: hold.code });
  }

  const scheduledPurgeAt = purgeAfter(now, input.coolingOffDays);

  const row = await prisma.$transaction(async (tx) => {
    // Replace any terminal (cancelled) row so the one-per-identity constraint
    // never blocks a legitimate re-request.
    if (existing) {
      await tx.accountDeletionRequest.delete({ where: { id: existing.id } });
    }

    const created = await tx.accountDeletionRequest.create({
      data: {
        identityId: input.identityId,
        status: 'scheduled',
        requestedAt: now,
        scheduledPurgeAt,
        reason: input.reason ?? null,
        requestedBy: input.requestedBy,
        requestedByIp: input.ipAddress ?? null,
        requestedByAgent: input.userAgent ?? null,
      },
    });

    await tx.identity.update({
      where: { id: input.identityId },
      data: { deletionRequestedAt: now },
    });

    return created;
  });

  await writeAudit(prisma, {
    identityId: input.requestedBy,
    onBehalfOf: input.onBehalfOf ?? null,
    action: 'account.deletion.requested',
    resourceType: 'identity',
    resourceId: input.identityId,
    after: {
      scheduledPurgeAt: scheduledPurgeAt.toISOString(),
      coolingOffDays: input.coolingOffDays,
      // The reason is stored on the row, not copied into the audit log.
      hasReason: Boolean(input.reason),
    },
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
    requestId: input.requestId ?? null,
  });

  return toView(row, now);
}

// ---------------------------------------------------------------------------
// Read / cancel
// ---------------------------------------------------------------------------

export async function getAccountDeletion(
  prisma: PrismaClient,
  identityId: string,
  now: Date = new Date(),
): Promise<DeletionRequestView | null> {
  const row = await prisma.accountDeletionRequest.findUnique({ where: { identityId } });
  return row ? toView(row, now) : null;
}

/**
 * Cancel a scheduled deletion.
 *
 * Only while `scheduled` and before `scheduledPurgeAt`. Once the window closes
 * the request is the job's to finalise, not the owner's to stop.
 */
export async function cancelAccountDeletion(
  prisma: PrismaClient,
  input: {
    identityId: string;
    cancelledBy: string;
    ipAddress?: string | null;
    userAgent?: string | null;
    requestId?: string | null;
    onBehalfOf?: string | null;
    now?: Date;
  },
): Promise<DeletionRequestView> {
  const now = input.now ?? new Date();

  const existing = await prisma.accountDeletionRequest.findUnique({
    where: { identityId: input.identityId },
  });
  if (!existing) {
    throw new AccountDeletionError('not_found', 'There is no deletion request to cancel.');
  }
  if (
    !canOwnerCancelDeletion(
      { status: existing.status as DeletionStatus, scheduledPurgeAt: existing.scheduledPurgeAt },
      now,
    )
  ) {
    throw new AccountDeletionError(
      'not_cancellable',
      'This deletion request can no longer be cancelled.',
    );
  }

  assertDeletionTransition(existing.status as DeletionStatus, 'cancelled');

  const row = await prisma.$transaction(async (tx) => {
    // Guarded update: if a finalisation just claimed it, `count` is 0 and we
    // lost the race — report it as no longer cancellable rather than pretend.
    // Both `scheduled` and `held` are cancellable by the owner.
    const updated = await tx.accountDeletionRequest.updateMany({
      where: { id: existing.id, status: { in: [...DELETION_PENDING_STATUSES] } },
      data: { status: 'cancelled', cancelledAt: now },
    });
    if (updated.count === 0) {
      throw new AccountDeletionError(
        'not_cancellable',
        'This deletion request can no longer be cancelled.',
      );
    }
    await tx.identity.update({
      where: { id: input.identityId },
      data: { deletionRequestedAt: null },
    });
    return tx.accountDeletionRequest.findUniqueOrThrow({ where: { id: existing.id } });
  });

  await writeAudit(prisma, {
    identityId: input.cancelledBy,
    onBehalfOf: input.onBehalfOf ?? null,
    action: 'account.deletion.cancelled',
    resourceType: 'identity',
    resourceId: input.identityId,
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
    requestId: input.requestId ?? null,
  });

  return toView(row, now);
}

// ---------------------------------------------------------------------------
// Finalisation
// ---------------------------------------------------------------------------

export interface FinalisationResult {
  readonly identityId: string;
  readonly alreadyDone: boolean;
  /**
   * The due request was blocked by a legal hold acquired during the cooling-off
   * period. It has been parked in `held`; a later run retries it.
   */
  readonly held?: boolean;
  /** The hold code, when `held`. Non-sensitive. */
  readonly heldReason?: string;
  /** Row counts by class, for the job report. Never row contents. */
  readonly counts: Record<string, number>;
}

/**
 * Anonymise an account whose cooling-off window has passed.
 *
 * Legal holds are **re-checked here**, not only at request time: a customer can
 * open a new order, trigger a dispute, or run their wallet negative during the
 * cooling-off period. If a hold is found now, the request is parked in `held`
 * (nothing is anonymised, nothing is completed) and every later maintenance run
 * re-evaluates it — it resumes automatically once the matter clears.
 *
 * Idempotent three ways:
 *   - `Identity.anonymisedAt` — a second run over a done account returns early.
 *   - The request's `idempotencyKey` — set on first finalisation, so a retry
 *     with the same key is a no-op.
 *   - Every write is a set-to-constant or a delete of rows that will be gone,
 *     so even a partial re-run converges.
 *
 * All in one transaction: a finalisation that half-completed would leave an
 * account both named and marked deleted.
 */
export async function finaliseAccountDeletion(
  prisma: PrismaClient,
  input: { identityId: string; idempotencyKey: string; now?: Date },
): Promise<FinalisationResult> {
  const now = input.now ?? new Date();

  const identity = await prisma.identity.findUnique({
    where: { id: input.identityId },
    select: {
      id: true,
      anonymisedAt: true,
      customer: { select: { id: true } },
    },
  });

  if (!identity) {
    return { identityId: input.identityId, alreadyDone: true, counts: {} };
  }
  if (identity.anonymisedAt) {
    return { identityId: input.identityId, alreadyDone: true, counts: {} };
  }

  const request = await prisma.accountDeletionRequest.findUnique({
    where: { identityId: input.identityId },
  });
  if (!request || (request.status !== 'scheduled' && request.status !== 'held')) {
    // Cancelled, already completed, or never existed. Nothing to do.
    return { identityId: input.identityId, alreadyDone: true, counts: {} };
  }
  const fromStatus = request.status as DeletionStatus;
  if (!isDueForFinalisation({ status: fromStatus, scheduledPurgeAt: request.scheduledPurgeAt }, now)) {
    throw new AccountDeletionError(
      'not_due',
      'This deletion request has not yet reached the end of its cooling-off window.',
    );
  }

  const customerId = identity.customer?.id ?? null;

  // Re-check legal holds at the last moment. A hold acquired since the request
  // was made parks it in `held` rather than letting it through.
  const hold: LegalHold | null = customerId
    ? evaluateLegalHold(await gatherLegalHoldSignals(prisma, customerId))
    : null;
  if (hold) {
    const parked = await prisma.accountDeletionRequest.updateMany({
      where: {
        id: request.id,
        status: { in: [...DELETION_PENDING_STATUSES] },
        idempotencyKey: null,
      },
      data: { status: 'held', heldReason: hold.code, heldAt: now },
    });
    if (parked.count === 0) {
      // Cancelled or completed under us. Nothing to do.
      return { identityId: input.identityId, alreadyDone: true, counts: {} };
    }
    // One audit entry when the hold first appears or its reason changes — not
    // one on every quiet retry.
    if (request.status !== 'held' || request.heldReason !== hold.code) {
      await writeAudit(prisma, {
        identityId: null,
        action: 'account.deletion.held',
        resourceType: 'identity',
        resourceId: input.identityId,
        after: { hold: hold.code },
        requestId: null,
      });
    }
    return {
      identityId: input.identityId,
      alreadyDone: false,
      held: true,
      heldReason: hold.code,
      counts: {},
    };
  }

  assertDeletionTransition(fromStatus, 'completed');

  const counts: Record<string, number> = {};

  const didFinalise = await prisma.$transaction(async (tx) => {
    // Claim the request. A `held` one that has just cleared its hold is claimed
    // the same way. If another finaliser beat us, `count` is 0 — bail.
    const claimed = await tx.accountDeletionRequest.updateMany({
      where: {
        id: request.id,
        status: { in: [...DELETION_PENDING_STATUSES] },
        idempotencyKey: null,
      },
      data: { status: 'completed', completedAt: now, idempotencyKey: input.idempotencyKey },
    });
    if (claimed.count === 0) {
      // Another finaliser claimed it first, or it is already completed. Nothing
      // for this call to do — and, crucially, it must not write a second
      // `account.deletion.completed` audit entry for work it did not do.
      return false;
    }

    // --- Delete: credentials and drafts ---------------------------------
    counts['Session'] = (await tx.session.deleteMany({ where: { identityId: identity.id } })).count;
    counts['Device'] = (await tx.device.deleteMany({ where: { identityId: identity.id } })).count;
    counts['OtpChallenge'] = (
      await tx.otpChallenge.deleteMany({ where: { identityId: identity.id } })
    ).count;
    counts['MfaChallenge'] = (
      await tx.mfaChallenge.deleteMany({ where: { identityId: identity.id } })
    ).count;
    counts['MfaRecoveryCode'] = (
      await tx.mfaRecoveryCode.deleteMany({ where: { identityId: identity.id } })
    ).count;

    if (customerId) {
      // Carts cascade to items on delete.
      counts['Cart'] = (await tx.cart.deleteMany({ where: { customerId } })).count;

      // --- Anonymise: rows the ledger / an order references ------------
      const addresses = await tx.address.findMany({
        where: { customerId },
        select: { id: true },
      });
      for (const address of addresses) {
        await tx.address.update({ where: { id: address.id }, data: anonymisedAddress() });
      }
      counts['Address'] = addresses.length;

      counts['Order'] = (
        await tx.order.updateMany({
          where: { customerId },
          // The address each order froze at placement is personal data too:
          // replaced exactly as the saved addresses above are.
          data: { instructions: null, deliveryAddressSnapshot: freezeDeliveryAddress(anonymisedAddress()) },
        })
      ).count;

      counts['Review'] = (
        await tx.review.updateMany({
          where: { customerId },
          // The rating stays — a vendor's aggregate must not shift silently.
          data: { comment: null },
        })
      ).count;

      counts['SupportAction'] = (
        await tx.supportAction.updateMany({
          where: { supportCase: { customerId } },
          data: { body: '[deleted]' },
        })
      ).count;

      await tx.customer.update({
        where: { id: customerId },
        data: {
          dietaryPreferences: null,
          referredByCode: null,
          marketingOptIn: false,
        },
      });
    }

    // --- Anonymise: the identity itself -------------------------------
    await tx.identity.update({
      where: { id: identity.id },
      data: {
        ...anonymisedIdentity(identity.id),
        anonymisedAt: now,
        // Kept as the record that a deletion happened and when.
        deletionRequestedAt: request.requestedAt,
      },
    });

    return true;
  });

  if (!didFinalise) {
    // We lost the claim race. The winner writes the audit entry and owns the
    // counts; this call is a no-op.
    return { identityId: input.identityId, alreadyDone: true, counts: {} };
  }

  if (fromStatus === 'held') {
    // It had been parked on a legal hold that has since cleared.
    await writeAudit(prisma, {
      identityId: null,
      action: 'account.deletion.resumed',
      resourceType: 'identity',
      resourceId: input.identityId,
      requestId: null,
    });
  }

  await writeAudit(prisma, {
    identityId: null,
    action: 'account.deletion.completed',
    resourceType: 'identity',
    resourceId: input.identityId,
    // Counts only. Never an email, a phone number, or a row id beyond the
    // account's own internal id, which is now non-personal.
    after: { counts },
    requestId: null,
  });

  return { identityId: input.identityId, alreadyDone: false, counts };
}

/** Identities whose cooling-off window has passed and still need action. */
export async function findDueDeletions(
  prisma: PrismaClient,
  now: Date = new Date(),
  limit = 500,
): Promise<string[]> {
  const rows = await prisma.accountDeletionRequest.findMany({
    where: { status: { in: [...DELETION_PENDING_STATUSES] }, scheduledPurgeAt: { lte: now } },
    select: { identityId: true },
    take: limit,
  });
  return rows.map((row) => row.identityId);
}
