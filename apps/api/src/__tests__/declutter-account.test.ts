import { afterAll, beforeAll, expect, it } from 'vitest';
import { seedDeclutterTaxonomy } from '@dash/db';
import { createTestContext, type TestContext } from './harness.js';
import { actAs, buildWorld, type Actor } from './world.js';

let context: TestContext;
let owner: Actor;
let other: Actor;
beforeAll(async () => {
  context = await createTestContext();
  const world = await buildWorld(context.prisma);
  owner = await actAs(context, world.customerA.email);
  other = await actAs(context, world.customerB.email);
  await seedDeclutterTaxonomy(context.prisma);
});
afterAll(async () => { await context?.close(); });

it('requires authentication and does not create a seller for an account visitor', async () => {
  expect((await context.app.inject({ method: 'GET', url: '/v1/declutter/account' })).statusCode).toBe(401);
  const response = await context.app.inject({ method: 'GET', url: '/v1/declutter/account', headers: owner.headers });
  expect(response.json()).toEqual({ seller: null, submissions: [], listings: [] });
  expect(response.headers['cache-control']).toBe('no-store');
  expect(await context.prisma.declutterSeller.count()).toBe(0);
});

it('returns only the caller’s safe seller status, submissions and listings', async () => {
  const profile = await context.app.inject({ method: 'POST', url: '/v1/declutter/seller', headers: owner.headers, payload: { displayName: 'Ada Seller' } });
  const sellerId = profile.json().seller.id;
  await context.prisma.declutterSeller.update({ where: { id: sellerId }, data: {
    kycStatus: 'pending', legalName: 'PRIVATE-LEGAL', phoneE164: 'PRIVATE-PHONE', addressLine: 'PRIVATE-ADDRESS',
    socialHandle: 'PRIVATE-SOCIAL', nationalIdCipher: 'PRIVATE-ID', adminNotes: 'PRIVATE-NOTE', rejectionReason: 'PRIVATE-REASON',
  } });
  const submission = await context.prisma.declutterSubmission.create({ data: { sellerId, code: 'DCL-ACCOUNT', title: 'Owner item', status: 'published', adminNotes: 'PRIVATE-SUBMISSION' } });
  const category = await context.prisma.declutterCategory.findFirstOrThrow();
  const location = await context.prisma.declutterLocation.findFirstOrThrow();
  await context.prisma.declutterListing.create({ data: { sellerId, submissionId: submission.id, slug: 'owner-item', title: 'Owner item', description: 'Safe item', categoryId: category.id, locationId: location.id, condition: 'good', priceKobo: 10000, moderationStatus: 'approved', availability: 'sold', publishedAt: new Date(), suspensionReason: 'PRIVATE-LISTING' } });
  const response = await context.app.inject({ method: 'GET', url: '/v1/declutter/account', headers: owner.headers });
  expect(response.statusCode).toBe(200);
  const summary = response.json();
  expect(summary.seller).toEqual({ kycStatus: 'pending', canSubmit: true });
  expect(summary.submissions).toEqual([{ id: submission.id, code: 'DCL-ACCOUNT', title: 'Owner item', status: 'published' }]);
  expect(summary.listings[0].availability).toBe('sold');
  expect(Object.keys(summary.listings[0]).sort()).toEqual(['id', 'submissionId', 'slug', 'title', 'moderationStatus', 'availability', 'publishedAt', 'priceKobo'].sort());
  expect(response.body).not.toContain('PRIVATE-');
  expect((await context.app.inject({ method: 'GET', url: '/v1/declutter/account', headers: other.headers })).json()).toEqual({ seller: null, submissions: [], listings: [] });
});
