/**
 * The seed, run for real against a disposable database.
 *
 * One property is worth this much machinery: **a freshly seeded rider must be
 * dispatchable.**
 *
 * Every other timestamp in the seed is pinned to `SEED_NOW`, a fixed date, so
 * re-seeding produces identical, comparable data. Location freshness cannot
 * be, and that exception is the whole subject of this file. Dispatch excludes
 * any rider whose last reported position is older than
 * `maximumLocationAgeSeconds`, measured against the real clock at the moment
 * the engine runs. A `locationReportedAt` pinned to a fixed date is therefore
 * stale the day after that date and stale for ever after: every seeded rider
 * is excluded as `location_stale`, every order escalates to manual dispatch,
 * and no rider can receive an offer in local development at all.
 *
 * That failure is expensive because of how it reads. Nothing errors. The API
 * returns 200, the outbox records the job, the worker runs and reports a
 * decision — with `ranked: 0` and every candidate excluded. It looks exactly
 * like "dispatch is broken", and the rider journey is simply untestable until
 * someone works out that the *seed* is the stale thing.
 *
 * So this asserts against `DEFAULT_CONFIG` rather than a copy of the number:
 * if the freshness window is ever tightened, this test fails and the seed is
 * corrected, instead of local development quietly losing its riders again.
 *
 * It runs the actual seed as a subprocess against a throwaway SQLite file.
 * Asserting on the source, or on a re-implementation of it, would prove
 * nothing about what `npm run db:seed` actually writes.
 */

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { DEFAULT_CONFIG } from '@dash/domain/dispatch';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/** The fixed date every other seeded timestamp is derived from. */
const SEED_NOW = new Date('2026-08-30T12:00:00.000Z');

let directory: string;
let prisma: PrismaClient;
/** When the seed ran, so freshness is measured from the right moment. */
let seededAt: number;

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'dash-seed-'));
  const file = join(directory, 'seed.db');
  writeFileSync(file, '');
  const databaseUrl = `file:${file}`;

  // The Prisma CLI's JS entry point through the current Node binary rather
  // than `npx`: on Windows `npx` resolves to `npx.cmd`, and Node refuses to
  // spawn a `.cmd` without a shell, failing with a bare EINVAL.
  const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');
  execFileSync(
    process.execPath,
    [prismaCli, 'db', 'push', '--skip-generate', '--schema', 'packages/db/prisma/schema.prisma'],
    { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: 'pipe' },
  );

  seededAt = Date.now();
  execFileSync(process.execPath, ['--import', 'tsx', 'packages/db/src/seed.ts'], {
    cwd: process.cwd(),
    // No ENCRYPTION_KEY: the seed treats the keyring as optional and simply
    // skips MFA enrolment, which this test does not look at.
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });

  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
}, 180_000);

