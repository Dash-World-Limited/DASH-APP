/**
 * Vendor and rider onboarding — integration tests.
 *
 * The founder approves every early vendor and rider by hand. What these tests
 * hold is that approval is the *only* way in: an application grants nothing,
 * a client cannot talk its way into a role, only a stepped-up administrator
 * can decide, and a suspension takes effect on the very next request.
 *
 * And one rule about words: a phone number collected at signup is never
 * described as verified, because nothing in V1 verifies one.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { hashPassword } from '@dash/domain/crypto';
import { PHONE_UNVERIFIED_NOTICE } from '@dash/domain/onboarding';
import { createTestContext, type TestContext } from './harness.js';
import { actAs, buildWorld, WORLD_PASSWORD, type Actor, type World } from './world.js';

let context: TestContext;
let world: World;
let citySlug: string;
let admin: Actor;
let support: Actor;
let passwordHash: string;
let counter = 0;

beforeAll(async () => {
  vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
  context = await createTestContext();
  world = await buildWorld(context.prisma);
  citySlug = (await context.prisma.city.findUniqueOrThrow({ where: { id: world.cityId } })).slug;
  passwordHash = await hashPassword(WORLD_PASSWORD);
  admin = await actAs(context, world.admin.email);
  support = await actAs(context, world.support.email);
}, 180_000);

afterAll(async () => {
  await context?.close();
});

/** A person who signed up normally: proved email, unproved phone, customer role. */
async function applicant(options: { verified?: boolean } = {}): Promise<{ actor: Actor; identityId: string; email: string }> {
  counter += 1;
  const email = `applicant-${counter}-${Date.now()}@dashapp.test`;
  const identity = await context.prisma.identity.create({
    data: {
      email,
      emailVerifiedAt: options.verified === false ? null : new Date(),
      phone: `+23480${String(Date.now()).slice(-6)}${String(counter).padStart(2, '0')}`,
      displayName: `Applicant ${counter}`,
      passwordHash,
      roles: { create: { role: 'customer' } },
    },
  });
  return { actor: await actAs(context, email), identityId: identity.id, email };
}

async function stepUpAdmin(): Promise<void> {
  await context.prisma.session.updateMany({
    where: { identityId: world.admin.identityId, revokedAt: null },
    data: { steppedUpAt: new Date() },
  });
}

async function clearAdminStepUp(): Promise<void> {
  await context.prisma.session.updateMany({ where: { identityId: world.admin.identityId }, data: { steppedUpAt: null } });
}

const vendorApplication = (overrides: Record<string, unknown> = {}) => ({
  businessName: 'Mama Put Kitchen',
  category: 'restaurant',
  citySlug,
  branch: { address: '12 Admiralty Way, Lekki', latitude: 6.5, longitude: 3.45 },
  ...overrides,
});

function inject(actor: Actor, method: 'GET' | 'POST', url: string, payload?: unknown) {
  return context.app.inject({ method, url, headers: actor.headers, ...(payload === undefined ? {} : { payload: payload as object }) });
}

async function applyAsVendor(actor: Actor): Promise<string> {
  const response = await inject(actor, 'POST', '/v1/vendor/applications', vendorApplication());
  expect(response.statusCode, response.body).toBe(201);
  return response.json<{ application: { vendorId: string } }>().application.vendorId;
}

async function decideVendor(vendorId: string, decision: string, reason?: string) {
  return inject(admin, 'POST', `/v1/admin/vendors/${vendorId}/decision`, { decision, ...(reason ? { reason } : {}) });
}

// ---------------------------------------------------------------------------

