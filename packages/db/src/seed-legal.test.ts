/**
 * What the published policies say, and what they must never say.
 *
 * These are the only user-facing legal words in the product, and the failure
 * mode is not a typo — it is a claim. A policy that promises escrow, guaranteed
 * authenticity, a certified vehicle or live AI valuation is the document
 * somebody quotes back on the day that promise fails, and the fact that no
 * engineer meant it that way will not matter.
 *
 * So the prohibitions below are asserted as bluntly as they are written. They
 * are not style rules; each one names a capability DASH does not have.
 *
 * No database. These read the constant the seeder writes, which is the same
 * text a person accepts.
 */

import { describe, expect, it } from 'vitest';
import {
  assertPublishable,
  PUBLISHED_LEGAL_DOCUMENTS,
  TERMS_SLUG,
  PRIVACY_SLUG,
} from './seed-legal.js';

function bodyOf(slug: string): string {
  const document = PUBLISHED_LEGAL_DOCUMENTS.find((candidate) => candidate.slug === slug);
  if (!document) throw new Error(`No document for ${slug}`);
  return document.body;
}

/**
 * Whitespace collapsed.
 *
 * The stored bodies are hard-wrapped for readability, so a sentence routinely
 * spans two lines. Matching the raw text would make these tests assert where
 * the line breaks fall rather than what the policy says, and every reflow would
 * look like a policy change.
 */
function flat(body: string): string {
  return body.replace(/\s+/g, ' ').trim();
}

const TERMS = flat(bodyOf(TERMS_SLUG));
const PRIVACY = flat(bodyOf(PRIVACY_SLUG));
const BOTH = `${TERMS} ${PRIVACY}`;

// ---------------------------------------------------------------------------

describe('claims the policies must never make', () => {
  it('never offers escrow or says DASH holds money', () => {
    // DASH takes no payment on Declutters at all. A buyer who read "escrow"
    // here would hand over money expecting a protection that does not exist.
    expect(TERMS).toContain('we do not provide escrow');
    expect(BOTH).not.toMatch(/we (hold|will hold) your (money|payment|funds)/i);
    expect(BOTH).not.toMatch(/payment protection|buyer protection|money.back guarantee/i);
  });

  it('never guarantees an item is authentic or free of defects', () => {
    expect(TERMS).toMatch(/do not guarantee that an item is authentic/i);
    expect(BOTH).not.toMatch(/guaranteed authentic|certified authentic|authenticity guarantee/i);
  });

  it('never certifies a vehicle', () => {
    // DASH does no mechanical inspection. Everything a car listing shows about
    // its condition is declared by the seller.
    expect(TERMS).toMatch(/do not carry out a mechanical inspection/i);
    expect(BOTH).not.toMatch(/certified (vehicle|car|mileage)|inspection guarantee|roadworthy/i);
  });

  it('never mentions AI valuation', () => {
    // ValueCheck runs on a deterministic local adapter and no listing has ever
    // been priced by a live model. The badge is dark for the same reason.
    expect(BOTH).not.toMatch(/valuecheck|artificial intelligence|\bAI\b|machine learning/i);
  });

  it('never claims the phone number is verified', () => {
    expect(BOTH).not.toMatch(/verified phone|phone number is verified|SMS code|text message code/i);
  });

  it('carries no engineering caveats', () => {
    // These are the words shown to the public. Whether they have been through
    // legal review is a business question tracked elsewhere, not a sentence for
    // a user to read.
    expect(BOTH).not.toMatch(/placeholder|not reviewed|lawyer|TODO|draft only/i);
  });

  it('never promises a response time DASH has not committed to', () => {
    expect(BOTH).not.toMatch(/within \d+ (hours|days|minutes)|same.day response/i);
  });
});

// ---------------------------------------------------------------------------

describe('what the terms must actually cover', () => {
  const required: [string, RegExp][] = [
    ['who operates it', /DASH World Limited/],
    ['one account across products', /same account you will use in the DASH app/i],
    ['18 or older', /18 or older/],
    ['email verification', /verify your email address by sending a code/i],
    ['phone unverified', /do not currently verify it/i],
    ['phone not used for recovery', /not use it to recover your account/i],
    ['fixed price', /Prices are set by DASH World and are fixed/i],
    ['no negotiation', /no negotiation/i],
    ['area only', /listed by area and state only/i],
    ['human moderation', /reviewed and approved by a DASH team member/i],
    ['contact request is not a purchase', /not a purchase/i],
    ['relay by default', /DASH World arranges the introduction/i],
    ['disclosure is irreversible', /cannot be unshared/i],
    ['signup grants nothing', /does not make you a seller/i],
    ['seller KYC', /verify your identity against government/i],
    ['seller cannot self-publish', /cannot publish a listing yourself/i],
    ['price acceptance', /publish only after you accept that exact price/i],
    ['trusted partner does not bypass review', /never removes the review and approval steps/i],
    ['no vehicle delivery', /does not deliver a vehicle/i],
    ['vehicle handover is direct', /directly between buyer and seller/i],
    ['photographs must be of the item', /actual item you are selling/i],
    ['ID documents not published', /are not published/i],
    ['suspension', /suspend or close an account/i],
    ['closing an account', /close your account at any time/i],
    ['versioning', /the version you accepted is recorded/i],
    ['contact route', /admin@dashworldng\.com/],
    ['whatsapp route', /\+234 911 249 6182/],
  ];

  for (const [topic, pattern] of required) {
    it(`covers ${topic}`, () => {
      expect(TERMS).toMatch(pattern);
    });
  }
});

