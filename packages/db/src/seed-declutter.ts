/**
 * Seed the DASH World Declutters reference data.
 *
 * Geography and categories are **reference data, not demo data**, and that
 * distinction decides how this file works.
 *
 * The main seed makes itself repeatable by deleting everything and writing it
 * again. That is right for invented vendors and fictional orders: nothing
 * points at them and nobody minds losing them. It would be wrong here. A
 * `DeclutterListing` holds a foreign key to its location and its category, and
 * those keys are RESTRICT — so a wipe-and-recreate either fails against real
 * listings or, worse, succeeds against an empty development database and
 * teaches everyone a habit that breaks in production.
 *
 * So this upserts on the natural key: `slug` for a location, `key` for a
 * category. Running it a hundred times leaves one row per identifier, updates
 * the label if it changed, and never touches an id that something else
 * references. That is also what makes the identifiers useful — a category can
 * be renamed from "Home & Furniture" to anything at all and every listing and
 * every URL still resolves, because neither ever held the label.
 *
 * Definitions live in `@dash/domain/declutter`, not here, so the API and the
 * admin console read exactly what was written.
 */

import type { PrismaClient } from '@prisma/client';
import {
  attributeSchemaJson,
  DECLUTTER_CATEGORIES,
  DECLUTTER_LOCATIONS,
} from '@dash/domain/declutter';

export interface DeclutterSeedResult {
  readonly locations: number;
  readonly categories: number;
}

/**
 * Write the taxonomy. Safe to run repeatedly, and safe to run against a
 * database that already holds listings.
 *
 * Locations are walked in declaration order, which is parents-first, so a
 * parent always exists by the time a child needs its id. That ordering is a
 * property of `DECLUTTER_LOCATIONS` and is asserted by its own test rather
 * than assumed here.
 */
export async function seedDeclutterTaxonomy(prisma: PrismaClient): Promise<DeclutterSeedResult> {
  const idBySlug = new Map<string, string>();

  for (const location of DECLUTTER_LOCATIONS) {
    const parentId = location.parentSlug ? idBySlug.get(location.parentSlug) : undefined;

    if (location.parentSlug && parentId === undefined) {
      // Declaration order is meant to prevent this. If it ever happens, failing
      // loudly beats writing an orphan that quietly disappears from the tree.
      throw new Error(
        `Declutter seed: "${location.slug}" names parent "${location.parentSlug}", which has not been written yet.`,
      );
    }

    const row = await prisma.declutterLocation.upsert({
      where: { slug: location.slug },
      create: {
        slug: location.slug,
        name: location.name,
        kind: location.kind,
        parentId: parentId ?? null,
        sortOrder: location.sortOrder,
        isActive: true,
      },
      // Deliberately narrow. `cityId` is not listed: it is the operational link
      // to a delivery city, set by whoever configures serviceability, and a
      // reseed must not reach in and clear their work.
      update: {
        name: location.name,
        kind: location.kind,
        parentId: parentId ?? null,
        sortOrder: location.sortOrder,
        isActive: true,
      },
      select: { id: true },
    });

    idBySlug.set(location.slug, row.id);
  }

  for (const category of DECLUTTER_CATEGORIES) {
    await prisma.declutterCategory.upsert({
      where: { key: category.key },
      create: {
        key: category.key,
        name: category.name,
        slug: category.slug,
        sortOrder: category.sortOrder,
        requiresOwnershipEvidence: category.requiresOwnershipEvidence,
        attributeSchema: attributeSchemaJson(category),
        isActive: true,
      },
      update: {
        name: category.name,
        slug: category.slug,
        sortOrder: category.sortOrder,
        requiresOwnershipEvidence: category.requiresOwnershipEvidence,
        attributeSchema: attributeSchemaJson(category),
        isActive: true,
      },
      select: { id: true },
    });
  }

  return { locations: DECLUTTER_LOCATIONS.length, categories: DECLUTTER_CATEGORIES.length };
}
