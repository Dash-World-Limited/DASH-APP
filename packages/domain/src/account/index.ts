/**
 * Account deletion and personal-data export — policy.
 *
 * Pure. No database, no clock beyond what is passed in, no I/O. This module
 * decides *what* deletion and export mean; the API routes and the jobs in
 * `apps/api` do the work.
 *
 * The governing rule, and the reason this is not a `DELETE FROM`:
 *
 *   **Anything the ledger references is anonymised, never deleted.** An order,
 *   a payment, a settlement, and every ledger entry survive a deletion with
 *   their ids intact — only the fields that identify a person are cleared. A
 *   deletion flow that removed a row the ledger sums over would silently
 *   corrupt every balance derived from it, which is worse than not offering
 *   deletion at all.
 *
 * **None of the periods here has been reviewed by qualified Nigerian counsel
 * (NDPA 2023).** They are conservative engineering defaults. See
 * `docs/RETENTION.md`.
 */

// ---------------------------------------------------------------------------
// Timings
// ---------------------------------------------------------------------------

/**
 * How long a scheduled deletion waits before it is finalised.
 *
 * The window exists so a request made under duress, by mistake, or by someone
 * who has briefly borrowed a session can be undone. Fourteen days is long
 * enough that a person on holiday can still catch it, short enough that it is
 * not an indefinite limbo.
 */
export const DELETION_COOLING_OFF_DAYS = 14;

/** Configuration may shorten the window but not stretch it past this. */
export const DELETION_COOLING_OFF_MAX_DAYS = 90;
export const DELETION_COOLING_OFF_MIN_DAYS = 1;

/**
 * How long a built export archive remains downloadable.
 *
 * The archive is the person's entire history in one file — the worst possible
 * thing to leave lying in object storage. Twenty-four hours is enough for
 * someone to notice the notification and act on it.
 */
export const EXPORT_DOWNLOAD_TTL_HOURS = 24;
export const EXPORT_DOWNLOAD_TTL_MAX_HOURS = 168;
export const EXPORT_DOWNLOAD_TTL_MIN_HOURS = 1;

/** Bytes of entropy in a download authorisation token. 256 bits. */
export const EXPORT_TOKEN_BYTES = 32;

export class AccountPolicyError extends Error {
  constructor(
    readonly reason:
      | 'invalid_transition'
      | 'window_out_of_range'
      | 'ttl_out_of_range'
      | 'legal_hold'
      | 'not_a_customer',
    message: string,
  ) {
    super(message);
    this.name = 'AccountPolicyError';
  }
}

export function assertCoolingOffDays(days: number): void {
  if (
    !Number.isInteger(days) ||
    days < DELETION_COOLING_OFF_MIN_DAYS ||
    days > DELETION_COOLING_OFF_MAX_DAYS
  ) {
    throw new AccountPolicyError(
      'window_out_of_range',
      `The deletion cooling-off window must be a whole number of days between ${DELETION_COOLING_OFF_MIN_DAYS} and ${DELETION_COOLING_OFF_MAX_DAYS}; ${days} was given.`,
    );
  }
}

export function assertExportTtlHours(hours: number): void {
  if (
    !Number.isInteger(hours) ||
    hours < EXPORT_DOWNLOAD_TTL_MIN_HOURS ||
    hours > EXPORT_DOWNLOAD_TTL_MAX_HOURS
  ) {
    throw new AccountPolicyError(
      'ttl_out_of_range',
      `The export download TTL must be a whole number of hours between ${EXPORT_DOWNLOAD_TTL_MIN_HOURS} and ${EXPORT_DOWNLOAD_TTL_MAX_HOURS}; ${hours} was given.`,
    );
  }
}

/** The instant a request made now becomes eligible for finalisation. */
export function purgeAfter(requestedAt: Date, coolingOffDays = DELETION_COOLING_OFF_DAYS): Date {
  assertCoolingOffDays(coolingOffDays);
  return new Date(requestedAt.getTime() + coolingOffDays * 86_400_000);
}

/** The instant a built archive stops being downloadable. */
export function exportExpiresAt(readyAt: Date, ttlHours = EXPORT_DOWNLOAD_TTL_HOURS): Date {
  assertExportTtlHours(ttlHours);
  return new Date(readyAt.getTime() + ttlHours * 3_600_000);
}

