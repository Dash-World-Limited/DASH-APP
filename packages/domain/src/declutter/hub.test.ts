import { expect, it } from 'vitest';
import {
  approvePublishBlockers,
  hubBlockers,
  hubProgress,
  hubStatus,
  type HubFacts,
} from './hub.js';
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
  expect(hubStatus(ready)).toBe('Under Review');
  const stages = hubProgress(ready);
  expect(stages.filter((s) => s.state === 'completed')).toHaveLength(2);
  expect(stages[2]!.state).toBe('current');
  expect(stages[3]!.state).toBe('pending');
});
it('shows completed consent without a second price action', () => {
  expect(hubProgress(ready).some((s) => s.key === 'seller_price')).toBe(false);
  expect(hubProgress(ready).map((s) => s.label)).toEqual([
    'Submitted',
    'Under Review',
    'Approved',
    'Live',
  ]);
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

it('consolidates uncompleted internal reviews into one Under Review milestone', () => {
  const f = {
    ...ready,
    authorizedPriceKobo: null,
    authorizedAt: null,
    valueCheckStatus: 'not_requested',
    safetyReviewedAt: null,
    itemReviewedAt: null,
    valuationAt: null,
    partnerApprovalRequired: true,
    openFraudFlags: 2,
  };
  expect(hubProgress(f).map((s) => [s.label, s.state])).toEqual([
    ['Submitted', 'completed'],
    ['Under Review', 'current'],
    ['Approved', 'pending'],
    ['Live', 'pending'],
  ]);
});
it('allows explicit final authority over internal checks without waiving seller or content requirements', () => {
  const f = {
    ...ready,
    safetyReviewedAt: null,
    itemReviewedAt: null,
    valuationAt: null,
    partnerApprovalRequired: true,
    openFraudFlags: 4,
    pendingUpdate: true,
  };
  expect(approvePublishBlockers(f)).toEqual([]);
  expect(
    approvePublishBlockers({ ...f, sellerKycStatus: 'pending' }),
  ).toContain('seller_not_verified');
  expect(
    approvePublishBlockers({
      ...f,
      valueCheckStatus: 'seller_acceptance_pending',
    }),
  ).toContain('seller_has_not_accepted');
  expect(approvePublishBlockers({ ...f, sellerAcceptedVersion: 0 })).toContain(
    'acceptance_stale',
  );
  expect(approvePublishBlockers({ ...f, photoCount: 0 })).toContain(
    'no_photographs',
  );
});
it.each(['archived', 'sold'])(
  'never republishes %s listings',
  (availability) => {
    expect(approvePublishBlockers({ ...ready, availability })).toContain(
      'item_paused',
    );
  },
);
it('keeps removed history paused and distinguishes removed items from sold items', () => {
  const f = { ...ready, status: 'withdrawn' };
  expect(hubStatus(f)).toBe('Removed');
  expect(hubProgress(f).find((s) => s.key === 'live')?.state).toBe('paused');
  expect(hubStatus({ ...f, availability: 'sold' })).toBe('Sold');
});
