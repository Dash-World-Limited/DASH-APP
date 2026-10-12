import { afterAll, beforeAll, expect, it } from 'vitest';
import { seedDeclutterTaxonomy } from '@dash/db';
import { createTestContext, type TestContext } from './harness.js';
import { actAs, buildWorld, type Actor, type World } from './world.js';
import { useIntegrationTimeouts } from './timeouts.js';
useIntegrationTimeouts();
let context: TestContext;
let world: World;
let seller: Actor;
let admin: Actor;
let reviewer: Actor;
let sellerId: string;
beforeAll(async () => {
  context = await createTestContext();
  world = await buildWorld(context.prisma);
  await seedDeclutterTaxonomy(context.prisma);
  await context.prisma.identityRole.create({ data: { identityId: world.support.identityId, role: 'declutter_admin' } });
  seller = await actAs(context, world.customerA.email);
  admin = await actAs(context, world.admin.email);
  reviewer = await actAs(context, world.support.email);
  sellerId = (await context.prisma.declutterSeller.create({ data: { customerId: world.customerA.customerId, displayName: 'Seller', kycStatus: 'verified' } })).id;
}, 180_000);
afterAll(async () => { await context?.close(); });
const post = (actor: Actor, url: string, payload: unknown) => context.app.inject({ method: 'POST', url, headers: actor.headers, payload: payload as Record<string, unknown> });
async function submission(consent?: boolean) {
  const response = await post(seller, '/v1/declutter/submissions', { title: 'Reading chair', categoryKey: 'home-furniture', expectedPriceKobo: 1_000_000, ...(consent === undefined ? {} : { preAuthorizePrice: consent }) });
  expect(response.statusCode, response.body).toBe(201);
  return response.json().submission.id as string;
}
async function valuation(id: string, price: number) {
  await context.prisma.declutterValuation.create({ data: { submissionId: id, status: 'succeeded', requestPayload: '{}', recommendedPriceKobo: price, estimatedMinKobo: price, estimatedMaxKobo: price, confidenceBasisPoints: 10_000 } });
  await context.prisma.declutterSubmission.update({ where: { id }, data: { valueCheckStatus: 'valuation_completed' } });
}

it.each([
  { consent: true, price: 1_000_000, expected: 'seller_accepted' },
  { consent: true, price: 1_000_001, expected: 'seller_acceptance_pending' },
  { consent: undefined, price: 1_000_000, expected: 'seller_acceptance_pending' },
  { consent: false, price: 1_000_000, expected: 'seller_acceptance_pending' },
])('applies the three consent rules through both authority paths: $consent / $price', async ({ consent, price, expected }) => {
  for (const escalated of [false, true]) {
    const id = await submission(consent);
    const original = await context.prisma.declutterSubmission.findUniqueOrThrow({ where: { id } });
    expect(original.sellerAcceptedAt).toBeNull();
    expect(original.submittedPriceConsentKobo).toBe(consent ? 1_000_000 : null);
    expect(original.submittedPriceConsentBy).toBe(consent ? world.customerA.identityId : null);
    await valuation(id, price);
    const decision = await post(reviewer, `/v1/admin/declutter/submissions/${id}/pricing-decision`, { kind: 'approved', escalate: escalated });
    expect(decision.statusCode, decision.body).toBe(200);
    if (escalated) {
      expect(decision.json().valueCheckStatus).toBe('super_admin_approval_pending');
      expect((await context.prisma.declutterSubmission.findUniqueOrThrow({ where: { id } })).sellerAcceptedAt).toBeNull();
      for (const denied of [seller, reviewer]) {
        expect((await post(denied, `/v1/admin/declutter/submissions/${id}/authorize`, { kind: 'approved' })).statusCode).toBe(403);
      }
      await context.prisma.session.updateMany({ where: { identityId: world.admin.identityId, revokedAt: null }, data: { steppedUpAt: null } });
      const guarded = await post(admin, `/v1/admin/declutter/submissions/${id}/authorize`, { kind: 'approved' });
      expect(guarded.statusCode).toBe(403);
      expect(guarded.json().error.code).toBe('step_up_required');
      await context.prisma.session.updateMany({ where: { identityId: world.admin.identityId, revokedAt: null }, data: { steppedUpAt: new Date() } });
      const authorized = await post(admin, `/v1/admin/declutter/submissions/${id}/authorize`, { kind: 'approved' });
      expect(authorized.statusCode, authorized.body).toBe(200);
      expect(authorized.json().valueCheckStatus).toBe(expected);
    } else expect(decision.json().valueCheckStatus).toBe(expected);
    const stored = await context.prisma.declutterSubmission.findUniqueOrThrow({ where: { id } });
    expect(stored.authorizedPriceKobo).toBe(price);
    expect(stored.authorizationVersion).toBe(1);
    const accepted = expected === 'seller_accepted';
    expect(stored.sellerAcceptedPriceKobo).toBe(accepted ? price : null);
    expect(stored.sellerAcceptedVersion).toBe(accepted ? 1 : null);
    expect(stored.sellerAcceptanceBy).toBe(accepted ? world.customerA.identityId : null);
    expect(stored.sellerAcceptedAt !== null).toBe(accepted);
    const read = await context.app.inject({ method: 'GET', url: `/v1/declutter/submissions/${id}/price`, headers: seller.headers });
    expect(read.json().acceptanceValid).toBe(accepted);
    expect(await context.prisma.auditLog.count({ where: { resourceId: id, action: 'declutter.price.pre_authorization_applied' } })).toBe(accepted ? 1 : 0);
    if (!accepted) {
      const answer = await post(seller, `/v1/declutter/submissions/${id}/price-response`, { response: 'accept', priceKobo: price });
      expect(answer.statusCode, answer.body).toBe(200);
      expect(answer.json().eligibleForPublication).toBe(true);
    }
  }
});