// ---------------------------------------------------------------------------
// Deletion state machine
// ---------------------------------------------------------------------------

export type DeletionStatus = 'scheduled' | 'cancelled' | 'completed';

/**
 * The only legal moves. A request is created `scheduled`; from there it either
 * gets cancelled inside the window or completed after it. `completed` and
 * `cancelled` are terminal — nothing reopens a deletion.
 */
const DELETION_TRANSITIONS: Readonly<Record<DeletionStatus, readonly DeletionStatus[]>> = {
  scheduled: ['cancelled', 'completed'],
  cancelled: [],
  completed: [],
};

export function canTransitionDeletion(from: DeletionStatus, to: DeletionStatus): boolean {
  return DELETION_TRANSITIONS[from].includes(to);
}

export function assertDeletionTransition(from: DeletionStatus, to: DeletionStatus): void {
  if (!canTransitionDeletion(from, to)) {
    throw new AccountPolicyError(
      'invalid_transition',
      `A deletion request cannot move from "${from}" to "${to}".`,
    );
  }
}

/** True once a scheduled request has passed its window and may be finalised. */
export function isDueForFinalisation(
  request: { status: DeletionStatus; scheduledPurgeAt: Date },
  now: Date,
): boolean {
  return request.status === 'scheduled' && request.scheduledPurgeAt.getTime() <= now.getTime();
}

/** True while a scheduled request can still be cancelled by its owner. */
export function isCancellable(
  request: { status: DeletionStatus; scheduledPurgeAt: Date },
  now: Date,
): boolean {
  return request.status === 'scheduled' && request.scheduledPurgeAt.getTime() > now.getTime();
}

// ---------------------------------------------------------------------------
// Legal holds
// ---------------------------------------------------------------------------

/**
 * Signals the API gathers about an account before accepting a deletion.
 *
 * A hold does not deny the *request* forever — it blocks acceptance until the
 * underlying matter resolves. The person is told which one, so they know what
 * to chase.
 */
export interface LegalHoldSignals {
  /** An order that has not reached a terminal state. */
  readonly hasOpenOrder: boolean;
  /** A refund, chargeback, or payment dispute still being worked. */
  readonly hasUnresolvedPaymentDispute: boolean;
  /** A support case flagged as a dispute, fraud, or safety matter, still open. */
  readonly hasOpenDisputeOrSafetyCase: boolean;
  /** A negative wallet or ledger balance the person owes the platform. */
  readonly owesMoney: boolean;
}

export interface LegalHold {
  readonly code:
    | 'open_order'
    | 'payment_dispute'
    | 'dispute_or_safety_case'
    | 'outstanding_balance';
  readonly message: string;
}

/**
 * The first hold that applies, or null. Order is deliberate: an open order is
 * the most common and the easiest for the person to clear.
 */