// ---------------------------------------------------------------------------

describe('what the privacy policy must actually cover', () => {
  const required: [string, RegExp][] = [
    ['who is responsible', /DASH World Limited/],
    ['name, email, phone', /full name, email address and phone number/i],
    ['location', /state and the city, town or area/i],
    ['no street address', /do not ask for your street address/i],
    ['acquisition source', /how you heard about us/i],
    ['analytics affects nothing', /affects nothing about what you are allowed to do/i],
    ['age attestation not DOB', /do not ask for your date of birth/i],
    ['consent record', /date, time and IP address recorded when you accept/i],
    ['email verified', /verify.*email address, by sending a code/i],
    ['phone unverified', /do not currently verify your phone number/i],
    ['seller KYC evidence', /government identification documents/i],
    ['KYC access recorded', /every access to it is recorded/i],
    ['what a listing shows', /published listing shows the item/i],
    ['what a listing never shows', /never shows an address/i],
    ['identifiers withheld', /IMEI/],
    ['contact request record', /which item you asked about/i],
    ['disclosure record', /exactly what was shared, with whom, when/i],
    ['marketing optional', /never a condition of holding an account/i],
    ['marketing withdrawable', /withdraw it at any time/i],
    ['transactional mail is not marketing', /are not marketing/i],
    ['fraud detection', /same photograph has been used by a different account/i],
    ['sharing with providers', /email delivery and hosting/i],
    ['no selling of data', /do not sell your personal information/i],
    ['retention', /anonymised rather than deleted/i],
    ['rights', /ask for a copy of your information/i],
    ['code security', /stored only as a hash/i],
    ['contact route', /admin@dashworldng\.com/],
  ];

  for (const [topic, pattern] of required) {
    it(`covers ${topic}`, () => {
      expect(PRIVACY).toMatch(pattern);
    });
  }
});

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Dating
// ---------------------------------------------------------------------------

describe('a published version is never dated in the future', () => {
  it('is not future-dated today', () => {
    // The failure this catches is not cosmetic. A document dated ahead of today
    // is skipped by the selection rule, so the site serves the *previous* text
    // while signup records acceptance of the new one. Somebody reads one
    // document and is recorded as agreeing to another, and nothing fails.
    const now = new Date();
    for (const document of PUBLISHED_LEGAL_DOCUMENTS) {
      expect(document.effectiveFrom.getTime(), document.slug).toBeLessThanOrEqual(now.getTime());
    }
  });

  it('spells the effective date the same way in both places', () => {
    // The version string and the effective date are two spellings of one fact.
    // Letting them drift means "which version is current" and "which version is
    // effective" can disagree.
    for (const document of PUBLISHED_LEGAL_DOCUMENTS) {
      expect(document.effectiveFrom.toISOString(), document.slug).toBe(
        `${document.version}T00:00:00.000Z`,
      );
    }
  });

  it('refuses to seed a future-dated document', () => {
    expect(() =>
      assertPublishable(
        {
          slug: 'terms-of-service',
          version: '2099-01-01',
          effectiveFrom: new Date('2099-01-01T00:00:00.000Z'),
        },
        new Date('2026-09-10T12:00:00.000Z'),
      ),
    ).toThrow(/dated in the future/);
  });

  it('refuses to seed a version that disagrees with its effective date', () => {
    expect(() =>
      assertPublishable(
        {
          slug: 'privacy-policy',
          version: '2026-09-10',
          effectiveFrom: new Date('2026-09-12T00:00:00.000Z'),
        },
        new Date('2026-12-01T00:00:00.000Z'),
      ),
    ).toThrow(/does not match effectiveFrom/);
  });

  it('accepts a document published today', () => {
    expect(() =>
      assertPublishable(
        {
          slug: 'terms-of-service',
          version: '2026-09-10',
          effectiveFrom: new Date('2026-09-10T00:00:00.000Z'),
        },
        new Date('2026-09-10T09:00:00.000Z'),
      ),
    ).not.toThrow();
  });

  it('sorts later versions after earlier ones lexicographically', () => {
    // The selection rule orders by effectiveFrom then version, both descending,
    // so the version strings have to sort the way the dates do. ISO dates are
    // chosen precisely because they do; this pins it against somebody
    // "tidying" the format to 10-09-2026.
    const dates = ['2026-09-01', '2026-09-10', '2026-10-01', '2027-01-01'];
    expect([...dates].sort()).toEqual(dates);
    for (const document of PUBLISHED_LEGAL_DOCUMENTS) {
      expect(document.version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

describe('the documents themselves', () => {
  it('publishes exactly one current version of each', () => {
    expect(PUBLISHED_LEGAL_DOCUMENTS).toHaveLength(2);
    expect(PUBLISHED_LEGAL_DOCUMENTS.map((d) => d.slug).sort()).toEqual(
      [PRIVACY_SLUG, TERMS_SLUG].sort(),
    );
  });

  it('gives each one a version and an effective date', () => {
    for (const document of PUBLISHED_LEGAL_DOCUMENTS) {
      expect(document.version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(document.effectiveFrom).toBeInstanceOf(Date);
      expect(document.title).toContain('DASH World');
    }
  });

  it('is long enough to be a policy rather than a summary', () => {
    for (const document of PUBLISHED_LEGAL_DOCUMENTS) {
      expect(document.body.length).toBeGreaterThan(3000);
    }
  });
});
