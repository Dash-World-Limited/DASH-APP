/**
 * DASH World Declutters — the lifecycles.
 *
 * Three state machines, kept apart on purpose.
 *
 *   * `DeclutterSubmission` — the private conversation between a seller and
 *     DASH about whether an item should be listed at all.
 *   * `DeclutterListing` — the public marketplace object, which exists only
 *     after that conversation succeeded.
 *   * `DeclutterContactRequest` — a buyer asking to be put in touch, and an
 *     admin deciding.
 *
 * They are separate because they have different owners, different audiences and
 * different failure modes. Collapsing them into one status column is how a
 * listing ends up "sold" because a moderator rejected a photo, or how "seller
 * has not sent their NIN yet" becomes indistinguishable from "this item is
 * reserved".
 *
 * ## What the machines guarantee
 *
 * Two rules matter more than the rest, and both are enforced here rather than
 * in a route that could be forgotten:
 *
 *   * **A submission cannot reach `published` without passing through
 *     `seller_acceptance_pending` and `approved`.** The seller must have
 *     accepted the final DASH price. No admin convenience path skips it.
 *   * **Nothing automated may publish.** Every transition into `approved` or
 *     into a listing's `approved` moderation status names a human actor. The
 *     valuation engine is not on any of those lists — see `valuation.ts`.
 *
 * The machines are pure. Persisting the change, writing the audit row and
 * emitting the notification are the caller's job, exactly as in
 * `orders/index.ts`.
 */

// ---------------------------------------------------------------------------
// Actors
// ---------------------------------------------------------------------------

/**
 * Who is making a transition.
 *
 * `seller` and `buyer` are the public; `staff`, `admin` and `super_admin` are
 * DASH; `system` is a scheduled job. The distinction between the three internal
 * roles is deliberate: a moderator preparing a submission is not the same
 * authority as the person who sets a final price, and the machine should say so
 * rather than leaving it to a UI that hides a button.
 */
export type DeclutterActor =
  | 'seller'
  | 'buyer'
  | 'staff'
  | 'admin'
  | 'super_admin'
  | 'system';

/** Internal actors, in ascending authority. Used by the seniority checks. */
const INTERNAL_RANK: Readonly<Record<string, number>> = {
  staff: 1,
  admin: 2,
  super_admin: 3,
};

export function isInternalActor(actor: DeclutterActor): boolean {
  return actor in INTERNAL_RANK;
}

// ---------------------------------------------------------------------------
// Submission
// ---------------------------------------------------------------------------

export const SUBMISSION_STATES = [
  /** An internal record started before anything was received. */
  'draft',
  /** Received — usually from the Declutters WhatsApp — and awaiting triage. */
  'intake',
  /** Blocked on the seller being verified. Nothing else can proceed. */
  'kyc_pending',
  /** Seller is verified; we are missing photos, specifications or answers. */
  'details_pending',
  /** A duplicate-image or fraud signal is being reviewed by a human. */
  'fraud_review',
  /** Complete enough to value. Queued for DASH ValueCheck. */
  'valuation_pending',
  /** ValueCheck has produced a recommendation; an admin is deciding. */
  'pricing_review',
  /** A final fixed price exists and the seller has not yet accepted it. */
  'seller_acceptance_pending',
  /** Seller accepted. Ready to become a listing. */
  'approved',
  /** A listing exists. Terminal for the submission. */
  'published',
  /** DASH declined the item. Terminal. */
  'rejected',
  /** The seller pulled out. Terminal. */
  'withdrawn',
] as const;

export type SubmissionState = (typeof SUBMISSION_STATES)[number];

export const SUBMISSION_TERMINAL: ReadonlySet<SubmissionState> = new Set<SubmissionState>([
  'published',
  'rejected',
  'withdrawn',
]);

/** States where DASH owes the seller a response. Drives the admin queue. */
export const SUBMISSION_AWAITING_DASH: ReadonlySet<SubmissionState> = new Set<SubmissionState>([
  'intake',
  'fraud_review',
  'valuation_pending',
  'pricing_review',
]);

/** States where DASH is waiting on the seller. Drives seller chasing. */
export const SUBMISSION_AWAITING_SELLER: ReadonlySet<SubmissionState> = new Set<SubmissionState>([
  'kyc_pending',
  'details_pending',
  'seller_acceptance_pending',
]);

interface Rule<S extends string> {
  readonly to: S;
  readonly actors: readonly DeclutterActor[];
  /** Human-readable, used in the error when a transition is refused. */
  readonly note?: string;
}

