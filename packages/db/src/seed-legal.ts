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
 * ## What the bodies say, and what they must never say
 *
 * They describe the product that exists. Every claim in them maps to something
 * the system actually does: the email is verified and the phone is not, prices
 * are fixed and set by DASH, a human approves every listing, identification
 * documents are private, contact details are relayed rather than published, and
 * a vehicle is neither delivered nor inspected by DASH.
 *
 * Just as importantly they claim nothing the product does not do. There is no
 * escrow, no guarantee of authenticity or condition, no promise about a
 * vehicle, and no mention of AI valuation — DASH ValueCheck runs on a
 * deterministic local adapter and no listing has ever been priced by a live
 * model. A policy that overstates the product is worse than no policy, because
 * it is the document somebody quotes back when the overstatement fails.
 *
 * These are the words shown to the public, so they contain no engineering
 * caveats. Whether they have been through legal review is a business question
 * tracked outside this repository, not a sentence for a user to read.
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
 *
 * **The date is the day the text was actually published, in UTC, and never a
 * future one.** UTC matters: Nigeria is an hour ahead, so for one hour each
 * evening a date that reads as "today" in Lagos is still tomorrow to a server,
 * and a document stamped that way is not yet effective. Dating from the UTC day
 * is never wrong; dating from the local one is wrong for an hour a day. A version dated ahead of today is not yet effective, so the selection
 * rule skips it and serves the previous text — while signup, which looked the
 * version up by name, recorded acceptance of the newer one. A person then read
 * one document and was recorded as having agreed to another. That happened
 * here, and `assertPublishable` below now makes it impossible rather than
 * merely discouraged.
 */
export const CURRENT_TERMS_VERSION = '2026-09-09';
export const CURRENT_PRIVACY_VERSION = '2026-09-09';

/**
 * The current published versions.
 *
 * Exported so the words themselves can be asserted without a database: these
 * are the only user-facing legal sentences in the product, and what they must
 * never claim matters more than that they parse.
 */
