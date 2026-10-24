/**
 * The guard that stops a schema change from skipping the migration history.
 *
 * `schema-sync.test.ts` already proves the two schemas agree with each other.
 * This proves each one agrees with the migrations that are supposed to build
 * it — which is a different property, and the one that was broken.
 *
 * ## What went wrong
 *
 * Four objects reached `schema.prisma` and no migration: `eligibilityMode` on
 * DispatchOffer, `condition` on MenuItem, `onlineUntil` on Rider, and the
 * unique index on `Device.pushToken`. Local development never noticed, because
 * development syncs with `db:push`, which makes a database match a schema
 * without writing a migration. Every test passed. Both schemas were in perfect
 * agreement. The only thing that could have caught it was applying the history
 * to an empty database and comparing — and nothing did that until the first
 * real `check:postgres` run against RDS, by which point the gap was nine
 * migrations old.
 *
 * The unique index is the one that mattered. It is what makes "two identities
 * claiming the same push token" unrepresentable, so a borrowed handset cannot
 * keep receiving the previous rider's dispatch offers. Production would have
 * had the comment explaining the constraint and not the constraint.
 *
 * ## Two checks, because the two dialects can be checked to different depths
 *
 *   1. **SQLite, exactly.** Prisma replays the history into a throwaway shadow
 *      database and diffs it against the datamodel. Nothing is approximated. It
 *      needs no server, so it runs here.
 *   2. **PostgreSQL, structurally.** The same diff needs a live PostgreSQL, and
 *      CI has none — that is the whole reason `check:postgres` is a separate
 *      manual gate. So the migration SQL is parsed and compared to the schema
 *      instead. It is a weaker check than a replay, and it would still have
 *      caught all four.
 *
 * Both matter. The structural check is the one that runs on every commit; the
 * replay is the one that cannot be fooled.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '../../..');
const SQLITE_SCHEMA = join(here, '../prisma/schema.prisma');
const POSTGRES_SCHEMA = join(here, '../prisma/postgres/schema.prisma');
const POSTGRES_MIGRATIONS = join(here, '../prisma/postgres/migrations');
const SQLITE_MIGRATIONS = join(here, '../prisma/migrations');

// ---------------------------------------------------------------------------
// Reading a Prisma schema
// ---------------------------------------------------------------------------

/**
 * Prisma's scalar types.
 *
 * A field whose type is not one of these is a relation, and a relation is not a
 * column — the foreign key beside it (`identityId String`) is. Deciding by type
 * rather than by looking for `@relation` also handles the implicit back-
 * references, which carry no attribute at all.
 */
const SCALARS = new Set([
  'String',
  'Boolean',
  'Int',
  'BigInt',
  'Float',
  'Decimal',
  'DateTime',
  'Json',
  'Bytes',
]);

interface Model {
  readonly columns: Set<string>;
  /** Each entry is the column list of one unique index, in declared order. */
  readonly uniques: string[][];
}