/**
 * The submission transition table.
 *
 * `withdrawn` and `rejected` are reachable from nearly everywhere because a
 * seller may change their mind and DASH may decline at any point before
 * publication. Neither is reachable from `published`: once an item is public,
 * taking it down is a *listing* action with its own audit trail, not a quiet
 * edit to the submission that produced it.
 */
const SUBMISSION_TRANSITIONS: Readonly<Record<SubmissionState, readonly Rule<SubmissionState>[]>> =
  {
    draft: [
      { to: 'intake', actors: ['staff', 'admin', 'super_admin', 'system'] },
      { to: 'withdrawn', actors: ['seller', 'staff', 'admin', 'super_admin'] },
    ],
    intake: [
      { to: 'kyc_pending', actors: ['staff', 'admin', 'super_admin', 'system'] },
      { to: 'details_pending', actors: ['staff', 'admin', 'super_admin'] },
      { to: 'fraud_review', actors: ['staff', 'admin', 'super_admin', 'system'] },
      { to: 'rejected', actors: ['admin', 'super_admin'] },
      { to: 'withdrawn', actors: ['seller', 'staff', 'admin', 'super_admin'] },
    ],
    kyc_pending: [
      { to: 'fraud_review', actors: ['system'], note: 'verification completed and item details are present' },
      { to: 'details_pending', actors: ['admin', 'super_admin'] },
      { to: 'rejected', actors: ['admin', 'super_admin'] },
      { to: 'withdrawn', actors: ['seller', 'staff', 'admin', 'super_admin'] },
    ],
    details_pending: [
      { to: 'valuation_pending', actors: ['staff', 'admin', 'super_admin'] },
      { to: 'fraud_review', actors: ['staff', 'admin', 'super_admin', 'system'] },
      { to: 'kyc_pending', actors: ['admin', 'super_admin'], note: 'verification lapsed' },
      { to: 'rejected', actors: ['admin', 'super_admin'] },
      { to: 'withdrawn', actors: ['seller', 'staff', 'admin', 'super_admin'] },
    ],
    fraud_review: [
      // Clearing a fraud flag is an admin decision and always needs a reason.
      { to: 'details_pending', actors: ['admin', 'super_admin'] },
      { to: 'valuation_pending', actors: ['admin', 'super_admin'] },
      { to: 'rejected', actors: ['admin', 'super_admin'] },
      { to: 'withdrawn', actors: ['seller', 'admin', 'super_admin'] },
    ],
    valuation_pending: [
      // `system` completes a valuation run. It may only move the submission
      // *to a human*, never past one.
      { to: 'pricing_review', actors: ['staff', 'admin', 'super_admin', 'system'] },
      // A valuation that failed outright returns the submission to a human
      // rather than stalling in a queue. See valuation.ts.
      { to: 'details_pending', actors: ['staff', 'admin', 'super_admin', 'system'] },
      { to: 'rejected', actors: ['admin', 'super_admin'] },
      { to: 'withdrawn', actors: ['seller', 'admin', 'super_admin'] },
    ],
    pricing_review: [
      // Only an admin sets a final price. Staff may prepare, not price.
      { to: 'seller_acceptance_pending', actors: ['admin', 'super_admin'] },
      { to: 'valuation_pending', actors: ['admin', 'super_admin'], note: 're-run valuation' },
      { to: 'rejected', actors: ['admin', 'super_admin'] },
      { to: 'withdrawn', actors: ['seller', 'admin', 'super_admin'] },
    ],
    seller_acceptance_pending: [
      // The seller accepts. An admin may record acceptance taken over the
      // phone or on WhatsApp, but the record must say who recorded it and on
      // what evidence — the route enforces that, this table permits it.
      { to: 'approved', actors: ['seller', 'admin', 'super_admin'] },
      // Seller wants a different price: back to pricing, not straight to a new
      // number, so the change is visible in the history.
      { to: 'pricing_review', actors: ['admin', 'super_admin'] },
      { to: 'rejected', actors: ['admin', 'super_admin'] },
      { to: 'withdrawn', actors: ['seller', 'admin', 'super_admin'] },
    ],
    approved: [
      { to: 'published', actors: ['admin', 'super_admin'] },
      { to: 'pricing_review', actors: ['admin', 'super_admin'] },
      { to: 'rejected', actors: ['admin', 'super_admin'] },
      { to: 'withdrawn', actors: ['seller', 'admin', 'super_admin'] },
    ],
    published: [],
    rejected: [],
    withdrawn: [],
  };

// ---------------------------------------------------------------------------
// Listing — two axes, deliberately
// ---------------------------------------------------------------------------

