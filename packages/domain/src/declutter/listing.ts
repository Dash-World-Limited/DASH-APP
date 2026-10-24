/**
 * Turning an approved submission into a public listing.
 *
 * This module holds the three things that must not be decided in a route:
 * whether a submission is genuinely ready to be published, what a listing is
 * allowed to *claim* about itself, and what a stranger is allowed to see.
 *
 * All of it is pure. Nothing here reads a database, a clock it was not handed,
 * or a provider.
 */

import type { KycState } from './seller.js';

// ---------------------------------------------------------------------------
// Slugs
// ---------------------------------------------------------------------------

/**
 * The public URL segment for a listing.
 *
 * Built from the title *and* the submission code, and the code is not optional.
 * Two people selling "iPhone 13 Pro 128GB" is the ordinary case rather than the
 * exception, and a slug that collides is either a failed publication or a
 * silently renamed listing — both worse than a URL with six characters of noise
 * on the end. The code is already unique, already public to the seller, and
 * already what support asks for on the phone.
 *
 * Non-ASCII is transliterated away rather than percent-encoded, because a
 * shared link should survive being pasted into WhatsApp, and a URL full of
 * `%E2%80%99` does not read as a real listing to anyone.
 */
export function listingSlug(title: string, code: string): string {
  const base = title
    .normalize('NFKD')
    // Strip combining marks left behind by the decomposition above.
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');

  const suffix = code.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

  // A title of nothing but punctuation or emoji leaves an empty base. The code
  // alone is still a valid, unique, resolvable URL.
  return base ? `${base}-${suffix}` : suffix;
}

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

/**
 * Why a submission cannot be published yet.
 *
 * Codes rather than sentences: the admin console renders them, the tests assert
 * them, and neither should depend on wording. Every one of these is a hard
 * gate — there is no "publish anyway" argument, because each represents either
 * a promise to a buyer we could not keep or a consent we do not have.
 */
export const PUBLICATION_GAPS = [
  'seller_not_verified',
  'price_not_authorized',
  'seller_has_not_accepted',
  'acceptance_stale',
  'no_category',
  'no_location',
  'no_photographs',
  'no_title',
  'no_description',
  'open_fraud_flag',
  'already_published',
] as const;

export type PublicationGap = (typeof PUBLICATION_GAPS)[number];

export interface PublicationCandidate {
  readonly sellerKycStatus: KycState;
  readonly valueCheckStatus: string;
  readonly authorizedPriceKobo: number | null;
  readonly authorizationVersion: number;
  readonly sellerAcceptedPriceKobo: number | null;
  readonly sellerAcceptedVersion: number | null;
  readonly categoryId: string | null;
  readonly locationId: string | null;
  readonly photoCount: number;
  readonly title: string | null;
  readonly description: string | null;
  readonly openFraudFlags: number;
  readonly alreadyHasListing: boolean;
}

/**
 * Everything standing between this submission and a public page.
 *
 * Returns every gap rather than the first one. An admin who fixes one problem,
 * retries, and is told about the next is being made to discover the checklist
 * one refusal at a time.
 */
export function publicationGaps(candidate: PublicationCandidate): readonly PublicationGap[] {
  const gaps: PublicationGap[] = [];

  if (candidate.alreadyHasListing) gaps.push('already_published');
  if (candidate.sellerKycStatus !== 'verified') gaps.push('seller_not_verified');

  if (candidate.authorizedPriceKobo === null || candidate.authorizedPriceKobo <= 0) {
    gaps.push('price_not_authorized');
  }

  if (candidate.valueCheckStatus !== 'seller_accepted') {
    gaps.push('seller_has_not_accepted');
  } else if (
    // Accepted, but against a figure or a version that is no longer the one on
    // the record. A price that moved after acceptance is a price nobody agreed
    // to, and publishing it would put a number in front of the public that the
    // seller never saw.
    candidate.sellerAcceptedPriceKobo !== candidate.authorizedPriceKobo ||
    candidate.sellerAcceptedVersion !== candidate.authorizationVersion
  ) {
    gaps.push('acceptance_stale');
  }

  if (!candidate.categoryId) gaps.push('no_category');
  if (!candidate.locationId) gaps.push('no_location');
  if (candidate.photoCount < 1) gaps.push('no_photographs');
  if (!candidate.title?.trim()) gaps.push('no_title');
  if (!candidate.description?.trim()) gaps.push('no_description');
  if (candidate.openFraudFlags > 0) gaps.push('open_fraud_flag');

  return gaps;
}

export function canPublish(candidate: PublicationCandidate): boolean {
  return publicationGaps(candidate).length === 0;
}

// ---------------------------------------------------------------------------
// Trust labels
// ---------------------------------------------------------------------------

/**
 * What a listing is allowed to claim.
 *
 * This is the most consequential function in the module, and the reason it
 * exists at all rather than living as JSX in a card component.
 *
 * A trust badge is a factual claim made to a stranger who is about to hand over
 * money for a second-hand item they have not touched. "DASH Reviewed" means a
 * named employee looked at this. "Verified Listing" means we checked who the
 * seller is against government identity. If either is ever shown when it is not
 * true, the badge stops being information and becomes decoration — and the day
 * a buyer is defrauded by a listing wearing a badge it did not earn is the day
 * the marketplace is finished.
 *
 * So each badge is derived from a fact recorded elsewhere, none is a default,
 * and the inputs are named individually rather than passed as a listing object.
 * Adding a badge means adding a fact.
 */
