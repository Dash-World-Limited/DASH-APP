/**
 * Multi-factor authentication policy.
 *
 * Pure: which roles must carry a second factor, and the rules governing
 * recovery codes. No secrets, no I/O, no clock beyond what is passed in.
 *
 * The TOTP algorithm itself is not implemented here — it comes from `otplib`
 * (RFC 6238) in the API layer. This module owns the *policy*, which is the part
 * that is specific to DASH APP and therefore the part worth testing directly.
 */

import { ROLES, STEP_UP_PERMISSIONS, buildActor, type Role } from '../permissions/index.js';

/**
 * Roles that must complete TOTP before receiving a privileged session.
 *
 * This is every **staff** role. The reasoning, role by role:
 *
 *   super_admin, platform_admin — everything, including permission changes
 *   finance_analyst             — approves refunds, settlements, payouts
 *   support_agent               — issues wallet credit
 *   city_manager                — city configuration, surge, zone pauses
 *   dispatcher                  — intervenes in live orders, reassigns riders
 *   marketing_manager           — messages the entire customer base
 *
 * The last three hold no step-up permission today, so a purely derived list
 * would omit them. They are included anyway: order intervention and mass
 * messaging are real blast radius, and `city_manager` was named explicitly as a
 * requirement. `assertMfaPolicyCoversStepUp()` below guards the other
 * direction — no role may hold a step-up permission without also requiring MFA.
 *
 * Customers, riders, and vendor users are deliberately excluded. Forcing an
 * authenticator app on a rider who signs in on a shared phone would push them
 * off the platform, and their blast radius is their own account. Changing that
 * is a product decision, not a security default.
 */
export const MFA_REQUIRED_ROLES: ReadonlySet<Role> = new Set<Role>([
  'super_admin',
  'platform_admin',
  'finance_analyst',
  'support_agent',
  'city_manager',
  'dispatcher',
  'marketing_manager',
]);

/** True when any of the identity's roles demands a second factor. */
export function requiresMfa(roles: readonly Role[]): boolean {
  return roles.some((role) => MFA_REQUIRED_ROLES.has(role));
}

/**
 * Roles allowed to hold a step-up permission without requiring TOTP.
 *
 * Step-up and MFA are not the same thing. Step-up means "prove who you are
 * again, recently"; *how* depends on what the account has. Staff have an
 * authenticator, so their step-up is TOTP. A vendor owner does not, so theirs
 * is the one-time code sent to their registered phone — still a second factor
 * for that action, still bound to something they hold.
 *
 * Each exemption needs a reason recorded here, and each is a product decision
 * rather than a security default:
 *
 *   vendor_owner — holds `vendor:payout:write`, which changes where their own
 *     settlements land. Gated behind phone-OTP step-up. Forcing an
 *     authenticator app on every small vendor to change a bank account would
 *     push them off the platform, and the blast radius is their own money, not
 *     the platform's or another party's. Revisit if vendors ever gain a
 *     permission that reaches somebody else's funds.
 *
 *   customer — holds `account:delete:own` and `account:export:own`, which act
 *     only on the customer's own account. Both are gated behind phone-OTP
 *     step-up. Requiring every customer to set up an authenticator app before
 *     they can leave the platform or take a copy of their data is neither
 *     proportionate nor something a person mid-departure will do; the blast
 *     radius is their own account and nobody else's.
 */
export const STEP_UP_WITHOUT_MFA: ReadonlyMap<Role, string> = new Map<Role, string>([
  [
    'vendor_owner',
    'vendor:payout:write is gated behind phone-OTP step-up; the blast radius is only their own settlements',
  ],
  [
    'customer',
    'account:delete:own and account:export:own are gated behind phone-OTP step-up; each acts only on the requesting account and no other',
  ],
]);

/**
 * Guard against policy drift.
 *
 * If someone grants a step-up permission to a role that neither requires MFA
 * nor appears in the exemption list above, that role can reach a money-moving
 * action behind a single password. This throws instead, and a test calls it —
 * so the failure surfaces at review time rather than in an incident.
 *
 * The exemption list is deliberately a map rather than a set: adding a role
 * means writing down why, in the same commit that grants the permission.
 */
