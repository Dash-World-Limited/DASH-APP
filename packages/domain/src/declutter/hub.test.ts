import { expect, it } from 'vitest';
import { hubBlockers, hubProgress, hubStatus, type HubFacts } from './hub.js';
const at = new Date('2026-10-11T09:00:00Z');
const ready: HubFacts = {
  status: 'pricing_review',
  sellerKycStatus: 'verified',
  valueCheckStatus: 'seller_accepted',
  authorizedPriceKobo: 1_000_000,
  authorizationVersion: 1,
  sellerAcceptedPriceKobo: 1_000_000,
  sellerAcceptedVersion: 1,
  categoryId: 'category',
  locationId: 'location',
  photoCount: 1,
  title: 'Chair',
  description: 'A real chair.',
  openFraudFlags: 0,
  alreadyHasListing: false,
  safetyReviewedAt: at,
  itemReviewedAt: at,
  fullyApprovedAt: null,
  valuationAt: at,
  createdAt: at,
  authorizedAt: at,
  sellerAcceptedAt: at,
  publishedAt: null,
  partnerApprovalRequired: false,
  partnerApprovedAt: null,
  pendingUpdate: false,
};
it('derives progress from recorded facts and keeps approval/publication pending until performed', () => {
  expect(hubBlockers(ready)).toEqual([]);
  expect(hubStatus(ready)).toBe('Ready for final approval');
  const stages = hubProgress(ready);
  expect(stages.filter((s) => s.state === 'completed')).toHaveLength(7);
  expect(stages[7]!.state).toBe('current');
  expect(stages[8]!.state).toBe('pending');
});
it('shows completed consent without a second price action', () => {
  expect(hubProgress(ready).find((s) => s.key === 'seller_price')?.state).toBe(
    'completed',
  );
});
it('shows a changed price as a real seller action and rejects stale acceptance', () => {
  const f = {
    ...ready,
    valueCheckStatus: 'seller_acceptance_pending',
    authorizedPriceKobo: 900_000,
  };
  expect(hubStatus(f)).toBe('Price decision required');
  expect(hubProgress(f).find((s) => s.key === 'seller_price')?.state).toBe(
    'action_required',
  );
  expect(hubBlockers({ ...f, valueCheckStatus: 'seller_accepted' })).toContain(
    'acceptance_stale',
  );
});
it.each([
  { sellerKycStatus: 'pending' as const },
  { safetyReviewedAt: null },
  { itemReviewedAt: null },
  { valuationAt: null },
  { openFraudFlags: 1 },
  { pendingUpdate: true },
  { partnerApprovalRequired: true },
  { photoCount: 0 },
])('keeps mandatory blockers visible: %j', (patch) => {
  expect(hubBlockers({ ...ready, ...patch }).length).toBeGreaterThan(0);
});
it('keeps Live, Sold and paused listing states human-readable', () => {
  expect(hubStatus({ ...ready, publishedAt: at, status: 'published' })).toBe(
    'Live',
  );
  expect(hubStatus({ ...ready, availability: 'sold' })).toBe('Sold');
  expect(hubStatus({ ...ready, moderationStatus: 'suspended' })).toBe(
    'Listing paused',
  );
});