it('captures no consent from a missing price, a coerced boolean or client-supplied audit fields', async () => {
  for (const body of [{ preAuthorizePrice: true }, { expectedPriceKobo: 1_000_000, preAuthorizePrice: 'true' }]) {
    const response = await post(seller, '/v1/declutter/submissions', { title: 'Bad consent', ...body });
    expect(response.statusCode).toBe(400);
  }
  const response = await post(seller, '/v1/declutter/submissions', { title: 'Forged consent', expectedPriceKobo: 1_000_000, submittedPriceConsentKobo: 1_000_000, submittedPriceConsentAt: new Date().toISOString(), submittedPriceConsentBy: world.admin.identityId });
  expect(response.statusCode).toBe(201);
  const stored = await context.prisma.declutterSubmission.findUniqueOrThrow({ where: { id: response.json().submission.id } });
  expect(stored.submittedPriceConsentAt).toBeNull();
  expect(stored.submittedPriceConsentBy).toBeNull();
});

it('does not consume legacy data or reuse consent when an authorised price is reviewed again', async () => {
  const id = await submission(true);
  await valuation(id, 1_000_000);
  expect((await post(reviewer, `/v1/admin/declutter/submissions/${id}/pricing-decision`, { kind: 'approved' })).json().valueCheckStatus).toBe('seller_accepted');
  const repriced = await post(reviewer, `/v1/admin/declutter/submissions/${id}/pricing-decision`, { kind: 'approved' });
  expect(repriced.statusCode, repriced.body).toBe(200);
  expect(repriced.json().valueCheckStatus).toBe('seller_acceptance_pending');
  const row = await context.prisma.declutterSubmission.findUniqueOrThrow({ where: { id } });
  expect(row.authorizationVersion).toBe(2);
  expect(row.sellerAcceptedVersion).toBeNull();
  expect(row.sellerAcceptanceBy).toBeNull();
  const legacy = await context.prisma.declutterSubmission.create({ data: { code: 'DCL-LEGACY-CONSENT', sellerId, expectedPriceKobo: 1_000_000, categoryId: (await context.prisma.declutterCategory.findUniqueOrThrow({ where: { key: 'home-furniture' } })).id } });
  await valuation(legacy.id, 1_000_000);
  expect((await post(reviewer, `/v1/admin/declutter/submissions/${legacy.id}/pricing-decision`, { kind: 'approved' })).json().valueCheckStatus).toBe('seller_acceptance_pending');
});