/**
 * Is DASH willing to show this?
 *
 * Separate from availability because they answer different questions and change
 * for different reasons. A suspended listing and a sold listing are both absent
 * from the marketplace, but one is a moderation decision and the other is a
 * commercial outcome, and conflating them destroys both the audit trail and the
 * seller's ability to understand what happened.
 */
export const MODERATION_STATES = [
  'draft',
  'pending_review',
  'approved',
  'rejected',
  'suspended',
] as const;

export type ModerationState = (typeof MODERATION_STATES)[number];

/** Is the item still obtainable? */
export const AVAILABILITY_STATES = [
  'available',
  /** Held for one buyer. Still visible — hiding it makes a busy market look dead. */
  'reserved',
  /** Temporarily off the market at the seller's or an admin's request. */
  'unavailable',
  'sold',
  'archived',
] as const;

export type AvailabilityState = (typeof AVAILABILITY_STATES)[number];

const MODERATION_TRANSITIONS: Readonly<
  Record<ModerationState, readonly Rule<ModerationState>[]>
> = {
  draft: [{ to: 'pending_review', actors: ['staff', 'admin', 'super_admin'] }],
  pending_review: [
    // Publication is an admin act. Staff prepare; they do not publish.
    { to: 'approved', actors: ['admin', 'super_admin'] },
    { to: 'rejected', actors: ['admin', 'super_admin'] },
  ],
  approved: [
    // A material edit sends an approved listing back for review. See
    // `MATERIAL_LISTING_FIELDS`.
    { to: 'pending_review', actors: ['staff', 'admin', 'super_admin', 'seller', 'system'] },
    { to: 'suspended', actors: ['admin', 'super_admin'] },
  ],
  rejected: [{ to: 'pending_review', actors: ['staff', 'admin', 'super_admin'] }],
  suspended: [
    { to: 'pending_review', actors: ['admin', 'super_admin'] },
    { to: 'rejected', actors: ['admin', 'super_admin'] },
  ],
};

const AVAILABILITY_TRANSITIONS: Readonly<
  Record<AvailabilityState, readonly Rule<AvailabilityState>[]>
> = {
  available: [
    { to: 'reserved', actors: ['admin', 'super_admin', 'system'] },
    { to: 'unavailable', actors: ['seller', 'staff', 'admin', 'super_admin'] },
    // Sold without a reservation: an off-platform sale the seller reports, or
    // an admin closing a deal that happened by phone. Allowed, but it is an
    // explicit act by a named person, never a side effect.
    { to: 'sold', actors: ['admin', 'super_admin'] },
    { to: 'archived', actors: ['admin', 'super_admin'] },
  ],
  reserved: [
    { to: 'available', actors: ['admin', 'super_admin', 'system'] },
    { to: 'sold', actors: ['admin', 'super_admin'] },
    { to: 'unavailable', actors: ['admin', 'super_admin'] },
  ],
  unavailable: [
    { to: 'available', actors: ['seller', 'staff', 'admin', 'super_admin'] },
    { to: 'archived', actors: ['admin', 'super_admin'] },
    { to: 'sold', actors: ['admin', 'super_admin'] },
  ],
  // Sold is not the end of the record — an admin can archive it — but an item
  // cannot become available again. If it genuinely is, that is a new listing
  // with a new inspection, not a resurrection of an old one.
  sold: [{ to: 'archived', actors: ['admin', 'super_admin'] }],
  archived: [],
};

/**
 * Editing any of these on an approved listing returns it to moderation.
 *
 * The list is the answer to a specific attack: get a cheap, honest item
 * approved, then edit it into an expensive dishonest one and keep the approval
 * badge. Everything that defines *what the item is* or *what it costs* is here.
 *
 * Deliberately absent: availability changes, view counts, and anything the
 * seller can already do without changing the item's identity.
 */
export const MATERIAL_LISTING_FIELDS = [
  'title',
  'description',
  'categoryKey',
  'condition',
  'priceKobo',
  'locationId',
  'photos',
  'attributes',
] as const;

export type MaterialListingField = (typeof MATERIAL_LISTING_FIELDS)[number];

const MATERIAL_SET: ReadonlySet<string> = new Set(MATERIAL_LISTING_FIELDS);

/** Does this set of changed fields require re-moderation? */
export function requiresRemoderation(changedFields: readonly string[]): boolean {
  return changedFields.some((field) => MATERIAL_SET.has(field));
}

/** Which of the changed fields were the material ones. For the audit note. */
export function materialFieldsIn(changedFields: readonly string[]): readonly string[] {
  return changedFields.filter((field) => MATERIAL_SET.has(field));
}

