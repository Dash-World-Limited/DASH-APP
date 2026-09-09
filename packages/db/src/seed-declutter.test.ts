/**
 * The Declutter taxonomy seed, run for real against a disposable database.
 *
 * One property is worth a real database to prove: **re-running the seed must
 * not duplicate anything, and must not change any id.**
 *
 * Counting rows twice would be a weak test — a seed that deleted everything and
 * rewrote it would pass that and still be wrong, because a `DeclutterListing`
 * holds a foreign key to its location and its category. So this asserts on the
 * ids as well. If the second run produced new rows, listings written between
 * the two runs would be pointing at rows that no longer exist.
 *
 * It also proves the other half of "stable identifiers": a label edited by hand
 * is corrected on the next run, and the id it was attached to survives. That is
 * what lets a category be renamed without breaking a single listing or URL.
 *
 * Runs against a throwaway SQLite file, using the same `prisma db push`
 * approach as seed.test.ts.
 */

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DECLUTTER_CATEGORIES, DECLUTTER_LOCATIONS } from '@dash/domain/declutter';
import { seedDeclutterTaxonomy } from './seed-declutter.js';

let directory: string;
let prisma: PrismaClient;

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'dash-declutter-seed-'));
  const databaseUrl = `file:${join(directory, 'declutter.db')}`;

  // The Prisma CLI's JS entry point through the current Node binary rather than
  // `npx`: on Windows `npx` resolves to `npx.cmd`, which Node refuses to spawn
  // without a shell.
  const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');
  execFileSync(
    process.execPath,
    [prismaCli, 'db', 'push', '--skip-generate', '--schema', 'packages/db/prisma/schema.prisma'],
    { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: 'pipe' },
  );

  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
}, 180_000);

afterAll(async () => {
  await prisma?.$disconnect();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

describe('the taxonomy seed is idempotent', () => {
  it('writes exactly what the domain declares', async () => {
    const result = await seedDeclutterTaxonomy(prisma);

    expect(result.locations).toBe(DECLUTTER_LOCATIONS.length);
    expect(result.categories).toBe(DECLUTTER_CATEGORIES.length);
    expect(await prisma.declutterLocation.count()).toBe(DECLUTTER_LOCATIONS.length);
    expect(await prisma.declutterCategory.count()).toBe(DECLUTTER_CATEGORIES.length);
  });

  it('creates no duplicates and moves no ids when run again', async () => {
    const before = await snapshot();

    await seedDeclutterTaxonomy(prisma);
    await seedDeclutterTaxonomy(prisma);

    const after = await snapshot();

    expect(after.locationCount).toBe(before.locationCount);
    expect(after.categoryCount).toBe(before.categoryCount);
    // The stronger assertion: same rows, not merely the same number of them.
    expect(after.locationIds).toEqual(before.locationIds);
    expect(after.categoryIds).toEqual(before.categoryIds);
  });

  it('restores an edited label without moving the row', async () => {
    const original = await prisma.declutterCategory.findUniqueOrThrow({
      where: { key: 'home-furniture' },
      select: { id: true, name: true },
    });

    await prisma.declutterCategory.update({
      where: { key: 'home-furniture' },
      data: { name: 'Renamed by hand', isActive: false },
    });

    await seedDeclutterTaxonomy(prisma);

    const restored = await prisma.declutterCategory.findUniqueOrThrow({
      where: { key: 'home-furniture' },
      select: { id: true, name: true, isActive: true },
    });

    expect(restored.name).toBe(original.name);
    expect(restored.isActive).toBe(true);
    // The identifier a listing and a URL hold is untouched by the rename.
    expect(restored.id).toBe(original.id);
  });

  it('builds the location tree, not a flat list', async () => {
    const lekki = await prisma.declutterLocation.findUniqueOrThrow({
      where: { slug: 'lagos-lekki' },
      select: { kind: true, parent: { select: { slug: true, parent: { select: { slug: true } } } } },
    });

    expect(lekki.kind).toBe('area');
    expect(lekki.parent?.slug).toBe('lagos-eti-osa');
    expect(lekki.parent?.parent?.slug).toBe('lagos');
  });

  it('seeds Asaba under Delta and nothing else in that state', async () => {
    const delta = await prisma.declutterLocation.findUniqueOrThrow({
      where: { slug: 'delta' },
      select: { children: { select: { slug: true, children: { select: { name: true } } } } },
    });

    expect(delta.children.map((c) => c.slug)).toEqual(['delta-oshimili-south']);
    expect(delta.children[0]?.children.map((c) => c.name)).toEqual(['Asaba']);
  });

  it('stores each category’s own attribute schema', async () => {
    const phones = await prisma.declutterCategory.findUniqueOrThrow({
      where: { key: 'phones-tablets' },
      select: { attributeSchema: true, requiresOwnershipEvidence: true },
    });
    const furniture = await prisma.declutterCategory.findUniqueOrThrow({
      where: { key: 'home-furniture' },
      select: { attributeSchema: true, requiresOwnershipEvidence: true },
    });

    const phoneKeys = (JSON.parse(phones.attributeSchema!) as { key: string }[]).map((f) => f.key);
    const furnitureKeys = (JSON.parse(furniture.attributeSchema!) as { key: string }[]).map(
      (f) => f.key,
    );

    expect(phoneKeys).toContain('batteryHealthPercent');
    expect(furnitureKeys).not.toContain('batteryHealthPercent');
    expect(phones.requiresOwnershipEvidence).toBe(true);
    expect(furniture.requiresOwnershipEvidence).toBe(false);
  });

  it('leaves an operational city link alone on reseed', async () => {
    // `cityId` is set by whoever configures delivery serviceability. A reseed
    // of reference data must not reach in and clear their work.
    await prisma.declutterLocation.update({
      where: { slug: 'lagos-lekki' },
      data: { cityId: 'city_configured_by_ops' },
    });

    await seedDeclutterTaxonomy(prisma);

    const lekki = await prisma.declutterLocation.findUniqueOrThrow({
      where: { slug: 'lagos-lekki' },
      select: { cityId: true },
    });
    expect(lekki.cityId).toBe('city_configured_by_ops');
  });
});

async function snapshot(): Promise<{
  locationCount: number;
  categoryCount: number;
  locationIds: Record<string, string>;
  categoryIds: Record<string, string>;
}> {
  const locations = await prisma.declutterLocation.findMany({
    select: { slug: true, id: true },
    orderBy: { slug: 'asc' },
  });
  const categories = await prisma.declutterCategory.findMany({
    select: { key: true, id: true },
    orderBy: { key: 'asc' },
  });

  return {
    locationCount: locations.length,
    categoryCount: categories.length,
    locationIds: Object.fromEntries(locations.map((l) => [l.slug, l.id])),
    categoryIds: Object.fromEntries(categories.map((c) => [c.key, c.id])),
  };
}