export function evaluateLegalHold(signals: LegalHoldSignals): LegalHold | null {
  if (signals.hasOpenOrder) {
    return {
      code: 'open_order',
      message:
        'You have an order that is still in progress. Deletion can proceed once it is delivered or cancelled.',
    };
  }
  if (signals.hasUnresolvedPaymentDispute) {
    return {
      code: 'payment_dispute',
      message:
        'A refund or payment dispute on your account is still being resolved. Deletion can proceed once it is closed.',
    };
  }
  if (signals.hasOpenDisputeOrSafetyCase) {
    return {
      code: 'dispute_or_safety_case',
      message:
        'A support case that must be kept on record is still open. Deletion can proceed once it is resolved.',
    };
  }
  if (signals.owesMoney) {
    return {
      code: 'outstanding_balance',
      message:
        'There is an outstanding balance on your account. Deletion can proceed once it is settled.',
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Anonymisation
// ---------------------------------------------------------------------------

/**
 * The non-personal values a person's fields become on finalisation.
 *
 * Every value is derived deterministically from the account's own internal id,
 * so a re-run produces the same result (idempotent) and two deleted accounts
 * never collide on a shared placeholder. The email lands in the reserved
 * `.invalid` TLD (RFC 2606) so it can never route anywhere.
 */
export interface AnonymisedIdentity {
  readonly email: string;
  readonly phone: null;
  readonly passwordHash: null;
  readonly displayName: string;
  readonly mfaSecretCipher: null;
  readonly mfaPendingCipher: null;
  readonly mfaEnrolledAt: null;
  readonly mfaLastTimeStep: null;
  readonly status: 'deleted';
}

export function anonymisedIdentity(internalId: string): AnonymisedIdentity {
  return {
    email: `deleted+${internalId}@deleted.dashapp.invalid`,
    phone: null,
    passwordHash: null,
    displayName: 'Deleted account',
    mfaSecretCipher: null,
    mfaPendingCipher: null,
    mfaEnrolledAt: null,
    mfaLastTimeStep: null,
    status: 'deleted',
  };
}

/** What a saved address becomes. The row itself survives so `Order.addressId` holds. */
export interface AnonymisedAddress {
  readonly label: null;
  readonly line1: string;
  readonly landmark: null;
  readonly instructions: null;
  readonly contactPhone: string;
  readonly latitude: 0;
  readonly longitude: 0;
}

export function anonymisedAddress(): AnonymisedAddress {
  return {
    label: null,
    line1: '[deleted]',
    landmark: null,
    instructions: null,
    contactPhone: '[deleted]',
    latitude: 0,
    longitude: 0,
  };
}

/**
 * The classes of a customer's data, and what finalisation does to each.
 *
 * `delete` — no evidential or accounting value; the rows go.
 * `anonymise` — the row is referenced by something that must survive (usually
 *   the ledger, via an order), so only the personal fields clear.
 * `retain` — kept whole, because it is itself the record of a transaction, a
 *   consent, or a dispute.
 *
 * This list is asserted complete by a test: a model that holds customer
 * personal data and is missing here is a leak.
 */
export type AnonymisationAction = 'delete' | 'anonymise' | 'retain';

export interface DataClassRule {
  readonly model: string;
  readonly action: AnonymisationAction;
  readonly reason: string;
}

export const DATA_CLASS_RULES: readonly DataClassRule[] = [
  // --- Deleted ----------------------------------------------------------
  {
    model: 'Session',
    action: 'delete',
    reason: 'A credential. Every session is revoked and removed at finalisation.',
  },
  {
    model: 'Device',
    action: 'delete',
    reason: 'Push tokens and device fingerprints. Nothing references them once sessions are gone.',
  },
  {
    model: 'Cart',
    action: 'delete',
    reason: 'A draft basket. No evidential value; cascades to CartItem.',
  },
  {
    model: 'OtpChallenge',
    action: 'delete',
    reason: 'Spent or unspent one-time codes tied to a phone number that is being cleared.',
  },
  {
    model: 'MfaChallenge',
    action: 'delete',
    reason:
      'Half-finished second-factor attempts tied to an authenticator that is being torn down. No evidential value once the account is gone.',
  },
  {
    model: 'MfaRecoveryCode',
    action: 'delete',
    reason: 'Backup credentials. Removed with the rest of the authentication material.',
  },

  // --- Anonymised -----------------------------------------------------
  {
    model: 'Identity',
    action: 'anonymise',
    reason:
      'Referenced by AuditLog and by the Customer row that anchors every order. Email, phone, password hash, MFA material, and display name are cleared; the row and its id remain.',
  },
  {
    model: 'Customer',
    action: 'anonymise',
    reason:
      'Anchors Order, Payment, Subscription, and ledger ownership. Dietary preferences and the referrer code clear; the referral code stays because other accounts may reference it; marketing opt-in is forced off.',
  },
  {
    model: 'Address',
    action: 'anonymise',
    reason:
      'Referenced by Order.addressId. Street, landmark, instructions, contact phone, and coordinates are cleared; the row stays so the order still resolves an address.',
  },
  {
    model: 'Order',
    action: 'anonymise',
    reason:
      'A financial record and dispute evidence — never deleted. The free-text delivery instructions are cleared; every id, amount, and timestamp is kept.',
  },
  {
    model: 'Review',
    action: 'anonymise',
    reason:
      'The written comment is cleared because it is the person speaking; the rating is kept because a vendor\'s aggregate score must not silently move when someone leaves.',
  },
  {
    model: 'SupportAction',
    action: 'anonymise',
    reason:
      'The free-text body a customer typed is cleared. The case, its status, and its outcome are kept as a dispute and safety record.',
  },

  // --- Retained -----------------------------------------------------
  {
    model: 'Payment',
    action: 'retain',
    reason: 'An accounting record. Holds no name or address; the amount and provider reference stay.',
  },
  {
    model: 'Refund',
    action: 'retain',
    reason:
      'An accounting record of money returned. Carries no personal data; the amount, reason code, and approving actor stay.',
  },
  {
    model: 'LedgerTransaction',
    action: 'retain',
    reason: 'Append-only by design (ADR-0006). Deleting one breaks reconciliation forever.',
  },
  {
    model: 'LedgerEntry',
    action: 'retain',
    reason: 'Balances are derived by summing these. A gap is silent corruption.',
  },
  {
    model: 'Subscription',
    action: 'retain',
    reason: 'Billing history. Tied to the Customer row, which is kept.',
  },
  {
    model: 'PromotionRedemption',
    action: 'retain',
    reason: 'Fraud and abuse control — how many times a code was used, and by which account id.',
  },
  {
    model: 'LegalAcceptance',
    action: 'retain',
    reason:
      'Proof that this person agreed to the terms in force at a given time. Deleting it destroys the evidence that consent was given.',
  },
  {
    model: 'AuditLog',
    action: 'retain',
    reason:
      'An audit trail that erases its own subjects is not an audit trail. The deletion itself is audited here.',
  },
  {
    model: 'OrderItem',
    action: 'retain',
    reason: 'Line items of a retained order. No personal data; part of the financial record.',
  },
  {
    model: 'DeliveryProof',
    action: 'retain',
    reason:
      'Proof a delivery happened, at a coordinate already coarsened at capture. Dispute evidence.',
  },
];

export function dataClassRule(model: string): DataClassRule {
  const rule = DATA_CLASS_RULES.find((entry) => entry.model === model);
  if (!rule) throw new Error(`No data-class rule for model "${model}"`);
  return rule;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/**
 * The sections a personal-data export contains.
 *
 * Everything here is data the requesting person supplied or generated. What is
 * deliberately absent: other people's data, internal fraud-rule scores,
 * platform operational notes, staff identities, and anything secret.
 */
export const EXPORT_SECTIONS = [
  'profile',
  'addresses',
  'orders',
  'reviews',
  'subscriptions',
  'legal_acceptances',
  'support_cases',
] as const;

export type ExportSection = (typeof EXPORT_SECTIONS)[number];

export interface ExportManifest {
  readonly format: 'json';
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly subjectId: string;
  readonly sections: readonly ExportSection[];
  /**
   * Stated in the archive so the reader knows the boundary: this is the
   * person's own data, not a copy of the platform's file on them.
   */
  readonly notice: string;
}

export function exportManifest(subjectId: string, generatedAt: Date): ExportManifest {
  return {
    format: 'json',
    schemaVersion: 1,
    generatedAt: generatedAt.toISOString(),
    subjectId,
    sections: EXPORT_SECTIONS,
    notice:
      'This archive contains the personal data you provided to or generated on DASH APP. It does not include other users\' data, internal risk scoring, or staff records.',
  };
}

export type ExportStatus = 'pending' | 'ready' | 'delivered' | 'expired' | 'failed';

const EXPORT_TRANSITIONS: Readonly<Record<ExportStatus, readonly ExportStatus[]>> = {
  pending: ['ready', 'failed'],
  ready: ['delivered', 'expired'],
  delivered: [],
  expired: [],
  failed: [],
};

export function canTransitionExport(from: ExportStatus, to: ExportStatus): boolean {
  return EXPORT_TRANSITIONS[from].includes(to);
}

export function assertExportTransition(from: ExportStatus, to: ExportStatus): void {
  if (!canTransitionExport(from, to)) {
    throw new AccountPolicyError(
      'invalid_transition',
      `A data export cannot move from "${from}" to "${to}".`,
    );
  }
}

/** True when a ready export may still be downloaded. */
export function isDownloadable(
  request: { status: ExportStatus; expiresAt: Date | null; downloadCount: number },
  now: Date,
): boolean {
  return (
    request.status === 'ready' &&
    request.downloadCount === 0 &&
    request.expiresAt !== null &&
    request.expiresAt.getTime() > now.getTime()
  );
}
