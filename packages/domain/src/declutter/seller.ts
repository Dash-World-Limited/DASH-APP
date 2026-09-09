/**
 * Declutter sellers: verification, and the line between private and public.
 *
 * Two things live here, and they are the two things a marketplace gets wrong.
 *
 * **Verification is a state machine, not a boolean.** "Verified" and "was
 * verified and has since been suspended" are different facts with different
 * consequences, and a `verified: true` column cannot hold the second one.
 *
 * **The public shape of a seller is a type, not a convention.** Every field a
 * buyer may see is on `PublicSellerProfile`, and there is no code path that
 * turns a seller row into one while carrying anything else along. A route
 * cannot leak a NIN by forgetting to omit it, because it never had a way to
 * include it.
 *
 * ## Ordinary accounts are not sellers
 *
 * Signing up, browsing, searching and saving require no verification and no
 * seller record at all. A `DeclutterSeller` row is created the moment someone
 * says they want to sell, and *only* then, which is what keeps the KYC burden
 * on the few people it belongs to.
 */

import type { DeclutterActor } from './lifecycle.js';

// ---------------------------------------------------------------------------
// Verification states
// ---------------------------------------------------------------------------

export const KYC_STATES = [
  /** A seller record exists; nothing has been submitted. */
  'unverified',
  /** Details are in and DASH owes them a decision. */
  'pending',
  /** Cleared to have items published. */
  'verified',
  /** Turned down, with a reason. May resubmit. */
  'rejected',
  /** Was verified; access withdrawn. Not the same as never verified. */
  'suspended',
] as const;

export type KycState = (typeof KYC_STATES)[number];

interface KycRule {
  readonly to: KycState;
  readonly actors: readonly DeclutterActor[];
}

/**
 * Who may move a seller's verification where.
 *
 * `seller` appears only on the two transitions that are a seller submitting
 * their own paperwork. Every judgement — verify, reject, suspend — is an admin
 * act, and `staff` is absent from all of them: a moderator prepares work, and
 * clearing someone to sell to the public is not preparation.
 */
const KYC_TRANSITIONS: Readonly<Record<KycState, readonly KycRule[]>> = {
  unverified: [{ to: 'pending', actors: ['seller', 'admin', 'super_admin'] }],
  pending: [
    { to: 'verified', actors: ['admin', 'super_admin'] },
    { to: 'rejected', actors: ['admin', 'super_admin'] },
  ],
  // Resubmission after a rejection is the seller's move, and it must be
  // possible: a rejection for a blurry document is not a life sentence.
  rejected: [{ to: 'pending', actors: ['seller', 'admin', 'super_admin'] }],
  verified: [
    { to: 'suspended', actors: ['admin', 'super_admin'] },
    // Re-verification, e.g. after a bank account changes.
    { to: 'pending', actors: ['admin', 'super_admin'] },
  ],
  suspended: [
    { to: 'verified', actors: ['admin', 'super_admin'] },
    { to: 'pending', actors: ['admin', 'super_admin'] },
  ],
};

export class KycTransitionError extends Error {
  constructor(
    readonly from: KycState,
    readonly to: KycState,
    readonly actor: DeclutterActor,
    readonly reason: 'illegal_transition' | 'actor_not_permitted',
  ) {
    super(`seller kyc: ${actor} cannot move ${from} → ${to} (${reason})`);
    this.name = 'KycTransitionError';
  }
}

export function canTransitionKyc(from: KycState, to: KycState, actor: DeclutterActor): boolean {
  return KYC_TRANSITIONS[from].some((rule) => rule.to === to && rule.actors.includes(actor));
}

export function allowedKycTransitions(from: KycState, actor: DeclutterActor): readonly KycState[] {
  return KYC_TRANSITIONS[from].filter((rule) => rule.actors.includes(actor)).map((rule) => rule.to);
}

export function assertKycTransition(
  from: KycState,
  to: KycState,
  actor: DeclutterActor,
): KycState {
  const rule = KYC_TRANSITIONS[from].find((candidate) => candidate.to === to);
  if (!rule) throw new KycTransitionError(from, to, actor, 'illegal_transition');
  if (!rule.actors.includes(actor)) {
    throw new KycTransitionError(from, to, actor, 'actor_not_permitted');
  }
  return to;
}

/** Transitions a seller must be told the reason for. */
export const KYC_REASON_REQUIRED: ReadonlySet<KycState> = new Set<KycState>([
  'rejected',
  'suspended',
]);

export function kycReasonRequired(to: KycState): boolean {
  return KYC_REASON_REQUIRED.has(to);
}

/**
 * May this seller have an item published?
 *
 * The single question the publication path asks. Deliberately narrow: only
 * `verified` passes, so a suspended seller's existing listings can be taken
 * down and no new one can replace them.
 */
export function canSellerPublish(status: KycState): boolean {
  return status === 'verified';
}

/**
 * May this seller still submit items for consideration?
 *
 * Broader than publishing on purpose. Someone who has not finished
 * verification can still send DASH an item — that is how the conversation
 * starts, and refusing it would mean asking for a NIN before anyone has agreed
 * there is anything to sell. A suspended seller cannot: the relationship is
 * paused, and taking more of their items would imply otherwise.
 */
export function canSellerSubmit(status: KycState): boolean {
  return status !== 'suspended';
}

// ---------------------------------------------------------------------------
// The private / public boundary
// ---------------------------------------------------------------------------

