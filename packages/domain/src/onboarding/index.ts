/**
 * Vendor and rider onboarding: what an application's state means, and who may
 * move it where.
 *
 * During early access the founder approves every vendor and rider personally,
 * because each one is somebody known to DASH. The rules below make that the
 * only way in: an application grants nothing, approval grants the role, and
 * suspension withdraws it without erasing who held what.
 *
 * ## Phone numbers
 *
 * Signup collects a phone number and SMS verification is switched off for V1,
 * so no phone number in the system has been proved. The wording here is the
 * one sentence every surface uses to say so, and there is deliberately no
 * state in which a phone is described as verified — that state becomes
 * reachable only when an SMS code has actually been delivered and redeemed,
 * which nothing does yet.
 */

/** Persisted on `Vendor.status` and `Rider.status`. */
export const PARTNER_STATUSES = ['pending', 'approved', 'rejected', 'suspended'] as const;
export type PartnerStatus = (typeof PARTNER_STATUSES)[number];

export const PARTNER_DECISIONS = ['approve', 'reject', 'suspend', 'reinstate'] as const;
export type PartnerDecision = (typeof PARTNER_DECISIONS)[number];

export class PartnerTransitionError extends Error {
  constructor(
    readonly from: PartnerStatus,
    readonly decision: PartnerDecision,
  ) {
    super(`A ${from} application cannot be given the decision "${decision}".`);
    this.name = 'PartnerTransitionError';
  }
}

const TRANSITIONS: Record<PartnerDecision, { from: readonly PartnerStatus[]; to: PartnerStatus }> = {
  approve: { from: ['pending'], to: 'approved' },
  reject: { from: ['pending'], to: 'rejected' },
  suspend: { from: ['approved'], to: 'suspended' },
  reinstate: { from: ['suspended'], to: 'approved' },
};

/**
 * Where a decision takes an application, or throws.
 *
 * A rejected application is final: the person applies again, which creates a
 * fresh record with its own history, rather than a rejection being quietly
 * turned into an approval.
 */
export function applyPartnerDecision(from: PartnerStatus, decision: PartnerDecision): PartnerStatus {
  const rule = TRANSITIONS[decision];
  if (!rule.from.includes(from)) throw new PartnerTransitionError(from, decision);
  return rule.to;
}

/** Rejection and suspension are told to the person, so they need a reason. */
export function partnerDecisionNeedsReason(decision: PartnerDecision): boolean {
  return decision === 'reject' || decision === 'suspend';
}

/** What the applicant is shown. Plain words, never the stored enum. */
export function describePartnerStatus(status: PartnerStatus): { code: string; label: string } {
  switch (status) {
    case 'pending':
      return { code: 'pending_admin_approval', label: 'Pending admin approval' };
    case 'approved':
      return { code: 'approved', label: 'Approved' };
    case 'rejected':
      return { code: 'rejected', label: 'Not approved' };
    case 'suspended':
      return { code: 'suspended', label: 'Suspended' };
  }
}

export function isPartnerStatus(value: unknown): value is PartnerStatus {
  return typeof value === 'string' && (PARTNER_STATUSES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Phone numbers
// ---------------------------------------------------------------------------

/** The exact sentence shown wherever an unproved phone number is displayed. */
export const PHONE_UNVERIFIED_NOTICE = 'Phone added · Verification not currently required during early access.';

/**
 * The feature flag that will one day require SMS verification.
 *
 * Off (or absent) means phone numbers are collected and never demanded proof
 * of. When SMS verification exists and this is switched on, existing accounts
 * are prompted at their next sign-in — which is why `required` is reported on
 * every account rather than decided once at signup.
 */
export const PHONE_VERIFICATION_FLAG = 'phone_verification_required';

export interface PhoneStatus {
  readonly number: string | null;
  /** Always `unverified` in V1. There is no code path that proves a phone. */
  readonly verification: 'unverified';
  readonly required: boolean;
  readonly notice: string | null;
}

export function describePhone(number: string | null, verificationRequired: boolean): PhoneStatus {
  return {
    number,
    verification: 'unverified',
    required: verificationRequired,
    notice: number ? PHONE_UNVERIFIED_NOTICE : null,
  };
}

// ---------------------------------------------------------------------------
// Vocabulary accepted on an application
// ---------------------------------------------------------------------------

/**
 * Merchant categories a vendor may apply under. `declutter` is excluded: the
 * Declutters marketplace has its own seller journey and is not a storefront.
 */
export const VENDOR_APPLICATION_CATEGORIES = ['restaurant', 'grocery', 'pharmacy', 'retail', 'market'] as const;
export type VendorApplicationCategory = (typeof VENDOR_APPLICATION_CATEGORIES)[number];

export const RIDER_VEHICLE_TYPES = ['motorcycle', 'bicycle', 'car', 'van', 'on_foot'] as const;
export type RiderVehicleType = (typeof RIDER_VEHICLE_TYPES)[number];

/** A URL-safe store slug from a business name. The caller adds uniqueness. */
export function slugForBusinessName(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return slug.length >= 2 ? slug : 'store';
}
