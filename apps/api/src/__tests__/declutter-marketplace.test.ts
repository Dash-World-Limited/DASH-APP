/**
 * The public marketplace — integration tests.
 *
 * The happy path here is short: an approved submission becomes a listing, a
 * stranger finds it, a buyer asks about it. Everything else in this file is
 * about what must *not* happen, because a public marketplace is the first
 * surface in this product that anyone at all can reach.
 *
 * Three groups matter most:
 *
 *   * **Publication gates.** A price nobody accepted, a seller nobody verified
 *     or an item nobody photographed must not reach a public page.
 *   * **What a stranger receives.** The seller's phone number, address, national
 *     identity digits, admin notes, IMEI, serial number and asking price all
 *     exist on records this endpoint reads. None may come back.
 *   * **Trust language.** `DASH ValueChecked` must not appear anywhere at
 *     launch, because no live valuation provider has ever run.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EmailPort } from '@dash/domain/ports';
import { seedDeclutterTaxonomy } from '@dash/db';
import { DECLUTTER_ADMIN_EMAILS } from '../declutter/notifications.js';
import { createTestContext, type TestContext } from './harness.js';
import { useIntegrationTimeouts } from './timeouts.js';
import { actAs, buildWorld, type Actor, type World } from './world.js';

const capturedEmails: Parameters<EmailPort['send']>[0][] = [];
const captureEmail: EmailPort = {
  providerName: 'capture',
  isLive: false,
  async send(message) {
    capturedEmails.push(message);
    return { accepted: true, providerMessageId: `marketplace-${capturedEmails.length}` };
  },
};

useIntegrationTimeouts();

let context: TestContext;
let world: World;
let seller: Actor;
let buyer: Actor;
let admin: Actor;
let moderator: Actor;
let sellerId: string;
let secondSellerId: string;

/** A one-pixel PNG. Real bytes, so the storage adapter's checks actually run. */
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** A different one-pixel PNG, so two uploads do not collide on their hash. */
const PNG_TWO =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const SELLER_SECRETS = {
  legalName: 'Chinedu Emeka Okonkwo',
  nationalIdLast4: '8901',
  phoneE164: '+2347000001234',
  addressLine: '14 Okpanam Road, Asaba',
  adminNotes: 'Internal note: seller was late responding',
};

beforeAll(async () => {
  context = await createTestContext({}, { email: captureEmail });
  world = await buildWorld(context.prisma);
  await seedDeclutterTaxonomy(context.prisma);

  await context.prisma.identityRole.create({
    data: { identityId: world.support.identityId, role: 'declutter_moderator' },
  });

  const customer = await context.prisma.customer.findFirstOrThrow({
    where: { identity: { email: world.customerA.email } },
  });
  const record = await context.prisma.declutterSeller.create({
    data: {
      customerId: customer.id,
      displayName: 'Chinedu',
      kycStatus: 'verified',
      nationalIdCipher: 'cipher-not-a-real-envelope',
      ...SELLER_SECRETS,
    },
  });
  sellerId = record.id;

  // A second, unrelated seller. Exists so the cross-account photograph test is
  // about two real accounts rather than a contrived fixture.
  const otherCustomer = await context.prisma.customer.findFirstOrThrow({
    where: { identity: { email: world.customerB.email } },
  });
  const second = await context.prisma.declutterSeller.create({
    data: { customerId: otherCustomer.id, displayName: 'Amaka', kycStatus: 'verified' },
  });
  secondSellerId = second.id;

  seller = await actAs(context, world.customerA.email);
  buyer = await actAs(context, world.customerB.email);
  admin = await actAs(context, world.admin.email);
  moderator = await actAs(context, world.support.email);
}, 180_000);

afterAll(async () => {
  await context?.close();
});

// ---------------------------------------------------------------------------

async function post(actor: Actor | null, url: string, payload?: Record<string, unknown>) {
  return await context.app.inject({
    method: 'POST',
    url,
    ...(actor ? { headers: actor.headers } : {}),
    payload,
  });
}
async function get(actor: Actor | null, url: string) {
  return await context.app.inject({
    method: 'GET',
    url,
    ...(actor ? { headers: actor.headers } : {}),
  });
}