describe('a vendor application', () => {
  it('is refused until the email address is proved', async () => {
    const { actor } = await applicant({ verified: false });
    const response = await inject(actor, 'POST', '/v1/vendor/applications', vendorApplication());
    expect(response.statusCode).toBe(403);
  });

  it('is recorded as pending admin approval and grants nothing', async () => {
    const { actor, identityId } = await applicant();
    const response = await inject(actor, 'POST', '/v1/vendor/applications', vendorApplication());
    expect(response.statusCode).toBe(201);

    const body = response.json<{ application: { status: { code: string; label: string }; insideServiceArea: boolean } }>();
    expect(body.application.status).toEqual({ code: 'pending_admin_approval', label: 'Pending admin approval' });
    expect(body.application.insideServiceArea).toBe(true);

    // No role row, and the vendor tools refuse.
    expect(await context.prisma.identityRole.count({ where: { identityId, role: 'vendor_owner' } })).toBe(0);
    expect((await inject(actor, 'GET', '/v1/vendor/dashboard')).statusCode).toBe(403);
  });

  it('keeps the store closed and out of the catalogue while pending', async () => {
    const { actor } = await applicant();
    const vendorId = await applyAsVendor(actor);
    const branch = await context.prisma.branch.findFirstOrThrow({ where: { vendorId } });
    expect(branch.state).toBe('closed');

    const vendor = await context.prisma.vendor.findUniqueOrThrow({ where: { id: vendorId }, select: { slug: true } });
    expect((await context.app.inject({ method: 'GET', url: `/v1/vendors/${vendor.slug}` })).statusCode).toBe(404);
  });

  it('refuses a second live application from the same person', async () => {
    const { actor } = await applicant();
    await applyAsVendor(actor);
    expect((await inject(actor, 'POST', '/v1/vendor/applications', vendorApplication())).statusCode).toBe(409);
  });

  it('refuses a category outside the merchant vocabulary', async () => {
    const { actor } = await applicant();
    for (const category of ['declutter', 'casino', '']) {
      const response = await inject(actor, 'POST', '/v1/vendor/applications', vendorApplication({ category }));
      expect(response.statusCode, category).toBe(400);
    }
  });

  it('ignores any role or status the client tries to set', async () => {
    const { actor, identityId } = await applicant();
    const response = await inject(actor, 'POST', '/v1/vendor/applications', vendorApplication({ status: 'approved', roles: ['vendor_owner'] }));
    expect(response.statusCode).toBe(201);
    const vendorId = response.json<{ application: { vendorId: string } }>().application.vendorId;
    expect((await context.prisma.vendor.findUniqueOrThrow({ where: { id: vendorId } })).status).toBe('pending');
    expect(await context.prisma.identityRole.count({ where: { identityId, role: 'vendor_owner' } })).toBe(0);
  });

  it('shows the phone as unverified, in the fixed words, and never as verified', async () => {
    const { actor } = await applicant();
    await applyAsVendor(actor);
    const response = await inject(actor, 'GET', '/v1/vendor/application');
    const phone = response.json<{ phone: { verification: string; notice: string; required: boolean } }>().phone;
    expect(phone.verification).toBe('unverified');
    expect(phone.notice).toBe(PHONE_UNVERIFIED_NOTICE);
    expect(phone.required).toBe(false);
    expect(response.body).not.toMatch(/"verification":"verified"/);
  });
});