export const TRUST_BADGES = [
  /** A named DASH employee approved this listing's content and price. */
  'dash_reviewed',
  /** The seller's identity was checked against government ID. */
  'verified_listing',
  /** The price is fixed. There is no negotiation anywhere in this product. */
  'fixed_price',
  /** The seller has an agreement with DASH. Granted only by a super admin. */
  'trusted_partner',
  /**
   * DASH ValueCheck produced this price with a genuine live provider, and a
   * human authorised it.
   *
   * Dark at launch, and deliberately so. The only valuation engine in the
   * product today is a deterministic local adapter — arithmetic over declared
   * evidence, no model, no provider. Calling that "ValueChecked" in front of a
   * buyer would be describing development code as artificial intelligence.
   * `liveValuationAt` is the fact that turns it on, and nothing sets it until a
   * live provider has actually answered.
   */
  'value_checked',
] as const;

export type TrustBadge = (typeof TRUST_BADGES)[number];

/** The words each badge is allowed to appear as. */
export const TRUST_BADGE_LABELS: Readonly<Record<TrustBadge, string>> = {
  dash_reviewed: 'DASH Reviewed',
  verified_listing: 'Verified Listing',
  fixed_price: 'Fixed Price',
  trusted_partner: 'Trusted Partner',
  value_checked: 'DASH ValueChecked',
};

export interface TrustFacts {
  /** A human approved the listing for publication. */
  readonly moderationApproved: boolean;
  /** The seller passed KYC. */
  readonly sellerKycStatus: KycState;
  /** The seller holds a Trusted Partner agreement, granted by a super admin. */
  readonly sellerIsTrustedPartner: boolean;
  /**
   * When a genuine live valuation provider last produced the authorised price.
   *
   * Null means no live provider ran — which is the case for every listing in
   * the product today. It is a timestamp rather than a boolean so that "which
   * run was it" stays answerable later.
   */
  readonly liveValuationAt: Date | null;
  /** A human authorised the final price after that valuation. */
  readonly priceAuthorizedByHuman: boolean;
}

/**
 * The badges this listing has earned. Never a default, never a decoration.
 */
export function trustBadges(facts: TrustFacts): readonly TrustBadge[] {
  const badges: TrustBadge[] = [];

  // Always true, and worth saying. It is the single biggest difference between
  // this marketplace and a classifieds board, and buyers do not know it unless
  // they are told.
  badges.push('fixed_price');

  if (facts.moderationApproved) badges.push('dash_reviewed');
  if (facts.sellerKycStatus === 'verified') badges.push('verified_listing');
  if (facts.sellerIsTrustedPartner) badges.push('trusted_partner');

  // Both halves, or nothing. A live model run that no human authorised is not a
  // DASH ValueCheck, and a human authorising a number the local adapter
  // produced is not one either.
  if (facts.liveValuationAt !== null && facts.priceAuthorizedByHuman) {
    badges.push('value_checked');
  }

  return badges;
}

// ---------------------------------------------------------------------------
// The public shape
// ---------------------------------------------------------------------------

/**
 * A listing as a stranger sees it.
 *
 * The type is the privacy boundary, exactly as `PublicSellerProfile` is on the
 * seller side. There is no seller phone number, no address, no coordinate, no
 * distance, no delivery estimate and no `expectedPriceKobo` — the last because
 * what a seller hoped for is a negotiating position, and this marketplace does
 * not negotiate.
 *
 * A route cannot leak one of those by forgetting a `select`: it would have to
 * add a field to this interface, and that shows up in review.
 */
export interface PublicListingCard {
  readonly slug: string;
  readonly title: string;
  readonly priceKobo: number;
  readonly condition: string;
  readonly categoryKey: string;
  readonly categoryName: string;
  /** Area and state only. Never an address, never a coordinate. */
  readonly location: { readonly slug: string; readonly label: string };
  readonly availability: string;
  readonly badges: readonly TrustBadge[];
  readonly photo: { readonly url: string; readonly alt: string } | null;
  readonly publishedAt: string | null;
}

export interface PublicListingDetail extends PublicListingCard {
  readonly description: string;
  /** Only the attributes the category marks public. */
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly photos: readonly { readonly url: string; readonly alt: string; readonly role: string }[];
  readonly seller: {
    readonly id: string;
    readonly displayName: string;
    readonly sellerType: string;
    readonly isTrustedPartner: boolean;
    readonly memberSince: string | null;
  };
  /** Whether a buyer may ask to be put in touch right now. */
  readonly contactable: boolean;
}

// ---------------------------------------------------------------------------
// Sorting and search
// ---------------------------------------------------------------------------

export const LISTING_SORTS = ['newest', 'price_low', 'price_high'] as const;
export type ListingSort = (typeof LISTING_SORTS)[number];

/**
 * Alt text for a listing photograph.
 *
 * Derived rather than optional. A seller who uploads six photographs and
 * captions none of them would otherwise publish six images that a screen reader
 * announces as nothing at all, and "photograph of an iPhone 13 Pro, showing the
 * screen" is both true and useful without anyone having to type it.
 */
export function photoAlt(title: string, role: string, caption: string | null): string {
  if (caption?.trim()) return caption.trim();
  const view: Record<string, string> = {
    front: 'front view',
    back: 'back view',
    side: 'side view',
    label: 'the model or serial label',
    screen: 'the screen',
    accessories: 'the included accessories',
    damage: 'a mark or fault on the item',
  };
  const suffix = view[role];
  return suffix ? `${title}, ${suffix}` : title;
}
