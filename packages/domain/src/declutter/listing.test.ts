/**
 * Publication readiness, trust labels and public shape.
 *
 * The trust-label suite is the important half. Everything else here protects a
 * feature; those tests protect a promise made to a stranger who is about to
 * send money for something they cannot touch.
 */

import { describe, expect, it } from 'vitest';
import {
  canPublish,
  listingSlug,
  photoAlt,
  publicationGaps,
  TRUST_BADGE_LABELS,
  TRUST_BADGES,
  trustBadges,
  type PublicationCandidate,
  type TrustFacts,
} from './listing.js';

// ---------------------------------------------------------------------------

describe('listing slugs', () => {
  it('reads as the item, and carries the code so two of them cannot collide', () => {
    expect(listingSlug('iPhone 13 Pro 128GB', 'DCL-4K9P2M')).toBe(
      'iphone-13-pro-128gb-dcl-4k9p2m',
    );
  });

  it('gives two identical titles two different URLs', () => {
    const first = listingSlug('iPhone 13 Pro', 'DCL-AAAAAA');
    const second = listingSlug('iPhone 13 Pro', 'DCL-BBBBBB');
    expect(first).not.toBe(second);
  });

  it('transliterates rather than percent-encoding, so a pasted link stays readable', () => {
    // A shared link lands in WhatsApp far more often than in a browser bar.
    expect(listingSlug('Sofá à Réstaurer', 'DCL-1')).toBe('sofa-a-restaurer-dcl-1');
    expect(listingSlug('Chinedu’s Generator', 'DCL-2')).toBe('chinedu-s-generator-dcl-2');
  });

  it('survives a title made entirely of punctuation', () => {
    expect(listingSlug('!!! ??? 🙂', 'DCL-9Z8Y7X')).toBe('dcl-9z8y7x');
  });

  it('never ends in a stray hyphen after truncation', () => {
    const slug = listingSlug('A'.repeat(58) + ' something', 'DCL-1');
    expect(slug).not.toContain('--');
    expect(slug.startsWith('-')).toBe(false);
  });
});

// ---------------------------------------------------------------------------

const READY: PublicationCandidate = {
  sellerKycStatus: 'verified',
  valueCheckStatus: 'seller_accepted',
  authorizedPriceKobo: 4_500_000,
  authorizationVersion: 1,
  sellerAcceptedPriceKobo: 4_500_000,
  sellerAcceptedVersion: 1,
  categoryId: 'cat-1',
  locationId: 'loc-1',
  photoCount: 3,
  title: 'iPhone 13 Pro 128GB',
  description: 'Used for fourteen months. Screen is unmarked.',
  openFraudFlags: 0,
  alreadyHasListing: false,
};

describe('publication readiness', () => {
  it('lets a complete, accepted, verified submission through', () => {
    expect(publicationGaps(READY)).toEqual([]);
    expect(canPublish(READY)).toBe(true);
  });

  it('refuses a price the seller never accepted', () => {
    expect(publicationGaps({ ...READY, valueCheckStatus: 'admin_approved' })).toContain(
      'seller_has_not_accepted',
    );
  });

  it('refuses an acceptance that no longer matches the authorised price', () => {
    // The seller agreed to ₦45,000 and the price was later re-authorised
    // higher. Publishing would show the public a number the seller never saw.
    const gaps = publicationGaps({ ...READY, authorizedPriceKobo: 5_200_000 });
    expect(gaps).toContain('acceptance_stale');
  });

  it('refuses an acceptance against an older authorisation, even at the same figure', () => {
    // Same money, different decision. Re-authorisation is a fresh question.
    const gaps = publicationGaps({
      ...READY,
      authorizationVersion: 2,
      sellerAcceptedVersion: 1,
    });
    expect(gaps).toContain('acceptance_stale');
  });

  it('refuses an unverified seller', () => {
    expect(publicationGaps({ ...READY, sellerKycStatus: 'pending' })).toContain(
      'seller_not_verified',
    );
  });

  it('refuses a listing with no photograph', () => {
    expect(publicationGaps({ ...READY, photoCount: 0 })).toContain('no_photographs');
  });

  it('refuses while a fraud flag is open', () => {
    expect(publicationGaps({ ...READY, openFraudFlags: 1 })).toContain('open_fraud_flag');
  });

  it('refuses to publish the same submission twice', () => {
    expect(publicationGaps({ ...READY, alreadyHasListing: true })).toContain('already_published');
  });

  it('reports every gap at once rather than one refusal at a time', () => {
    const gaps = publicationGaps({
      ...READY,
      sellerKycStatus: 'pending',
      photoCount: 0,
      categoryId: null,
      description: '   ',
    });
    expect(gaps).toEqual(
      expect.arrayContaining([
        'seller_not_verified',
        'no_photographs',
        'no_category',
        'no_description',
      ]),
    );
  });

  it('treats whitespace as absent, not as content', () => {
    expect(publicationGaps({ ...READY, title: '   ' })).toContain('no_title');
  });
});

