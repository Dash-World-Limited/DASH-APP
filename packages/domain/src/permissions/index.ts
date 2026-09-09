/**
 * Permissions.
 *
 * Authorization is expressed as explicit permission strings, never as scattered
 * `if (user.role === 'admin')` checks. Roles are bundles of permissions; code
 * always asks "may this actor do this thing?", never "what is this actor?".
 *
 * Three rules this module exists to enforce:
 *   1. Deny by default. An unlisted permission is denied.
 *   2. Holding a permission is necessary but never sufficient — object-level
 *      ownership/scope is checked separately by `assertScope`.
 *   3. High-risk permissions require a recent step-up authentication.
 */

export const PERMISSIONS = [
  // --- Customer ------------------------------------------------------------
  'order:create',
  'order:read:own',
  'order:cancel:own',
  'order:rate',
  'address:manage:own',
  'payment:method:manage:own',
  'wallet:read:own',
  'subscription:manage:own',
  // Acting on one's own account: destroying its personal data, or taking a
  // copy of it. Both are step-up-gated (below) because both are irreversible
  // or high-egress, and both belong to the customer alone.
  'account:delete:own',
  'account:export:own',

  // --- Rider ---------------------------------------------------------------
  'rider:availability:set',
  'rider:offer:respond',
  'rider:delivery:progress',
  'rider:location:report',
  'rider:earnings:read:own',
  'rider:incident:report',

  // --- Vendor --------------------------------------------------------------
  'vendor:order:read',
  'vendor:order:accept',
  'vendor:order:reject',
  'vendor:order:progress',
  'vendor:catalog:read',
  'vendor:catalog:write',
  'vendor:inventory:write',
  'vendor:hours:write',
  'vendor:promotion:write',
  'vendor:report:read',
  'vendor:settlement:read',
  // Write-only by design. There is no permission to *read* payout details in
  // clear, because no route needs to: settlement will hand the ciphertext
  // straight to the payment provider. Masked reads need no permission beyond
  // the vendor scope.
  'vendor:payout:write',
  'vendor:staff:manage',
  'vendor:settings:write',
  'vendor:review:respond',

  // --- Operations / dispatch ----------------------------------------------
  'ops:order:read:all',
  'ops:order:intervene',
  'ops:dispatch:assign',
  'ops:dispatch:reassign',
  'ops:zone:pause',
  'ops:vendor:pause',
  'ops:rider:read:all',
  'ops:livemap:read',
  'ops:surge:write',

  // --- Support -------------------------------------------------------------
  'support:case:read',
  'support:case:write',
  'support:case:assign',
  'support:customer:read',
  'support:compensation:issue',
  'support:refund:request',

  // --- Finance -------------------------------------------------------------
  'finance:ledger:read',
  'finance:payment:read',
  'finance:refund:approve',
  'finance:settlement:read',
  'finance:settlement:approve',
  'finance:payout:approve',
  'finance:adjustment:create',
  'finance:report:read',

  // --- Marketing / growth --------------------------------------------------
  'marketing:promotion:write',
  'marketing:campaign:write',
  'marketing:campaign:send',
  'marketing:content:write',
  'marketing:segment:read',

  // --- Vendor / rider lifecycle -------------------------------------------
  'admin:vendor:approve',
  'admin:rider:approve',
  'admin:kyc:review',

  // --- Governance ----------------------------------------------------------
  'admin:user:read',
  'admin:user:write',
  'admin:role:write',
  'admin:featureflag:write',
  'admin:config:write',
  'admin:audit:read',
  'admin:data:export',
  'admin:impersonate',
  // A staff path to schedule deletion of a user's account. Separate from
  // `account:delete:own` so it can never be exercised silently: it demands
  // its own permission, a mandatory reason, and an on-behalf-of audit entry.
  'admin:account:delete',

  // --- DASH World Declutters ----------------------------------------------
  // A curated marketplace where nothing reaches the public without a named
  // human deciding it should. The split between moderator and admin below is
  // the whole point: preparing a submission and setting the price a stranger
  // will pay are different jobs with different consequences.
  'declutter:seller:read',
  'declutter:seller:write',
  // Reading a seller's NIN, bank details and identity documents. Step-up
  // gated: this is the most personal data in the marketplace.
  'declutter:kyc:review',
  'declutter:submission:read',
  'declutter:submission:write',
  // Running a ValueCheck. Deliberately separate from deciding a price —
  // the model advises, a person decides.
  'declutter:valuation:run',
  // Setting the final fixed price a buyer will pay. Admin only.
  'declutter:price:decide',
  'declutter:listing:read',
  'declutter:listing:write',
  // Making a listing public, and taking it down again.
  'declutter:listing:publish',
  'declutter:listing:suspend',
  // Approving a buyer's request to be introduced to a seller.
  'declutter:contact:review',
  // Releasing a seller's real phone or WhatsApp number to a buyer. Step-up
  // gated because it is the one action in this product that cannot be undone:
  // once a number has been seen, no revocation reaches the buyer's phone.
  'declutter:contact:disclose:direct',
  'declutter:fraud:read',
  // Overriding a duplicate-image block. Step-up gated, reason mandatory.
  'declutter:fraud:override',
  // Granting or revoking Trusted Partner. Super admin only — it is a
  // commercial relationship, not an operational setting, and it must never be
  // reachable by whoever happens to be working the queue.
  'declutter:partner:write',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const PERMISSION_SET: ReadonlySet<string> = new Set(PERMISSIONS);

export function isPermission(value: string): value is Permission {
  return PERMISSION_SET.has(value);
}

/**
 * Permissions that move money, change who can do what, or expose personal data
 * in bulk. Holding one is not enough — the session must also have completed a
 * step-up authentication recently (see `STEP_UP_MAX_AGE_SECONDS`).
 */
export const STEP_UP_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>([
  'finance:refund:approve',
  'finance:settlement:approve',
  'finance:payout:approve',
  'finance:adjustment:create',
  'admin:role:write',
  'admin:user:write',
  'admin:data:export',
  'admin:impersonate',
  'admin:config:write',
  'support:compensation:issue',
  // Redirecting a vendor's settlements is the highest-value single edit in the
  // system: it changes where money lands without touching any ledger.
  'vendor:payout:write',
  // Deleting an account is irreversible after the cooling-off window; exporting
  // one hands over a person's entire history in a single file. A borrowed
  // session must not be enough for either.
  'account:delete:own',
  'account:export:own',
  'admin:account:delete',
  // Declutter. KYC review exposes a seller's identity documents and bank
  // details; a direct contact disclosure hands a real personal number to a
  // stranger and can never be taken back; a fraud override waves through a
  // block that a rule raised for a reason.
  'declutter:kyc:review',
  'declutter:contact:disclose:direct',
  'declutter:fraud:override',
  'declutter:partner:write',
]);

/** A step-up is valid for 15 minutes. After that, re-authenticate. */
export const STEP_UP_MAX_AGE_SECONDS = 900;

/**
 * Permissions that additionally require a second approver before the action
 * takes effect (four-eyes). The first actor creates a pending request; a
 * different actor holding the same permission approves it.
 */
export const FOUR_EYES_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>([
  'finance:settlement:approve',
  'finance:payout:approve',
  'finance:adjustment:create',
  'admin:role:write',
]);

export const ROLES = [
  'customer',
  'rider',
  'vendor_owner',
  'vendor_manager',
  'vendor_staff',
  'support_agent',
  'dispatcher',
  'finance_analyst',
  'marketing_manager',
  'city_manager',
  // Declutters marketplace. `declutter_moderator` prepares work and cannot
  // publish or price; `declutter_admin` decides. §29's Staff/Admin split,
  // expressed as permissions rather than hidden buttons.
  'declutter_moderator',
  'declutter_admin',
  'platform_admin',
  'super_admin',
] as const;

export type Role = (typeof ROLES)[number];

const CUSTOMER_PERMISSIONS: readonly Permission[] = [
  'order:create',
  'order:read:own',
  'order:cancel:own',
  'order:rate',
  'address:manage:own',
  'payment:method:manage:own',
  'wallet:read:own',
  'subscription:manage:own',
  'account:delete:own',
  'account:export:own',
];

const RIDER_PERMISSIONS: readonly Permission[] = [
  'rider:availability:set',
  'rider:offer:respond',
  'rider:delivery:progress',
  'rider:location:report',
  'rider:earnings:read:own',
  'rider:incident:report',
];

const VENDOR_STAFF_PERMISSIONS: readonly Permission[] = [
  'vendor:order:read',
  'vendor:order:accept',
  'vendor:order:reject',
  'vendor:order:progress',
  'vendor:catalog:read',
  'vendor:inventory:write',
];

const VENDOR_MANAGER_PERMISSIONS: readonly Permission[] = [
  ...VENDOR_STAFF_PERMISSIONS,
  'vendor:catalog:write',
  'vendor:hours:write',
  'vendor:promotion:write',
  'vendor:report:read',
  'vendor:review:respond',
];

const VENDOR_OWNER_PERMISSIONS: readonly Permission[] = [
  ...VENDOR_MANAGER_PERMISSIONS,
  'vendor:settlement:read',
  'vendor:payout:write',
  'vendor:staff:manage',
  'vendor:settings:write',
];

const SUPPORT_PERMISSIONS: readonly Permission[] = [
  'support:case:read',
  'support:case:write',
  'support:case:assign',
  'support:customer:read',
  'support:compensation:issue',
  'support:refund:request',
  'ops:order:read:all',
];

const DISPATCHER_PERMISSIONS: readonly Permission[] = [
  'ops:order:read:all',
  'ops:order:intervene',
  'ops:dispatch:assign',
  'ops:dispatch:reassign',
  'ops:rider:read:all',
  'ops:livemap:read',
  'ops:vendor:pause',
];

const FINANCE_PERMISSIONS: readonly Permission[] = [
  'finance:ledger:read',
  'finance:payment:read',
  'finance:refund:approve',
  'finance:settlement:read',
  'finance:settlement:approve',
  'finance:payout:approve',
  'finance:adjustment:create',
  'finance:report:read',
  'ops:order:read:all',
];

const MARKETING_PERMISSIONS: readonly Permission[] = [
  'marketing:promotion:write',
  'marketing:campaign:write',
  'marketing:campaign:send',
  'marketing:content:write',
  'marketing:segment:read',
];

const CITY_MANAGER_PERMISSIONS: readonly Permission[] = [
  ...DISPATCHER_PERMISSIONS,
  'ops:zone:pause',
  'ops:surge:write',
  'vendor:report:read',
  'finance:report:read',
  'admin:vendor:approve',
  'admin:rider:approve',
];

const PLATFORM_ADMIN_PERMISSIONS: readonly Permission[] = [
  ...CITY_MANAGER_PERMISSIONS,
  ...SUPPORT_PERMISSIONS,
  ...FINANCE_PERMISSIONS,
  ...MARKETING_PERMISSIONS,
  'admin:kyc:review',
  'admin:user:read',
  'admin:featureflag:write',
  'admin:audit:read',
  'admin:account:delete',
];

/**
 * Prepares Declutter work; decides none of it.
 *
 * A moderator can build a submission, upload photos, run a ValueCheck and see
 * a fraud flag. They cannot read a seller's bank details, set a price, publish
 * a listing, or release anybody's phone number. Those four are exactly the
 * actions where a mistake reaches a member of the public.
 */
const DECLUTTER_MODERATOR_PERMISSIONS: readonly Permission[] = [
  'declutter:seller:read',
  'declutter:submission:read',
  'declutter:submission:write',
  'declutter:valuation:run',
  'declutter:listing:read',
  'declutter:listing:write',
  'declutter:contact:review',
  'declutter:fraud:read',
];

/** Decides. Everything a moderator may do, plus the consequential half. */
const DECLUTTER_ADMIN_PERMISSIONS: readonly Permission[] = [
  ...DECLUTTER_MODERATOR_PERMISSIONS,
  'declutter:seller:write',
  'declutter:kyc:review',
  'declutter:price:decide',
  'declutter:listing:publish',
  'declutter:listing:suspend',
  'declutter:contact:disclose:direct',
  'declutter:fraud:override',
];

/**
 * Role → permissions. Super admin is defined as "every permission" rather than a
 * hand-maintained list, so a newly added permission is never accidentally
 * unreachable. Every other role is an explicit allowlist.
 */
export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  customer: CUSTOMER_PERMISSIONS,
  rider: RIDER_PERMISSIONS,
  vendor_staff: VENDOR_STAFF_PERMISSIONS,
  vendor_manager: VENDOR_MANAGER_PERMISSIONS,
  vendor_owner: VENDOR_OWNER_PERMISSIONS,
  support_agent: SUPPORT_PERMISSIONS,
  dispatcher: DISPATCHER_PERMISSIONS,
  finance_analyst: FINANCE_PERMISSIONS,
  marketing_manager: MARKETING_PERMISSIONS,
  city_manager: CITY_MANAGER_PERMISSIONS,
  declutter_moderator: DECLUTTER_MODERATOR_PERMISSIONS,
  declutter_admin: DECLUTTER_ADMIN_PERMISSIONS,
  platform_admin: PLATFORM_ADMIN_PERMISSIONS,
  super_admin: PERMISSIONS,
};