afterAll(async () => {
  await prisma?.$disconnect();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

describe('a freshly seeded rider is dispatchable', () => {
  it('reports a location inside the dispatch freshness window', async () => {
    const riders = await prisma.rider.findMany({
      select: { id: true, availability: true, locationReportedAt: true },
    });

    expect(riders.length).toBeGreaterThan(0);

    for (const rider of riders) {
      expect(rider.locationReportedAt).not.toBeNull();

      // The exact comparison `decideDispatch` makes, against the same config.
      const ageSeconds = (seededAt - rider.locationReportedAt!.getTime()) / 1000;

      expect(ageSeconds).toBeLessThanOrEqual(DEFAULT_CONFIG.maximumLocationAgeSeconds);
      // A position from the future is refused just as firmly as a stale one,
      // so a seed that overshot the clock would be no better.
      expect(ageSeconds).toBeGreaterThanOrEqual(0);
    }
  });

  it('does not pin rider freshness to the fixed seed date', async () => {
    // The regression in one assertion. `SEED_NOW` is a constant in the past;
    // anchoring freshness to it is what made every rider permanently stale.
    const rider = await prisma.rider.findFirstOrThrow({
      select: { locationReportedAt: true },
    });

    expect(rider.locationReportedAt!.getTime()).toBeGreaterThan(SEED_NOW.getTime());
  });
});

describe('the rest of the seed stays deterministic', () => {
  it('still pins every other rider timestamp to the seed date', async () => {
    // Freshness is the single documented exception. If a later change reaches
    // for `Date.now()` again, two runs of the seed stop being comparable and
    // this catches it.
    const rider = await prisma.rider.findFirstOrThrow({
      where: { lastAssignedAt: { not: null } },
      select: { lastAssignedAt: true },
    });

    expect(rider.lastAssignedAt!.toISOString()).toBe(
      new Date(SEED_NOW.getTime() - 900_000).toISOString(),
    );
  });

  it('still pins the fictional world it builds', async () => {
    const city = await prisma.city.findFirstOrThrow({ select: { slug: true } });
    expect(city.slug).toBe('lagos');

    // The seed is documented as idempotent and comparable. A spot check that
    // its shape has not drifted, so "deterministic" is asserted rather than
    // assumed.
    const [vendors, riders, customers] = await Promise.all([
      prisma.vendor.count(),
      prisma.rider.count(),
      prisma.customer.count(),
    ]);
    // Seven customers, not three: the three consumer accounts plus one for
    // each of the four riders. DASH has a single consumer identity, so an
    // approved rider *is* a customer who can also work — see the capability
    // suite below. If this number drops back to three, the back-fill has
    // stopped running and rider accounts can no longer shop.
    // Eight vendors: two restaurants, a grocer, a pharmacy, a retail shop, two
    // market traders and one Declutter seller — one for each of the five
    // customer-facing sections, so no section opens onto an empty state.
    // Seven customers: three consumer accounts plus one for each of the four
    // riders, because an approved rider is a customer who can also work.
    expect({ vendors, riders, customers }).toEqual({ vendors: 8, riders: 4, customers: 7 });
  });
});

/**
 * Every rider is also a customer.
 *
 * DASH has one consumer identity: a person signs in once, is a Customer by
 * default, and switches that same session into Rider mode when their rider
 * profile is approved. A `Rider` without the underlying Customer capability is
 * therefore a broken identity — switching to Customer mode would land on a
 * shop with no basket, no address and no way to order — and the seed used to
 * produce exactly that shape.
 *
 * Asserted against the real seeded database rather than against the source,
 * because what matters is what `npm run db:seed` actually writes.
 */
describe('a seeded rider carries the customer capability too', () => {
  it('gives every rider identity a customer profile', async () => {
    const riders = await prisma.rider.findMany({
      select: { identityId: true, identity: { select: { customer: { select: { id: true } } } } },
    });

    expect(riders.length).toBeGreaterThan(0);
    for (const rider of riders) {
      expect(rider.identity.customer, `rider identity ${rider.identityId}`).not.toBeNull();
    }
  });

  it('gives every rider identity both roles on the same identity', async () => {
    const riders = await prisma.rider.findMany({
      select: { identityId: true, identity: { select: { roles: { select: { role: true } } } } },
    });

    for (const rider of riders) {
      const roles = rider.identity.roles.map((entry) => entry.role);
      expect(roles, `rider identity ${rider.identityId}`).toContain('rider');
      expect(roles, `rider identity ${rider.identityId}`).toContain('customer');
    }
  });

  it('creates exactly one customer profile and one customer role per rider', async () => {
    // The invariant that makes the back-fill safe to re-run: a repeated seed,
    // or a repair over an already-repaired database, must converge rather than
    // accumulate.
    const riders = await prisma.rider.findMany({ select: { identityId: true } });

    for (const rider of riders) {
      const profiles = await prisma.customer.count({ where: { identityId: rider.identityId } });
      expect(profiles, `profiles for ${rider.identityId}`).toBe(1);

      const roles = await prisma.identityRole.count({
        where: { identityId: rider.identityId, role: 'customer' },
      });
      expect(roles, `customer roles for ${rider.identityId}`).toBe(1);
    }
  });

  it('gives the rider-customer exactly one delivery address it can order to', async () => {
    // Without an address the account can browse and fill a basket but cannot
    // check out, which would leave the customer half of the capability
    // untestable.
    const riders = await prisma.rider.findMany({
      select: {
        identityId: true,
        identity: { select: { customer: { select: { id: true } } } },
      },
    });

    for (const rider of riders) {
      const customerId = rider.identity.customer?.id;
      expect(customerId).toBeTruthy();
      const addresses = await prisma.address.findMany({
        where: { customerId },
        select: { isDefault: true, latitude: true, longitude: true },
      });
      expect(addresses, `addresses for ${rider.identityId}`).toHaveLength(1);
      expect(addresses[0]?.isDefault).toBe(true);
    }
  });

  it('creates no second identity for the customer half', async () => {
    // One identity, two capabilities. A second account would mean a second
    // login, which is the thing this architecture exists to avoid.
    const riders = await prisma.rider.findMany({
      select: { identityId: true, identity: { select: { customer: { select: { identityId: true } } } } },
    });

    for (const rider of riders) {
      expect(rider.identity.customer?.identityId).toBe(rider.identityId);
    }
  });

  it('does not turn staff identities into customers', async () => {
    // Vendor, ops and admin accounts are separate web-side identities. Giving
    // them a consumer profile would blur a role boundary the platform relies
    // on, so the back-fill is scoped to riders only.
    const staffRoles = ['vendor_owner', 'vendor_manager', 'vendor_staff', 'support_agent',
      'dispatcher', 'finance_analyst', 'city_manager', 'platform_admin', 'super_admin'];

    const staff = await prisma.identity.findMany({
      where: { roles: { some: { role: { in: staffRoles } } }, rider: null },
      select: { id: true, customer: { select: { id: true } }, roles: { select: { role: true } } },
    });

    expect(staff.length).toBeGreaterThan(0);
    for (const identity of staff) {
      expect(identity.customer, `staff identity ${identity.id}`).toBeNull();
      expect(identity.roles.map((r) => r.role)).not.toContain('customer');
    }
  });
});
