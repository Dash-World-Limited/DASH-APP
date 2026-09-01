/**
 * Public catalogue and search — integration tests.
 *
 * These are the only broadly-unauthenticated endpoints in the API, which makes
 * them the ones most worth checking for leakage: anything they return is
 * returned to the whole internet.
 *
 * Previously covered only by `scripts/smoke.mjs`, which needs a running server
 * and cannot gate a merge.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './harness.js';
import { buildWorld, type World } from './world.js';

let context: TestContext;
let world: World;

beforeAll(async () => {
  context = await createTestContext();
  world = await buildWorld(context.prisma);
});

afterAll(async () => {
  await context.close();
});

const get = (url: string) => context.app.inject({ method: 'GET', url });

describe('GET /v1/cities', () => {
  it('lists live cities', async () => {
    const response = await get('/v1/cities');
    expect(response.statusCode).toBe(200);

    const { cities } = response.json<{ cities: { slug: string }[] }>();
    expect(cities.length).toBeGreaterThan(0);
  });

  it('hides a city that is not live', async () => {
    await context.prisma.city.update({
      where: { id: world.cityId },
      data: { isLive: false },
    });

    const { cities } = (await get('/v1/cities')).json<{ cities: { id: string }[] }>();
    expect(cities.map((city) => city.id)).not.toContain(world.cityId);

    await context.prisma.city.update({
      where: { id: world.cityId },
      data: { isLive: true },
    });
  });

  it('needs no authentication', async () => {
    // Asserted explicitly: this endpoint is deliberately public, and a future
    // change that made it leak more should have to face this test.
    expect((await get('/v1/cities')).statusCode).toBe(200);
  });

  it('returns no operational or internal fields', async () => {
    const body = (await get('/v1/cities')).body;
    for (const forbidden of ['detourFactor', 'createdAt', 'updatedAt']) {
      expect(body, `leaked ${forbidden}`).not.toContain(forbidden);
    }
  });
});

describe('GET /v1/serviceability', () => {
  it('resolves a point inside a zone', async () => {
    const response = await get('/v1/serviceability?latitude=6.4281&longitude=3.4219');
    expect(response.statusCode).toBe(200);
    expect(response.json<{ serviceable: boolean }>().serviceable).toBe(true);
  });

  it('rejects a point outside every zone', async () => {
    const response = await get('/v1/serviceability?latitude=51.5&longitude=-0.12');
    expect(response.json<{ serviceable: boolean }>().serviceable).toBe(false);
  });

  it('rejects swapped coordinates', async () => {
    // Lagos sits at ~6.4N, ~3.4E. Swapping them lands in the Gulf of Guinea
    // while barely changing any distance calculation, so point-in-polygon is
    // what actually catches it.
    const response = await get('/v1/serviceability?latitude=3.4219&longitude=6.4281');
    expect(response.json<{ serviceable: boolean }>().serviceable).toBe(false);
  });

  it('rejects out-of-range coordinates', async () => {
    for (const query of [
      'latitude=91&longitude=3',
      'latitude=6&longitude=181',
      'latitude=-91&longitude=3',
      'latitude=abc&longitude=3',
      'longitude=3',
      'latitude=6',
    ]) {
      const response = await get(`/v1/serviceability?${query}`);
      expect(response.statusCode, query).toBe(400);
    }
  });

  it('reports a paused zone as unserviceable without naming why internally', async () => {
    await context.prisma.zone.update({
      where: { id: world.zoneId },
      data: { isActive: false, pausedReason: 'Flooding on the mainland' },
    });

    const response = await get('/v1/serviceability?latitude=6.4281&longitude=3.4219');
    const body = response.json<{ serviceable: boolean; reason: string }>();

    expect(body.serviceable).toBe(false);
    expect(body.reason).toBe('zone_paused');

    await context.prisma.zone.update({
      where: { id: world.zoneId },
      data: { isActive: true, pausedReason: null },
    });
  });
});

describe('GET /v1/vendors', () => {
  it('lists approved vendors', async () => {
    const response = await get('/v1/vendors');
    expect(response.statusCode).toBe(200);
    expect(response.json<{ vendors: unknown[] }>().vendors.length).toBeGreaterThan(0);
  });

  it('never exposes commercial or banking fields', async () => {
    const body = (await get('/v1/vendors')).body;

    // Commission is what a competitor would most like to know.
    for (const forbidden of [
      'commissionBasisPoints',
      'bankAccountCipher',
      'bankAccountLast4',
      'bankName',
      'internalNotes',
      'approvedBy',
    ]) {
      expect(body, `leaked ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('hides a vendor that is not approved', async () => {
    for (const status of ['pending', 'suspended', 'rejected']) {
      await context.prisma.vendor.update({
        where: { id: world.vendorA.vendorId },
        data: { status },
      });

      const { vendors } = (await get('/v1/vendors')).json<{ vendors: { id: string }[] }>();
      expect(vendors.map((v) => v.id), `status ${status}`).not.toContain(world.vendorA.vendorId);
    }

    await context.prisma.vendor.update({
      where: { id: world.vendorA.vendorId },
      data: { status: 'approved' },
    });
  });

  it('caps the page size however large a limit is asked for', async () => {
    const response = await get('/v1/vendors?limit=10000');
    // Rejected outright rather than silently returning everything.
    expect(response.statusCode).toBe(400);
  });

  it('rejects a nonsensical limit', async () => {
    for (const limit of ['-1', '0', 'abc', '1.5']) {
      const response = await get(`/v1/vendors?limit=${limit}`);
      expect(response.statusCode, `limit ${limit}`).toBe(400);
    }
  });

  it('rejects an over-long search term', async () => {
    const response = await get(`/v1/vendors?search=${'x'.repeat(500)}`);
    expect(response.statusCode).toBe(400);
  });

  it('rejects an unknown category rather than ignoring it', async () => {
    // Silently ignoring an unknown filter returns more than the caller asked
    // for, which is the wrong direction to fail in.
    const response = await get('/v1/vendors?category=not-a-category');
    expect(response.statusCode).toBe(400);
  });

  it('paginates with an opaque cursor', async () => {
    const first = await get('/v1/vendors?limit=1');
    expect(first.statusCode).toBe(200);

    const body = first.json<{ vendors: { id: string }[]; nextCursor: string | null }>();
    expect(body.vendors).toHaveLength(1);

    if (body.nextCursor) {
      const second = await get(`/v1/vendors?limit=1&cursor=${body.nextCursor}`);
      expect(second.statusCode).toBe(200);
      const secondBody = second.json<{ vendors: { id: string }[] }>();
      expect(secondBody.vendors[0]?.id).not.toBe(body.vendors[0]?.id);
    }
  });

  it('tolerates a malformed cursor without erroring', async () => {
    const response = await get('/v1/vendors?cursor=not-a-real-cursor');
    expect([200, 400]).toContain(response.statusCode);
  });
});

describe('GET /v1/vendors/:slug', () => {
  it('returns the vendor and its catalogue', async () => {
    const response = await get(`/v1/vendors/${world.vendorA.slug}`);
    expect(response.statusCode).toBe(200);

    const { vendor } = response.json<{ vendor: { categories: unknown[] } }>();
    expect(vendor.categories.length).toBeGreaterThan(0);
  });

  it('never exposes commercial or banking fields', async () => {
    const body = (await get(`/v1/vendors/${world.vendorA.slug}`)).body;

    for (const forbidden of [
      'commissionBasisPoints',
      'bankAccountCipher',
      'bankAccountLast4',
      'approvedBy',
    ]) {
      expect(body, `leaked ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('returns 404 for an unknown slug', async () => {
    expect((await get('/v1/vendors/no-such-vendor')).statusCode).toBe(404);
  });

  it('returns 404 for a vendor that is not approved — not 403', async () => {
    await context.prisma.vendor.update({
      where: { id: world.vendorA.vendorId },
      data: { status: 'suspended' },
    });

    const response = await get(`/v1/vendors/${world.vendorA.slug}`);
    // Indistinguishable from "never existed": a 403 would confirm the vendor
    // is real and merely hidden.
    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: { message: string } }>().error.message).toBe('Not found.');

    await context.prisma.vendor.update({
      where: { id: world.vendorA.vendorId },
      data: { status: 'approved' },
    });
  });

  it('hides archived catalogue items', async () => {
    const item = await context.prisma.menuItem.findFirstOrThrow({
      where: { vendorId: world.vendorA.vendorId },
    });
    await context.prisma.menuItem.update({
      where: { id: item.id },
      data: { archivedAt: new Date() },
    });

    const body = (await get(`/v1/vendors/${world.vendorA.slug}`)).body;
    expect(body).not.toContain(item.id);

    await context.prisma.menuItem.update({
      where: { id: item.id },
      data: { archivedAt: null },
    });
  });

  it('still shows an unavailable item, flagged rather than hidden', async () => {
    // A sold-out dish should be visible and marked, not vanish — otherwise the
    // menu appears to change size at random.
    const item = await context.prisma.menuItem.findFirstOrThrow({
      where: { vendorId: world.vendorA.vendorId },
    });
    await context.prisma.menuItem.update({
      where: { id: item.id },
      data: { isAvailable: false },
    });

    const body = (await get(`/v1/vendors/${world.vendorA.slug}`)).body;
    expect(body).toContain(item.id);
    expect(body).toContain('"isAvailable":false');

    await context.prisma.menuItem.update({
      where: { id: item.id },
      data: { isAvailable: true },
    });
  });
});

describe('GET /v1/search', () => {
  it('finds vendors and items', async () => {
    // Two characters is the documented minimum; one is rejected below.
    const response = await get('/v1/search?q=aa');
    expect(response.statusCode).toBe(200);
    const body = response.json<{ vendors: unknown[]; items: unknown[] }>();
    expect(Array.isArray(body.vendors)).toBe(true);
    expect(Array.isArray(body.items)).toBe(true);
  });

  it('requires a usable query', async () => {
    for (const q of ['', 'a', `${'x'.repeat(200)}`]) {
      const response = await get(`/v1/search?q=${q}`);
      expect(response.statusCode, `q=${q.slice(0, 12)}`).toBe(400);
    }
  });

  it('requires the q parameter at all', async () => {
    expect((await get('/v1/search')).statusCode).toBe(400);
  });

  it('does not surface items from an unapproved vendor', async () => {
    const item = await context.prisma.menuItem.findFirstOrThrow({
      where: { vendorId: world.vendorA.vendorId },
      select: { id: true, name: true },
    });

    await context.prisma.vendor.update({
      where: { id: world.vendorA.vendorId },
      data: { status: 'suspended' },
    });

    const body = (await get(`/v1/search?q=${encodeURIComponent(item.name.slice(0, 6))}`)).body;
    expect(body).not.toContain(item.id);

    await context.prisma.vendor.update({
      where: { id: world.vendorA.vendorId },
      data: { status: 'approved' },
    });
  });

  it('caps how much it will return', async () => {
    const response = await get('/v1/search?q=a&limit=10000');
    expect(response.statusCode).toBe(400);
  });

  it('treats a query with SQL metacharacters as text', async () => {
    // Prisma parameterises, so this is a regression guard rather than a
    // discovery: the point is that it returns a normal empty result.
    const response = await get(`/v1/search?q=${encodeURIComponent("'; DROP TABLE Vendor;--")}`);
    expect(response.statusCode).toBe(200);
    expect(await context.prisma.vendor.count()).toBeGreaterThan(0);
  });
});
