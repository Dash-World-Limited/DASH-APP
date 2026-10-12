/**
 * Declutter selling and verification — integration tests.
 *
 * The happy path is one request each. What is worth the machinery is
 * everything around it: that browsing needs no verification, that a seller
 * cannot move their own item toward the public, that a moderator cannot make
 * an admin's decision, and that nothing anyone typed into a KYC form ever
 * comes back out of a public endpoint.
 *
 * The 403s and 404s are the subject. A green happy path shows the feature
 * works; the denials show it is safe to run.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './harness.js';
import { actAs, buildWorld, type Actor, type World } from './world.js';
import { useIntegrationTimeouts } from './timeouts.js';
import { PRIVATE_SELLER_FIELDS } from '@dash/domain/declutter';
import { seedDeclutterTaxonomy } from '@dash/db';

useIntegrationTimeouts();

let context: TestContext;
let world: World;
let customerA: Actor;
let customerB: Actor;
let admin: Actor;
let moderator: Actor;
let declutterAdmin: Actor;
let documentId: string;

/** A seller record for customer A, reused across the reads. */
let sellerAId: string;

beforeAll(async () => {
  context = await createTestContext();
  world = await buildWorld(context.prisma);

  // Geography and categories are reference data the marketplace cannot work
  // without — a submission names an area and a category, and both are checked
  // server-side. `buildWorld` seeds the DASH fixture, not this taxonomy, so it
  // is written here by the same idempotent function the real seed uses.
  await seedDeclutterTaxonomy(context.prisma);

  // A Declutters moderator: prepares work, decides nothing. Granted to an
  // existing staff identity so the sign-in path is the one the harness knows.
  await context.prisma.identityRole.create({
    data: { identityId: world.support.identityId, role: 'declutter_moderator' },
  });

  // A Declutters admin: decides verification, and still cannot confer a
  // commercial relationship.
  await context.prisma.identityRole.create({
    data: { identityId: world.finance.identityId, role: 'declutter_admin' },
  });

  customerA = await actAs(context, world.customerA.email);
  customerB = await actAs(context, world.customerB.email);
  admin = await actAs(context, world.admin.email);
  moderator = await actAs(context, world.support.email);
  declutterAdmin = await actAs(context, world.finance.email);
}, 180_000);

afterAll(async () => {
  await context?.close();
});

// ---------------------------------------------------------------------------

const KYC_BODY = {
  legalName: 'Chinedu Emeka Okonkwo',
  identityName: 'OKONKWO CHINEDU EMEKA',
  bankAccountName: 'Chinedu E Okonkwo',
  nationalId: '12345678901',
  phoneE164: '+2347000001234',
  addressLine: '14 Okpanam Road, Asaba',
  socialHandle: '@chinedu_seller',
  bankName: 'Test Bank',
  bankAccountNumber: '0123456789',
};

/** Complete a step-up by writing `steppedUpAt` on the live session. */
async function stepUp(email: string): Promise<void> {
  const identity = await context.prisma.identity.findUniqueOrThrow({ where: { email } });
  await context.prisma.session.updateMany({
    where: { identityId: identity.id, revokedAt: null },
    data: { steppedUpAt: new Date() },
  });
}

async function post(actor: Actor, url: string, payload?: Record<string, unknown>) {
  return await context.app.inject({ method: 'POST', url, headers: actor.headers, payload });
}
async function get(actor: Actor | null, url: string) {
  return await context.app.inject({
    method: 'GET',
    url,
    ...(actor ? { headers: actor.headers } : {}),
  });
}

// ---------------------------------------------------------------------------
// Ordinary accounts
// ---------------------------------------------------------------------------

