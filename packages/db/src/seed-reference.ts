/**
 * Seed production reference data, and nothing else.
 *
 * Run with: npm run db:seed:reference  (idempotent — safe to re-run)
 *
 * This exists because the runbook asks for two things to be written to a
 * production database — the Declutter taxonomy and the published legal
 * documents — and until now the only caller of either was `seed.ts`, the
 * development seed, which the runbook forbids in the same breath because it
 * deletes and recreates fictional vendors, riders and orders. Naming a
 * function in a runbook that has no entry point is a step nobody can follow,
 * and the two ways out of that on deployment day are both bad: run the
 * destructive seed against production, or hand-write SQL against a schema
 * whose invariants live in TypeScript.
 *
 * So this is the third way, and its entire design is the absence of the wipe.
 * It calls exactly the two reference seeds, in the order `seed.ts` calls them,
 * and it holds no fictional data of its own:
 *
 * - `seedDeclutterTaxonomy` — the locations and categories. Upserts on the
 *   natural key and never touches an id a listing already points at.
 * - `seedLegalDocuments` — Terms and Privacy. Upserts on `(slug, version)`,
 *   and updates only the display title: a published version is the evidence
 *   of what somebody agreed to, so its body is never rewritten underneath an
 *   existing `LegalAcceptance`.
 *
 * Both are safe against a database that already holds real listings and real
 * acceptances. That is the property that makes this runnable on a live
 * marketplace rather than only on an empty one, and it is a property of those
 * two functions rather than a promise made here.
 *
 * Unlike `seed.ts` this deliberately does **not** refuse `NODE_ENV=production`.
 * Production is what it is for. The guard it has instead is that it cannot
 * express a destructive operation: it issues no `delete`, no `deleteMany` and
 * no `$executeRaw`.
 */

import { PrismaClient } from '@prisma/client';

import { seedDeclutterTaxonomy } from './seed-declutter.js';
import { seedLegalDocuments } from './seed-legal.js';

const prisma = new PrismaClient();

/**
 * The database being written to, with the password removed.
 *
 * Printed before anything is written. The failure this is here to catch is an
 * operator with several shells open running the right command against the
 * wrong database — which a connection string echoed back in full would catch
 * too, while also putting a production password into the terminal scrollback
 * and from there into whatever the session is logged to.
 */
function describeTarget(url: string | undefined): string {
  if (!url) return 'unset';

  try {
    const parsed = new URL(url);
    const database = parsed.pathname.replace(/^\//, '') || '(none)';
    return `${parsed.protocol}//${parsed.host}/${database}`;
  } catch {
    // A SQLite `file:./dev.db` is not a URL with a host, and is not worth
    // parsing further — it is self-evidently not production.
    return url.startsWith('file:') ? url : '(unparseable)';
  }
}

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];

  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. This writes reference data to a specific database ' +
        'and will not guess which one.',
    );
  }

  console.warn(`Seeding reference data into ${describeTarget(url)}\n`);

  const declutter = await seedDeclutterTaxonomy(prisma);
  const legal = await seedLegalDocuments(prisma);

  console.warn('Reference seed complete.');
  console.warn(`  Declutter: ${declutter.locations} locations, ${declutter.categories} categories`);
  console.warn(`  Legal: ${legal.documents} documents`);
  console.warn('\nNo operational data was created, changed or deleted.\n');
}

main()
  .catch((error: unknown) => {
    console.error('\nReference seed failed:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
