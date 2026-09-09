/**
 * The legal documents a person accepts when they create a DASH account.
 *
 * Reference data, not demo data, and upserted on its natural key — `slug` plus
 * `version` — for the same reason the Declutters taxonomy is. A
 * `LegalAcceptance` holds a foreign key to the document row it points at, and
 * that record is the *evidence*: it answers "which text, in which version, did
 * this person agree to, and when". Deleting and recreating the document would
 * either fail against real acceptances or, worse, succeed against an empty
 * development database and teach a habit that destroys evidence in production.
 *
 * **A version is never edited in place.** Changing the terms means adding a row
 * with a new version string, because every acceptance already pointing at the
 * old row is a claim about the old text. Editing the body under an existing
 * version would silently rewrite what thousands of people are recorded as
 * having agreed to, which is the one thing this table exists to prevent.
 *
 * ## The bodies below are placeholders
 *
 * They are a truthful plain-language summary of how the product actually
 * behaves, and they are **not drafted or reviewed by a Nigerian lawyer**. They
 * exist so the acceptance mechanism is real and testable before launch. The
 * real text replaces them as a new version, which is exactly the operation this
 * structure is built for.
 */

import type { PrismaClient } from '@prisma/client';

export interface LegalSeedResult {
  documents: number;
}

/**
 * The slugs the signup flow records acceptance of.
 *
 * Two, because they are two different agreements: one is the contract, the
 * other is what happens to somebody's data. Bundling them into a single
 * "legal" document would make it impossible to say which a person accepted
 * when only one of them changes.
 */
export const TERMS_SLUG = 'terms-of-service';
export const PRIVACY_SLUG = 'privacy-policy';

/**
 * The versions signup currently records.
 *
 * Dated rather than numbered, so "which terms did they accept" is answerable
 * without a lookup table. Bumping these is how new terms are published.
 */
export const CURRENT_TERMS_VERSION = '2026-09-01';
export const CURRENT_PRIVACY_VERSION = '2026-09-01';

const DOCUMENTS = [
  {
    slug: TERMS_SLUG,
    version: CURRENT_TERMS_VERSION,
    title: 'DASH World Terms of Service',
    effectiveFrom: new Date('2026-09-01T00:00:00.000Z'),
    body: [
      'PLACEHOLDER — not reviewed by qualified Nigerian counsel.',
      '',
      'These terms describe how DASH World Limited operates the DASH account and',
      'the DASH World Declutters marketplace.',
      '',
      '1. Your account. One DASH account identifies you across DASH World',
      '   products. You are responsible for the codes sent to your email address',
      '   and must not share them. You must be 18 or older to hold an account.',
      '',
      '2. Buying. Prices on Declutters are set by DASH and are fixed. There is no',
      '   negotiation. Asking to be put in touch with a seller creates a request',
      '   that a DASH team member reviews; it is not a purchase and it does not',
      '   reserve an item.',
      '',
      '3. Selling. Listing an item requires identity verification and approval by',
      '   DASH. Creating an account does not make you a seller, whatever you',
      '   selected when you signed up.',
      '',
      '4. Introductions. DASH arranges contact between buyers and sellers. Your',
      '   contact details are not published. Where a direct introduction is made,',
      '   it happens only with the consent of the person whose details are shared.',
      '',
      '5. Ending your account. You may close your account at any time. Records',
      '   that other obligations depend on are retained as described in the',
      '   Privacy Policy.',
    ].join('\n'),
  },
  {
    slug: PRIVACY_SLUG,
    version: CURRENT_PRIVACY_VERSION,
    title: 'DASH World Privacy Policy',
    effectiveFrom: new Date('2026-09-01T00:00:00.000Z'),
    body: [
      'PLACEHOLDER — not reviewed by qualified Nigerian counsel.',
      '',
      'This describes what DASH World Limited collects and what it does with it.',
      '',
      '1. What we collect at signup. Your name, email address, phone number, the',
      '   state and area you are in, how you plan to use DASH and how you heard',
      '   about us. We do not collect your date of birth; we ask you to confirm',
      '   you are 18 or older.',
      '',
      '2. What we verify. Your email address, by sending a code to it. We do not',
      '   currently verify your phone number, and we do not use it to recover or',
      '   link accounts.',
      '',
      '3. What is public. A listing shows the item, its price, its condition and',
      '   the area it is in. It never shows an address, a coordinate, a phone',
      '   number or an email address.',
      '',
      '4. Selling. If you apply to sell, we collect government identity evidence.',
      '   That evidence is held separately from your public profile, is visible',
      '   only to authorised staff, and every access to it is recorded.',
      '',
      '5. Marketing. Only if you ask for it. You can withdraw at any time, and',
      '   your account is unaffected either way.',
      '',
      '6. Retention and deletion. You can request deletion of your account. Some',
      '   records are anonymised rather than deleted where financial or legal',
      '   obligations require them to survive.',
    ].join('\n'),
  },
];

export async function seedLegalDocuments(prisma: PrismaClient): Promise<LegalSeedResult> {
  for (const document of DOCUMENTS) {
    await prisma.legalDocument.upsert({
      where: { slug_version: { slug: document.slug, version: document.version } },
      create: document,
      // Deliberately narrow, and deliberately not the body. A published version
      // is evidence; only the display title may be corrected in place.
      update: { title: document.title },
    });
  }

  return { documents: DOCUMENTS.length };
}
