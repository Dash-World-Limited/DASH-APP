import { publicationGaps, type PublicationCandidate } from './listing.js';

export interface HubFacts extends PublicationCandidate {
  status: string;
  safetyReviewedAt: Date | null;
  itemReviewedAt: Date | null;
  fullyApprovedAt: Date | null;
  valuationAt: Date | null;
  createdAt: Date;
  authorizedAt: Date | null;
  sellerAcceptedAt: Date | null;
  publishedAt: Date | null;
  partnerApprovalRequired: boolean;
  partnerApprovedAt: Date | null;
  pendingUpdate: boolean;
  sellerVerifiedAt?: Date | null;
  availability?: string | null;
  moderationStatus?: string | null;
}
export const HUB_BLOCKER_LABELS: Record<string, string> = {
  seller_not_verified: 'Seller verification is required',
  price_not_authorized: 'DASH must authorise a price',
  seller_has_not_accepted: 'Seller price decision is required',
  acceptance_stale: 'The current price needs fresh seller acceptance',
  no_category: 'Select an item category',
  no_location: 'Select an item location',
  no_photographs: 'Upload item photos',
  no_title: 'An item title is required',
  no_description: 'An item description is required',
  open_fraud_flag: 'Safety concerns need an authorised review',
  safety_review_required: 'Safety review is required',
  item_review_required: 'Item review is required',
  valuation_required: 'ValueCheck is required',
  partner_approval_required: 'Source partner approval is required',
  update_review_required: 'Seller changes need review',
  item_paused: 'This item was declined or withdrawn',
};
export function hubBlockers(f: HubFacts): string[] {
  const legacyApproved = Boolean(
    f.fullyApprovedAt || ['approved', 'published'].includes(f.status),
  );
  const gaps: string[] = [
    ...publicationGaps({ ...f, alreadyHasListing: false }),
  ];
  if (!f.safetyReviewedAt && !legacyApproved)
    gaps.push('safety_review_required');
  if (!f.itemReviewedAt && !legacyApproved) gaps.push('item_review_required');
  if (!f.valuationAt && !legacyApproved) gaps.push('valuation_required');
  if (f.partnerApprovalRequired && !f.partnerApprovedAt && !f.fullyApprovedAt)
    gaps.push('partner_approval_required');
  if (f.pendingUpdate) gaps.push('update_review_required');
  if (['rejected', 'withdrawn'].includes(f.status)) gaps.push('item_paused');
  return gaps;
}
/** Seller progress deliberately consolidates all DASH-controlled checks. */
export function hubProgress(f: HubFacts) {
  const accepted =
    f.valueCheckStatus === 'seller_accepted' &&
    f.authorizedPriceKobo !== null &&
    f.sellerAcceptedVersion === f.authorizationVersion &&
    f.sellerAcceptedPriceKobo === f.authorizedPriceKobo;
  const approved = Boolean(
    f.fullyApprovedAt || ['approved', 'published'].includes(f.status),
  );
  const steps = [
    { key: 'submitted', label: 'Submitted', done: true, at: f.createdAt },
    {
      key: 'review',
      label: 'Under Review',
      done: approved || Boolean(f.authorizedAt),
      at: f.fullyApprovedAt ?? f.authorizedAt,
    },
    ...(!accepted && f.authorizedPriceKobo !== null
      ? [
          {
            key: 'seller_price',
            label: 'Price Decision',
            done: false,
            at: f.authorizedAt,
          },
        ]
      : []),
    {
      key: 'approved',
      label: 'Approved',
      done: approved && accepted && f.sellerKycStatus === 'verified',
      at: f.fullyApprovedAt,
    },
    {
      key: 'live',
      label: 'Live',
      done: Boolean(f.publishedAt),
      at: f.publishedAt,
    },
  ];
  const first = steps.findIndex((s) => !s.done);
  const paused =
    f.status === 'withdrawn' ||
    f.status === 'rejected' ||
    f.availability === 'archived';
  return steps.map((s, i) => ({
    key: s.key,
    label: s.label,
    at: s.at,
    state: s.done
      ? 'completed'
      : paused
        ? 'paused'
        : s.key === 'seller_price'
          ? 'action_required'
          : i === first
            ? 'current'
            : 'pending',
  }));
}
/** Publication content and seller requirements cannot be overridden. */
export function approvePublishBlockers(f: HubFacts): string[] {
  const gaps: string[] = [
    ...publicationGaps({ ...f, openFraudFlags: 0, alreadyHasListing: false }),
  ];
  if (
    f.status === 'withdrawn' ||
    f.availability === 'archived' ||
    f.availability === 'sold'
  )
    gaps.push('item_paused');
  return gaps;
}
export function hubStatus(f: HubFacts): string {
  if (f.availability === 'sold') return 'Sold';
  if (f.availability === 'archived') return 'Removed';
  if (f.moderationStatus === 'suspended') return 'Listing paused';
  if (f.publishedAt)
    return (!f.availability ||
      ['available', 'reserved'].includes(f.availability)) &&
      (!f.moderationStatus || f.moderationStatus === 'approved')
      ? 'Live'
      : 'Listing paused';
  if (f.status === 'withdrawn') return 'Removed';
  if (f.status === 'rejected' || f.valueCheckStatus === 'rejected')
    return 'Not approved';
  if (f.pendingUpdate) return 'Changes under review';
  if (f.valueCheckStatus === 'seller_acceptance_pending')
    return 'Price decision required';
  if (f.valueCheckStatus === 'seller_declined') return 'Price declined';
  if (f.sellerKycStatus !== 'verified') return 'Verification required';
  if (f.status === 'details_pending') return 'Changes requested';
  if ((f.fullyApprovedAt || f.status === 'approved') && !hubBlockers(f).length)
    return 'Approved';
  if (!hubBlockers(f).length) return 'Under Review';
  return 'Under Review';
}