export const PUBLISHED_LEGAL_DOCUMENTS = [
  {
    slug: TERMS_SLUG,
    version: CURRENT_TERMS_VERSION,
    title: 'DASH World Terms of Service',
    effectiveFrom: new Date('2026-09-09T00:00:00.000Z'),
    body: [
      'Terms of Service',
      '',
      'DASH World Limited ("DASH World", "we") operates DASH World Declutters, a',
      'curated marketplace for second-hand items in Nigeria. These terms apply to your',
      'DASH account and to your use of the Declutters marketplace.',
      '',
      '1. YOUR DASH ACCOUNT',
      '',
      '1.1 One account identifies you across DASH World products. The account you',
      '    create on the Declutters website is the same account you will use in the',
      '    DASH app.',
      '',
      '1.2 You must be 18 or older to hold an account, and you confirm this when you',
      '    create one.',
      '',
      '1.3 We verify your email address by sending a code to it. Codes are personal to',
      '    you and must not be shared. Anyone holding a valid code can reach your',
      '    account, so treat one as you would a password.',
      '',
      '1.4 We ask for a phone number and we do not currently verify it. It is how a',
      '    DASH team member reaches you about an item. Because it is unverified, we do',
      '    not use it to recover your account, to link accounts, or as proof of who you',
      '    are.',
      '',
      '1.5 You are responsible for keeping your email account secure and for activity',
      '    carried out through your DASH account.',
      '',
      '2. HOW THE MARKETPLACE WORKS',
      '',
      '2.1 Prices are set by DASH World and are fixed. There is no negotiation, no',
      '    offers and no bidding. The price shown is the price.',
      '',
      '2.2 Items are listed by area and state only. We never publish an address or a',
      '    precise location.',
      '',
      '2.3 Every listing is reviewed and approved by a DASH team member before it goes',
      '    live. Approval means we have reviewed the item, the seller\'s description and',
      '    the price against market evidence.',
      '',
      '2.4 "DASH Reviewed", "Verified Listing" and "Fixed Price" describe exactly the',
      '    checks named in these terms and nothing further.',
      '',
      '2.5 We do not guarantee that an item is authentic, free of defects, or fit for',
      '    a particular purpose. We are not a party to the sale, we do not hold your',
      '    money, and we do not provide escrow. Inspect anything before you pay for it.',
      '',
      '3. ASKING TO BE PUT IN TOUCH',
      '',
      '3.1 To enquire about an item you send a contact request. This is a question for',
      '    a DASH team member to review. It is not a purchase, it does not reserve the',
      '    item, and it does not commit anyone to anything.',
      '',
      '3.2 By default DASH World arranges the introduction and no personal contact',
      '    detail is passed between you and the other person. Where a direct',
      '    introduction is more practical, we only share a contact detail with the',
      '    consent of the person it belongs to.',
      '',
      '3.3 Once a contact detail has been shared with someone, it cannot be unshared.',
      '    We can stop relaying messages and we can withdraw access to the platform,',
      '    but we cannot recall information a person already has.',
      '',
      '4. SELLING',
      '',
      '4.1 Creating an account does not make you a seller. What you selected when you',
      '    signed up describes how you plan to use DASH; it grants nothing.',
      '',
      '4.2 To sell, you apply and we verify your identity against government',
      '    identification. A DASH team member reviews that evidence and decides. We may',
      '    decline, and we may ask for more.',
      '',
      '4.3 You may not list an item you do not own or are not entitled to sell.',
      '',
      '4.4 You describe the item honestly, including faults. Photographs must be of the',
      '    actual item you are selling.',
      '',
      '4.5 You cannot publish a listing yourself. We value the item, put one fixed',
      '    price to you, and publish only after you accept that exact price. If the',
      '    price changes, we ask you again.',
      '',
      '4.6 We may decline, edit, suspend or remove a listing at any time, including',
      '    after publication.',
      '',
      '4.7 "Trusted Partner" describes a seller with a standing agreement with DASH',
      '    World. It never removes the review and approval steps in these terms.',
      '',
      '5. CARS AND VEHICLES',
      '',
      '5.1 Vehicles are listed on the marketplace only. DASH World does not deliver a',
      '    vehicle, does not transport one, and does not arrange transport.',
      '',
      '5.2 We do not carry out a mechanical inspection and we do not certify a',
      '    vehicle\'s condition, mileage, accident history or service history. What a',
      '    listing shows about a vehicle is declared by the seller.',
      '',
      '5.3 You are responsible for inspecting the vehicle, arranging any independent',
      '    mechanical inspection you want, satisfying yourself about ownership and',
      '    documentation, and completing any legal transfer of title.',
      '',
      '5.4 Handover happens directly between buyer and seller, at a place and time you',
      '    agree. DASH World is not present and is not a party to it.',
      '',
      '6. PHOTOGRAPHS AND DOCUMENTS',
      '',
      '6.1 Photographs you supply of an item may be published on a listing. You confirm',
      '    they are yours to supply and that they show the actual item.',
      '',
      '6.2 Identification documents you supply for seller verification are not',
      '    published. They are held privately, are visible only to authorised DASH',
      '    staff, and every access to them is recorded.',
      '',
      '7. SUSPENSION AND ENDING YOUR ACCOUNT',
      '',
      '7.1 We may suspend or close an account, or withdraw selling privileges, where',
      '    these terms are breached, where we reasonably suspect fraud or',
      '    misrepresentation, or where we are required to.',
      '',
      '7.2 You may close your account at any time. Some records are kept, or kept in',
      '    anonymised form, where financial, legal or safety obligations require it.',
      '    The Privacy Policy explains this.',
      '',
      '8. CHANGES',
      '',
      '8.1 We may publish new terms. Each version is kept, and the version you accepted',
      '    is recorded against your account.',
      '',
      '9. CONTACT',
      '',
      'Questions, complaints and anything that needs a person:',
      'admin@dashworldng.com, or the DASH World Declutters WhatsApp line on',
      '+234 911 249 6182.',
      '',
      'DASH World Limited, Lagos and Asaba, Nigeria.',
    ].join('\n'),
  },
  {
    slug: PRIVACY_SLUG,
    version: CURRENT_PRIVACY_VERSION,
    title: 'DASH World Privacy Policy',
    effectiveFrom: new Date('2026-09-09T00:00:00.000Z'),
    body: [
      'Privacy Policy',
      '',
      'DASH World Limited ("DASH World", "we") is responsible for the personal',
      'information described here. This policy covers your DASH account and the DASH',
      'World Declutters marketplace.',
      '',
      '1. WHAT WE COLLECT WHEN YOU CREATE AN ACCOUNT',
      '',
      '1.1 Your full name, email address and phone number.',
      '',
      '1.2 The state and the city, town or area you are in. We do not ask for your',
      '    street address.',
      '',
      '1.3 How you plan to use DASH, and how you heard about us. If you tell us',
      '    somebody referred you, we record who. We use this to understand who the',
      '    marketplace serves and which of our efforts reach people. It affects nothing',
      '    about what you are allowed to do.',
      '',
      '1.4 Your confirmation that you are 18 or older, with the date and time you',
      '    confirmed it. We do not ask for your date of birth.',
      '',
      '1.5 The date, time and IP address recorded when you accept these policies.',
      '',
      '2. WHAT WE VERIFY',
      '',
      '2.1 Your email address, by sending a code to it. Until you enter that code your',
      '    account is not active.',
      '',
      '2.2 We do not currently verify your phone number. Because it is unverified we do',
      '    not use it to recover your account, to link one account to another, or to',
      '    decide who you are.',
      '',
      '3. IF YOU APPLY TO SELL',
      '',
      '3.1 We collect your legal name, your identification number and government',
      '    identification documents.',
      '',
      '3.2 That evidence is stored separately from your public profile, is visible only',
      '    to authorised DASH staff, and every access to it is recorded. It is never',
      '    published and never shown to a buyer.',
      '',
      '3.3 We may keep a decision and the evidence behind it after an application, so',
      '    the decision can be explained or reviewed.',
      '',
      '4. ITEMS YOU LIST',
      '',
      '4.1 A published listing shows the item, its price, its condition, its category',
      '    and the area and state it is in, along with the photographs supplied and a',
      '    display name.',
      '',
      '4.2 A listing never shows an address, a coordinate, a distance, a phone number',
      '    or an email address.',
      '',
      '4.3 Some details are collected so we can check an item and are never published.',
      '    Serial numbers, IMEI numbers, and a vehicle\'s chassis, engine or plate',
      '    number are examples: they exist so we can check an item is what a seller',
      '    says it is, and publishing one would help somebody misuse it.',
      '',
      '5. WHEN YOU ASK TO BE PUT IN TOUCH',
      '',
      '5.1 We record which item you asked about, when, and anything you wrote.',
      '',
      '5.2 By default nothing about you reaches the other person and nothing about them',
      '    reaches you; DASH World relays.',
      '',
      '5.3 If a direct introduction is made, we record exactly what was shared, with',
      '    whom, when, on whose authority, and the consent it relied on.',
      '',
      '6. MARKETING',
      '',
      '6.1 Only if you ask for it. It is a separate choice and it is never a condition',
      '    of holding an account.',
      '',
      '6.2 You can withdraw it at any time, and your account is unaffected.',
      '',
      '6.3 Emails about your account, your items and your enquiries are not marketing',
      '    and are sent whichever choice you made.',
      '',
      '7. HOW WE USE INFORMATION',
      '',
      '7.1 To operate your account, review items, set prices, arrange introductions and',
      '    answer you.',
      '',
      '7.2 To detect and investigate fraud, including checking whether the same',
      '    photograph has been used by a different account.',
      '',
      '7.3 To understand how the marketplace is used, in aggregate.',
      '',
      '7.4 To meet legal and regulatory obligations.',
      '',
      '8. WHO WE SHARE IT WITH',
      '',
      '8.1 Service providers who operate parts of the platform for us, including email',
      '    delivery and hosting. They act on our instructions.',
      '',
      '8.2 Another person, only as described in section 5.',
      '',
      '8.3 Authorities, where the law requires it.',
      '',
      '8.4 We do not sell your personal information.',
      '',
      '9. HOW LONG WE KEEP IT',
      '',
      '9.1 For as long as your account is open, and afterwards where an obligation',
      '    requires it.',
      '',
      '9.2 Some records are anonymised rather than deleted, because deleting them would',
      '    corrupt financial or safety records that must remain accurate.',
      '',
      '10. YOUR CHOICES',
      '',
      '10.1 You can ask for a copy of your information, ask us to correct it, withdraw',
      '     marketing consent, or ask us to close your account.',
      '',
      '10.2 To do any of these, contact us using section 12.',
      '',
      '11. SECURITY',
      '',
      '11.1 Verification codes are stored only as a hash, expire, can be used once and',
      '     stop working after a small number of wrong attempts.',
      '',
      '11.2 Identification documents are stored privately and are reachable only',
      '     through short-lived, recorded links.',
      '',
      '11.3 No system is perfectly secure. Keep your email account secure, and tell us',
      '     promptly if you think somebody else has reached your DASH account.',
      '',
      '12. CONTACT',
      '',
      'admin@dashworldng.com, or the DASH World Declutters WhatsApp line on',
      '+234 911 249 6182.',
      '',
      'DASH World Limited, Lagos and Asaba, Nigeria.',
    ].join('\n'),
  },
];