/**
 * Everything a buyer may ever see about a seller.
 *
 * Note what is not here: no legal name, no national identifier, no phone, no
 * email, no address, no bank details, no admin notes, no rejection reason, no
 * name-match score. A marketplace shows that DASH checked somebody, not what
 * DASH found.
 */
export interface PublicSellerProfile {
  readonly id: string;
  readonly displayName: string;
  readonly sellerType: 'individual' | 'trusted_partner';
  /** A general area such as "Lekki, Lagos". Never a street address. */
  readonly area: string | null;
  /** Whether DASH has verified them. Not *how*, and not what was checked. */
  readonly verified: boolean;
  readonly trustedPartner: boolean;
}

/** The seller row as this module needs to see it. */
export interface SellerRecordLike {
  readonly id: string;
  readonly displayName: string;
  readonly sellerType: string;
  readonly publicArea: string | null;
  readonly kycStatus: string;
}

/**
 * Narrow a seller record to its public shape.
 *
 * The one function that may produce a seller for public consumption. It builds
 * a fresh object field by field rather than spreading and deleting, so a column
 * added to the table tomorrow — another identifier, another note — cannot
 * appear in a public response by default. New fields are invisible until
 * somebody adds them here deliberately.
 */
export function publicSellerProfile(seller: SellerRecordLike): PublicSellerProfile {
  const sellerType = seller.sellerType === 'trusted_partner' ? 'trusted_partner' : 'individual';
  return {
    id: seller.id,
    displayName: seller.displayName,
    sellerType,
    area: seller.publicArea,
    verified: seller.kycStatus === 'verified',
    trustedPartner: sellerType === 'trusted_partner',
  };
}

/**
 * Field names that must never appear in a public payload.
 *
 * Used by a test that walks real API responses. A list of forbidden names is a
 * blunt instrument, and that is the point — it catches the case where somebody
 * bypasses `publicSellerProfile` and hand-builds a response.
 */
export const PRIVATE_SELLER_FIELDS: readonly string[] = [
  'legalName',
  'nationalIdCipher',
  'nationalIdLast4',
  'phoneE164',
  'addressLine',
  'bankName',
  'bankAccountLast4',
  'bankAccountCipher',
  'bankAccountName',
  'nameMatchScore',
  'nameMatchVerdict',
  'nameMatchDetail',
  'adminNotes',
  'rejectionReason',
  'verifiedBy',
];

// ---------------------------------------------------------------------------
// What verification actually requires
// ---------------------------------------------------------------------------

/**
 * Document kinds DASH accepts as proof of identity.
 *
 * A government-issued photo document, and nothing else. A utility bill proves
 * an address, not a person, and accepting one as identity evidence is how a
 * verification process becomes decorative.
 */
export const IDENTITY_DOCUMENT_KINDS = ['national_id', 'drivers_licence', 'passport', 'voters_card'] as const;

export type IdentityDocumentKind = (typeof IDENTITY_DOCUMENT_KINDS)[number];

/** Kinds a seller may upload at all, identity documents plus supporting ones. */
export const SELLER_DOCUMENT_KINDS = [...IDENTITY_DOCUMENT_KINDS, 'proof_of_address', 'selfie'] as const;

export type SellerDocumentKind = (typeof SELLER_DOCUMENT_KINDS)[number];

export function isIdentityDocumentKind(kind: string): kind is IdentityDocumentKind {
  return (IDENTITY_DOCUMENT_KINDS as readonly string[]).includes(kind);
}

/** What DASH holds about a seller, as far as verification is concerned. */
export interface VerificationEvidence {
  readonly legalName: string | null;
  readonly nationalIdOnFile: boolean;
  readonly phoneOnFile: boolean;
  /** Identity documents an admin has looked at and accepted. */
  readonly acceptedIdentityDocuments: number;
}

export type VerificationGap =
  | 'legal_name'
  | 'national_id'
  | 'phone'
  | 'accepted_identity_document';

/**
 * What is still missing before this seller could be verified.
 *
 * Returned as a list rather than a boolean so the admin screen can say *what*
 * is outstanding instead of greying out a button for reasons nobody can see.
 *
 * The document requirement is the one that matters. Typed identity details are
 * a claim; a government document an admin has opened and accepted is evidence.
 * Verification that never looks at a document is a form, not a check — which
 * is exactly the failure mode that makes a marketplace's "verified" badge
 * worthless.
 */
export function verificationGaps(evidence: VerificationEvidence): readonly VerificationGap[] {
  const gaps: VerificationGap[] = [];
  if (!evidence.legalName || evidence.legalName.trim().length === 0) gaps.push('legal_name');
  if (!evidence.nationalIdOnFile) gaps.push('national_id');
  if (!evidence.phoneOnFile) gaps.push('phone');
  if (evidence.acceptedIdentityDocuments < 1) gaps.push('accepted_identity_document');
  return gaps;
}

export function canVerifySeller(evidence: VerificationEvidence): boolean {
  return verificationGaps(evidence).length === 0;
}

/** Wording an admin screen can show directly. */
export const VERIFICATION_GAP_LABELS: Readonly<Record<VerificationGap, string>> = {
  legal_name: 'No legal name on file',
  national_id: 'No identity number on file',
  phone: 'No phone number on file',
  accepted_identity_document: 'No accepted government identity document',
};
