/**
 * Regenerate the PostgreSQL Prisma schema from the authored SQLite one.
 *
 *   npm run db:pg:sync            # write packages/db/prisma/postgres/schema.prisma
 *   npm run db:pg:sync -- --check # verify it is current, write nothing (CI)
 *
 * `--check` exits non-zero when the generated file is stale, which is the same
 * condition `schema-sync.test.ts` asserts. Both exist because the test gives a
 * developer the failure inside `npm test`, and this gives CI a check that does
 * not need the test runner.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SQLITE_SCHEMA = join(root, 'packages/db/prisma/schema.prisma');
const POSTGRES_SCHEMA = join(root, 'packages/db/prisma/postgres/schema.prisma');

// The transform lives in TypeScript beside the rest of @dash/db so the test and
// this script cannot drift apart. tsx runs it directly.
const { toPostgresSchema } = await import('../packages/db/src/postgres-schema.ts');

const source = readFileSync(SQLITE_SCHEMA, 'utf8');
const generated = toPostgresSchema(source);

const check = process.argv.includes('--check');

if (check) {
  let current;
  try {
    current = readFileSync(POSTGRES_SCHEMA, 'utf8');
  } catch {
    console.error(
      `\n  ${POSTGRES_SCHEMA} does not exist.\n  Run: npm run db:pg:sync\n`,
    );
    process.exit(1);
  }

  if (current !== generated) {
    console.error(
      '\n  The PostgreSQL schema is out of date with packages/db/prisma/schema.prisma.\n' +
        '  Run: npm run db:pg:sync\n',
    );
    process.exit(1);
  }

  console.log('  PostgreSQL schema is in sync with the SQLite schema.');
  process.exit(0);
}

mkdirSync(dirname(POSTGRES_SCHEMA), { recursive: true });
writeFileSync(POSTGRES_SCHEMA, generated, 'utf8');
console.log(`  Wrote ${POSTGRES_SCHEMA}`);
