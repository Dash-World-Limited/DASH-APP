/**
 * DASH ValueCheck through the marketplace — integration tests.
 *
 * The milestone's demonstration runs here end to end: a submission becomes a
 * sanitised valuation request, the engine answers, an admin decides, policy
 * decides whether a super admin must approve, a super admin authorises, and
 * the seller accepts that exact price.
 *
 * Everything around it is the point. A provider that fails, times out or
 * returns nonsense must leave the submission's authoritative state exactly as
 * it was. No automated actor and no seller may authorise a price. A price that
 * moves invalidates an acceptance. And nothing a seller typed into a KYC form
 * may appear in what is sent to a provider.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './harness.js';
import { actAs, buildWorld, type Actor, type World } from './world.js';
import { useIntegrationTimeouts } from './timeouts.js';
import { seedDeclutterTaxonomy } from '@dash/db';
import {
  DeterministicValuationAdapter,
  type ValuationPort,
  type ValuationRequest,
  type ValuationResult,
} from '@dash/domain/valuecheck';

useIntegrationTimeouts();

/**
 * A provider the test can break on demand.
 *
 * One context is expensive, so rather than building a second one for the
 * failure cases this adapter switches behaviour between tests.
 */
class SwitchableAdapter implements ValuationPort {
  readonly providerName = 'local-deterministic';
  readonly modelVersion = 'valuecheck-local-1';
  readonly isLive = false;
  mode: 'ok' | 'throw' | 'malformed' | 'inverted' = 'ok';

  private readonly real = new DeterministicValuationAdapter({
    now: () => new Date('2026-09-10T09:00:00.000Z'),
  });

  async value(request: ValuationRequest): Promise<ValuationResult> {
    if (this.mode === 'throw') throw new Error('provider unavailable');
    if (this.mode === 'malformed') return { nonsense: true } as unknown as ValuationResult;
    const result = await this.real.value(request);
    if (this.mode === 'inverted') {
      return { ...result, estimatedLowKobo: result.estimatedHighKobo * 10 };
    }
    return result;
  }
}

const provider = new SwitchableAdapter();

let context: TestContext;
let world: World;
let seller: Actor;
let admin: Actor;
let moderator: Actor;
let sellerId: string;

beforeAll(async () => {
  context = await createTestContext({}, { valuation: provider });
  world = await buildWorld(context.prisma);
  await seedDeclutterTaxonomy(context.prisma);

  await context.prisma.identityRole.create({
    data: { identityId: world.support.identityId, role: 'declutter_moderator' },
  });

  // A verified seller, written directly. The verification journey has its own
  // suite; repeating it here would test that instead of this.
  const customer = await context.prisma.customer.findFirstOrThrow({
    where: { identity: { email: world.customerA.email } },
  });
  const record = await context.prisma.declutterSeller.create({
    data: {
      customerId: customer.id,
      displayName: 'Chinedu',
      kycStatus: 'verified',
      legalName: 'Chinedu Emeka Okonkwo',
      nationalIdLast4: '8901',
      nationalIdCipher: 'cipher-not-a-real-envelope',
      phoneE164: '+2347000001234',
      addressLine: '14 Okpanam Road, Asaba',
      adminNotes: 'Internal note about this seller',
    },
  });
  sellerId = record.id;

  seller = await actAs(context, world.customerA.email);
  admin = await actAs(context, world.admin.email);
  moderator = await actAs(context, world.support.email);
}, 180_000);

afterAll(async () => {
  await context?.close();
});

// ---------------------------------------------------------------------------

async function post(actor: Actor, url: string, payload?: Record<string, unknown>) {
  return await context.app.inject({ method: 'POST', url, headers: actor.headers, payload });
}
async function get(actor: Actor, url: string) {
  return await context.app.inject({ method: 'GET', url, headers: actor.headers });
}
async function stepUp(email: string): Promise<void> {
  const identity = await context.prisma.identity.findUniqueOrThrow({ where: { email } });
  await context.prisma.session.updateMany({
    where: { identityId: identity.id, revokedAt: null },
    data: { steppedUpAt: new Date() },
  });
}

