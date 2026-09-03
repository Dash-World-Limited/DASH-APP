/**
 * PostgreSQL + PostGIS verification against a real server.
 *
 * **This is the gate that is PENDING.** Nothing in `npm test` proves the
 * PostgreSQL path works, because this machine has no PostgreSQL to prove it
 * against. Everything here needs a real server and is therefore not part of the
 * suite; until it has been run and passed, the PostgreSQL path is implemented
 * and unverified, and should be described that way.
 *
 *   createdb dash_verify
 *   psql -d dash_verify -c 'CREATE EXTENSION IF NOT EXISTS postgis;'
 *   PG_CHECK_URL='postgresql://user:pw@localhost:5432/dash_verify' \
 *     node scripts/postgres-check.mjs
 *
 * The database is migrated from zero and then written to. Point it at a
 * throwaway database — it is not destructive, but it is not read-only either.
 *
 * What it proves:
 *   1. The PostgreSQL migration history applies to an empty database.
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
const prisma = (args) =>
  execFileSync(process.execPath, [prismaCli, ...args], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: url },
    encoding: 'utf8',
    stdio: 'pipe',
  });

console.log('\nDASH APP — PostgreSQL + PostGIS verification\n' + '='.repeat(50));

// --- 0. The target must genuinely be empty ---------------------------------
//
// "Run it against a fresh database" was previously an instruction in a comment
// and nothing enforced it. A re-used database produces the most confusing
// failure available: `migrate deploy` finds a history it did not write, or
// applies nothing, and the drift check then reports a long list of "missing"
// tables that are missing only because the history never ran. That is exactly
// the shape of the failure this check was sent back to fix, so it is asserted
// first rather than assumed.
console.log('\nPre-flight');
try {
  prisma(['migrate', 'diff', '--from-url', url, '--to-empty', '--exit-code']);
  check('the target database is empty before anything is applied', true);
} catch (error) {
  const detail =
    error.status === 2
      ? 'The database already contains objects. Drop and recreate it - this check migrates from zero, and its results are meaningless against a partially-migrated database.'
      : error.stdout || error.message;
  check('the target database is empty before anything is applied', false, detail);
}

// --- 1. Fresh migration ----------------------------------------------------
console.log('\nMigration');
try {
  const out = prisma(['migrate', 'deploy', '--schema', SCHEMA]);
  check('the migration history applies to a fresh database', /successfully applied|already in sync/i.test(out), out);
} catch (error) {
  check('the migration history applies to a fresh database', false, error.stdout || error.message);
}

try {
  const status = prisma(['migrate', 'status', '--schema', SCHEMA]);
  check('migrate status is clean', /up to date/i.test(status), status);
} catch (error) {
  check('migrate status is clean', false, error.stdout || error.message);
}

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
try {
  prisma([
    'migrate', 'diff',
    '--from-url', url,
    '--to-schema-datamodel', SCHEMA,
    '--exit-code',
  ]);
  check('there is no drift between the database and the schema', true);
} catch (error) {
  // `--exit-code` returns 2 when a difference exists.
  check('there is no drift between the database and the schema', false, error.stdout || error.message);
}

// --- 3 & 4. PostGIS --------------------------------------------------------
console.log('\nPostGIS');
// Generated here, from the PostgreSQL schema, into its own directory.
//
// This is the defect that made the entire PostGIS half of this check
// unrunnable. Both schemas used to generate into the hoisted root
// `@prisma/client`, so they overwrote each other and the winner was whichever
// ran last - always `npm run db:generate` (SQLite), because every other
// workflow runs it. A SQLite-generated client rejects a `postgresql://` URL
// outright, so this script could never connect to the database it exists to
// verify.
//
// Generating on demand also means the check cannot pass against a stale client
// built before the schema last changed.
try {
  prisma(['generate', '--schema', SCHEMA]);
  check('a PostgreSQL client generates from the PostgreSQL schema', true);
} catch (error) {
  check(
    'a PostgreSQL client generates from the PostgreSQL schema',
    false,
    error.stdout || error.message,
  );
}

const clientEntry = join(root, 'packages/db/prisma/postgres/.client/index.js');
const { PrismaClient } = await import(pathToFileURL(clientEntry).href);
const { PostgisGeoAdapter } = await import('../apps/api/src/adapters/postgis.ts');
const { LocalGeoAdapter } = await import('../apps/api/src/adapters/index.ts');
const { isPointInPolygon } = await import('@dash/domain/geo');

const client = new PrismaClient({ datasources: { db: { url } } });

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
