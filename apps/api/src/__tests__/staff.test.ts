/**
 * Staff, operations, and admin authorization tests.
 *
 * The staff console is where the widest permissions live, so this suite is
 * mostly about what each role *cannot* do. It also covers city scoping, which
 * is the one tenancy boundary that is not vendor- or rider-shaped.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '@dash/domain/crypto';
import { naira } from '@dash/domain/money';
import { createTestContext, type TestContext } from './harness.js';
import { actAs, buildWorld, idempotencyKey, WORLD_PASSWORD, type Actor, type World } from './world.js';

let context: TestContext;
let world: World;
let customerA: Actor;
let vendorA: Actor;
let riderA: Actor;
let support: Actor;
let finance: Actor;
let dispatcher: Actor;
let admin: Actor;

/** A second city, so city scoping can actually be violated in a test. */
let otherCityId: string;
let otherZoneId: string;
let otherBranchId: string;
let otherItemId: string;
let otherOrderId: string;
let otherDispatcher: Actor;

beforeAll(async () => {
  context = await createTestContext();
  world = await buildWorld(context.prisma);

  customerA = await actAs(context, world.customerA.email);
  vendorA = await actAs(context, world.vendorA.ownerEmail);
  riderA = await actAs(context, world.riderA.email);
  support = await actAs(context, world.support.email);
  finance = await actAs(context, world.finance.email);
  dispatcher = await actAs(context, world.dispatcher.email);
  admin = await actAs(context, world.admin.email);

  // --- A second city with its own vendor, order, and dispatcher --------------
  const city = await context.prisma.city.create({
    data: {
      slug: 'other-city',
      name: 'Other City',
      centreLatitude: 9.06,
      centreLongitude: 7.49,
      isLive: true,
    },
  });
  otherCityId = city.id;

  const zone = await context.prisma.zone.create({
    data: {
      cityId: city.id,
      name: 'Other Zone',
      slug: 'other-zone',
      polygon: JSON.stringify([
        [7.4, 9.0],
        [7.6, 9.0],
        [7.6, 9.2],
        [7.4, 9.2],
      ]),
      minLatitude: 9.0,
      maxLatitude: 9.2,
      minLongitude: 7.4,
      maxLongitude: 7.6,
      isActive: true,
    },
  });
  otherZoneId = zone.id;

  await context.prisma.pricingRule.create({
    data: {
      cityId: city.id,
      version: 'other.1',
      baseDeliveryFee: naira(400),
      includedMetres: 2000,
      perKilometreFee: naira(120),
      perMinuteFee: 0,
      minimumDeliveryFee: naira(300),
      maximumDeliveryFee: naira(3500),
      serviceFeeBasisPoints: 500,
      serviceFeeCap: naira(500),
      smallOrderThreshold: naira(2000),
      smallOrderFee: naira(200),
      taxBasisPoints: 0,
      maximumSurgeMultiplier: 2,
    },
  });

  const vendor = await context.prisma.vendor.create({
    data: {
      cityId: city.id,
      name: 'Other Vendor',
      slug: 'other-vendor',
      category: 'restaurant',
      status: 'approved',
      approvedAt: new Date(),
    },
  });
  const branch = await context.prisma.branch.create({
    data: {
      vendorId: vendor.id,
      zoneId: zone.id,
      name: 'Other Main',
      address: '1 Other Street',
      latitude: 9.06,
      longitude: 7.49,
      state: 'open',
      supportsDelivery: true,
    },
  });
  otherBranchId = branch.id;

  const category = await context.prisma.menuCategory.create({
    data: { vendorId: vendor.id, name: 'Mains' },
  });
  const item = await context.prisma.menuItem.create({
    data: {
      vendorId: vendor.id,
      categoryId: category.id,
      name: 'Other Dish',
      price: naira(2500),
      isAvailable: true,
    },
  });
  otherItemId = item.id;

  // An order in the other city, created directly — the point is the city, not
  // the checkout path, which `orders.test.ts` already covers.
  const otherCustomerIdentity = await context.prisma.identity.create({
    data: {
      email: 'other-customer@dashapp.test',
      displayName: 'Other Customer',
      passwordHash: await hashPassword(WORLD_PASSWORD),
      roles: { create: { role: 'customer' } },
    },
  });
  const otherCustomer = await context.prisma.customer.create({
    data: { identityId: otherCustomerIdentity.id, referralCode: 'REFOTHER' },
  });
  const otherAddress = await context.prisma.address.create({
    data: {
      customerId: otherCustomer.id,
      line1: '2 Other Street',
      contactPhone: '+2347009999999',
      latitude: 9.07,
      longitude: 7.5,
      isDefault: true,
    },
  });

  const order = await context.prisma.order.create({
    data: {
      code: 'DASH-OTHER1',
      customerId: otherCustomer.id,
      vendorId: vendor.id,
      branchId: branch.id,
      addressId: otherAddress.id,
      zoneId: zone.id,
      status: 'ready',
      mode: 'delivery',
      itemsSubtotal: naira(2500),
      total: naira(3200),
      quoteBreakdown: JSON.stringify({ lines: [], inputs: {} }),
      pricingRuleVersion: 'other.1',
    },
  });
  otherOrderId = order.id;

  const otherDispatcherIdentity = await context.prisma.identity.create({
    data: {
      email: 'other-dispatcher@dashapp.test',
      displayName: 'Other Dispatcher',
      passwordHash: await hashPassword(WORLD_PASSWORD),
      mfaEnrolledAt: new Date(),
      roles: { create: { role: 'dispatcher', cityId: city.id } },
    },
  });
  void otherDispatcherIdentity;
  otherDispatcher = await actAs(context, 'other-dispatcher@dashapp.test');
}, 180_000);