export function assertMfaPolicyCoversStepUp(): void {
  const offenders: string[] = [];

  for (const role of ROLES) {
    if (MFA_REQUIRED_ROLES.has(role)) continue;

    const actor = buildActor({ identityId: 'policy-check', sessionId: 'policy-check', roles: [role] });
    const stepUp = [...actor.permissions].filter((permission) =>
      STEP_UP_PERMISSIONS.has(permission),
    );

    if (stepUp.length === 0) continue;
    if (STEP_UP_WITHOUT_MFA.has(role)) continue;

    offenders.push(
      `${role} holds ${stepUp.join(', ')} but neither requires MFA nor is listed in STEP_UP_WITHOUT_MFA`,
    );
  }

  if (offenders.length > 0) {
    throw new Error(
      ['MFA policy does not cover every step-up role:', ...offenders].join('\n  '),
    );
  }
}

// ---------------------------------------------------------------------------
// Recovery codes
// ---------------------------------------------------------------------------

/**
 * How many codes are issued at once.
 *
 * Ten is enough that losing a phone is survivable without the set becoming a
 * long-lived list of passwords someone screenshots and forgets.
 */
export const RECOVERY_CODE_COUNT = 10;

/**
 * Bytes of entropy per code. 10 bytes is 80 bits, which is not guessable, and
 * encodes to 16 readable characters.
 */
export const RECOVERY_CODE_BYTES = 10;

/**
 * Alphabet for recovery codes.
 *
 * Crockford-style: no I, L, O, U, and no digits 0 or 1. These are written down,
 * read off paper under stress, and typed on a phone keyboard — the characters
 * people confuse are removed rather than relying on the user being careful.
 */
export const RECOVERY_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Normalise a code as typed by a human: uppercase, and drop the grouping
 * dashes and any stray whitespace.
 *
 * Deliberately no character substitution. The alphabet above already excludes
 * every confusable glyph — there is no `O` to mistake for `0`, and no `I` to
 * mistake for `1`, because none of those four characters can appear in a code.
 * A substitution table here would have nothing valid to map onto, so it would
 * be dead code at best and a way to make two different codes collide at worst.
 */
export function normaliseRecoveryCode(input: string): string {
  return input.trim().toUpperCase().replace(/[\s-]/g, '');
}

/**
 * Format a raw code for display: `XXXX-XXXX-XXXX-XXXX`.
 *
 * Grouped because a 16-character unbroken string is transcribed wrongly far
 * more often than four groups of four.
 */
export function formatRecoveryCode(raw: string): string {
  return (raw.match(/.{1,4}/g) ?? [raw]).join('-');
}

export interface RecoveryCodeStatus {
  readonly total: number;
  readonly remaining: number;
  readonly exhausted: boolean;
  /** True once few enough remain that the user should regenerate. */
  readonly lowWarning: boolean;
}

export function summariseRecoveryCodes(
  codes: readonly { usedAt: Date | null }[],
): RecoveryCodeStatus {
  const total = codes.length;
  const remaining = codes.filter((code) => code.usedAt === null).length;
  return {
    total,
    remaining,
    exhausted: remaining === 0,
    lowWarning: remaining > 0 && remaining <= 3,
  };
}

// ---------------------------------------------------------------------------
// Challenge policy
// ---------------------------------------------------------------------------

/**
 * How long a half-finished login stays valid.
 *
 * Five minutes: long enough to open an authenticator app and type six digits,
 * short enough that a stolen intermediate token is rarely still usable.
 */
export const MFA_CHALLENGE_TTL_SECONDS = 300;

/**
 * Attempts allowed against one challenge.
 *
 * Five, against a six-digit code, leaves a 1-in-200,000 chance of a lucky
 * guess per challenge. The rate limiter bounds how many challenges an attacker
 * can start, so the two together are what make the number meaningful.
 */
export const MFA_MAX_ATTEMPTS = 5;

/**
 * Accepted clock skew, in seconds, either side of the current step.
 *
 * 30 seconds — one period. Phone clocks drift, and rejecting a code that the
 * user is looking at right now generates support tickets and teaches people to
 * distrust the system. Wider than this starts to matter: every extra period
 * doubles the window in which a shoulder-surfed code still works.
 */
export const MFA_EPOCH_TOLERANCE_SECONDS = 30;

/** How long an enrolment may sit unconfirmed before it is discarded. */
export const MFA_ENROLMENT_TTL_SECONDS = 900;
