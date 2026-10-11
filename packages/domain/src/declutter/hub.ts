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
  const legacyApproved = ['approved', 'published'].includes(f.status);
  const gaps: string[] = [
    ...publicationGaps({ ...f, alreadyHasListing: false }),
  ];
  if (!f.safetyReviewedAt && !legacyApproved)
    gaps.push('safety_review_required');
  if (!f.itemReviewedAt && !legacyApproved) gaps.push('item_review_required');
  if (!f.valuationAt && !legacyApproved) gaps.push('valuation_required');
  if (f.partnerApprovalRequired && !f.partnerApprovedAt)
    gaps.push('partner_approval_required');
  if (f.pendingUpdate) gaps.push('update_review_required');
  if (['rejected', 'withdrawn'].includes(f.status)) gaps.push('item_paused');
  return gaps;
}
export function hubProgress(f: HubFacts) {
  const legacy = ['approved', 'published'].includes(f.status);
  const accepted =
    f.valueCheckStatus === 'seller_accepted' &&
    f.sellerAcceptedVersion === f.authorizationVersion &&
    f.sellerAcceptedPriceKobo === f.authorizedPriceKobo;
  const steps = [
    { key: 'submitted', label: 'Submitted', done: true, at: f.createdAt },
    {
      key: 'verification',
      label: 'Seller verification',
      done: f.sellerKycStatus === 'verified',
      at: f.sellerVerifiedAt ?? null,
    },
    {
      key: 'safety',
      label: 'Fraud / safety review',
      done: f.openFraudFlags === 0 && Boolean(f.safetyReviewedAt || legacy),
      at: f.safetyReviewedAt,
    },
    {
      key: 'review',
      label: 'Item review',
      done: Boolean(f.itemReviewedAt || legacy),
      at: f.itemReviewedAt,
    },
    {
      key: 'valuecheck',
      label: 'ValueCheck',
      done: Boolean(f.valuationAt || legacy),
      at: f.valuationAt,
    },
    {
      key: 'dash_price',
      label: 'DASH price decision',
      done: Boolean(f.authorizedPriceKobo && f.authorizedAt),
      at: f.authorizedAt,
    },
    {
      key: 'seller_price',
      label: 'Seller price decision',
      done: accepted,
      at: f.sellerAcceptedAt,
    },
    {
      key: 'approved',
      label: 'Fully approved',
      done: Boolean(
        (f.fullyApprovedAt || legacy) &&
          (f.publishedAt || hubBlockers(f).length === 0),
      ),
      at: f.fullyApprovedAt,
    },
    {
      key: 'live',
      label: 'Published / Live',
      done: Boolean(f.publishedAt),
      at: f.publishedAt,
    },
  ];
  const first = steps.findIndex((s) => !s.done);
  return steps.map((s, i) => ({
    key: s.key,
    label: s.label,
    at: s.at,
    state: s.done
      ? 'completed'
      : (s.key === 'seller_price' &&
            f.valueCheckStatus === 'seller_acceptance_pending') ||
          (s.key === 'verification' && f.sellerKycStatus !== 'pending')
        ? 'action_required'
        : s.key === 'safety' && f.openFraudFlags > 0
          ? 'paused'
          : i === first
            ? 'current'
            : 'pending',
  }));
}
export function hubStatus(f: HubFacts): string {
  if (f.availability === 'sold') return 'Sold';
  if (f.availability === 'archived') return 'Archived';
  if (f.moderationStatus === 'suspended') return 'Listing paused';
  if (f.publishedAt) return 'Live';
  if (f.status === 'withdrawn') return 'Withdrawn';
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
  if (!hubBlockers(f).length) return 'Ready for final approval';
  return 'Under review';
}