afterAll(async () => {
  await context?.close();
});

// ---------------------------------------------------------------------------
describe('city scoping', () => {
  it('shows a dispatcher only orders in their own city', async () => {
    const response = await context.app.inject({
      method: 'GET',
      url: '/v1/ops/live',
      headers: dispatcher.headers,
    });

    expect(response.statusCode).toBe(200);
    const { orders } = response.json<{ orders: { id: string }[] }>();
    expect(orders.some((order) => order.id === otherOrderId)).toBe(false);
  });

  // Reassignment is super admin only (`ops:order:override`), so a dispatcher
  // is refused it in every city, their own included, before scope is
  // consulted. Both answers are safe; neither reveals the order.
  it("refuses to let a dispatcher reassign another city's order", async () => {
    const response = await context.app.inject({
      method: 'POST',
      url: `/v1/ops/orders/${otherOrderId}/reassign`,
      headers: dispatcher.headers,
      payload: { reasonCode: 'rider_unresponsive' },
    });

    expect(response.statusCode).toBe(403);
  });

  it('refuses even the dispatcher for that city, and lets a super admin act on it', async () => {
    // Reassignment only makes sense for an order that actually has a rider.
    await context.prisma.order.update({
      where: { id: otherOrderId },
      data: { status: 'rider_assigned', riderId: world.riderB.riderId },
    });

    const byDispatcher = await context.app.inject({
      method: 'POST',
      url: `/v1/ops/orders/${otherOrderId}/reassign`,
      headers: otherDispatcher.headers,
      payload: { reasonCode: 'rider_unresponsive' },
    });
    expect(byDispatcher.statusCode).toBe(403);

    const byAdmin = await context.app.inject({
      method: 'POST',
      url: `/v1/ops/orders/${otherOrderId}/reassign`,
      headers: admin.headers,
      payload: { reasonCode: 'rider_unresponsive' },
    });
    expect(byAdmin.statusCode).toBe(200);
  });

  it('refuses to reassign an order that has no rider', async () => {
    await context.prisma.order.update({
      where: { id: otherOrderId },
      data: { status: 'ready', riderId: null },
    });

    const response = await context.app.inject({
      method: 'POST',
      url: `/v1/ops/orders/${otherOrderId}/reassign`,
      headers: admin.headers,
      payload: { reasonCode: 'other' },
    });
    expect(response.statusCode).toBe(409);
  });

  it("refuses to let a dispatcher pause another city's zone", async () => {
    const response = await context.app.inject({
      method: 'POST',
      url: `/v1/ops/zones/${otherZoneId}/pause`,
      headers: dispatcher.headers,
      payload: { paused: true, reason: 'trying it on' },
    });
    // A dispatcher lacks ops:zone:pause entirely, so this is a 403 before scope
    // is even consulted. Both answers are safe; neither reveals the zone.
    expect([403, 404]).toContain(response.statusCode);

    const zone = await context.prisma.zone.findUnique({
      where: { id: otherZoneId },
      select: { isActive: true },
    });
    expect(zone?.isActive).toBe(true);
  });

  it("refuses to let a city manager surge another city's zone", async () => {
    const identity = await context.prisma.identity.create({
      data: {
        email: 'city-manager-a@dashapp.test',
        displayName: 'City Manager A',
        passwordHash: await hashPassword(WORLD_PASSWORD),
        mfaEnrolledAt: new Date(),
        roles: { create: { role: 'city_manager', cityId: world.cityId } },
      },
    });
    void identity;
    const cityManager = await actAs(context, 'city-manager-a@dashapp.test');

    // Their own city: allowed.
    const own = await context.app.inject({
      method: 'POST',
      url: `/v1/ops/zones/${world.zoneId}/surge`,
      headers: cityManager.headers,
      payload: { multiplier: 1.5, reason: 'heavy rain' },
    });
    expect(own.statusCode).toBe(200);

    // Another city: refused.
    const foreign = await context.app.inject({
      method: 'POST',
      url: `/v1/ops/zones/${otherZoneId}/surge`,
      headers: cityManager.headers,
      payload: { multiplier: 2, reason: 'not my city' },
    });
    expect(foreign.statusCode).toBe(404);

    const zone = await context.prisma.zone.findUnique({
      where: { id: otherZoneId },
      select: { surgeMultiplier: true },
    });
    expect(zone?.surgeMultiplier).toBe(1);

    // Reset.
    await context.app.inject({
      method: 'POST',
      url: `/v1/ops/zones/${world.zoneId}/surge`,
      headers: cityManager.headers,
      payload: { multiplier: 1, reason: 'rain stopped' },
    });
  });

  it('caps surge at the city configuration, whatever is requested', async () => {
    const cityManager = await actAs(context, 'city-manager-a@dashapp.test');
    const response = await context.app.inject({
      method: 'POST',
      url: `/v1/ops/zones/${world.zoneId}/surge`,
      headers: cityManager.headers,
      payload: { multiplier: 2.9, reason: 'far too much' },
    });
    // Schema allows up to 3; the city rule caps at 2.
    expect(response.statusCode).toBe(422);
  });
});