function parseSchema(text: string): Map<string, Model> {
  const models = new Map<string, Model>();
  let current: { name: string; model: Model } | null = null;

  for (const raw of text.split('\n')) {
    // `///` doc comments and `//` comments are not schema.
    const line = raw.replace(/\/\/.*$/, '').trim();
    if (line === '') continue;

    const opening = /^model\s+(\w+)\s*\{$/.exec(line);
    if (opening?.[1]) {
      current = { name: opening[1], model: { columns: new Set(), uniques: [] } };
      continue;
    }
    if (!current) continue;
    if (line === '}') {
      models.set(current.name, current.model);
      current = null;
      continue;
    }

    const composite = /^@@unique\(\s*\[([^\]]+)\]/.exec(line);
    if (composite?.[1]) {
      current.model.uniques.push(composite[1].split(',').map((name) => name.trim()));
      continue;
    }
    // Other block attributes declare no column.
    if (line.startsWith('@@')) continue;

    const field = /^(\w+)\s+(\w+)(\[\])?(\?)?(.*)$/.exec(line);
    if (!field?.[1] || !field[2]) continue;
    const [, name, type, list, , rest = ''] = field;
    if (list !== undefined) continue; // a list is never a column here
    if (!SCALARS.has(type)) continue; // a relation

    current.model.columns.add(name);
    // `@@unique` is already handled above; this is the field-level form. The
    // word boundary keeps `@unique` from matching inside `@uniqueSomething`.
    if (/@unique\b/.test(rest)) current.model.uniques.push([name]);
  }

  return models;
}

// ---------------------------------------------------------------------------
// Reading a migration history
// ---------------------------------------------------------------------------

interface History {
  readonly tables: Map<string, Set<string>>;
  /** Unique indexes as `Table(colA,colB)`. */
  readonly uniques: Set<string>;
  /** Statements the parser did not recognise. */
  readonly unrecognised: string[];
}

/**
 * Parse only the DDL these histories actually contain.
 *
 * Deliberately not a general SQL parser. The vocabulary is closed — CREATE
 * TABLE, ALTER TABLE ADD COLUMN, ALTER TABLE ADD CONSTRAINT, CREATE INDEX and
 * CREATE UNIQUE INDEX — and anything outside it is collected in `unrecognised`
 * and fails a test below rather than being skipped. A parser that quietly
 * ignores what it does not understand is worse than none, because it reports
 * agreement it did not establish: a future `DROP COLUMN` would leave this test
 * green while the column vanished.
 */
function parseHistory(dir: string): History {
  const tables = new Map<string, Set<string>>();
  const uniques = new Set<string>();
  const unrecognised: string[] = [];

  const migrations = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  for (const migration of migrations) {
    const sql = readFileSync(join(dir, migration, 'migration.sql'), 'utf8');

    // Strip comments and split on statement terminators.
    const cleaned = sql
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n');

    for (const statement of cleaned.split(';')) {
      const text = statement.trim();
      if (text === '') continue;
      const flat = text.replace(/\s+/g, ' ');

      const created = /^CREATE TABLE (?:IF NOT EXISTS )?"(\w+)" \(/i.exec(flat);
      if (created?.[1]) {
        const columns = new Set<string>();
        // Column definitions are the lines opening with a quoted name. A
        // table-level CONSTRAINT line opens with the keyword instead.
        for (const line of text.split('\n').slice(1)) {
          const column = /^\s*"(\w+)"\s+\S/.exec(line);
          if (column?.[1] && !/^\s*(CONSTRAINT|PRIMARY|FOREIGN|UNIQUE|CHECK)\b/i.test(line)) {
            columns.add(column[1]);
          }
        }
        tables.set(created[1], columns);
        continue;
      }

      // One `ALTER TABLE` may carry several comma-separated `ADD COLUMN`
      // clauses — Prisma emits that form whenever a migration adds more than
      // one field to a table — so every clause is collected, not just the first.
      // Matching only the first is how this parser initially reported two dozen
      // columns as missing that were present all along.
      const altered = /^ALTER TABLE "(\w+)" /i.exec(flat);
      if (altered?.[1]) {
        const table = tables.get(altered[1]);
        if (!table) {
          unrecognised.push(`${migration}: ALTER TABLE on unknown table ${altered[1]}`);
          continue;
        }
        const clauses = [...flat.matchAll(/ADD COLUMN (?:IF NOT EXISTS )?"(\w+)"/gi)];
        for (const clause of clauses) {
          if (clause[1]) table.add(clause[1]);
        }
        // A statement that alters a table without adding a column is only safe
        // to ignore when it is one of the forms known not to change the column
        // set. Anything else must be reported.
        if (clauses.length === 0 && !/ADD CONSTRAINT /i.test(flat)) {
          unrecognised.push(`${migration}: ${flat.slice(0, 100)}`);
        }
        continue;
      }

      const unique = /^CREATE UNIQUE INDEX (?:IF NOT EXISTS )?"[^"]+" ON "(\w+)"\s*\(([^)]+)\)/i.exec(flat);
      if (unique?.[1] && unique[2]) {
        const columns = unique[2].split(',').map((name) => name.trim().replace(/"/g, ''));
        uniques.add(`${unique[1]}(${columns.join(',')})`);
        continue;
      }

      // Known and column-irrelevant.
      if (/^CREATE INDEX /i.test(flat)) continue;
      if (/^(UPDATE|INSERT|DELETE|PRAGMA|CREATE EXTENSION|CREATE SCHEMA) /i.test(flat)) continue;

      unrecognised.push(`${migration}: ${flat.slice(0, 100)}`);
    }
  }

  return { tables, uniques, unrecognised };
}

// ---------------------------------------------------------------------------
// PostgreSQL — structural
// ---------------------------------------------------------------------------

describe('the PostgreSQL migration history builds the PostgreSQL schema', () => {
  const schema = parseSchema(readFileSync(POSTGRES_SCHEMA, 'utf8'));
  const history = parseHistory(POSTGRES_MIGRATIONS);

  it('parses a schema and a history worth comparing', () => {
    // Both parsers are heuristics, and a heuristic that silently returns
    // nothing would make every assertion below vacuous.
    expect(schema.size).toBeGreaterThan(60);
    expect(history.tables.size).toBeGreaterThan(60);
    expect(schema.has('Device')).toBe(true);
    expect(history.tables.has('Device')).toBe(true);
  });

  it('understands every statement in the history', () => {
    // If this fails, the parser met DDL it does not model, and the column
    // comparison below can no longer be trusted. Teach it the statement rather
    // than deleting this test.
    expect(history.unrecognised).toEqual([]);
  });

  it('creates a table for every model', () => {
    const missing = [...schema.keys()].filter((model) => !history.tables.has(model));
    expect(missing, `models with no CREATE TABLE: ${missing.join(', ')}`).toEqual([]);
  });

  it('creates a column for every scalar field', () => {
    // The check that would have caught eligibilityMode, condition and
    // onlineUntil nine migrations before RDS did.
    const missing: string[] = [];
    for (const [model, { columns }] of schema) {
      const built = history.tables.get(model);
      if (!built) continue; // reported by the test above
      for (const column of columns) {
        if (!built.has(column)) missing.push(`${model}.${column}`);
      }
    }
    expect(
      missing,
      `${missing.length} column(s) in the schema that no migration creates: ${missing.join(', ')}. ` +
        'Add a forward migration; do not edit an applied one.',
    ).toEqual([]);
  });

  it('creates no column the schema does not declare', () => {
    // The other direction. A field removed from the schema without a migration
    // leaves a column behind, and drift is drift whichever way it points.
    const extra: string[] = [];
    for (const [table, columns] of history.tables) {
      const model = schema.get(table);
      if (!model) {
        extra.push(`${table} (whole table)`);
        continue;
      }
      for (const column of columns) {
        if (!model.columns.has(column)) extra.push(`${table}.${column}`);
      }
    }
    expect(extra, `built by a migration but absent from the schema: ${extra.join(', ')}`).toEqual([]);
  });

  it('creates a unique index for every uniqueness the schema declares', () => {
    // The check that would have caught Device.pushToken — the one with real
    // consequences, since without it a borrowed handset can hold a second claim
    // on a push token and keep receiving the previous rider's offers.
    const missing: string[] = [];
    for (const [model, { uniques }] of schema) {
      for (const columns of uniques) {
        const key = `${model}(${columns.join(',')})`;
        if (!history.uniques.has(key)) missing.push(key);
      }
    }
    expect(
      missing,
      `${missing.length} unique constraint(s) declared in the schema and built by no migration: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('still has the constraint that makes a stolen push route unrepresentable', () => {
    // Named on its own, so that removing it fails with its reason attached
    // rather than as one line in a list.
    expect(history.uniques.has('Device(pushToken)')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SQLite — exact, by replay
// ---------------------------------------------------------------------------

describe('the SQLite migration history builds the SQLite schema', () => {
  it('replays to exactly the schema, with no drift', () => {
    // The check that cannot be fooled: Prisma applies every migration to an
    // empty shadow database and diffs the result against the datamodel. This is
    // what `check:postgres` does against a real server, and SQLite lets it run
    // with no server at all — so the property is enforced on every commit for
    // one dialect, and `schema-sync.test.ts` ties the two dialects together.
    const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');
    const scratch = mkdtempSync(join(tmpdir(), 'dash-migration-parity-'));

    try {
      const output = execFileSync(
        process.execPath,
        [
          prismaCli,
          'migrate',
          'diff',
          '--from-migrations',
          SQLITE_MIGRATIONS,
          '--to-schema-datamodel',
          SQLITE_SCHEMA,
          '--shadow-database-url',
          `file:${join(scratch, 'shadow.db').replace(/\\/g, '/')}`,
        ],
        { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe' },
      );

      expect(
        output,
        `The SQLite migration history no longer builds the schema:\n${output}`,
      ).toContain('No difference detected');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 180_000);
});