describe('an ordinary account is not a seller', () => {
  it('has no seller record until it asks for one', async () => {
    const response = await get(customerB, '/v1/declutter/seller/me');
    // Not 403: there is nothing to be forbidden from. They simply are not one.
    expect(response.statusCode).toBe(404);
  });

  it('is refused a submission before it has become a seller', async () => {
    const response = await post(customerB, '/v1/declutter/submissions', { title: 'A sofa' });
    expect(response.statusCode).toBe(404);
  });

  it('creates a seller on request, with no verification demanded', async () => {
    const response = await post(customerA, '/v1/declutter/seller', {
      displayName: 'Chinedu',
      publicArea: 'Lekki, Lagos',
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.seller.kycStatus).toBe('unverified');
    // Unverified is not blocked from starting a conversation.
    expect(body.seller.canSubmit).toBe(true);
    sellerAId = body.seller.id;
  });

  it('returns the same record when asked twice', async () => {
    const response = await post(customerA, '/v1/declutter/seller', { displayName: 'Chinedu' });
    expect(response.statusCode).toBe(200);
    expect(response.json().seller.id).toBe(sellerAId);
  });
});

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

describe('verification', () => {
  it('rejects invalid numbering plans in private seller verification', async () => {
    for (const phoneE164 of ['+2340000000000', '+4474001', '08012345678']) {
      const response = await post(customerA, '/v1/declutter/seller/me/verification', { ...KYC_BODY, phoneE164 });
      expect(response.statusCode).toBe(400);
    }
  });

  it.each(['<script>', 'https://example.com/profile', '@bad handle', '@', 'x'.repeat(82)])('refuses invalid social handle %s', async (socialHandle) => {
    const response = await post(customerA, '/v1/declutter/seller/me/verification', { ...KYC_BODY, socialHandle });
    expect(response.statusCode).toBe(400);
  });

  it('accepts details and puts the seller in the queue', async () => {
    const response = await post(customerA, '/v1/declutter/seller/me/verification', KYC_BODY);
    expect(response.statusCode).toBe(200);
    expect(response.json().seller.kycStatus).toBe('pending');
    expect(response.json().seller.socialHandle).toBe('@chinedu_seller');
    const stored = await context.prisma.declutterSeller.findUniqueOrThrow({ where: { id: sellerAId } });
    expect(stored.socialHandle).toBe('@chinedu_seller');
    expect(stored.addressLine).toBe(KYC_BODY.addressLine);
    expect(stored.adminNotes).toBeNull();
  });

  it('never hands back what it was given, even to its owner', async () => {
    const body = (await get(customerA, '/v1/declutter/seller/me')).json();
    const serialised = JSON.stringify(body);
    expect(serialised).not.toContain('12345678901');
    expect(serialised).not.toContain('0123456789');
    for (const field of PRIVATE_SELLER_FIELDS) {
      // Their own rejection reason is the exception: a seller is owed the
      // reason they were turned down. Everything else stays behind the wall,
      // including from its owner — there is no product reason to re-display a
      // national identifier, and every extra place it appears can leak.
      if (field === 'rejectionReason' || field === 'socialHandle') continue;
      expect(body.seller, field).not.toHaveProperty(field);
    }
  });

  it('records how well the three names agreed', async () => {
    const queue = (await get(admin, '/v1/admin/declutter/sellers?kycStatus=pending')).json();
    const row = queue.sellers.find((s: { id: string }) => s.id === sellerAId);
    // Surname-first on the identity record, an initial at the bank: the same
    // person, and the match should say so rather than sending them to review.
    expect(row.nameMatchVerdict).toBe('match');
    expect(row.nameMatchScore).toBeGreaterThanOrEqual(85);
  });

  it('refuses a second submission while one is already pending', async () => {
    const response = await post(customerA, '/v1/declutter/seller/me/verification', KYC_BODY);
    expect(response.statusCode).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// Permissions, enforced on the server
// ---------------------------------------------------------------------------

describe('a moderator prepares work and decides none of it', () => {
  it('cannot read a seller’s identity or banking details', async () => {
    const response = await get(moderator, `/v1/admin/declutter/sellers/${sellerAId}`);
    expect(response.statusCode).toBe(403);
  });

  it('cannot verify a seller', async () => {
    const response = await post(
      moderator,
      `/v1/admin/declutter/sellers/${sellerAId}/decision`,
      { to: 'verified' },
    );
    expect(response.statusCode).toBe(403);
  });

  it('can still see the queue it has to work', async () => {
    const response = await get(moderator, '/v1/admin/declutter/sellers?kycStatus=pending');
    expect(response.statusCode).toBe(200);
  });
});

describe('a seller cannot act as an administrator', () => {
  it('is refused the seller queue', async () => {
    expect((await get(customerA, '/v1/admin/declutter/sellers')).statusCode).toBe(403);
  });

  it('is refused the submission queue', async () => {
    expect((await get(customerA, '/v1/admin/declutter/submissions')).statusCode).toBe(403);
  });

  it('is refused a verification decision on itself', async () => {
    const response = await post(
      customerA,
      `/v1/admin/declutter/sellers/${sellerAId}/decision`,
      { to: 'verified' },
    );
    expect(response.statusCode).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// The admin decision
// ---------------------------------------------------------------------------

describe('an administrator decides', () => {
  it('refuses a verification decision without a fresh step-up', async () => {
    // Holding the permission is not enough. `steppedUpAt` lives on the session
    // and is valid for fifteen minutes, so one elevation covers a whole queue —
    // but there has to be one.
    const response = await post(admin, `/v1/admin/declutter/sellers/${sellerAId}/decision`, {
      to: 'verified',
    });
    expect(response.statusCode).toBe(403);
  });

  it('refuses the private record without a fresh step-up', async () => {
    const response = await get(admin, `/v1/admin/declutter/sellers/${sellerAId}`);
    expect(response.statusCode).toBe(403);
  });

  it('opens an elevated window that covers more than one decision', async () => {
    await stepUp(world.admin.email);

    // Two gated calls, one elevation. This is the behaviour the design relies
    // on: an admin steps up once, then works the queue.
    const read = await get(admin, `/v1/admin/declutter/sellers/${sellerAId}`);
    const decide = await post(admin, `/v1/admin/declutter/sellers/${sellerAId}/decision`, {
      to: 'rejected',
    });

    expect(read.statusCode).toBe(200);
    expect(read.json().seller.socialHandle).toBe('@chinedu_seller');
    // 400 for the missing reason, not 403. The elevation held across both.
    expect(decide.statusCode).toBe(400);
  });

  it('refuses a transition the machine does not allow', async () => {
    const response = await post(admin, `/v1/admin/declutter/sellers/${sellerAId}/decision`, {
      to: 'suspended',
      reason: 'not reachable from pending',
    });
    expect(response.statusCode).toBe(409);
  });

  it('refuses to verify a seller with no accepted identity document', async () => {
    // The rule this milestone adds. Typed details are a claim; a government
    // document a reviewer opened and accepted is evidence.
    const response = await post(admin, `/v1/admin/declutter/sellers/${sellerAId}/decision`, {
      to: 'verified',
    });
    expect(response.statusCode).toBe(422);
    expect(JSON.stringify(response.json())).toContain('accepted_identity_document');
  });

  it('audits a reviewer opening the private record', async () => {
    const response = await get(admin, `/v1/admin/declutter/sellers/${sellerAId}`);
    expect(response.statusCode).toBe(200);

    const serialised = JSON.stringify(response.json());
    expect(serialised).toContain('6789'); // last four of the account number
    expect(serialised).not.toContain('0123456789');

    const audit = await context.prisma.auditLog.findFirst({
      where: { resourceId: sellerAId, action: 'declutter.seller.kyc_viewed' },
    });
    expect(audit).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

describe('seller documents', () => {
  /** A one-pixel PNG. Real bytes, so the adapter's checks actually run. */
  const PNG =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  it('accepts a government identity document from its owner', async () => {
    const response = await post(customerA, '/v1/declutter/seller/me/documents', {
      kind: 'national_id',
      contentType: 'image/png',
      data: PNG,
    });

    expect(response.statusCode).toBe(201);
    const document = response.json().document;
    expect(document.status).toBe('pending');
    expect(document.isIdentityDocument).toBe(true);
    documentId = document.id;
  });

  it('never returns a storage key or any bytes to the seller', async () => {
    const body = (await get(customerA, '/v1/declutter/seller/me/documents')).json();
    const serialised = JSON.stringify(body);
    expect(serialised).not.toContain('declutter-kyc');
    expect(body.documents[0]).not.toHaveProperty('storageKey');
    expect(body.documents[0]).not.toHaveProperty('data');
  });

  it('refuses a file type outside the allowlist', async () => {
    const response = await post(customerA, '/v1/declutter/seller/me/documents', {
      kind: 'national_id',
      contentType: 'application/zip',
      data: PNG,
    });
    expect(response.statusCode).toBe(400);
  });

  it('will not hand a moderator a link to the bytes', async () => {
    const response = await get(
      moderator,
      `/v1/admin/declutter/sellers/${sellerAId}/documents/${documentId}/link`,
    );
    expect(response.statusCode).toBe(403);
  });

  it('will not hand the seller a link either', async () => {
    const response = await get(
      customerA,
      `/v1/admin/declutter/sellers/${sellerAId}/documents/${documentId}/link`,
    );
    expect(response.statusCode).toBe(403);
  });

  it('gives a reviewer a short-lived link, and records that it did', async () => {
    const response = await get(
      admin,
      `/v1/admin/declutter/sellers/${sellerAId}/documents/${documentId}/link`,
    );
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.expiresInSeconds).toBeLessThanOrEqual(300);
    expect(body.url).toContain('signature=');

    const audit = await context.prisma.auditLog.findFirst({
      where: { resourceId: documentId, action: 'declutter.seller.document_link_issued' },
    });
    expect(audit).not.toBeNull();
  });

  it('does not let a document be reached through another seller', async () => {
    // A seller with no linked account — the shape an admin-created record
    // takes, and enough to prove the scoping.
    const other = await context.prisma.declutterSeller.create({
      data: { displayName: 'Another seller', kycStatus: 'unverified' },
    });
    const response = await get(
      admin,
      `/v1/admin/declutter/sellers/${other.id}/documents/${documentId}/link`,
    );
    // Scoped by seller as well as by id, so a document id cannot be walked
    // from one review screen onto another.
    expect(response.statusCode).toBe(404);
  });

  it('requires a note when a document is rejected', async () => {
    const response = await post(
      admin,
      `/v1/admin/declutter/sellers/${sellerAId}/documents/${documentId}/review`,
      { status: 'rejected' },
    );
    expect(response.statusCode).toBe(400);
  });

  it('accepts the document, which unblocks verification', async () => {
    const review = await post(
      admin,
      `/v1/admin/declutter/sellers/${sellerAId}/documents/${documentId}/review`,
      { status: 'accepted' },
    );
    expect(review.statusCode).toBe(200);

    const verify = await post(admin, `/v1/admin/declutter/sellers/${sellerAId}/decision`, {
      to: 'verified',
    });
    expect(verify.statusCode).toBe(200);
    expect(verify.json().seller.kycStatus).toBe('verified');

    const audit = await context.prisma.auditLog.findFirst({
      where: { resourceId: sellerAId, action: 'declutter.seller.verified' },
    });
    expect(audit).not.toBeNull();
    expect(audit!.identityId).toBe(world.admin.identityId);
  });
});

// ---------------------------------------------------------------------------
// Trusted Partner
// ---------------------------------------------------------------------------

describe('trusted partner is a super admin grant', () => {
  it('is out of reach of a declutter admin', async () => {
    await stepUp(world.finance.email);
    const response = await post(
      declutterAdmin,
      `/v1/admin/declutter/sellers/${sellerAId}/partner`,
      { trusted: true, reason: 'they asked nicely' },
    );
    // They may decide verification all day. Conferring a commercial
    // relationship is not theirs to do.
    expect(response.statusCode).toBe(403);
  });

  it('is out of reach of a seller', async () => {
    const response = await post(customerA, `/v1/admin/declutter/sellers/${sellerAId}/partner`, {
      trusted: true,
      reason: 'promoting myself',
    });
    expect(response.statusCode).toBe(403);
  });

  it('demands a reason', async () => {
    const response = await post(admin, `/v1/admin/declutter/sellers/${sellerAId}/partner`, {
      trusted: true,
    });
    expect(response.statusCode).toBe(400);
  });

  it('is granted by a super admin, with the reason on the record', async () => {
    const response = await post(admin, `/v1/admin/declutter/sellers/${sellerAId}/partner`, {
      trusted: true,
      reason: 'Signed operator agreement, business identity verified',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().seller.sellerType).toBe('trusted_partner');

    const audit = await context.prisma.auditLog.findFirst({
      where: { resourceId: sellerAId, action: 'declutter.seller.partner_granted' },
    });
    expect(audit).not.toBeNull();
    expect(audit!.after).toContain('Signed operator agreement');
  });

  it('never lets a partner grant stand in for verification', async () => {
    const unverified = await context.prisma.declutterSeller.create({
      data: { displayName: 'Unverified partner hopeful', kycStatus: 'pending' },
    });
    const response = await post(admin, `/v1/admin/declutter/sellers/${unverified.id}/partner`, {
      trusted: true,
      reason: 'a partner we have not verified',
    });
    expect(response.statusCode).toBe(422);
  });
});

// ---------------------------------------------------------------------------
// Submissions
// ---------------------------------------------------------------------------

describe('submissions', () => {
  let submissionId: string;

  it('opens in intake once the seller is verified', async () => {
    const response = await post(customerA, '/v1/declutter/submissions', {
      title: 'iPhone 13 Pro, 128GB',
      condition: 'good',
      expectedPriceKobo: 47_000_000,
      categoryKey: 'phones-tablets',
      locationSlug: 'lagos-lekki',
    });

    expect(response.statusCode).toBe(201);
    const submission = response.json().submission;
    expect(submission.status).toBe('intake');
    submissionId = submission.id;
  });

  it('refuses an area DASH does not cover', async () => {
    const response = await post(customerA, '/v1/declutter/submissions', {
      title: 'A fridge',
      locationSlug: 'lagos', // a state, not a listable area
    });
    expect(response.statusCode).toBe(400);
  });

  it('shows a seller only their own', async () => {
    await post(customerB, '/v1/declutter/seller', { displayName: 'Someone else' });
    const mine = (await get(customerA, '/v1/declutter/submissions')).json();
    const theirs = (await get(customerB, '/v1/declutter/submissions')).json();

    expect(mine.submissions.length).toBeGreaterThan(0);
    expect(theirs.submissions).toEqual([]);
  });

  it('will not let anyone publish from here', async () => {
    // The one transition this milestone must not offer. Publication needs a
    // listing, an accepted price and a different permission.
    const response = await post(
      admin,
      `/v1/admin/declutter/submissions/${submissionId}/transition`,
      { to: 'published' },
    );
    expect(response.statusCode).not.toBe(200);
  });

  it('refuses a seller the admin transition route entirely', async () => {
    const response = await post(
      customerA,
      `/v1/admin/declutter/submissions/${submissionId}/transition`,
      { to: 'valuation_pending' },
    );
    expect(response.statusCode).toBe(403);
  });

  it('lets an admin move it on, and writes the event and the audit', async () => {
    const response = await post(
      admin,
      `/v1/admin/declutter/submissions/${submissionId}/transition`,
      { to: 'details_pending', note: 'Need a photo of the back' },
    );
    expect(response.statusCode).toBe(200);
    expect(response.json().submission.status).toBe('details_pending');

    const events = await context.prisma.declutterSubmissionEvent.findMany({
      where: { submissionId },
      orderBy: { createdAt: 'asc' },
    });
    expect(events.map((e) => e.toStatus)).toEqual(['intake', 'details_pending']);
    expect(events[1]!.actorType).toBe('super_admin');

    const audit = await context.prisma.auditLog.findFirst({
      where: { resourceId: submissionId, action: 'declutter.submission.details_pending' },
    });
    expect(audit).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The public boundary
// ---------------------------------------------------------------------------

describe('the public seller profile', () => {
  it('shows a verified seller without showing anything private', async () => {
    const response = await get(null, `/v1/declutter/sellers/${sellerAId}`);
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.seller.verified).toBe(true);
    expect(Object.keys(body.seller).sort()).toEqual([
      'area',
      'displayName',
      'id',
      'sellerType',
      'trustedPartner',
      'verified',
    ]);

    const serialised = JSON.stringify(body);
    expect(serialised).not.toContain('Okonkwo'); // the legal name
    expect(serialised).not.toContain('Okpanam'); // the street address
    expect(serialised).not.toContain('6789'); // any part of an account number
  });

  it('does not admit that an unverified seller exists', async () => {
    const other = await context.prisma.declutterSeller.findFirstOrThrow({
      where: { kycStatus: 'unverified' },
    });
    const response = await get(null, `/v1/declutter/sellers/${other.id}`);
    // 404 rather than 403 — a 403 would confirm the record is there.
    expect(response.statusCode).toBe(404);
  });
});
