/**
 * A minimal but complete business world for integration tests.
 *
 * Deliberately small: two vendors, two customers, two riders, one of each staff
 * role. That is the smallest set that can express every authorization question
 * worth asking — "can vendor A touch vendor B's order?", "can rider A modify
 * rider B's job?", "can a customer read another customer's order?" — and a
 * bigger world would only make failures harder to read.
 *
 * Everything here is fictional. Phone numbers use the reserved-style +234 700
 * block that cannot ring a real handset.
 */

import type { PrismaClient } from '@prisma/client';
import { ensureRidersAreCustomers } from '@dash/db';
import { hashPassword, generateReference } from '@dash/domain/crypto';
import { naira } from '@dash/domain/money';
import { signInWithPassword, type TestContext } from './harness.js';
import { CSRF_COOKIE } from '../auth/cookies.js';

export const WORLD_PASSWORD = 'WorldFixture!2026';

/** A zone covering the coordinates every fixture uses. */
const ZONE_RING = [
  [3.30, 6.40],
  [3.60, 6.40],
  [3.60, 6.70],
  [3.30, 6.70],
];

export interface WorldVendor {
  vendorId: string;
  branchId: string;
  itemId: string;
  /** A required single-select modifier group on `itemId`. */
  modifierGroupId: string;
  modifierId: string;
  ownerIdentityId: string;
  ownerEmail: string;
  slug: string;
}

export interface WorldCustomer {
  identityId: string;
  customerId: string;
  addressId: string;
  email: string;
  phone: string;
}

export interface WorldRider {
  identityId: string;
  riderId: string;
  email: string;
  phone: string;
}

export interface WorldStaff {
  identityId: string;
  email: string;
}

export interface World {
  cityId: string;
  zoneId: string;
  vendorA: WorldVendor;
  vendorB: WorldVendor;
  customerA: WorldCustomer;
  customerB: WorldCustomer;
  riderA: WorldRider;
  riderB: WorldRider;
  support: WorldStaff;
  finance: WorldStaff;
  dispatcher: WorldStaff;
  admin: WorldStaff;
}

let counter = 0;
const unique = (): string => {
  counter += 1;
  return String(counter).padStart(3, '0');
};

