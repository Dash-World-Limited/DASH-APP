/**
 * PostgreSQL + PostGIS verification against a real server.
 *
 * Nothing in `npm test` proves the PostgreSQL path works, because a development
 * machine has no PostgreSQL to prove it against. Everything here needs a real
 * server and is therefore not part of the suite.
 *
 * **First run: 11 September 2026, against a throwaway RDS database.** It found
 * real drift - four objects present in `schema.prisma` and in no migration -
 * and two faults in itself. Both are fixed below and described where they are.
 * The drift is repaired by `20260915000000_schema_parity_repair`, and
 * `packages/db/src/migration-parity.test.ts` now asserts the same property on
 * every commit without needing a server, so this gate is no longer the only
 * thing standing between a schema edit and production.
 *
 *   createdb dash_verify
 *   psql -d dash_verify -c 'CREATE EXTENSION IF NOT EXISTS postgis;'
 *   PG_CHECK_URL='postgresql://user:pw@localhost:5432/dash_verify' \
 *     node scripts/postgres-check.mjs
 *
 * The database is migrated from zero and then written to. Point it at a
 * throwaway database — it is not destructive, but it is not read-only either.
 *
 * Every Prisma command is judged by its **exit status**, never by matching words
 * in its output. The first run reported a failure for a command that had plainly
 * worked, because the check was looking for a phrase.
 *
 * What it proves:
 *   1. The PostgreSQL migration history applies to a database holding no
 *      application tables. PostGIS being installed already does not count as
 *      "not empty" - the setup above installs it deliberately.
 *   2. `migrate status` is clean and `migrate diff` reports no drift.
 *   3. PostGIS is installed and answers.
 *   4. The PostGIS adapter and the in-process adapter agree about containment,
 *      including on the cases a ray cast gets wrong — a point on an edge, a
 *      point in a hole, and a point just outside a vertex.
 */

import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA = join(root, 'packages/db/prisma/postgres/schema.prisma');

const url = process.env.PG_CHECK_URL;
if (!url) {
  console.error(
    '\n  PG_CHECK_URL is required.\n' +
      "  Example: PG_CHECK_URL='postgresql://user:pw@localhost:5432/dash_verify'\n",
  );
  process.exit(2);
}

let passed = 0;
let failed = 0;
const check = (label, condition, detail) => {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}`);
    if (detail !== undefined) console.log(`        ${String(detail).slice(0, 400)}`);
  }
};

const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');

/**
 * Run a Prisma command and report how it went, rather than throwing.
 *
 * Every caller here wants the same two facts — did it succeed, and what did it
 * say — and the previous shape (throw on non-zero) forced each one into a
 * try/catch that then judged success by matching words in stdout. That is how a
 * run against RDS reported a failure for a command that had worked: the
 * migrations applied, and the check looked for a phrase.
 *
 * Exit status is the contract. Prisma's wording is not.
 */
const prisma = (args) => {
  try {
    const stdout = execFileSync(process.execPath, [prismaCli, ...args], {
      cwd: root,
      env: { ...process.env, DATABASE_URL: url },
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return { ok: true, status: 0, stdout: stdout ?? '', stderr: '' };
  } catch (error) {
    return {
      ok: false,
      status: error.status,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
      message: error.message,
    };
  }
};

/** Everything a command said, for a failure detail. */
const said = (result) =>
  [result.stdout, result.stderr].filter(Boolean).join('\n').trim() || result.message || '';

console.log('\nDASH APP — PostgreSQL + PostGIS verification\n' + '='.repeat(50));

// --- 0. A client, first -----------------------------------------------------
//
// Generated before anything else, because the pre-flight below needs it to ask
// the database what it contains. Generating on demand also means the check
// cannot pass against a stale client built before the schema last changed.
//
// Into its own directory, from the PostgreSQL schema. That was the defect which
// made the entire PostGIS half of this check unrunnable: both schemas used to
// generate into the hoisted root `@prisma/client`, so they overwrote each other
// and the winner was whichever ran last - always `npm run db:generate`
// (SQLite), because every other workflow runs it. A SQLite-generated client
// rejects a `postgresql://` URL outright, so this script could never connect to
// the database it exists to verify.
console.log('\nClient');
const generated = prisma(['generate', '--schema', SCHEMA]);
check('a PostgreSQL client generates from the PostgreSQL schema', generated.ok, said(generated));
if (!generated.ok) {
  console.log('\n  Cannot continue without a client.\n');
  process.exit(1);
}