/**
 * Is this listing visible to the public right now?
 *
 * Both axes must agree. A single boolean column would be cheaper to query and
 * would be wrong the first time someone suspended a reserved listing.
 */
export function isPubliclyVisible(
  moderation: ModerationState,
  availability: AvailabilityState,
): boolean {
  if (moderation !== 'approved') return false;
  return availability === 'available' || availability === 'reserved';
}

/** Can a buyer act on it — request contact, start a deal? */
export function isPubliclyActionable(
  moderation: ModerationState,
  availability: AvailabilityState,
): boolean {
  return moderation === 'approved' && availability === 'available';
}

// ---------------------------------------------------------------------------
// Contact request
// ---------------------------------------------------------------------------

/**
 * A buyer asking to be put in touch with a seller.
 *
 * Modelled as an object with a lifecycle rather than a boolean, because every
 * one of these is a decision to hand one real person's contact details to
 * another, and the day someone abuses it we must be able to say who released
 * what, when, and who approved it.
 */
export const CONTACT_REQUEST_STATES = [
  'pending',
  'approved',
  'rejected',
  /** Time-limited access lapsed. */
  'expired',
  /** Access withdrawn after the fact, e.g. the buyer turned out to be abusive. */
  'revoked',
] as const;

export type ContactRequestState = (typeof CONTACT_REQUEST_STATES)[number];

const CONTACT_TRANSITIONS: Readonly<
  Record<ContactRequestState, readonly Rule<ContactRequestState>[]>
> = {
  pending: [
    { to: 'approved', actors: ['staff', 'admin', 'super_admin'] },
    { to: 'rejected', actors: ['staff', 'admin', 'super_admin'] },
    { to: 'expired', actors: ['system'] },
  ],
  approved: [
    { to: 'expired', actors: ['system'] },
    { to: 'revoked', actors: ['admin', 'super_admin'] },
  ],
  rejected: [],
  expired: [],
  revoked: [],
};

// ---------------------------------------------------------------------------
// The shared engine
// ---------------------------------------------------------------------------

export class DeclutterTransitionError extends Error {
  constructor(
    readonly machine: string,
    readonly from: string,
    readonly to: string,
    readonly actor: DeclutterActor,
    readonly reason: 'unknown_state' | 'illegal_transition' | 'actor_not_permitted',
  ) {
    super(`${machine}: ${actor} cannot move ${from} → ${to} (${reason})`);
    this.name = 'DeclutterTransitionError';
  }
}

function makeMachine<S extends string>(
  machine: string,
  table: Readonly<Record<S, readonly Rule<S>[]>>,
) {
  const states = Object.keys(table) as S[];

  function allowedFor(from: S, actor: DeclutterActor): readonly S[] {
    const rules = table[from];
    if (!rules) return [];
    return rules.filter((rule) => rule.actors.includes(actor)).map((rule) => rule.to);
  }

  function can(from: S, to: S, actor: DeclutterActor): boolean {
    const rules = table[from];
    if (!rules) return false;
    return rules.some((rule) => rule.to === to && rule.actors.includes(actor));
  }

  function assert(from: S, to: S, actor: DeclutterActor): S {
    const rules = table[from];
    if (!rules) {
      throw new DeclutterTransitionError(machine, from, to, actor, 'unknown_state');
    }
    const rule = rules.find((candidate) => candidate.to === to);
    if (!rule) {
      throw new DeclutterTransitionError(machine, from, to, actor, 'illegal_transition');
    }
    if (!rule.actors.includes(actor)) {
      throw new DeclutterTransitionError(machine, from, to, actor, 'actor_not_permitted');
    }
    return to;
  }

  return { states, allowedFor, can, assert } as const;
}

export const submissionMachine = makeMachine('submission', SUBMISSION_TRANSITIONS);
export const moderationMachine = makeMachine('listing.moderation', MODERATION_TRANSITIONS);
export const availabilityMachine = makeMachine('listing.availability', AVAILABILITY_TRANSITIONS);
export const contactRequestMachine = makeMachine('contact_request', CONTACT_TRANSITIONS);

// ---------------------------------------------------------------------------
// Reasons — required, and enumerated
// ---------------------------------------------------------------------------

/**
 * Transitions that may not happen without a recorded reason.
 *
 * A rejection a seller cannot understand is how you lose a seller for good, and
 * an override nobody can explain three months later is how an audit fails.
 * The route reads this set; the tests assert it covers every destructive or
 * discretionary move.
 */