describe('deciding a vendor application', () => {
  it('is refused to a customer, a vendor applicant, and support staff', async () => {
    const { actor } = await applicant();
    const vendorId = await applyAsVendor(actor);
    const customer = await actAs(context, world.customerA.email);
    for (const who of [customer, actor, support]) {
      expect((await inject(who, 'GET', '/v1/admin/vendor-applications')).statusCode).toBe(403);
      expect((await inject(who, 'POST', `/v1/admin/vendors/${vendorId}/decision`, { decision: 'approve' })).statusCode).toBe(403);
    }
    expect((await context.prisma.vendor.findUniqueOrThrow({ where: { id: vendorId } })).status).toBe('pending');
  });

  it('needs a recent step-up even for a super admin', async () => {
    const { actor } = await applicant();
    const vendorId = await applyAsVendor(actor);
    await clearAdminStepUp();
    expect((await decideVendor(vendorId, 'approve')).statusCode).toBe(403);
    expect((await context.prisma.vendor.findUniqueOrThrow({ where: { id: vendorId } })).status).toBe('pending');
  });

  it('lists pending applications with the owner and an unverified phone', async () => {
    const { actor, email } = await applicant();
    const vendorId = await applyAsVendor(actor);
    await stepUpAdmin();
    const response = await inject(admin, 'GET', '/v1/admin/vendor-applications?status=pending&limit=100');
    expect(response.statusCode).toBe(200);
    const row = response
      .json<{ applications: { vendorId: string; owner: { email: string; phone: { verification: string } } }[] }>()
      .applications.find((a) => a.vendorId === vendorId);
    expect(row?.owner.email).toBe(email);
    expect(row?.owner.phone.verification).toBe('unverified');
  });

  it('approves: grants the vendor role, audits it, and opens the vendor tools on the same session', async () => {
    const { actor, identityId } = await applicant();
    const vendorId = await applyAsVendor(actor);
    await stepUpAdmin();

    const response = await decideVendor(vendorId, 'approve');
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<{ status: { code: string } }>().status.code).toBe('approved');

    const role = await context.prisma.identityRole.findFirst({ where: { identityId, role: 'vendor_owner', vendorId } });
    expect(role?.grantedBy).toBe(world.admin.identityId);
    expect(await context.prisma.auditLog.count({ where: { action: 'vendor.approve', resourceId: vendorId } })).toBe(1);

    // No re-login: permissions are read from the database on every request.
    expect((await inject(actor, 'GET', '/v1/vendor/dashboard')).statusCode).toBe(200);
    // Approval does not open the shop; the owner does.
    expect((await context.prisma.branch.findFirstOrThrow({ where: { vendorId } })).state).toBe('closed');
  });

  it('refuses to approve twice, and refuses an impossible transition', async () => {
    const { actor } = await applicant();
    const vendorId = await applyAsVendor(actor);
    await stepUpAdmin();
    expect((await decideVendor(vendorId, 'approve')).statusCode).toBe(200);
    expect((await decideVendor(vendorId, 'approve')).statusCode).toBe(409);
    expect((await decideVendor(vendorId, 'reinstate')).statusCode).toBe(409);
  });

  it('needs a reason to reject, and tells the applicant', async () => {
    const { actor, identityId } = await applicant();
    const vendorId = await applyAsVendor(actor);
    await stepUpAdmin();
    expect((await decideVendor(vendorId, 'reject')).statusCode).toBe(400);
    expect((await decideVendor(vendorId, 'reject', 'We cannot deliver to that area yet.')).statusCode).toBe(200);

    const mine = await inject(actor, 'GET', '/v1/vendor/application');
    expect(mine.json<{ application: { status: { code: string }; reason: string } }>().application).toMatchObject({
      status: { code: 'rejected' },
      reason: 'We cannot deliver to that area yet.',
    });
    expect(await context.prisma.identityRole.count({ where: { identityId, role: 'vendor_owner' } })).toBe(0);
    // A rejection does not block a fresh application.
    expect((await inject(actor, 'POST', '/v1/vendor/applications', vendorApplication())).statusCode).toBe(201);
  });

  it('suspends with immediate effect, closes the store, and reinstates', async () => {
    const { actor } = await applicant();
    const vendorId = await applyAsVendor(actor);
    await stepUpAdmin();
    await decideVendor(vendorId, 'approve');
    await context.prisma.branch.updateMany({ where: { vendorId }, data: { state: 'open' } });
    expect((await inject(actor, 'GET', '/v1/vendor/dashboard')).statusCode).toBe(200);

    expect((await decideVendor(vendorId, 'suspend')).statusCode).toBe(400);
    expect((await decideVendor(vendorId, 'suspend', 'Food safety complaint under review.')).statusCode).toBe(200);

    // Same access token, next request: refused.
    expect((await inject(actor, 'GET', '/v1/vendor/dashboard')).statusCode).toBe(403);
    expect((await context.prisma.branch.findFirstOrThrow({ where: { vendorId } })).state).toBe('closed');

    expect((await decideVendor(vendorId, 'reinstate')).statusCode).toBe(200);
    expect((await inject(actor, 'GET', '/v1/vendor/dashboard')).statusCode).toBe(200);
    // Reinstatement did not duplicate the role.
    expect(await context.prisma.identityRole.count({ where: { vendorId, role: 'vendor_owner' } })).toBe(1);
  });

  it('lets exactly one of two simultaneous decisions win', async () => {
    const { actor } = await applicant();
    const vendorId = await applyAsVendor(actor);
    await stepUpAdmin();
    const results = await Promise.all([decideVendor(vendorId, 'approve'), decideVendor(vendorId, 'reject', 'Duplicate listing.')]);
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes).toEqual([200, 409]);
  });
});