/** A submission with comparables, ready to value. */
async function makeSubmission(expectedPriceKobo: number, comparablePriceKobo: number) {
  const category = await context.prisma.declutterCategory.findUniqueOrThrow({
    where: { key: 'phones-tablets' },
  });
  const submission = await context.prisma.declutterSubmission.create({
    data: {
      code: `DCL-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      sellerId,
      status: 'valuation_pending',
      title: 'iPhone 13 Pro 128GB',
      condition: 'good',
      categoryId: category.id,
      expectedPriceKobo,
      attributes: JSON.stringify({ storageGb: 128, batteryHealth: 88 }),
    },
  });

  // Three comparables and a photograph: enough evidence that the confidence
  // ceiling clears the escalation threshold, so the non-escalating path can
  // actually be exercised.
  for (const price of [
    comparablePriceKobo,
    comparablePriceKobo + 100_000,
    comparablePriceKobo + 200_000,
  ]) {
    await context.prisma.declutterComparable.create({
      data: {
        submissionId: submission.id,
        source: 'Marketplace listing',
        description: 'iPhone 13 Pro 128GB',
        soldPriceKobo: price,
        observedAt: new Date('2026-09-01T00:00:00.000Z'),
      },
    });
  }

  const fingerprint = await context.prisma.declutterImageFingerprint.create({
    data: { sha256: `sha-${submission.id}` },
  });
  await context.prisma.declutterSubmissionPhoto.create({
    data: {
      submissionId: submission.id,
      fingerprintId: fingerprint.id,
      storageKey: `declutter-kyc/${submission.id}`,
      position: 0,
    },
  });

  return submission.id;
}

// ---------------------------------------------------------------------------
// The standalone service
// ---------------------------------------------------------------------------

describe('ValueCheck stands on its own', () => {
  const body = {
    reference: 'standalone-1',
    categoryKey: 'phones-tablets',
    brand: 'Apple',
    model: 'iPhone 13 Pro',
    condition: 'good',
    marketLocation: 'Lekki, Lagos',
    expectedPriceKobo: 47_000_000,
    comparables: [
      {
        id: 'c1',
        source: 'Marketplace',
        description: 'iPhone 13 Pro',
        soldPriceKobo: 44_000_000,
        observedAt: '2026-09-01T00:00:00.000Z',
      },
    ],
  };

  it('values an item without any listing, submission or seller', async () => {
    provider.mode = 'ok';
    const response = await post(moderator, '/v1/valuecheck/valuations', body);
    expect(response.statusCode).toBe(200);

    const valuation = response.json().valuation;
    expect(valuation.recommendedPriceKobo).toBeGreaterThan(0);
    // Honest about what produced it.
    expect(valuation.isLive).toBe(false);
    expect(valuation.providerName).toBe('local-deterministic');
  });

  it('is refused without the permission', async () => {
    expect((await post(seller, '/v1/valuecheck/valuations', body)).statusCode).toBe(403);
  });

  it('confers no authority to price or publish anything', async () => {
    const response = await post(moderator, '/v1/valuecheck/valuations', body);
    const payload = JSON.stringify(response.json());
    // A valuation is advice. Nothing here is a listing, an authorisation or a
    // price a stranger will pay.
    expect(payload).not.toContain('authorized');
    expect(payload).not.toContain('listingId');
  });

  it('refuses a provider result it cannot trust, and changes nothing', async () => {
    provider.mode = 'malformed';
    const response = await post(moderator, '/v1/valuecheck/valuations', body);
    expect(response.statusCode).toBe(422);
    provider.mode = 'ok';
  });

  it('survives a provider that is simply down', async () => {
    provider.mode = 'throw';
    const response = await post(moderator, '/v1/valuecheck/valuations', body);
    expect(response.statusCode).toBe(422);
    expect(JSON.stringify(response.json())).not.toContain('provider unavailable');
    provider.mode = 'ok';
  });
});

// ---------------------------------------------------------------------------
// A run that fails must change nothing
// ---------------------------------------------------------------------------

describe('a failed run leaves the submission alone', () => {
  it('records the failure without moving authoritative state', async () => {
    const id = await makeSubmission(4_000_000, 3_500_000);
    provider.mode = 'throw';

    const response = await post(admin, `/v1/admin/declutter/submissions/${id}/valuecheck`);
    expect(response.statusCode).toBe(422);

    const after = await context.prisma.declutterSubmission.findUniqueOrThrow({ where: { id } });
    expect(after.valueCheckStatus).toBe('valuation_pending');
    expect(after.authorizedPriceKobo).toBeNull();
    expect(after.authorizationVersion).toBe(0);

    // The attempt is on the record, so a reviewer can see the engine was tried.
    const failed = await context.prisma.declutterValuation.findFirst({
      where: { submissionId: id, status: 'failed' },
    });
    expect(failed).not.toBeNull();
    provider.mode = 'ok';
  });

  it('refuses an inverted range and leaves the submission untouched', async () => {
    const id = await makeSubmission(4_000_000, 3_500_000);
    provider.mode = 'inverted';

    expect((await post(admin, `/v1/admin/declutter/submissions/${id}/valuecheck`)).statusCode).toBe(422);
    const after = await context.prisma.declutterSubmission.findUniqueOrThrow({ where: { id } });
    expect(after.valueCheckStatus).toBe('valuation_pending');
    provider.mode = 'ok';
  });
});

// ---------------------------------------------------------------------------
// Nothing about a seller reaches a provider
// ---------------------------------------------------------------------------

describe('what is sent to the engine', () => {
  it('carries the item and nothing about the person', async () => {
    const id = await makeSubmission(4_000_000, 3_500_000);
    provider.mode = 'ok';
    expect((await post(admin, `/v1/admin/declutter/submissions/${id}/valuecheck`)).statusCode).toBe(200);

    const run = await context.prisma.declutterValuation.findFirstOrThrow({
      where: { submissionId: id, status: 'succeeded' },
    });
    const payload = run.requestPayload;

    // The exact values that exist on this seller's record.
    for (const secret of [
      'Chinedu Emeka Okonkwo',
      '8901',
      'cipher-not-a-real-envelope',
      '+2347000001234',
      'Okpanam',
      'Internal note about this seller',
      sellerId,
    ]) {
      expect(payload, secret).not.toContain(secret);
    }
  });
});

// ---------------------------------------------------------------------------
// Authority
// ---------------------------------------------------------------------------

describe('a small, well-evidenced price needs no super admin', () => {
  let id: string;

  it('runs and lands on an admin desk', async () => {
    provider.mode = 'ok';
    id = await makeSubmission(4_000_000, 3_500_000);
    const response = await post(admin, `/v1/admin/declutter/submissions/${id}/valuecheck`);
    expect(response.statusCode).toBe(200);
    expect(response.json().result.isLive).toBe(false);

    const after = await context.prisma.declutterSubmission.findUniqueOrThrow({ where: { id } });
    expect(after.valueCheckStatus).toBe('valuation_completed');
  });

  it('refuses an adjustment with no reason', async () => {
    const response = await post(admin, `/v1/admin/declutter/submissions/${id}/pricing-decision`, {
      kind: 'adjusted',
      adminPriceKobo: 2_000_000,
    });
    expect(response.statusCode).toBe(400);
  });

  it('authorises on the admin’s approval, and presents it to the seller', async () => {
    const response = await post(admin, `/v1/admin/declutter/submissions/${id}/pricing-decision`, {
      kind: 'approved',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().escalation).toEqual([]);
    expect(response.json().valueCheckStatus).toBe('seller_acceptance_pending');

    const after = await context.prisma.declutterSubmission.findUniqueOrThrow({ where: { id } });
    expect(after.authorizedPriceKobo).toBeGreaterThan(0);
    expect(after.authorizationVersion).toBe(1);
  });

  it('keeps the model’s recommendation beside the human decision', async () => {
    const decision = await context.prisma.declutterPricingDecision.findFirstOrThrow({
      where: { submissionId: id },
    });
    // Both numbers, on the record. Nothing can later imply the model
    // recommended what a person chose.
    expect(decision.recommendedPriceKobo).not.toBeNull();
    expect(decision.proposedPriceKobo).toBe(decision.recommendedPriceKobo);
    expect(decision.actorRole).toBe('super_admin');
  });

  it('lets the seller accept that exact price', async () => {
    const submission = await context.prisma.declutterSubmission.findUniqueOrThrow({ where: { id } });
    const response = await post(seller, `/v1/declutter/submissions/${id}/price-response`, {
      response: 'accept',
      priceKobo: submission.authorizedPriceKobo,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().valueCheckStatus).toBe('seller_accepted');
    expect(response.json().eligibleForPublication).toBe(true);
  });

  it('refuses an answer to a price that is no longer on the table', async () => {
    const response = await post(seller, `/v1/declutter/submissions/${id}/price-response`, {
      response: 'accept',
      priceKobo: 999_999,
    });
    expect(response.statusCode).toBe(409);
  });

  it('invalidates the acceptance when the price is authorised again', async () => {
    // Re-price after acceptance. The seller agreed to a number that is no
    // longer the number.
    await post(admin, `/v1/admin/declutter/submissions/${id}/pricing-decision`, {
      kind: 'adjusted',
      adminPriceKobo: 3_000_000,
      reason: 'Comparable evidence moved',
    });

    const after = await context.prisma.declutterSubmission.findUniqueOrThrow({ where: { id } });
    expect(after.sellerAcceptedPriceKobo).toBeNull();
    expect(after.authorizationVersion).toBe(2);

    const price = await get(seller, `/v1/declutter/submissions/${id}/price`);
    expect(price.json().acceptanceValid).toBe(false);
  });
});

describe('a price at the threshold needs a super admin', () => {
  let id: string;

  it('escalates, and says why', async () => {
    provider.mode = 'ok';
    // Comparables well above ₦50,000 so the recommendation clears the pilot
    // threshold.
    id = await makeSubmission(90_000_000, 80_000_000);
    await post(admin, `/v1/admin/declutter/submissions/${id}/valuecheck`);

    const response = await post(admin, `/v1/admin/declutter/submissions/${id}/pricing-decision`, {
      kind: 'approved',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().valueCheckStatus).toBe('super_admin_approval_pending');
    expect(response.json().escalation).toContain('price_at_or_above_threshold');
  });

  it('shows the approver why it is in their queue', async () => {
    await stepUp(world.admin.email);
    const response = await get(admin, '/v1/admin/declutter/approvals');
    expect(response.statusCode).toBe(200);

    const row = response.json().approvals.find((a: { id: string }) => a.id === id);
    expect(row.escalationReasons).toContain('price_at_or_above_threshold');
  });

  it('is not authorised by a seller', async () => {
    const response = await post(seller, `/v1/admin/declutter/submissions/${id}/authorize`, {
      kind: 'approved',
    });
    expect(response.statusCode).toBe(403);
  });

  it('is not authorised by a moderator', async () => {
    const response = await post(moderator, `/v1/admin/declutter/submissions/${id}/authorize`, {
      kind: 'approved',
    });
    expect(response.statusCode).toBe(403);
  });

  it('refuses a super admin adjustment with no reason', async () => {
    const response = await post(admin, `/v1/admin/declutter/submissions/${id}/authorize`, {
      kind: 'adjusted',
      priceKobo: 70_000_000,
    });
    expect(response.statusCode).toBe(400);
  });

  it('authorises on the super admin’s approval', async () => {
    const response = await post(admin, `/v1/admin/declutter/submissions/${id}/authorize`, {
      kind: 'approved',
    });
    expect(response.statusCode).toBe(200);

    const after = await context.prisma.declutterSubmission.findUniqueOrThrow({ where: { id } });
    expect(after.valueCheckStatus).toBe('seller_acceptance_pending');
    expect(after.authorizedPriceKobo).toBeGreaterThanOrEqual(5_000_000);
    expect(after.authorizedBy).toBe(world.admin.identityId);
  });

  it('records the authorisation in the audit log', async () => {
    const audit = await context.prisma.auditLog.findFirst({
      where: { resourceId: id, action: 'declutter.pricing.authorized' },
    });
    expect(audit).not.toBeNull();
  });
});

describe('escalation on grounds other than price', () => {
  it('escalates a small price when the evidence is thin', async () => {
    provider.mode = 'ok';
    // No comparables at all: the confidence ceiling drops to the floor, which
    // is a risk signal however small the number.
    const category = await context.prisma.declutterCategory.findUniqueOrThrow({
      where: { key: 'home-furniture' },
    });
    const submission = await context.prisma.declutterSubmission.create({
      data: {
        code: `DCL-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        sellerId,
        status: 'valuation_pending',
        title: 'A sofa',
        condition: 'good',
        categoryId: category.id,
        expectedPriceKobo: 1_000_000,
      },
    });

    await post(admin, `/v1/admin/declutter/submissions/${submission.id}/valuecheck`);
    const response = await post(
      admin,
      `/v1/admin/declutter/submissions/${submission.id}/pricing-decision`,
      { kind: 'approved' },
    );

    expect(response.json().escalation).toContain('low_confidence');
    expect(response.json().valueCheckStatus).toBe('super_admin_approval_pending');
  });
});