/** Roles that may only ever act inside a single vendor's data. */
export const VENDOR_SCOPED_ROLES: ReadonlySet<Role> = new Set<Role>([
  'vendor_owner',
  'vendor_manager',
  'vendor_staff',
]);

/** Roles whose reach is limited to the cities they are assigned to. */
export const CITY_SCOPED_ROLES: ReadonlySet<Role> = new Set<Role>(['city_manager', 'dispatcher']);

/** Roles that sign in through the staff console and must carry MFA. */
export const STAFF_ROLES: ReadonlySet<Role> = new Set<Role>([
  'support_agent',
  'dispatcher',
  'finance_analyst',
  'marketing_manager',
  'city_manager',
  'declutter_moderator',
  'declutter_admin',
  'platform_admin',
  'super_admin',
]);

export function permissionsForRoles(roles: readonly Role[]): ReadonlySet<Permission> {
  const granted = new Set<Permission>();
  for (const role of roles) {
    for (const permission of ROLE_PERMISSIONS[role] ?? []) granted.add(permission);
  }
  return granted;
}

/**
 * The authenticated actor, as the API reconstructs it from a verified token.
 *
 * Everything here is derived server-side from the session record. None of it is
 * ever read from the request body — a client claiming `roles: ['super_admin']`
 * changes nothing.
 */