// ---------------------------------------------------------------------------
// Trust labels
// ---------------------------------------------------------------------------

const LAUNCH_FACTS: TrustFacts = {
  moderationApproved: true,
  sellerKycStatus: 'verified',
  sellerIsTrustedPartner: false,
  liveValuationAt: null,
  priceAuthorizedByHuman: true,
};

describe('trust labels tell the truth', () => {
  it('gives an approved listing from a verified seller the launch badges', () => {
    expect(trustBadges(LAUNCH_FACTS)).toEqual(['fixed_price', 'dash_reviewed', 'verified_listing']);
  });

  it('says Fixed Price on everything, because it is always true here', () => {
    expect(
      trustBadges({
        moderationApproved: false,
        sellerKycStatus: 'unverified',
        sellerIsTrustedPartner: false,
        liveValuationAt: null,
        priceAuthorizedByHuman: false,
      }),
    ).toEqual(['fixed_price']);
  });

  it('does not call a listing DASH Reviewed until a human approved it', () => {
    expect(trustBadges({ ...LAUNCH_FACTS, moderationApproved: false })).not.toContain(
      'dash_reviewed',
    );
  });

  it('does not call a listing Verified until the seller passed KYC', () => {
    for (const status of ['unverified', 'pending', 'rejected', 'suspended'] as const) {
      expect(trustBadges({ ...LAUNCH_FACTS, sellerKycStatus: status }), status).not.toContain(
        'verified_listing',
      );
    }
  });

  it('never says DASH ValueChecked at launch, whatever else is true', () => {
    // The load-bearing test of this milestone.
    //
    // The only valuation engine in the product is a deterministic local
    // adapter. `liveValuationAt` is the single fact that could turn this badge
    // on, and nothing in the system sets it. This asserts that no combination
    // of everything else does it by accident.
    const combinations: TrustFacts[] = [];
    for (const moderationApproved of [true, false]) {
      for (const sellerIsTrustedPartner of [true, false]) {
        for (const priceAuthorizedByHuman of [true, false]) {
          for (const sellerKycStatus of ['verified', 'pending'] as const) {
            combinations.push({
              moderationApproved,
              sellerKycStatus,
              sellerIsTrustedPartner,
              priceAuthorizedByHuman,
              liveValuationAt: null,
            });
          }
        }
      }
    }

    for (const facts of combinations) {
      expect(trustBadges(facts), JSON.stringify(facts)).not.toContain('value_checked');
    }
  });

  it('still refuses ValueChecked when a live run had no human authorisation', () => {
    expect(
      trustBadges({
        ...LAUNCH_FACTS,
        liveValuationAt: new Date('2026-09-11T10:00:00.000Z'),
        priceAuthorizedByHuman: false,
      }),
    ).not.toContain('value_checked');
  });

  it('allows ValueChecked only when a live run and a human decision both exist', () => {
    expect(
      trustBadges({
        ...LAUNCH_FACTS,
        liveValuationAt: new Date('2026-09-11T10:00:00.000Z'),
        priceAuthorizedByHuman: true,
      }),
    ).toContain('value_checked');
  });

  it('gives Trusted Partner only to a seller who holds the agreement', () => {
    expect(trustBadges({ ...LAUNCH_FACTS, sellerIsTrustedPartner: true })).toContain(
      'trusted_partner',
    );
    expect(trustBadges(LAUNCH_FACTS)).not.toContain('trusted_partner');
  });

  it('has a label for every badge and no label for anything else', () => {
    expect(Object.keys(TRUST_BADGE_LABELS).sort()).toEqual([...TRUST_BADGES].sort());
  });

  it('uses the launch wording David approved, exactly', () => {
    expect(TRUST_BADGE_LABELS.dash_reviewed).toBe('DASH Reviewed');
    expect(TRUST_BADGE_LABELS.verified_listing).toBe('Verified Listing');
    expect(TRUST_BADGE_LABELS.fixed_price).toBe('Fixed Price');
  });
});

// ---------------------------------------------------------------------------

describe('photo alt text', () => {
  it('prefers what the seller actually wrote', () => {
    expect(photoAlt('iPhone 13 Pro', 'front', 'Small scratch near the camera')).toBe(
      'Small scratch near the camera',
    );
  });

  it('describes the view when the seller wrote nothing', () => {
    expect(photoAlt('iPhone 13 Pro', 'screen', null)).toBe('iPhone 13 Pro, the screen');
    expect(photoAlt('iPhone 13 Pro', 'damage', '  ')).toBe(
      'iPhone 13 Pro, a mark or fault on the item',
    );
  });

  it('falls back to the title alone for an unlabelled view', () => {
    expect(photoAlt('iPhone 13 Pro', 'other', null)).toBe('iPhone 13 Pro');
  });
});