describe('a rider application', () => {
  it('is pending, grants no rider access, and is visible on /me', async () => {
    const { actor } = await applicant();
    const response = await inject(actor, 'POST', '/v1/rider/applications', { vehicleType: 'motorcycle', vehiclePlate: 'LSD-123XY' });
    expect(response.statusCode, response.body).toBe(201);

    expect((await inject(actor, 'GET', '/v1/rider/offers')).statusCode).toBe(403);
    const me = (await inject(actor, 'GET', '/v1/auth/me')).json<{ riderStatus: string; riderId: string | null; roles: string[] }>();
    expect(me.riderStatus).toBe('pending');
    expect(me.riderId).not.toBeNull();
    expect(me.roles).not.toContain('rider');
  });

  it('once approved, a customer-turned-rider can go online exactly as the app does', async () => {
    const { actor } = await applicant();
    const applied = await inject(actor, 'POST', '/v1/rider/applications', { vehicleType: 'motorcycle' });
    const riderId = applied.json<{ application: { riderId: string } }>().application.riderId;
    await stepUpAdmin();
    expect((await inject(admin, 'POST', `/v1/admin/riders/${riderId}/decision`, { decision: 'approve' })).statusCode).toBe(200);

    // The app's Go online: availability, then the first fix, on the same session.
    const online = await inject(actor, 'POST', '/v1/rider/availability', { availability: 'idle' });
    expect(online.statusCode, online.body).toBe(200);
    const located = await inject(actor, 'POST', '/v1/rider/location', { latitude: 6.2059, longitude: 6.6959, accuracy: 35 });
    expect(located.statusCode, located.body).toBe(200);
    expect(located.json<{ accepted: boolean }>().accepted).toBe(true);

    const rider = await context.prisma.rider.findUniqueOrThrow({ where: { id: riderId } });
    expect(rider.availability).toBe('idle');
    expect(rider.onlineUntil).not.toBeNull();
    expect(rider.locationReportedAt).not.toBeNull();
  });

  it('is approved by a stepped-up admin, and suspension withdraws access at once', async () => {
    const { actor, identityId } = await applicant();
    const applied = await inject(actor, 'POST', '/v1/rider/applications', { vehicleType: 'bicycle' });
    const riderId = applied.json<{ application: { riderId: string } }>().application.riderId;

    // Not by a customer, and not without step-up.
    const customer = await actAs(context, world.customerA.email);
    expect((await inject(customer, 'POST', `/v1/admin/riders/${riderId}/decision`, { decision: 'approve' })).statusCode).toBe(403);
    await clearAdminStepUp();
    expect((await inject(admin, 'POST', `/v1/admin/riders/${riderId}/decision`, { decision: 'approve' })).statusCode).toBe(403);

    await stepUpAdmin();
    expect((await inject(admin, 'POST', `/v1/admin/riders/${riderId}/decision`, { decision: 'approve' })).statusCode).toBe(200);
    expect(await context.prisma.identityRole.count({ where: { identityId, role: 'rider' } })).toBe(1);
    expect((await inject(actor, 'GET', '/v1/rider/offers')).statusCode).toBe(200);

    const suspended = await inject(admin, 'POST', `/v1/admin/riders/${riderId}/decision`, { decision: 'suspend', reason: 'Documents expired.' });
    expect(suspended.statusCode).toBe(200);
    expect((await inject(actor, 'GET', '/v1/rider/offers')).statusCode).toBe(403);
    expect((await context.prisma.rider.findUniqueOrThrow({ where: { id: riderId } })).availability).toBe('offline');
  });

  it('suspension releases the rider’s open offers back to dispatch', async () => {
    // The suspended rider can no longer answer, so the order must not wait out
    // the offer clock on their behalf.
    const { actor } = await applicant();
    const applied = await inject(actor, 'POST', '/v1/rider/applications', { vehicleType: 'motorcycle' });
    const riderId = applied.json<{ application: { riderId: string } }>().application.riderId;
    await stepUpAdmin();
    await inject(admin, 'POST', `/v1/admin/riders/${riderId}/decision`, { decision: 'approve' });

    const order = await context.prisma.order.create({
      data: {
        code: `DASH-ONB-${Date.now()}`,
        customerId: world.customerA.customerId,
        vendorId: world.vendorA.vendorId,
        branchId: world.vendorA.branchId,
        addressId: world.customerA.addressId,
        zoneId: world.zoneId,
        status: 'preparing',
        mode: 'delivery',
        itemsSubtotal: 100_000,
        total: 100_000,
        quoteBreakdown: '{}',
        pricingRuleVersion: 'test',
      },
    });
    const offer = await context.prisma.dispatchOffer.create({
      data: {
        orderId: order.id,
        riderId,
        score: 1,
        scoreBreakdown: '{}',
        ruleVersion: 'test',
        pickupEtaSeconds: 300,
        pickupDistanceMetres: 1000,
        expiresAt: new Date(Date.now() + 90_000),
      },
    });

    const response = await inject(admin, 'POST', `/v1/admin/riders/${riderId}/decision`, { decision: 'suspend', reason: 'Investigation.' });
    expect(response.statusCode).toBe(200);

    expect((await context.prisma.dispatchOffer.findUniqueOrThrow({ where: { id: offer.id } })).status).toBe('withdrawn');
    const requeued = await context.prisma.outboxEvent.findMany({ where: { name: 'dispatch.find_rider' }, select: { payload: true } });
    expect(requeued.some((event) => event.payload.includes(order.id))).toBe(true);
  });

  it('refuses a second application while one is live', async () => {
    const { actor } = await applicant();
    expect((await inject(actor, 'POST', '/v1/rider/applications', { vehicleType: 'car' })).statusCode).toBe(201);
    expect((await inject(actor, 'POST', '/v1/rider/applications', { vehicleType: 'car' })).statusCode).toBe(409);
  });
});

describe('/v1/auth/me and the phone number', () => {
  it('never reports a phone as verified', async () => {
    const { actor } = await applicant();
    const me = await inject(actor, 'GET', '/v1/auth/me');
    const phone = me.json<{ phone: { verification: string; notice: string } }>().phone;
    expect(phone.verification).toBe('unverified');
    expect(phone.notice).toBe(PHONE_UNVERIFIED_NOTICE);
  });

  it('reports verification as required only when the flag is switched on', async () => {
    const { actor } = await applicant();
    await context.prisma.featureFlag.upsert({
      where: { key: 'phone_verification_required' },
      create: { key: 'phone_verification_required', isEnabled: true },
      update: { isEnabled: true },
    });
    try {
      const phone = (await inject(actor, 'GET', '/v1/auth/me')).json<{ phone: { required: boolean; verification: string } }>().phone;
      expect(phone.required).toBe(true);
      // Required is not the same as done.
      expect(phone.verification).toBe('unverified');
    } finally {
      await context.prisma.featureFlag.update({ where: { key: 'phone_verification_required' }, data: { isEnabled: false } });
    }
  });
});
