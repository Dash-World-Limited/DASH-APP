/**
 * Data retention policy.
 *
 * Pure: what may be deleted, what must be anonymised instead, what must be kept
 * whatever happens, and how long each is held. No database access — the job in
 * `apps/api/src/jobs/retention.ts` does the work, this decides what the work is.
 *
 * The split matters more than the durations. Getting a duration wrong is a
 * policy adjustment; deleting a ledger entry is unrecoverable and, in Nigeria,
 * probably unlawful.
 *
 * **None of these periods has been reviewed by qualified counsel.** They are
 * conservative engineering defaults chosen to be defensible, not compliant. See
 * `docs/RETENTION.md` and the NDPA 2023 review that is still outstanding.
 */

/** What happens to a class of data once its retention period passes. */
export type RetentionAction =
  /** The row goes. Only ever for data with no evidential or accounting value. */
  | 'delete'
  /** The row stays; the fields identifying a person are cleared. */
  | 'anonymise'
  /** Never touched by this job, at any age. */
  | 'retain';

export interface RetentionRule {
  readonly name: string;
  readonly action: RetentionAction;
  /** Null for `retain` — nothing expires. */
  readonly afterDays: number | null;
  /** Why this action and this period. Read during a privacy review. */
  readonly reason: string;
}

/**
 * The complete policy. Everything the job may touch is named here; anything not
 * listed is retained by omission, which is the safe default.
 */
export const RETENTION_RULES: readonly RetentionRule[] = [
  // --- Deleted ------------------------------------------------------------
  {
    name: 'expired_sessions',
    action: 'delete',
    afterDays: 60,
    reason:
      'A session past its expiry authenticates nothing. Kept 60 days beyond expiry so a support agent can still answer "was this device signed in last month?" during a dispute.',
  },
  {
    name: 'consumed_otp_challenges',
    action: 'delete',
    afterDays: 7,
    reason:
      'A used or expired one-time code is spent. Holding the hash longer only widens what a database leak yields.',
  },
  {
    name: 'consumed_mfa_challenges',
    action: 'delete',
    afterDays: 7,
    reason: 'Same reasoning as OTP challenges: a spent challenge has no further use.',
  },
  {
    name: 'expired_idempotency_keys',
    action: 'delete',
    afterDays: 30,
    reason:
      'The stored response body can contain order detail. The key only needs to outlive a provider retry window, which is hours, not months.',
  },
  {
    name: 'rejected_rider_locations',
    action: 'delete',
    afterDays: 30,
    reason:
      'Points rejected as implausible are kept briefly as fraud evidence, then dropped. They were never trusted enough to act on.',
  },

  {
    name: 'published_outbox_events',
    action: 'delete',
    afterDays: 14,
    reason:
      'A published outbox event has done its job — the queue has the work and the state change it accompanied is in the audit log. Kept a fortnight so a delivery question can be answered after a weekend, then dropped, because an append-only table of every domain event that ever fired grows without bound and holds nothing the audit trail does not. Failed and pending events are never deleted: those are outstanding work.',
  },

  // --- Anonymised ---------------------------------------------------------
  {
    name: 'rider_location_history',
    action: 'anonymise',
    afterDays: 90,
    reason:
      'A rider\'s movement history is the most sensitive routine data the platform holds. Coarsened rather than deleted so aggregate ETA and coverage analysis survives, while the trail stops being a record of where one person was on a given afternoon.',
  },

  // --- Retained -----------------------------------------------------------
  {
    name: 'ledger_transactions',
    action: 'retain',
    afterDays: null,
    reason: 'Append-only by design (ADR-0006). Deleting one would break reconciliation forever.',
  },
  {
    name: 'ledger_entries',
    action: 'retain',
    afterDays: null,
    reason: 'As above. Balances are derived by summing these; a gap is silent corruption.',
  },
  {
    name: 'payments_and_refunds',
    action: 'retain',
    afterDays: null,
    reason: 'Accounting records. Nigerian tax and company law require retention; the period is for counsel to set.',
  },
  {
    name: 'orders',
    action: 'retain',
    afterDays: null,
    reason:
      'Evidence in a consumer dispute and the anchor for every financial record. Personal fields are handled by account deletion, not by this job.',
  },
  {
    name: 'settlements_and_payouts',
    action: 'retain',
    afterDays: null,
    reason: 'Accounting records owed to vendors and riders.',
  },
  {
    name: 'audit_log',
    action: 'retain',
    afterDays: null,
    reason:
      'An audit trail that deletes itself is not an audit trail. If it ever needs pruning, that is a separate, separately-authorised job.',
  },
  {
    name: 'payment_webhooks',
    action: 'retain',
    afterDays: null,
    reason:
      'Replay protection depends on remembering event ids. Deleting them reopens the replay window that the unique constraint closes.',
  },
];