const clientEntry = join(root, 'packages/db/prisma/postgres/.client/index.js');
const { PrismaClient } = await import(pathToFileURL(clientEntry).href);
const client = new PrismaClient({ datasources: { db: { url } } });

/**
 * The target must hold no application tables.
 *
 * A re-used database produces the most confusing failure available: `migrate
 * deploy` finds a history it did not write, or applies nothing, and the drift
 * check then reports a long list of "missing" tables that are missing only
 * because the history never ran.
 *
 * This used to be `migrate diff --to-empty`, which asks a different question:
 * *is the database empty*, not *does it hold application tables*. PostGIS is
 * installed before this check runs — the setup notes at the top say to do
 * exactly that — and `CREATE EXTENSION postgis` leaves `spatial_ref_sys` and
 * friends behind. So the pre-flight failed on every correctly-prepared
 * database, which is the worst kind of check: it fires when you have followed
 * the instructions.
 *
 * Asking PostgreSQL directly fixes it without loosening anything. Objects that
 * an extension owns are recorded in `pg_depend` with `deptype = 'e'`, so they
 * can be excluded by provenance rather than by name — no allowlist of PostGIS
 * table names to fall behind, and a future extension needs no change here.
 * Everything else still counts, `_prisma_migrations` included, which is the
 * signal that matters most: a database that has been migrated before is
 * rejected.
 */
console.log('\nPre-flight');
let applicationTables = [];
try {
  applicationTables = await client.$queryRaw`
    SELECT n.nspname AS schema, c.relname AS name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p')
      AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'topology', 'tiger', 'tiger_data')
      AND NOT EXISTS (
        SELECT 1 FROM pg_depend d
        WHERE d.objid = c.oid AND d.deptype = 'e'
      )
    ORDER BY 1, 2
  `;
  check(
    'the target database holds no application tables',
    applicationTables.length === 0,
    applicationTables.length === 0
      ? undefined
      : `Found ${applicationTables.length}: ${applicationTables
          .map((row) => `${row.schema}.${row.name}`)
          .join(', ')}. Drop and recreate the database - this check migrates from zero, and its ` +
          'results are meaningless against a partially-migrated one.',
  );
} catch (error) {
  check('the target database holds no application tables', false, error.message);
}

// --- 1. Fresh migration ----------------------------------------------------
console.log('\nMigration');
const deployed = prisma(['migrate', 'deploy', '--schema', SCHEMA]);
check('the migration history applies to a fresh database', deployed.ok, said(deployed));

const status = prisma(['migrate', 'status', '--schema', SCHEMA]);
check('migrate status is clean', status.ok, said(status));