// ---------------------------------------------------------------------------
describe('the live board', () => {
  it('is refused to a customer, vendor, and rider', async () => {
    for (const [label, actor] of [
      ['customer', customerA],
      ['vendor', vendorA],
      ['rider', riderA],
    ] as const) {
      const response = await context.app.inject({
        method: 'GET',
        url: '/v1/ops/live',
        headers: actor.headers,
      });
      expect(response.statusCode, label).toBe(403);
    }
  });

  it('never exposes a customer phone number to operations', async () => {
    const response = await context.app.inject({
      method: 'GET',
      url: '/v1/ops/live',
      headers: dispatcher.headers,
    });
    expect(response.body).not.toContain(world.customerA.phone);
  });
});

// ---------------------------------------------------------------------------
describe('support cases', () => {
  it('is refused to a customer, vendor, and rider', async () => {
    for (const [label, actor] of [
      ['customer', customerA],
      ['vendor', vendorA],
      ['rider', riderA],
    ] as const) {
      const response = await context.app.inject({
        method: 'GET',
        url: '/v1/support/cases',
        headers: actor.headers,
      });
      expect(response.statusCode, label).toBe(403);
    }
  });

  it('is allowed to a support agent', async () => {
    const response = await context.app.inject({
      method: 'GET',
      url: '/v1/support/cases',
      headers: support.headers,
    });
    expect(response.statusCode).toBe(200);
  });

  it('returns 404 for a nonexistent case rather than leaking its absence differently', async () => {
    await context.prisma.session.updateMany({
      where: { identityId: world.support.identityId, revokedAt: null },
      data: { steppedUpAt: new Date() },
    });

    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/support/cases/no-such-case/compensate',
      headers: support.headers,
      payload: { amount: 1000, reason: 'a case that does not exist' },
    });
    expect(response.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
describe('audit log', () => {
  it('is refused to every non-admin role', async () => {
    for (const [label, actor] of [
      ['customer', customerA],
      ['vendor', vendorA],
      ['rider', riderA],
      ['support', support],
      ['finance', finance],
      ['dispatcher', dispatcher],
    ] as const) {
      const response = await context.app.inject({
        method: 'GET',
        url: '/v1/admin/audit',
        headers: actor.headers,
      });
      expect(response.statusCode, label).toBe(403);
    }
  });

  it('is readable by an admin and records real actions', async () => {
    // Generate an auditable action first.
    await context.app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: { ...customerA.headers, 'idempotency-key': idempotencyKey('audit') },
      payload: {
        branchId: world.vendorA.branchId,
        items: [
          { itemId: world.vendorA.itemId, quantity: 1, modifierIds: [world.vendorA.modifierId] },
        ],
        mode: 'delivery',
        addressId: world.customerA.addressId,
        paymentMethod: 'card',
      },
    });

    const response = await context.app.inject({
      method: 'GET',
      url: '/v1/admin/audit?action=order.created',
      headers: admin.headers,
    });

    expect(response.statusCode).toBe(200);
    const { logs } = response.json<{ logs: { action: string }[] }>();
    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0]?.action).toContain('order');
  });

  it('never contains a token, password hash, or PIN', async () => {
    const response = await context.app.inject({
      method: 'GET',
      url: '/v1/admin/audit?limit=200',
      headers: admin.headers,
    });

    const body = response.body;
    expect(body).not.toContain('passwordHash');
    expect(body).not.toContain('refreshToken');
    expect(body).not.toContain('deliveryPinHash');
    expect(body).not.toMatch(/\bs1\$[0-9a-f]{32}\$/);
  });
});