export interface Actor {
  readonly identityId: string;
  readonly sessionId: string;
  readonly roles: readonly Role[];
  readonly permissions: ReadonlySet<Permission>;
  /** Vendor the actor is bound to, for vendor-scoped roles. */
  readonly vendorId?: string | undefined;
  /** Branch within that vendor, when the actor is branch-limited. */
  readonly branchId?: string | undefined;
  /** Cities the actor may operate in, for city-scoped roles. */
  readonly cityIds?: readonly string[] | undefined;
  /** Rider profile, when the actor is a rider. */
  readonly riderId?: string | undefined;
  /** Customer profile, when the actor is a customer. */
  readonly customerId?: string | undefined;
  /** When step-up auth was last completed, if ever. */
  readonly steppedUpAt?: Date | undefined;
  /** Whether this session is an admin impersonating another identity. */
  readonly impersonating?: boolean | undefined;
}

export function buildActor(input: {
  identityId: string;
  sessionId: string;
  roles: readonly Role[];
  vendorId?: string | undefined;
  branchId?: string | undefined;
  cityIds?: readonly string[] | undefined;
  riderId?: string | undefined;
  customerId?: string | undefined;
  steppedUpAt?: Date | undefined;
  impersonating?: boolean | undefined;
}): Actor {
  return { ...input, permissions: permissionsForRoles(input.roles) };
}