export async function buildWorld(prisma: PrismaClient): Promise<World> {
  // One hash, reused. scrypt is deliberately slow; hashing ten identities
  // separately would add a second to every suite for no benefit.
  const passwordHash = await hashPassword(WORLD_PASSWORD);

  const city = await prisma.city.create({
    data: {
      slug: `test-city-${unique()}`,
      name: 'Test City',
      centreLatitude: 6.5,
      centreLongitude: 3.4,
      isLive: true,
    },
  });

  const zone = await prisma.zone.create({
    data: {
      cityId: city.id,
      name: 'Test Zone',
      slug: `test-zone-${unique()}`,
      polygon: JSON.stringify(ZONE_RING),
      minLatitude: 6.4,
      maxLatitude: 6.7,
      minLongitude: 3.3,
      maxLongitude: 3.6,
      isActive: true,
    },
  });

  await prisma.pricingRule.create({
    data: {
      cityId: city.id,
      version: 'test.1',
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

  async function makeVendor(label: string): Promise<WorldVendor> {
    const suffix = unique();
    const slug = `vendor-${label}-${suffix}`;

    const vendor = await prisma.vendor.create({
      data: {
        cityId: city.id,
        name: `Vendor ${label}`,
        slug,
        category: 'restaurant',
        status: 'approved',
        approvedAt: new Date(),
        commissionBasisPoints: 1800,
      },
    });

    const branch = await prisma.branch.create({
      data: {
        vendorId: vendor.id,
        zoneId: zone.id,
        name: `${label} Main`,
        address: `${suffix} Test Street`,
        latitude: 6.5,
        longitude: 3.4,
        state: 'open',
        minimumOrder: 0,
        defaultPrepMinutes: 20,
        supportsDelivery: true,
        supportsPickup: true,
      },
    });

    const category = await prisma.menuCategory.create({
      data: { vendorId: vendor.id, name: 'Mains' },
    });

    const item = await prisma.menuItem.create({
      data: {
        vendorId: vendor.id,
        categoryId: category.id,
        name: `${label} Dish`,
        price: naira(3000),
        prepMinutes: 15,
        isAvailable: true,
      },
    });

    // A required single-select group, so tests can exercise modifier validation.
    const group = await prisma.modifierGroup.create({
      data: { itemId: item.id, name: 'Protein', minSelect: 1, maxSelect: 1 },
    });
    const modifier = await prisma.modifier.create({
      data: { groupId: group.id, name: 'Chicken', priceDelta: naira(1000) },
    });

    await prisma.itemStock.create({
      data: { itemId: item.id, branchId: branch.id, quantity: null, isAvailable: true },
    });

    const ownerEmail = `owner-${slug}@dashapp.test`;
    const owner = await prisma.identity.create({
      data: {
        email: ownerEmail,
        displayName: `Owner ${label}`,
        passwordHash,
        roles: { create: { role: 'vendor_owner', vendorId: vendor.id } },
      },
    });
    await prisma.vendorUser.create({
      data: {
        vendorId: vendor.id,
        identityId: owner.id,
        role: 'vendor_owner',
        acceptedAt: new Date(),
      },
    });

    return {
      vendorId: vendor.id,
      branchId: branch.id,
      itemId: item.id,
      modifierGroupId: group.id,
      modifierId: modifier.id,
      ownerIdentityId: owner.id,
      ownerEmail,
      slug,
    };
  }

  async function makeCustomer(label: string): Promise<WorldCustomer> {
    const suffix = unique();
    const email = `customer-${label}-${suffix}@dashapp.test`;
    const phone = `+2347001${suffix.padStart(6, '0')}`;

    const identity = await prisma.identity.create({
      data: {
        email,
        phone,
        displayName: `Customer ${label}`,
        passwordHash,
        roles: { create: { role: 'customer' } },
      },
    });

    const customer = await prisma.customer.create({
      data: { identityId: identity.id, referralCode: generateReference('REF') },
    });

    const address = await prisma.address.create({
      data: {
        customerId: customer.id,
        label: 'Home',
        line1: `${suffix} Customer Road`,
        contactPhone: phone,
        latitude: 6.52,
        longitude: 3.42,
        isDefault: true,
      },
    });

    return { identityId: identity.id, customerId: customer.id, addressId: address.id, email, phone };
  }

  async function makeRider(label: string): Promise<WorldRider> {
    const suffix = unique();
    const email = `rider-${label}-${suffix}@dashapp.test`;
    const phone = `+2347002${suffix.padStart(6, '0')}`;

    const identity = await prisma.identity.create({
      data: {
        email,
        phone,
        displayName: `Rider ${label}`,
        passwordHash,
        roles: { create: { role: 'rider' } },
      },
    });

    const rider = await prisma.rider.create({
      data: {
        identityId: identity.id,
        status: 'approved',
        approvedAt: new Date(),
        vehicleType: 'motorcycle',
        availability: 'idle',
        lastLatitude: 6.5,
        lastLongitude: 3.4,
        locationReportedAt: new Date(),
        // A fixture rider is described as available, so they must hold a valid
        // Online lease too — acceptance now verifies the claim rather than
        // trusting `availability` alone.
        onlineUntil: new Date(Date.now() + 900_000),
        qualityScore: 90,
        canCarryCash: true,
        cashFloatCap: naira(20_000),
        // Unrestricted, so zone rules never silently exclude a fixture rider.
        allowedZoneIds: JSON.stringify([]),
      },
    });

    return { identityId: identity.id, riderId: rider.id, email, phone };
  }

  async function makeStaff(role: string, cityId?: string): Promise<WorldStaff> {
    const suffix = unique();
    const email = `${role}-${suffix}@dashapp.test`;
    const identity = await prisma.identity.create({
      data: {
        email,
        displayName: `Staff ${role}`,
        passwordHash,
        mfaEnrolledAt: new Date(),
        roles: { create: { role, cityId: cityId ?? null } },
      },
    });
    return { identityId: identity.id, email };
  }

  const world = {
    cityId: city.id,
    zoneId: zone.id,
    vendorA: await makeVendor('a'),
    vendorB: await makeVendor('b'),
    customerA: await makeCustomer('a'),
    customerB: await makeCustomer('b'),
    riderA: await makeRider('a'),
    riderB: await makeRider('b'),
    support: await makeStaff('support_agent'),
    finance: await makeStaff('finance_analyst'),
    dispatcher: await makeStaff('dispatcher', city.id),
    admin: await makeStaff('super_admin'),
  };

  // Riders are customers too, by the same function the seed uses.
  //
  // DASH has one consumer identity: an approved rider is a customer who can
  // also work. A fixture whose riders lacked the customer half would let a
  // test pass against a shape the real database never has — and would make the
  // capability payload untestable, since `customerId` would be null for every
  // rider here. One implementation of the invariant, exercised by both.
  await ensureRidersAreCustomers(prisma);

  return world;
}

// ---------------------------------------------------------------------------
// Acting as someone
// ---------------------------------------------------------------------------

export interface Actor {
  accessToken: string;
  refreshToken: string;
  csrfToken: string;
  /** Headers for an authenticated request, including CSRF. */
  headers: Record<string, string>;
}

/**
 * Sign in and return everything needed to act as this identity.
 *
 * Password sign-in is used for every fixture, including customers and riders.
 * In production those sign in by OTP, but the login route does not restrict by
 * role — it authenticates any identity that has a password — so this exercises
 * a real path and avoids two extra requests per actor per test.
 */
export async function actAs(context: TestContext, email: string): Promise<Actor> {
  // Delegates to the harness so there is exactly one implementation of the
  // sign-in flow. Staff roles now require a second factor, and duplicating that
  // walk here would mean two places to keep correct.
  const client = await signInWithPassword(context, email, WORLD_PASSWORD);

  return {
    accessToken: client.accessToken,
    refreshToken: client.refreshToken,
    csrfToken: client.csrfToken,
    headers: {
      authorization: `Bearer ${client.accessToken}`,
      // Sent on every request so a state-changing call is never rejected for a
      // missing CSRF token when what is under test is authorization.
      'x-csrf-token': client.csrfToken,
      cookie: `${CSRF_COOKIE}=${client.csrfToken}`,
    },
  };
}

/** Convenience: an authenticated request as a given actor. */
export function as(actor: Actor, extraHeaders: Record<string, string> = {}) {
  return { ...actor.headers, ...extraHeaders };
}

/** A fresh idempotency key. */
export function idempotencyKey(label = 'test'): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