// ---------------------------------------------------------------------------
describe('feature flags', () => {
  it('are refused to every non-admin role', async () => {
    for (const [label, actor] of [
      ['customer', customerA],
      ['vendor', vendorA],
      ['rider', riderA],
      ['support', support],
      ['finance', finance],
      ['dispatcher', dispatcher],
    ] as const) {
      const response = await context.app.inject({
        method: 'GET',
        url: '/v1/admin/feature-flags',
        headers: actor.headers,
      });
      expect(response.statusCode, label).toBe(403);
    }
  });

  it('cannot be mutated by a non-admin', async () => {
    await context.prisma.featureFlag.create({
      data: { key: 'test_flag', description: 'test', isEnabled: false },
    });

    const response = await context.app.inject({
      method: 'PATCH',
      url: '/v1/admin/feature-flags/test_flag',
      headers: finance.headers,
      payload: { isEnabled: true },
    });
    expect(response.statusCode).toBe(403);

    const flag = await context.prisma.featureFlag.findUnique({ where: { key: 'test_flag' } });
    expect(flag?.isEnabled).toBe(false);
  });

  it('is mutable by an admin and audit-logged', async () => {
    const response = await context.app.inject({
      method: 'PATCH',
      url: '/v1/admin/feature-flags/test_flag',
      headers: admin.headers,
      payload: { isEnabled: true },
    });
    expect(response.statusCode).toBe(200);

    const audit = await context.prisma.auditLog.findFirst({
      where: { action: 'admin.feature_flag.updated', resourceId: 'test_flag' },
    });
    expect(audit).not.toBeNull();
  });

  it('returns 404 for an unknown flag', async () => {
    const response = await context.app.inject({
      method: 'PATCH',
      url: '/v1/admin/feature-flags/no-such-flag',
      headers: admin.headers,
      payload: { isEnabled: true },
    });
    expect(response.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
describe('role separation among staff', () => {
  it('does not let a dispatcher touch money', async () => {
    const order = await context.prisma.order.findFirst({
      where: { payments: { some: { status: 'captured' } } },
      select: { id: true },
    });

    const response = await context.app.inject({
      method: 'POST',
      url: `/v1/finance/orders/${order!.id}/refund`,
      headers: dispatcher.headers,
      payload: { amount: 100, reason: 'dispatchers do not refund' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('does not let a finance analyst issue support compensation', async () => {
    const supportCase = await context.prisma.supportCase.create({
      data: {
        code: 'CASE-FINANCE',
        customerId: world.customerA.customerId,
        subject: 'Test',
        category: 'refund',
        status: 'open',
      },
    });

    const response = await context.app.inject({
      method: 'POST',
      url: `/v1/support/cases/${supportCase.id}/compensate`,
      headers: finance.headers,
      payload: { amount: 1000, reason: 'wrong role for this' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('does not let a support agent approve their own refund request', async () => {
    // Requesting and approving are deliberately separate permissions.
    const order = await context.prisma.order.findFirst({
      where: { payments: { some: { status: 'captured' } } },
      select: { id: true },
    });

    const response = await context.app.inject({
      method: 'POST',
      url: `/v1/finance/orders/${order!.id}/refund`,
      headers: support.headers,
      payload: { amount: 100, reason: 'support cannot approve' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('does not let a dispatcher read the ledger', async () => {
    const response = await context.app.inject({
      method: 'GET',
      url: '/v1/finance/ledger/integrity',
      headers: dispatcher.headers,
    });
    expect(response.statusCode).toBe(403);
  });
});

// ---------------------------------------------------------------------------
describe('staff cannot use business endpoints they have no business using', () => {
  it('a dispatcher cannot place an order', async () => {
    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: { ...dispatcher.headers, 'idempotency-key': idempotencyKey('staff') },
      payload: {
        branchId: world.vendorA.branchId,
        items: [
          { itemId: world.vendorA.itemId, quantity: 1, modifierIds: [world.vendorA.modifierId] },
        ],
        mode: 'delivery',
        addressId: world.customerA.addressId,
        paymentMethod: 'card',
      },
    });
    expect(response.statusCode).toBe(403);
  });

  it('records an admin acting on a vendor order as ops, not as the vendor', async () => {
    // A super admin holds every permission and is bound to no vendor, so the
    // vendor scope check does not apply to them. That is the intended
    // operational escape hatch — ops must be able to unstick a stalled order.
    //
    // What must NOT happen is the record claiming the vendor did it. The event
    // and the audit entry previously hardcoded `vendor`, so an admin's
    // intervention was indistinguishable from the vendor's own action — which
    // is exactly the record a vendor would later dispute.
    const created = await context.app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: { ...customerA.headers, 'idempotency-key': idempotencyKey('escape') },
      payload: {
        branchId: world.vendorA.branchId,
        items: [
          { itemId: world.vendorA.itemId, quantity: 1, modifierIds: [world.vendorA.modifierId] },
        ],
        mode: 'delivery',
        addressId: world.customerA.addressId,
        paymentMethod: 'card',
      },
    });
    const orderId = created.json<{ order: { id: string } }>().order.id;

    const response = await context.app.inject({
      method: 'POST',
      url: `/v1/vendor/orders/${orderId}/accept`,
      headers: admin.headers,
      payload: { prepMinutes: 20 },
    });
    expect(response.statusCode).toBe(200);

    const event = await context.prisma.orderStatusEvent.findFirst({
      where: { orderId, toStatus: 'accepted' },
      select: { actorType: true, actorId: true },
    });
    expect(event?.actorType).toBe('ops');
    expect(event?.actorId).toBe(world.admin.identityId);

    const audit = await context.prisma.auditLog.findFirst({
      where: { resourceId: orderId, action: 'ops.order.accepted' },
    });
    expect(audit).not.toBeNull();
  });

  it('still records a real vendor accepting as vendor', async () => {
    const created = await context.app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: { ...customerA.headers, 'idempotency-key': idempotencyKey('normal') },
      payload: {
        branchId: world.vendorA.branchId,
        items: [
          { itemId: world.vendorA.itemId, quantity: 1, modifierIds: [world.vendorA.modifierId] },
        ],
        mode: 'delivery',
        addressId: world.customerA.addressId,
        paymentMethod: 'card',
      },
    });
    const orderId = created.json<{ order: { id: string } }>().order.id;

    await context.app.inject({
      method: 'POST',
      url: `/v1/vendor/orders/${orderId}/accept`,
      headers: vendorA.headers,
      payload: { prepMinutes: 20 },
    });

    const event = await context.prisma.orderStatusEvent.findFirst({
      where: { orderId, toStatus: 'accepted' },
      select: { actorType: true },
    });
    expect(event?.actorType).toBe('vendor');
  });

  it('a support agent cannot set rider availability', async () => {
    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/rider/availability',
      headers: support.headers,
      payload: { availability: 'idle' },
    });
    expect(response.statusCode).toBe(403);
  });
});

// ---------------------------------------------------------------------------
describe('other-city data is invisible', () => {
  it('does not leak the other city’s branch through the vendor catalogue', async () => {
    // Public catalogue is city-agnostic by design, but the order path must
    // still price against the right city's rules.
    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/orders/quote',
      headers: customerA.headers,
      payload: {
        branchId: otherBranchId,
        items: [{ itemId: otherItemId, quantity: 1, modifierIds: [] }],
        mode: 'delivery',
        addressId: world.customerA.addressId,
      },
    });

    // The address is 300km from the branch, so the quote is either refused or
    // priced at the distance cap — but it must never be free or negative.
    if (response.statusCode === 200) {
      const { quote } = response.json<{ quote: { total: number; deliveryFee: number } }>();
      expect(quote.total).toBeGreaterThan(0);
      expect(quote.deliveryFee).toBeGreaterThan(0);
    } else {
      expect([404, 422]).toContain(response.statusCode);
    }
  });

  it('keeps the other city’s order out of the first city’s dispatcher view', async () => {
    const response = await context.app.inject({
      method: 'GET',
      url: '/v1/ops/live',
      headers: dispatcher.headers,
    });
    const { orders } = response.json<{ orders: { id: string }[] }>();

    const ids = orders.map((order) => order.id);
    if (ids.length > 0) {
      const foreign = await context.prisma.order.count({
        where: { id: { in: ids }, vendor: { cityId: otherCityId } },
      });
      expect(foreign).toBe(0);
    }
  });
});