export function can(actor: Actor, permission: Permission): boolean {
  return actor.permissions.has(permission);
}

export function canAll(actor: Actor, permissions: readonly Permission[]): boolean {
  return permissions.every((permission) => actor.permissions.has(permission));
}

export function canAny(actor: Actor, permissions: readonly Permission[]): boolean {
  return permissions.some((permission) => actor.permissions.has(permission));
}

export type DenialReason =
  | 'missing_permission'
  | 'step_up_required'
  | 'step_up_expired'
  | 'out_of_scope';

export class AuthorizationError extends Error {
  constructor(
    readonly reason: DenialReason,
    /** Safe to show a user. Never names the resource that was probed. */
    message: string,
    /** Internal only — logged, never serialized to a client. */
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'AuthorizationError';
  }
}

/**
 * The permission gate. Throws rather than returning false, so a forgotten
 * `if` cannot become an authorization bypass.
 */
export function assertPermission(
  actor: Actor,
  permission: Permission,
  now: Date = new Date(),
): void {
  if (!actor.permissions.has(permission)) {
    throw new AuthorizationError(
      'missing_permission',
      'You do not have access to perform this action.',
      `identity=${actor.identityId} lacks ${permission}`,
    );
  }

  if (!STEP_UP_PERMISSIONS.has(permission)) return;

  if (!actor.steppedUpAt) {
    throw new AuthorizationError(
      'step_up_required',
      'Confirm your identity to continue.',
      `identity=${actor.identityId} needs step-up for ${permission}`,
    );
  }

  const ageSeconds = (now.getTime() - actor.steppedUpAt.getTime()) / 1000;
  if (ageSeconds > STEP_UP_MAX_AGE_SECONDS || ageSeconds < 0) {
    throw new AuthorizationError(
      'step_up_expired',
      'Confirm your identity to continue.',
      `identity=${actor.identityId} step-up aged ${Math.round(ageSeconds)}s`,
    );
  }
}

