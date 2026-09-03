/**
 * The guard that stops the two Prisma schemas diverging.
 *
 * Prisma forbids `env()` in a datasource provider (P1012) and pins the provider
 * in `migration_lock.toml`, so SQLite development and PostgreSQL production
 * cannot share one schema. This repository therefore keeps two — and the whole
 * risk of that arrangement is that someone adds a model to one and forgets the
 * other, which would not fail anything until production.
 *
 * These tests make that failure immediate and loud. They check the same
 * property two independent ways, so a bug in the transform cannot hide a real
 * divergence:
 *
 *   1. Regenerating the PostgreSQL schema reproduces the checked-in file
 *      byte-for-byte.
 *   2. The model surface of both files — every model, field, relation, index,
 *      and constraint, with the datasource and generator blocks removed — is
 *      character-identical, computed without going through the transform at all.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DIALECT_SUBSTITUTIONS,
  modelSurface,
  SchemaSyncError,
  toPostgresSchema,
} from './postgres-schema.js';

const here = dirname(fileURLToPath(import.meta.url));
const SQLITE_PATH = join(here, '../prisma/schema.prisma');
const POSTGRES_PATH = join(here, '../prisma/postgres/schema.prisma');

const sqliteSchema = readFileSync(SQLITE_PATH, 'utf8');
const postgresSchema = readFileSync(POSTGRES_PATH, 'utf8');

describe('the two schemas stay in step', () => {
  it('regenerates the PostgreSQL schema byte-for-byte', () => {
    // If this fails, schema.prisma changed and nobody ran `npm run db:pg:sync`.
    expect(toPostgresSchema(sqliteSchema)).toBe(postgresSchema);
  });

  it('has an identical model surface in both dialects', () => {
    // Computed straight from the files, not via the transform, so this still
    // catches a divergence that a broken transform would happily reproduce.
    expect(modelSurface(postgresSchema)).toBe(modelSurface(sqliteSchema));
  });

  it('declares the same models in both files', () => {
    const models = (schema: string) =>
      [...schema.matchAll(/^model\s+(\w+)\s*\{/gm)].map((match) => match[1]).sort();

    const sqliteModels = models(sqliteSchema);
    expect(sqliteModels.length).toBeGreaterThan(40);
    expect(models(postgresSchema)).toEqual(sqliteModels);
  });
});

describe('the dialect differences are declared, not incidental', () => {
  it('differs only in the datasource provider and the client output path', () => {
    // Two declared differences, and the list is asserted exhaustively so a
    // third cannot be added without this test being edited deliberately. Both
    // are about *where the schema points*, never about what it models — the
    // model-surface comparison above is what guarantees that half.
    expect(DIALECT_SUBSTITUTIONS).toHaveLength(2);

    expect(DIALECT_SUBSTITUTIONS[0]!.from).toBe('provider = "sqlite"');
    expect(DIALECT_SUBSTITUTIONS[0]!.to).toBe('provider = "postgresql"');

    // The second exists because both schemas previously generated into the
    // hoisted root @prisma/client and overwrote each other. `db:generate`
    // (SQLite) runs far more often, so the ambient client was always the SQLite
    // one, and a SQLite client rejects a postgresql:// URL — which meant
    // `check:postgres` could not connect to the database it verifies.
    expect(DIALECT_SUBSTITUTIONS[1]!.to).toContain('output   = "./.client"');
    expect(DIALECT_SUBSTITUTIONS[1]!.from).toContain('No custom `output`');
  });

  it('gives the PostgreSQL client its own output directory', () => {
    // The property that matters, asserted on the generated file rather than on
    // the substitution that produces it.
    expect(postgresSchema).toMatch(/output\s*=\s*"\.\/\.client"/);
    expect(sqliteSchema).not.toMatch(/output\s*=/);
  });

  it('gives every declared difference a written reason', () => {
    for (const substitution of DIALECT_SUBSTITUTIONS) {
      expect(substitution.why.length, `${substitution.from} has no reason`).toBeGreaterThan(40);
    }
  });

  it('carries no native type annotations, which would be dialect-specific', () => {
    // A single `@db.VarChar` or `@db.Timestamptz` would make the two schemas
    // genuinely different documents rather than one document and a provider
    // line. Prisma maps every field itself while none are present.
    expect(sqliteSchema).not.toMatch(/@db\./);
    expect(postgresSchema).not.toMatch(/@db\./);
  });

  it('sets the right provider in each file', () => {
    expect(sqliteSchema).toMatch(/provider\s*=\s*"sqlite"/);
    expect(postgresSchema).toMatch(/provider\s*=\s*"postgresql"/);
    expect(postgresSchema).not.toMatch(/provider\s*=\s*"sqlite"/);
  });

  it('marks the generated file as generated', () => {
    expect(postgresSchema.startsWith('// GENERATED FILE — DO NOT EDIT.')).toBe(true);
  });
});

describe('the transform refuses to guess', () => {
  it('throws when a substitution anchor is missing', () => {
    // Simulates schema.prisma being reworked so the anchor no longer matches.
    // Silently producing an unchanged file would ship a SQLite provider to
    // production, so this must fail rather than no-op.
    expect(() => toPostgresSchema('datasource db {\n  provider = "mysql"\n}\n')).toThrow(
      SchemaSyncError,
    );
  });

  it('throws when a substitution anchor is ambiguous', () => {
    const doubled = `${sqliteSchema}\nprovider = "sqlite"\n`;
    expect(() => toPostgresSchema(doubled)).toThrow(SchemaSyncError);
  });
});

describe('the PostgreSQL migration history is its own', () => {
  const migrationLock = readFileSync(
    join(here, '../prisma/postgres/migrations/migration_lock.toml'),
    'utf8',
  );
  const initMigration = readFileSync(
    join(here, '../prisma/postgres/migrations/20260902000000_init/migration.sql'),
    'utf8',
  );

  /**
   * Every PostgreSQL migration concatenated.
   *
   * The model-coverage check below used to read `initMigration` alone, which
   * quietly assumed there would only ever be one migration. The first migration
   * added after it — Milestone IV's outbox — failed the test for a model that
   * was correctly created, just not in the baseline. Coverage is a property of
   * the history, not of its first entry.
   */
  const allMigrations = readdirSync(join(here, '../prisma/postgres/migrations'), {
    withFileTypes: true,
  })
    .filter((entry) => entry.isDirectory())
    .map((entry) =>
      readFileSync(join(here, '../prisma/postgres/migrations', entry.name, 'migration.sql'), 'utf8'),
    )
    .join('\n');

  it('pins the PostgreSQL provider', () => {
    expect(migrationLock).toContain('provider = "postgresql"');
    expect(migrationLock).not.toContain('sqlite');
  });

  it('emits PostgreSQL DDL, not SQLite DDL', () => {
    // The SQLite history uses DATETIME and inline `TEXT NOT NULL PRIMARY KEY`;
    // neither runs on PostgreSQL. Catching a copied-across migration here is
    // cheaper than catching it during a deploy.
    expect(initMigration).toMatch(/TIMESTAMP\(3\)/);
    expect(initMigration).toMatch(/DOUBLE PRECISION/);
    expect(initMigration).not.toMatch(/\bDATETIME\b/);
    expect(initMigration).not.toMatch(/AUTOINCREMENT/);
  });

  it('creates every model as a table', () => {
    const models = [...sqliteSchema.matchAll(/^model\s+(\w+)\s*\{/gm)].map((match) => match[1]!);
    for (const model of models) {
      expect(allMigrations, `no CREATE TABLE for ${model}`).toContain(`CREATE TABLE "${model}"`);
    }
  });
});