export const REASON_REQUIRED_TRANSITIONS: ReadonlySet<string> = new Set([
  'submission:rejected',
  'submission:fraud_review',
  'listing.moderation:rejected',
  'listing.moderation:suspended',
  'listing.availability:sold',
  'listing.availability:unavailable',
  'contact_request:rejected',
  'contact_request:revoked',
]);

export function reasonRequired(machine: string, to: string): boolean {
  return REASON_REQUIRED_TRANSITIONS.has(`${machine}:${to}`);
}

/** Fixed rejection vocabulary. Written for the seller, not for the operator. */
export const SUBMISSION_REJECTION_REASONS = [
  'photos_insufficient',
  'photos_not_original',
  'ownership_unverified',
  'condition_misrepresented',
  'prohibited_item',
  'duplicate_submission',
  'outside_service_area',
  'price_expectation_unworkable',
  'seller_unresponsive',
  'failed_verification',
] as const;

export type SubmissionRejectionReason = (typeof SUBMISSION_REJECTION_REASONS)[number];

// ---------------------------------------------------------------------------
// Contact methods — and the honesty about what "revoke" can mean
// ---------------------------------------------------------------------------

/**
 * How an approved buyer actually reaches a seller.
 *
 * Modelled as a typed method rather than a `sellerPhoneReleased` boolean
 * because the choice has consequences the boolean cannot carry, and because a
 * future masked-relay or WhatsApp Business integration must be an added method
 * rather than a schema replacement.
 */
export const CONTACT_METHODS = [
  /** DASH World Declutters coordinates the introduction. V1 default. */
  'dash_relay',
  /** A proxy number or thread. Neither party sees the other's real details. */
  'masked_relay',
  /** The seller's real WhatsApp number is shown to the buyer. */
  'whatsapp_direct',
  /** The seller's real phone number is shown to the buyer. */
  'phone_direct',
] as const;

export type ContactMethod = (typeof CONTACT_METHODS)[number];

/**
 * V1 default: DASH mediates and no seller detail leaves the platform.
 *
 * The buyer asks to arrange an inspection, an admin approves, and the buyer is
 * given "Contact Seller Through DASH" — the Declutters WhatsApp handles the
 * introduction. The seller's own number is never part of that exchange.
 */
export const DEFAULT_CONTACT_METHOD: ContactMethod = 'dash_relay';

/** Methods where DASH stands between the two people. */
export const MEDIATED_CONTACT_METHODS: ReadonlySet<ContactMethod> = new Set<ContactMethod>([
  'dash_relay',
  'masked_relay',
]);

/** Methods that hand a real, permanent contact detail to a stranger. */
export const DIRECT_CONTACT_METHODS: ReadonlySet<ContactMethod> = new Set<ContactMethod>([
  'whatsapp_direct',
  'phone_direct',
]);

export function isMediatedContact(method: ContactMethod): boolean {
  return MEDIATED_CONTACT_METHODS.has(method);
}

/**
 * Can withdrawing this grant actually withdraw anything?
 *
 * This is the one place in the system where the answer is allowed to be "no",
 * and saying so plainly matters more than the code that reads it.
 *
 * Revoking a mediated grant genuinely works: DASH stops relaying, and the buyer
 * has nothing but a listing page. Revoking a *direct* grant closes the app's
 * door and nothing else — the buyer wrote the number down, or their phone
 * saved it, or they messaged it to someone else. A product that shows a
 * "revoked" badge over a disclosed phone number is lying to the seller about
 * the protection they have.
 *
 * So the schema keeps two separate records: a grant, which may expire and be
 * revoked, and a disclosure, which is append-only and has no revoked column,
 * because there is no such thing.
 */
export function accessIsRevocable(method: ContactMethod): boolean {
  return isMediatedContact(method);
}

/**
 * Handing out a seller's real number is the seller's decision, not only an
 * admin's, and it needs a reason on the record from whoever approved it.
 */
export function requiresSellerConsent(method: ContactMethod): boolean {
  return DIRECT_CONTACT_METHODS.has(method);
}

export function requiresApprovalReason(method: ContactMethod): boolean {
  return DIRECT_CONTACT_METHODS.has(method);
}

/** What a disclosure of this method actually reveals. Stored on the record. */
export function disclosedFieldsFor(method: ContactMethod): readonly string[] {
  switch (method) {
    case 'dash_relay':
      return [];
    case 'masked_relay':
      return ['proxy_channel'];
    case 'whatsapp_direct':
      return ['seller_whatsapp'];
    case 'phone_direct':
      return ['seller_phone'];
  }
}