export function ruleFor(name: string): RetentionRule {
  const rule = RETENTION_RULES.find((entry) => entry.name === name);
  if (!rule) throw new Error(`No retention rule named "${name}"`);
  return rule;
}

/**
 * The timestamp before which rows of this class are due.
 *
 * Takes `now` rather than reading the clock, so a test can pin it and a job can
 * use one consistent instant across every rule.
 */
export function cutoffFor(rule: RetentionRule, now: Date): Date | null {
  if (rule.action === 'retain' || rule.afterDays === null) return null;
  return new Date(now.getTime() - rule.afterDays * 86_400_000);
}

/**
 * Overrides supplied by configuration, validated against the policy.
 *
 * Operations may shorten a period freely — less data held is never a
 * compliance risk. Lengthening one past the ceiling below is refused, because
 * "keep rider movement for five years" is the kind of change that should
 * require a documented decision rather than an environment variable.
 */
export const MAX_ALLOWED_DAYS: Readonly<Record<string, number>> = {
  expired_sessions: 180,
  consumed_otp_challenges: 30,
  consumed_mfa_challenges: 30,
  expired_idempotency_keys: 90,
  rejected_rider_locations: 90,
  published_outbox_events: 90,
  rider_location_history: 365,
};

export class RetentionPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetentionPolicyError';
  }
}

export function assertRetentionDays(name: string, days: number): void {
  const rule = ruleFor(name);

  if (rule.action === 'retain') {
    throw new RetentionPolicyError(
      `"${name}" is retained indefinitely and has no configurable period`,
    );
  }
  if (!Number.isInteger(days) || days < 1) {
    throw new RetentionPolicyError(`Retention for "${name}" must be a whole number of days above 0`);
  }

  const ceiling = MAX_ALLOWED_DAYS[name];
  if (ceiling !== undefined && days > ceiling) {
    throw new RetentionPolicyError(
      `Retention for "${name}" is capped at ${ceiling} days; ${days} was requested. Raising it needs a documented decision, not a configuration change.`,
    );
  }
}

/**
 * Precision a coarsened coordinate keeps.
 *
 * Two decimal places is roughly a kilometre at this latitude — enough to say
 * "this delivery crossed Yaba", not enough to say which building. The delivery
 * proof at the moment of handover keeps 4dp; this is the long tail of tracking
 * pings, which is where a movement profile would otherwise accumulate.
 */
export const ANONYMISED_LOCATION_DECIMALS = 2;

export function coarsenCoordinate(value: number): number {
  const factor = 10 ** ANONYMISED_LOCATION_DECIMALS;
  return Math.round(value * factor) / factor;
}

/** A single rule's outcome, for the job's report. */
export interface RetentionOutcome {
  readonly rule: string;
  readonly action: RetentionAction;
  readonly cutoff: Date | null;
  readonly affected: number;
  /** True when nothing was written — a dry run, or a rule with nothing due. */
  readonly dryRun: boolean;
  readonly error?: string;
}

export interface RetentionReport {
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly dryRun: boolean;
  readonly outcomes: readonly RetentionOutcome[];
  readonly totalAffected: number;
  readonly failed: number;
}

export function summariseRetention(
  startedAt: Date,
  finishedAt: Date,
  dryRun: boolean,
  outcomes: readonly RetentionOutcome[],
): RetentionReport {
  return {
    startedAt,
    finishedAt,
    dryRun,
    outcomes,
    totalAffected: outcomes.reduce((total, outcome) => total + outcome.affected, 0),
    failed: outcomes.filter((outcome) => outcome.error !== undefined).length,
  };
}