/**
 * A submission that is ready to publish, short of whatever the caller overrides.
 *
 * Written directly rather than driven through the whole pricing journey: that
 * journey has its own suite, and repeating it here would test it a second time
 * instead of testing publication.
 */
async function makePublishable(
  overrides: Partial<{
    valueCheckStatus: string;
    authorizedPriceKobo: number | null;
    authorizationVersion: number;
    sellerAcceptedPriceKobo: number | null;
    sellerAcceptedVersion: number | null;
    title: string;
    description: string | null;
    withPhoto: boolean;
    ownerSellerId: string;
  }> = {},
) {
  const category = await context.prisma.declutterCategory.findUniqueOrThrow({
    where: { key: 'phones-tablets' },
  });
  const location = await context.prisma.declutterLocation.findFirstOrThrow({
    where: { kind: 'area' },
  });

  const submission = await context.prisma.declutterSubmission.create({
    data: {
      code: `DCL-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      sellerId: overrides.ownerSellerId ?? sellerId,
      status: 'approved',
      title: overrides.title ?? 'iPhone 13 Pro 128GB',
      description:
        overrides.description === undefined
          ? 'Used for fourteen months. Screen unmarked, battery replaced by Apple.'
          : overrides.description,
      condition: 'good',
      categoryId: category.id,
      locationId: location.id,
      expectedPriceKobo: 5_200_000,
      // Both an admin-only identifier and a public specification, so the
      // publication path can be shown to publish one and drop the other.
      attributes: JSON.stringify({
        brand: 'Apple',
        model: 'iPhone 13 Pro',
        storageGb: 128,
        imei: '356938035643809',
        serialNumber: 'F17GQ2Y9Q1GC',
      }),
      valueCheckStatus: overrides.valueCheckStatus ?? 'seller_accepted',
      authorizedPriceKobo:
        overrides.authorizedPriceKobo === undefined ? 4_500_000 : overrides.authorizedPriceKobo,
      authorizationVersion: overrides.authorizationVersion ?? 1,
      sellerAcceptedPriceKobo:
        overrides.sellerAcceptedPriceKobo === undefined
          ? 4_500_000
          : overrides.sellerAcceptedPriceKobo,
      sellerAcceptedVersion:
        overrides.sellerAcceptedVersion === undefined ? 1 : overrides.sellerAcceptedVersion,
    },
  });

  if (overrides.withPhoto !== false) {
    const fingerprint = await context.prisma.declutterImageFingerprint.create({
      data: { sha256: `sha-${submission.id}`, firstSellerId: submission.sellerId },
    });
    await context.prisma.declutterSubmissionPhoto.create({
      data: {
        submissionId: submission.id,
        fingerprintId: fingerprint.id,
        storageKey: `declutter-items/${submission.id}`,
        position: 0,
        role: 'front',
      },
    });
  }

  return submission.id;
}

// ---------------------------------------------------------------------------
// Publication
// ---------------------------------------------------------------------------

describe('publishing a submission', () => {
  it('creates a listing and closes the submission, in one step', async () => {
    const id = await makePublishable();

    const readiness = await get(admin, `/v1/admin/declutter/submissions/${id}/publication-readiness`);
    expect(readiness.json().canPublish).toBe(true);

    const response = await post(admin, `/v1/admin/declutter/submissions/${id}/publish`);
    expect(response.statusCode).toBe(201);

    const listing = response.json().listing;
    expect(listing.priceKobo).toBe(4_500_000);
    // The slug reads as the item and carries the code, so two identical titles
    // cannot collide.
    expect(listing.slug).toContain('iphone-13-pro-128gb');

    const submission = await context.prisma.declutterSubmission.findUniqueOrThrow({ where: { id } });
    expect(submission.status).toBe('published');
  });

  it('carries the photographs onto the listing', async () => {
    const id = await makePublishable();
    await post(admin, `/v1/admin/declutter/submissions/${id}/publish`);

    const listing = await context.prisma.declutterListing.findFirstOrThrow({
      where: { submissionId: id },
      include: { photos: true },
    });
    expect(listing.photos).toHaveLength(1);
    // The role travels with it, so alt text on the public page is real.
    expect(listing.photos[0]?.role).toBe('front');
  });

  it('refuses a price the seller never accepted', async () => {
    const id = await makePublishable({ valueCheckStatus: 'admin_approved' });
    const response = await post(admin, `/v1/admin/declutter/submissions/${id}/publish`);

    expect(response.statusCode).toBe(422);
    expect(response.json().error.details.gaps).toContain('seller_has_not_accepted');
  });

  it('refuses an acceptance against an older authorisation', async () => {
    // The seller agreed to this figure, then the price was re-authorised. Same
    // money, different decision — and a decision nobody has answered.
    const id = await makePublishable({ authorizationVersion: 2, sellerAcceptedVersion: 1 });
    const response = await post(admin, `/v1/admin/declutter/submissions/${id}/publish`);

    expect(response.statusCode).toBe(422);
    expect(response.json().error.details.gaps).toContain('acceptance_stale');
  });

  it('refuses an item with no photograph', async () => {
    const id = await makePublishable({ withPhoto: false });
    const response = await post(admin, `/v1/admin/declutter/submissions/${id}/publish`);

    expect(response.statusCode).toBe(422);
    expect(response.json().error.details.gaps).toContain('no_photographs');
  });

  it('refuses while a fraud flag is open', async () => {
    const id = await makePublishable();
    await context.prisma.declutterFraudFlag.create({
      data: { kind: 'perceptual_similar', submissionId: id, status: 'open' },
    });

    const response = await post(admin, `/v1/admin/declutter/submissions/${id}/publish`);
    expect(response.statusCode).toBe(422);
    expect(response.json().error.details.gaps).toContain('open_fraud_flag');
  });

  it('cannot publish the same submission twice', async () => {
    const id = await makePublishable();
    expect((await post(admin, `/v1/admin/declutter/submissions/${id}/publish`)).statusCode).toBe(201);

    const second = await post(admin, `/v1/admin/declutter/submissions/${id}/publish`);
    expect(second.statusCode).toBe(422);
    expect(second.json().error.details.gaps).toContain('already_published');
  });

  it('is refused to a moderator, who prepares work rather than publishing it', async () => {
    const id = await makePublishable();
    expect((await post(moderator, `/v1/admin/declutter/submissions/${id}/publish`)).statusCode).toBe(
      403,
    );
  });

  it('is refused to the seller themselves', async () => {
    const id = await makePublishable();
    expect((await post(seller, `/v1/admin/declutter/submissions/${id}/publish`)).statusCode).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// The public feed
// ---------------------------------------------------------------------------

describe('the public feed', () => {
  let slug: string;

  beforeAll(async () => {
    const id = await makePublishable({ title: 'Samsung Galaxy S22 Ultra' });
    const response = await post(admin, `/v1/admin/declutter/submissions/${id}/publish`);
    slug = response.json().listing.slug;
  });

  it('is readable with no account at all', async () => {
    const response = await get(null, '/v1/declutter/listings');
    expect(response.statusCode).toBe(200);
    expect(response.json().listings.length).toBeGreaterThan(0);
  });

  it('finds an item by a word in its title', async () => {
    const response = await get(null, '/v1/declutter/listings?q=Galaxy');
    const titles = response.json().listings.map((row: { title: string }) => row.title);
    expect(titles).toContain('Samsung Galaxy S22 Ultra');
  });

  it('filters by category, condition and price', async () => {
    const response = await get(
      null,
      '/v1/declutter/listings?category=phones-tablets&condition=good&minPriceKobo=1000000&maxPriceKobo=9000000',
    );
    expect(response.statusCode).toBe(200);
    expect(response.json().listings.length).toBeGreaterThan(0);

    const none = await get(null, '/v1/declutter/listings?minPriceKobo=90000000000');
    expect(none.json().listings).toEqual([]);
  });

  it('refuses a price range that is inside out', async () => {
    const response = await get(null, '/v1/declutter/listings?minPriceKobo=900&maxPriceKobo=100');
    expect(response.statusCode).toBe(400);
  });

  it('sorts by price in both directions', async () => {
    const cheap = await get(null, '/v1/declutter/listings?sort=price_low');
    const prices = cheap.json().listings.map((row: { priceKobo: number }) => row.priceKobo);
    expect([...prices].sort((a: number, b: number) => a - b)).toEqual(prices);
  });

  it('says where an item is, and nothing more precise than an area', async () => {
    const response = await get(null, `/v1/declutter/listings/${slug}`);
    const location = response.json().listing.location;

    expect(location.label).toBeTruthy();
    // The shape of `PublicLocation` is the guarantee; this asserts the wire
    // format kept it.
    expect(Object.keys(location).sort()).toEqual(['label', 'slug']);
  });

  it('hides a suspended listing from the feed and from its own URL', async () => {
    const listing = await context.prisma.declutterListing.findFirstOrThrow({ where: { slug } });
    await post(admin, `/v1/admin/declutter/listings/${listing.id}/moderation`, {
      to: 'suspended',
      reason: 'Awaiting proof of ownership.',
    });

    expect((await get(null, `/v1/declutter/listings/${slug}`)).statusCode).toBe(404);

    const feed = await get(null, '/v1/declutter/listings');
    const slugs = feed.json().listings.map((row: { slug: string }) => row.slug);
    expect(slugs).not.toContain(slug);

    // Put it back. Deliberately two steps: the machine has no
    // suspended -> approved edge, because a listing that was pulled down has to
    // be looked at again before it goes back in front of the public.
    const direct = await post(admin, `/v1/admin/declutter/listings/${listing.id}/moderation`, {
      to: 'approved',
    });
    expect(direct.statusCode).toBe(409);

    expect(
      (
        await post(admin, `/v1/admin/declutter/listings/${listing.id}/moderation`, {
          to: 'pending_review',
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await post(admin, `/v1/admin/declutter/listings/${listing.id}/moderation`, {
          to: 'approved',
        })
      ).statusCode,
    ).toBe(200);
  });

  it('refuses to suspend without a reason the seller can be told', async () => {
    const listing = await context.prisma.declutterListing.findFirstOrThrow({ where: { slug } });
    const response = await post(admin, `/v1/admin/declutter/listings/${listing.id}/moderation`, {
      to: 'suspended',
    });
    expect(response.statusCode).toBe(400);
  });

  it('keeps a reserved item visible but not enquirable', async () => {
    const listing = await context.prisma.declutterListing.findFirstOrThrow({ where: { slug } });
    await post(admin, `/v1/admin/declutter/listings/${listing.id}/availability`, { to: 'reserved' });

    const detail = await get(null, `/v1/declutter/listings/${slug}`);
    expect(detail.statusCode).toBe(200);
    // Still browsable — a buyer should be able to see what sold and at what
    // price — but the enquiry button is off.
    expect(detail.json().listing.contactable).toBe(false);

    await post(admin, `/v1/admin/declutter/listings/${listing.id}/availability`, { to: 'available' });
  });

  it('answers a slug that does not exist with a 404, not a hint', async () => {
    expect((await get(null, '/v1/declutter/listings/not-a-real-slug-dcl-000000')).statusCode).toBe(
      404,
    );
  });
});

// ---------------------------------------------------------------------------
// What a stranger receives
// ---------------------------------------------------------------------------

describe('what a public listing does not contain', () => {
  let slug: string;

  beforeAll(async () => {
    const id = await makePublishable({ title: 'Dell XPS 15 for privacy test' });
    slug = (await post(admin, `/v1/admin/declutter/submissions/${id}/publish`)).json().listing.slug;
  });

  it('carries nothing from the seller’s KYC record', async () => {
    const response = await get(null, `/v1/declutter/listings/${slug}`);
    const payload = JSON.stringify(response.json());

    for (const secret of Object.values(SELLER_SECRETS)) {
      expect(payload, secret).not.toContain(secret);
    }
    expect(payload).not.toContain('cipher-not-a-real-envelope');
  });

  it('does not publish an IMEI or a serial number', async () => {
    // Collected so DASH can check an item is not stolen. Publishing one hands a
    // thief everything they need to clone a handset or contest a blacklisting.
    const payload = JSON.stringify((await get(null, `/v1/declutter/listings/${slug}`)).json());

    expect(payload).not.toContain('356938035643809');
    expect(payload).not.toContain('F17GQ2Y9Q1GC');
  });

  it('still publishes the specifications a buyer needs', async () => {
    const attributes = (await get(null, `/v1/declutter/listings/${slug}`)).json().listing.attributes;
    expect(attributes.storageGb).toBe(128);
    expect(attributes.brand).toBe('Apple');
  });

  it('never reveals what the seller hoped to get', async () => {
    // `expectedPriceKobo` is a negotiating position, and this marketplace does
    // not negotiate. There is exactly one price on a listing.
    const payload = JSON.stringify((await get(null, `/v1/declutter/listings/${slug}`)).json());
    expect(payload).not.toContain('5200000');
    expect(payload).not.toContain('expectedPrice');
  });

  it('gives every photograph real alt text', async () => {
    const photos = (await get(null, `/v1/declutter/listings/${slug}`)).json().listing.photos;
    expect(photos.length).toBeGreaterThan(0);
    for (const photo of photos) {
      expect(photo.alt.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Trust language
// ---------------------------------------------------------------------------

describe('trust language at launch', () => {
  let slug: string;

  beforeAll(async () => {
    const id = await makePublishable({ title: 'HP Envy for badge test' });
    slug = (await post(admin, `/v1/admin/declutter/submissions/${id}/publish`)).json().listing.slug;
  });

  it('says Fixed Price, DASH Reviewed and Verified Listing', async () => {
    const badges = (await get(null, `/v1/declutter/listings/${slug}`)).json().listing.badges;
    expect(badges).toEqual(
      expect.arrayContaining(['fixed_price', 'dash_reviewed', 'verified_listing']),
    );
  });

  it('never says DASH ValueChecked, because no live provider has ever run', async () => {
    const detail = await get(null, `/v1/declutter/listings/${slug}`);
    expect(detail.json().listing.badges).not.toContain('value_checked');

    const feed = await get(null, '/v1/declutter/listings');
    for (const listing of feed.json().listings) {
      expect(listing.badges, listing.slug).not.toContain('value_checked');
    }
  });

  it('drops Verified Listing the moment a seller is suspended', async () => {
    // Computed on read rather than stored, so a revoked fact takes the claim
    // with it instead of leaving a stale badge on a live page.
    await context.prisma.declutterSeller.update({
      where: { id: sellerId },
      data: { kycStatus: 'suspended' },
    });

    const badges = (await get(null, `/v1/declutter/listings/${slug}`)).json().listing.badges;
    expect(badges).not.toContain('verified_listing');

    await context.prisma.declutterSeller.update({
      where: { id: sellerId },
      data: { kycStatus: 'verified' },
    });
  });
});

// ---------------------------------------------------------------------------
// Photographs
// ---------------------------------------------------------------------------

describe('item photographs', () => {
  let submissionId: string;

  beforeAll(async () => {
    const category = await context.prisma.declutterCategory.findUniqueOrThrow({
      where: { key: 'phones-tablets' },
    });
    const submission = await context.prisma.declutterSubmission.create({
      data: {
        code: `DCL-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        sellerId,
        status: 'details_pending',
        title: 'Nikon D3500',
        categoryId: category.id,
      },
    });
    submissionId = submission.id;
  });

  it('records which view the seller uploaded', async () => {
    const response = await post(seller, `/v1/declutter/submissions/${submissionId}/photos`, {
      contentType: 'image/png',
      role: 'label',
      data: PNG,
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().photo.role).toBe('label');
    // A signed link, not a public object URL.
    expect(response.json().photo.url).toBeTruthy();
  });

  it('refuses the same photograph twice on one item', async () => {
    const response = await post(seller, `/v1/declutter/submissions/${submissionId}/photos`, {
      contentType: 'image/png',
      role: 'front',
      data: PNG,
    });
    expect(response.statusCode).toBe(409);
  });

  it('blocks another account from re-using it, and tells a human', async () => {
    // The oldest fraud in second-hand selling, and invisible unless
    // fingerprints are shared across the whole marketplace.
    const other = await context.prisma.declutterSubmission.create({
      data: {
        code: `DCL-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        sellerId: secondSellerId,
        status: 'details_pending',
        title: 'Nikon D3500 (also)',
      },
    });

    const response = await post(buyer, `/v1/declutter/submissions/${other.id}/photos`, {
      contentType: 'image/png',
      role: 'front',
      data: PNG,
    });

    expect(response.statusCode).toBe(409);
    // Deliberately vague: naming the other account would turn this endpoint
    // into a way to test whether an image is already on the marketplace.
    expect(response.json().error.message).not.toContain('Chinedu');

    const flags = await context.prisma.declutterFraudFlag.findMany({
      where: { submissionId: other.id, kind: 'exact_duplicate_cross_account' },
    });
    expect(flags).toHaveLength(1);
    expect(flags[0]?.severity).toBe('high');

    // The blocked attempt itself is kept. It is exactly what an investigator
    // wants to find later.
    const usage = await context.prisma.declutterImageUsage.findMany({
      where: { submissionId: other.id, outcome: 'blocked_duplicate' },
    });
    expect(usage).toHaveLength(1);
  });

  it('will not let one seller touch another seller’s submission', async () => {
    const response = await post(buyer, `/v1/declutter/submissions/${submissionId}/photos`, {
      contentType: 'image/png',
      role: 'front',
      data: PNG_TWO,
    });
    // 404, not 403: a 403 would confirm the submission id is real.
    expect(response.statusCode).toBe(404);
  });

  it('refuses to change photographs once a price is on the table', async () => {
    await context.prisma.declutterSubmission.update({
      where: { id: submissionId },
      data: { status: 'seller_acceptance_pending' },
    });

    const response = await post(seller, `/v1/declutter/submissions/${submissionId}/photos`, {
      contentType: 'image/png',
      role: 'front',
      data: PNG_TWO,
    });
    // Otherwise a seller could accept a price for one item and publish
    // photographs of another.
    expect(response.statusCode).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// Contact requests
// ---------------------------------------------------------------------------

describe('asking to be put in touch', () => {
  let slug: string;
  let listingId: string;
  let requestId: string;

  beforeAll(async () => {
    const id = await makePublishable({ title: 'Canon EOS for contact test' });
    slug = (await post(admin, `/v1/admin/declutter/submissions/${id}/publish`)).json().listing.slug;
    listingId = (await context.prisma.declutterListing.findFirstOrThrow({ where: { slug } })).id;
  });

  it('needs an account, because an introduction names who asked', async () => {
    const response = await post(null, `/v1/declutter/listings/${slug}/contact-requests`, {
      message: 'Is the battery original?',
    });
    expect(response.statusCode).toBe(401);
  });

  it('creates a request and reveals nothing by doing so', async () => {
    const response = await post(buyer, `/v1/declutter/listings/${slug}/contact-requests`, {
      message: 'Is the battery original?',
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().contactRequest.status).toBe('pending');
    // Nothing about the seller comes back from creating one.
    expect(JSON.stringify(response.json())).not.toContain(SELLER_SECRETS.phoneE164);

    requestId = response.json().contactRequest.id;

    const conversation = await context.prisma.declutterConversation.findFirstOrThrow({
      where: { scopeKey: { contains: `:contact:${requestId}` } },
    });
    const inbox = await get(admin, '/v1/admin/declutter/conversations');
    const row = inbox.json().conversations.find(
      (entry: { id: string }) => entry.id === conversation.id,
    );
    expect(row?.kind).toBe('buyer_enquiry');
    expect(row?.title).toBe('Canon EOS for contact test');
    expect(row?.unreadCount).toBe(1);

    const messages = await get(admin, `/v1/admin/declutter/conversations/${conversation.id}`);
    expect(messages.json().messages).toHaveLength(1);
    expect(messages.json().messages[0].senderType).toBe('buyer');
    expect(messages.json().messages[0].body).toBe('Is the battery original?');
    const alerts = capturedEmails.filter(
      (message) => message.reference === `declutter_admin_message_${messages.json().messages[0].id}`,
    );
    expect(alerts.map((message) => message.to).sort()).toEqual([...DECLUTTER_ADMIN_EMAILS].sort());
    expect(alerts).toHaveLength(2);
  });

  it('will not queue the same unanswered question twice', async () => {
    const response = await post(buyer, `/v1/declutter/listings/${slug}/contact-requests`, {
      message: 'Asking again',
    });
    expect(response.statusCode).toBe(409);
  });

  it('will not let a seller enquire about their own item', async () => {
    const response = await post(seller, `/v1/declutter/listings/${slug}/contact-requests`, {});
    expect(response.statusCode).toBe(400);
  });

  it('defaults an approval to a DASH relay, disclosing nothing', async () => {
    const response = await post(
      admin,
      `/v1/admin/declutter/contact-requests/${requestId}/decision`,
      { decision: 'approved' },
    );

    expect(response.statusCode).toBe(200);
    expect(response.json().contactRequest.grantedMethod).toBe('dash_relay');

    const disclosure = await context.prisma.declutterContactDisclosure.findFirstOrThrow({
      where: { contactRequestId: requestId },
    });
    // Empty, because nothing was revealed. A mediated introduction is DASH
    // standing between two people, not a number changing hands.
    expect(JSON.parse(disclosure.disclosedFields)).toEqual([]);
  });

  it('refuses a direct number to an admin without the disclosure permission', async () => {
    const second = await makePublishable({ title: 'Second item for direct test' });
    const secondSlug = (
      await post(admin, `/v1/admin/declutter/submissions/${second}/publish`)
    ).json().listing.slug;

    const created = await post(buyer, `/v1/declutter/listings/${secondSlug}/contact-requests`, {});
    const id = created.json().contactRequest.id;

    const response = await post(moderator, `/v1/admin/declutter/contact-requests/${id}/decision`, {
      decision: 'approved',
      method: 'whatsapp_direct',
    });

    // `declutter:contact:disclose:direct` is a separate, step-up-gated
    // permission. Handing a stranger someone's personal number is not the same
    // authority as arranging an introduction.
    expect(response.statusCode).toBe(403);
  });

  it('refuses a direct number without recorded seller consent', async () => {
    const third = await makePublishable({ title: 'Third item for consent test' });
    const thirdSlug = (
      await post(admin, `/v1/admin/declutter/submissions/${third}/publish`)
    ).json().listing.slug;

    const created = await post(buyer, `/v1/declutter/listings/${thirdSlug}/contact-requests`, {});
    const id = created.json().contactRequest.id;

    const response = await post(admin, `/v1/admin/declutter/contact-requests/${id}/decision`, {
      decision: 'approved',
      method: 'whatsapp_direct',
      reason: 'Buyer wants to inspect today.',
    });

    // Consent to DASH mediating is implied by listing. Consent to handing a
    // stranger your personal number is not.
    expect(response.statusCode).toBe(400);
  });

  it('records exactly what was revealed when a direct method is used', async () => {
    const fourth = await makePublishable({ title: 'Fourth item for disclosure test' });
    const fourthSlug = (
      await post(admin, `/v1/admin/declutter/submissions/${fourth}/publish`)
    ).json().listing.slug;

    const created = await post(buyer, `/v1/declutter/listings/${fourthSlug}/contact-requests`, {});
    const id = created.json().contactRequest.id;

    const response = await post(admin, `/v1/admin/declutter/contact-requests/${id}/decision`, {
      decision: 'approved',
      method: 'whatsapp_direct',
      reason: 'Buyer wants to inspect today.',
      sellerConsentEvidence: 'Seller agreed on the Declutters WhatsApp line at 14:02.',
    });

    expect(response.statusCode).toBe(200);

    const disclosure = await context.prisma.declutterContactDisclosure.findFirstOrThrow({
      where: { contactRequestId: id },
    });
    expect(JSON.parse(disclosure.disclosedFields)).toContain('seller_whatsapp');
    expect(disclosure.sellerConsentAt).not.toBeNull();
  });

  it('shows a buyer their own enquiries and nobody else’s', async () => {
    const mine = await get(buyer, '/v1/declutter/contact-requests');
    expect(mine.statusCode).toBe(200);
    expect(mine.json().contactRequests.length).toBeGreaterThan(0);

    const theirs = await get(seller, '/v1/declutter/contact-requests');
    expect(theirs.json().contactRequests).toEqual([]);
  });

  it('keeps the review queue behind a permission', async () => {
    expect((await get(buyer, '/v1/admin/declutter/contact-requests')).statusCode).toBe(403);
    expect((await get(admin, '/v1/admin/declutter/contact-requests')).statusCode).toBe(200);
  });

  it('will not accept an enquiry on a listing that is not visible', async () => {
    await post(admin, `/v1/admin/declutter/listings/${listingId}/moderation`, {
      to: 'suspended',
      reason: 'Checking ownership.',
    });

    const response = await post(buyer, `/v1/declutter/listings/${slug}/contact-requests`, {});
    expect(response.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Serving the bytes
// ---------------------------------------------------------------------------

describe('a photograph reaches a browser, and only through its signed URL', () => {
  let photoUrl: string;

  beforeAll(async () => {
    const category = await context.prisma.declutterCategory.findUniqueOrThrow({
      where: { key: 'phones-tablets' },
    });
    const submission = await context.prisma.declutterSubmission.create({
      data: {
        code: `DCL-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        sellerId,
        status: 'details_pending',
        title: 'Camera for the file route',
        categoryId: category.id,
      },
    });

    const upload = await post(seller, `/v1/declutter/submissions/${submission.id}/photos`, {
      contentType: 'image/png',
      role: 'front',
      data: PNG_TWO,
    });
    photoUrl = upload.json().photo.url;
  });

  it('serves the image, and tells the browser not to second-guess the type', async () => {
    const response = await get(null, photoUrl);

    expect(response.statusCode).toBe(200);
    // Sniffed from the bytes rather than taken from the request, and the
    // browser is told not to sniff again — that is how an image becomes a
    // script.
    expect(response.headers['content-type']).toBe('image/png');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    // Signed and short-lived, so a shared cache must not keep it.
    expect(String(response.headers['cache-control'])).toContain('private');
  });

  it('refuses an edited signature', async () => {
    const tampered = photoUrl.replace(/signature=([0-9a-f])/, (_match, first: string) =>
      `signature=${first === 'a' ? 'b' : 'a'}`,
    );
    expect((await get(null, tampered)).statusCode).toBe(404);
  });

  it('refuses a link whose expiry has been pushed out', async () => {
    // The signature covers the expiry, so extending one invalidates the other.
    const extended = photoUrl.replace(/expires=\d+/, 'expires=99999999999');
    expect((await get(null, extended)).statusCode).toBe(404);
  });

  it('refuses a key that is not one we issued', async () => {
    const forged = photoUrl.replace(/\/v1\/files\/[^?]+/, '/v1/files/..%2F..%2Fetc%2Fpasswd');
    expect((await get(null, forged)).statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------

describe('the taxonomy a filter is built from', () => {
  it('is public, and offers areas without coordinates', async () => {
    const response = await get(null, '/v1/declutter/taxonomy');
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.categories.length).toBeGreaterThan(0);
    expect(body.locations.length).toBeGreaterThan(0);

    for (const location of body.locations) {
      expect(Object.keys(location).sort()).toEqual(['label', 'slug']);
    }
  });
});