/**
 * Refuse to publish a document that cannot be served.
 *
 * Two invariants, both learned the hard way:
 *
 *   * **The version string is the effective date.** They are two spellings of
 *     one fact, and letting them drift means "which version is current" and
 *     "which version is effective" can disagree.
 *   * **Neither is in the future.** A document dated ahead of today is skipped
 *     by the selection rule, so the site serves the previous text while signup
 *     records acceptance of the new one. Somebody reads one document and is
 *     recorded as agreeing to another, and nothing fails loudly enough to
 *     notice.
 *
 * Throwing here is deliberate. A seed that silently writes an unservable
 * document is a seed that has published nothing while appearing to succeed.
 */
export function assertPublishable(
  document: { slug: string; version: string; effectiveFrom: Date },
  now: Date,
): void {
  const dateOfVersion = `${document.version}T00:00:00.000Z`;

  if (document.effectiveFrom.toISOString() !== dateOfVersion) {
    throw new Error(
      `${document.slug}: version "${document.version}" does not match effectiveFrom ` +
        `${document.effectiveFrom.toISOString()}. The version string is the effective date.`,
    );
  }

  if (document.effectiveFrom.getTime() > now.getTime()) {
    throw new Error(
      `${document.slug}: version "${document.version}" is dated in the future. ` +
        'It would not be served, while signup recorded acceptance of it.',
    );
  }
}

export async function seedLegalDocuments(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<LegalSeedResult> {
  for (const document of PUBLISHED_LEGAL_DOCUMENTS) {
    assertPublishable(document, now);
  }

  for (const document of PUBLISHED_LEGAL_DOCUMENTS) {
    await prisma.legalDocument.upsert({
      where: { slug_version: { slug: document.slug, version: document.version } },
      create: document,
      // Deliberately narrow, and deliberately not the body. A published version
      // is evidence; only the display title may be corrected in place.
      update: { title: document.title },
    });
  }

  return { documents: PUBLISHED_LEGAL_DOCUMENTS.length };
}