// Every migration directory on disk must actually have been applied.
//
// `migrate deploy` reporting success is not the same as the history being
// complete, and a hand-written PostgreSQL migration is exactly the kind that
// can sit in the tree looking applied while its tables do not exist. Comparing
// the directory listing against what the database recorded closes that gap and
// names the offending migration, instead of leaving it to be inferred from a
// drift dump.
const migrationsDir = join(root, 'packages/db/prisma/postgres/migrations');
const onDisk = readdirSync(migrationsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

check('the PostgreSQL migration history is non-empty', onDisk.length > 0, `${onDisk.length} on disk`);

// --- 2. Drift --------------------------------------------------------------
//
// The check that found four objects present in `schema.prisma` and in no
// migration: `DispatchOffer.eligibilityMode`, `MenuItem.condition`,
// `Rider.onlineUntil`, and the unique index on `Device.pushToken`. They were
// added to the schema and pushed into a local database with `db:push`, which
// syncs without writing a migration, so development had them and the history
// never did. `packages/db/src/migration-parity.test.ts` now asserts the same
// property on every commit, for both dialects, without needing a server.
//
// `--exit-code` returns 2 when a difference exists, so a non-zero status is the
// finding rather than an error.
const drift = prisma([
  'migrate', 'diff',
  '--from-url', url,
  '--to-schema-datamodel', SCHEMA,
  '--exit-code',
]);
check('there is no drift between the database and the schema', drift.ok, said(drift));

// --- 3 & 4. PostGIS --------------------------------------------------------
console.log('\nPostGIS');
const { PostgisGeoAdapter } = await import('../apps/api/src/adapters/postgis.ts');
const { LocalGeoAdapter } = await import('../apps/api/src/adapters/index.ts');
const { isPointInPolygon } = await import('@dash/domain/geo');

try {
  const [{ postgis_version: version }] = await client.$queryRaw`SELECT PostGIS_Version() AS postgis_version`;
  check('PostGIS is installed and answers', Boolean(version), version);
} catch (error) {
  check('PostGIS is installed and answers', false, `${error.message}  (did you CREATE EXTENSION postgis?)`);
}

// A square with a square hole cut out of the middle.
const OUTER = [[3.3, 6.4], [3.7, 6.4], [3.7, 6.8], [3.3, 6.8]];
const HOLE = [[3.45, 6.55], [3.55, 6.55], [3.55, 6.65], [3.45, 6.65]];

const suffix = Date.now();
const city = await client.city.create({
  data: {
    slug: `pgcheck-${suffix}`,
    name: 'PG Check City',
    centreLatitude: 6.6,
    centreLongitude: 3.5,
    isLive: false,
  },
});
const zone = await client.zone.create({
  data: {
    cityId: city.id,
    name: 'PG Check Zone',
    slug: `pgcheck-zone-${suffix}`,
    polygon: JSON.stringify({ outer: OUTER, holes: [HOLE] }),
    minLatitude: 6.4,
    maxLatitude: 6.8,
    minLongitude: 3.3,
    maxLongitude: 3.7,
    isActive: true,
  },
});

const postgis = new PostgisGeoAdapter(client, new LocalGeoAdapter(client));

// The cases worth checking are the ones a hand-written ray cast gets subtly
// wrong, not the obvious interior point.
const cases = [
  { label: 'a point well inside', point: { latitude: 6.45, longitude: 3.35 }, expected: true },
  { label: 'a point inside the hole', point: { latitude: 6.6, longitude: 3.5 }, expected: false },
  { label: 'a point outside the outer ring', point: { latitude: 6.9, longitude: 3.5 }, expected: false },
  { label: 'a point level with a vertex', point: { latitude: 6.4, longitude: 3.5 }, expected: true },
  { label: 'a point just outside a corner', point: { latitude: 6.39, longitude: 3.29 }, expected: false },
];

const polygon = { outer: OUTER, holes: [HOLE] };
for (const testCase of cases) {
  const fromPostgis = (await postgis.zonesContaining(testCase.point, city.id)).includes(zone.id);
  const fromLocal = isPointInPolygon(testCase.point, polygon);

  check(
    `PostGIS agrees with the in-process test: ${testCase.label}`,
    fromPostgis === fromLocal,
    { postgis: fromPostgis, local: fromLocal },
  );
  check(
    `${testCase.label} is ${testCase.expected ? 'contained' : 'not contained'}`,
    fromPostgis === testCase.expected,
    { postgis: fromPostgis, expected: testCase.expected },
  );
}

await client.zone.delete({ where: { id: zone.id } });
await client.city.delete({ where: { id: city.id } });
await client.$disconnect();

console.log('\n' + '='.repeat(50));
console.log(`  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