/**
 * Object-level scope check — the defence against IDOR/BOLA.
 *
 * Permission answers "may you accept vendor orders?". This answers "is *this*
 * order one of yours?". Both must pass. Every route that loads a record by an
 * id from the request must call this before returning or mutating it.
 */
export function assertScope(
  actor: Actor,
  resource: {
    ownerIdentityId?: string | undefined;
    vendorId?: string | undefined;
    branchId?: string | undefined;
    cityId?: string | undefined;
    riderId?: string | undefined;
    customerId?: string | undefined;
  },
): void {
  const deny = (detail: string): never => {
    // Deliberately the same message as a missing record, so a probing client
    // cannot distinguish "exists but not yours" from "does not exist".
    throw new AuthorizationError('out_of_scope', 'Not found.', detail);
  };

  const isVendorScoped = actor.roles.some((role) => VENDOR_SCOPED_ROLES.has(role));
  if (isVendorScoped && resource.vendorId !== undefined) {
    if (actor.vendorId !== resource.vendorId) {
      deny(`identity=${actor.identityId} vendor=${actor.vendorId} != ${resource.vendorId}`);
    }
    // A branch-bound staff member cannot reach a sibling branch.
    if (actor.branchId && resource.branchId && actor.branchId !== resource.branchId) {
      deny(`identity=${actor.identityId} branch=${actor.branchId} != ${resource.branchId}`);
    }
  }

  const isCityScoped = actor.roles.some((role) => CITY_SCOPED_ROLES.has(role));
  if (isCityScoped && resource.cityId !== undefined) {
    const cities = actor.cityIds ?? [];
    if (!cities.includes(resource.cityId)) {
      deny(`identity=${actor.identityId} cities=[${cities.join(',')}] lacks ${resource.cityId}`);
    }
  }

  if (actor.roles.includes('rider') && resource.riderId !== undefined) {
    if (actor.riderId !== resource.riderId) {
      deny(`identity=${actor.identityId} rider=${actor.riderId} != ${resource.riderId}`);
    }
  }

  // A customer reaching their own records. Staff roles bypass this because their
  // reach is governed by `ops:*` / `support:*` permissions instead.
  const isStaff = actor.roles.some((role) => STAFF_ROLES.has(role));
  if (!isStaff && resource.customerId !== undefined) {
    if (actor.customerId !== resource.customerId) {
      deny(`identity=${actor.identityId} customer=${actor.customerId} != ${resource.customerId}`);
    }
  }
  if (!isStaff && resource.ownerIdentityId !== undefined) {
    if (actor.identityId !== resource.ownerIdentityId) {
      deny(`identity=${actor.identityId} != owner=${resource.ownerIdentityId}`);
    }
  }
}

export function requiresStepUp(permission: Permission): boolean {
  return STEP_UP_PERMISSIONS.has(permission);
}

export function requiresFourEyes(permission: Permission): boolean {
  return FOUR_EYES_PERMISSIONS.has(permission);
}
