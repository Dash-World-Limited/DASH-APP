/**
 * Every rider is also a customer.
 *
 * DASH has one consumer identity. A person signs in once, is a Customer by
 * default, and — if their rider profile has been approved — may switch that
 * same session into Rider mode. There is no second account and no second
 * login, so a `Rider` that exists without the underlying Customer capability
 * is a broken identity: switching into Customer mode lands on a shop the
 * person cannot buy from, because there is no `Customer` row to own a basket,
 * an address, or an order.
 *
 * The seed used to create rider identities with the `rider` role alone, which
 * is exactly that broken shape. This repairs it, and keeps repairing it.
 *
 * ## Why this is not simply a fix inside the seed
 *
 * `npm run db:seed` deletes every table before it writes. That is right for a
 * fixture, and useless for a database someone is testing against: running it
 * to gain a customer profile would destroy the orders, positions and ledger
 * entries that the test produced. This runs against a live database and adds
 * only what is missing, so an existing rider — including the one on the test
 * handset — is repaired in place.
 *
 * ## Why nested `create` is not enough
 *
 * Prisma's nested `create` would attach a customer to a rider being created
 * now, and do nothing for the thousands of ways an identity can already exist:
 * seeded before this change, created by an earlier version, or half-repaired
 * by an interrupted run. Each concern is therefore reconciled explicitly and
 * independently — profile, role, address — so the function converges on the
 * same result whether it is run once, twice, or against a database that is
 * already correct.
 *
 * Staff are deliberately untouched. A vendor, ops, admin or super-admin
 * identity is a separate web-side account, and turning it into a consumer
 * would blur a role boundary the platform depends on.
 */

import { generateReference } from '@dash/domain/crypto';

import type { DbClient } from './index.js';

export interface RiderCustomerRepair {
  /** Rider identities inspected. */
  readonly riders: number;
  /** Customer profiles created because none existed. */
  readonly profilesCreated: number;
  /** `customer` roles granted because none existed. */
  readonly rolesGranted: number;
  /** Delivery addresses created because the rider-customer had none. */
  readonly addressesCreated: number;
}

/**
 * A delivery address the rider-customer can actually order to.
 *
 * Placed at the rider's own last known position rather than at a fixed point,
 * so the address sits inside the zone that rider is permitted to work in and a
 * test order from this account produces a sane trip instead of a cross-city
 * one. Riders are seeded with a position; the fallback only matters for a
 * rider row that somehow has none.
 */
const FALLBACK_POSITION = { latitude: 6.4281, longitude: 3.4219 };

/** Marks the address this function owns, so it is never created twice. */
const SEEDED_ADDRESS_LABEL = 'Home';

/**
 * Give every rider identity the customer capability it must already have.
 *
 * Idempotent by construction: each step asks what exists before writing, and
 * the underlying uniqueness constraints (`Customer.identityId` is unique,
 * `IdentityRole` is unique on identity+role+scope) make a concurrent second
 * run fail loudly rather than duplicate.
 */
export async function ensureRidersAreCustomers(db: DbClient): Promise<RiderCustomerRepair> {
  const riders = await db.rider.findMany({
    select: {
      id: true,
      identityId: true,
      lastLatitude: true,
      lastLongitude: true,
      identity: {
        select: {
          id: true,
          customer: { select: { id: true } },
          roles: { select: { role: true } },
        },
      },
    },
  });

  let profilesCreated = 0;
  let rolesGranted = 0;
  let addressesCreated = 0;

  for (const rider of riders) {
    // --- 1. The customer profile ------------------------------------------
    let customerId = rider.identity.customer?.id ?? null;
    if (!customerId) {
      const created = await db.customer.create({
        data: {
          identityId: rider.identityId,
          // Same shape the seed gives its customers. Referral codes are
          // unique, so this is generated rather than derived.
          referralCode: generateReference('DASH', 6).replace('DASH-', 'REF'),
          marketingOptIn: false,
        },
        select: { id: true },
      });
      customerId = created.id;
      profilesCreated += 1;
    }

    // --- 2. The customer role ---------------------------------------------
    // Checked rather than upserted: the unique constraint spans the optional
    // vendor and city scopes, so a plain `upsert` would need a composite key
    // that reads far less clearly than asking whether the role is there.
    if (!rider.identity.roles.some((entry) => entry.role === 'customer')) {
      await db.identityRole.create({
        data: { identityId: rider.identityId, role: 'customer' },
      });
      rolesGranted += 1;
    }

    // --- 3. A delivery address --------------------------------------------
    // Without one, this account can browse and fill a basket but cannot check
    // out, which would make the customer half of the capability untestable.
    const existing = await db.address.findFirst({
      where: { customerId, label: SEEDED_ADDRESS_LABEL },
      select: { id: true },
    });
    if (!existing) {
      await db.address.create({
        data: {
          customerId,
          label: SEEDED_ADDRESS_LABEL,
          line1: 'Rider home address',
          latitude: rider.lastLatitude ?? FALLBACK_POSITION.latitude,
          longitude: rider.lastLongitude ?? FALLBACK_POSITION.longitude,
          contactPhone: '+2340000000000',
          isDefault: true,
        },
      });
      addressesCreated += 1;
    }
  }

  return {
    riders: riders.length,
    profilesCreated,
    rolesGranted,
    addressesCreated,
  };
}
