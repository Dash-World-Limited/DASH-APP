/**
 * Which generated Prisma client a given DATABASE_URL resolves to.
 *
 * This exists because of a failure that reached a production runbook without
 * anyone noticing. The PostgreSQL schema generates its client into its own
 * `.client` directory so the two generated clients cannot overwrite each
 * other — correct, and the reason `check:postgres` works at all. But the
 * consequence was that `@dash/db` imported the *hoisted* client, which is
 * generated from the SQLite schema, and a SQLite client refuses a
 * `postgresql://` URL:
 *
 *     Error validating datasource `db`: the URL must start with the protocol `file:`
 *
 * It refuses at the first query, not at boot. So the documented deployment
 * sequence — `npm ci`, `db:pg:generate`, `build`, start — produced an API that
 * appeared to start and then failed on its first request, and a reference seed
 * that could never write to production.
 *
 * These tests pin the four properties that have to stay true together. Three
 * of them run in child processes, because module resolution is the thing under
 * test and `vi.mock` would be testing the mock.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PrismaClient } from '@prisma/client';
import { beforeAll, describe, expect, it } from 'vitest';

import { resolvePrismaConstructor, targetsPostgres } from './index.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const postgresSchema = join(repoRoot, 'packages/db/prisma/postgres/schema.prisma');
const postgresClientEntry = join(repoRoot, 'packages/db/prisma/postgres/.client/index.js');
const postgresClientSchema = join(repoRoot, 'packages/db/prisma/postgres/.client/schema.prisma');
const sqliteClientSchema = join(repoRoot, 'node_modules/.prisma/client/schema.prisma');

/**
 * An address nothing is listening on.
 *
 * The runtime assertions below only need the client to get far enough to
 * reject or accept the *protocol*. Reaching a real server would make these
 * tests need one, and the distinction being proved happens before any
 * connection is opened.
 */
const UNREACHABLE = 'postgresql://someone:secret@127.0.0.1:1/nothing';

const DATASOURCE_PROVIDER = /datasource\s+\w+\s*\{[^}]*?provider\s*=\s*"([^"]+)"/;

function datasourceProviderOf(schemaPath: string): string {
  return DATASOURCE_PROVIDER.exec(readFileSync(schemaPath, 'utf8'))?.[1] ?? 'unknown';
}

/** Run a snippet in a child process with a chosen DATABASE_URL. */
function runWithUrl(source: string, url: string): { stdout: string; stderr: string; ok: boolean } {
  try {
    const stdout = execFileSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', source],
      { cwd: repoRoot, env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8' },
    );
    return { stdout, stderr: '', ok: true };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    return { stdout: failure.stdout ?? '', stderr: failure.stderr ?? '', ok: false };
  }
}

beforeAll(() => {
  // Gitignored and generated on demand, exactly as check:postgres does it, so
  // this suite does not depend on whoever ran what before it.
  if (!existsSync(postgresClientEntry)) {
    execFileSync('npx', ['prisma', 'generate', '--schema', postgresSchema], {
      cwd: repoRoot,
      stdio: 'ignore',
      shell: process.platform === 'win32',
    });
  }
}, 300_000);

describe('targetsPostgres', () => {
  it('recognises both PostgreSQL URL spellings and nothing else', () => {
    expect(targetsPostgres('postgresql://user@host:5432/db')).toBe(true);
    expect(targetsPostgres('postgres://user@host:5432/db')).toBe(true);
    expect(targetsPostgres('POSTGRESQL://user@host:5432/db')).toBe(true);

    expect(targetsPostgres('file:./dev.db')).toBe(false);
    expect(targetsPostgres(undefined)).toBe(false);
    expect(targetsPostgres('')).toBe(false);
  });
});

describe('SQLite development is untouched', () => {
  it('resolves the hoisted client for a file: URL', () => {
    expect(resolvePrismaConstructor('file:./dev.db')).toBe(PrismaClient);
  });

  it('resolves the hoisted client when DATABASE_URL is unset', () => {
    // The default has to stay SQLite: every test, the development seed and
    // `npm run dev` rely on it, and none of them should have to opt out.
    expect(resolvePrismaConstructor(undefined)).toBe(PrismaClient);
  });

  it('the hoisted client really is the SQLite one', () => {
    expect(datasourceProviderOf(sqliteClientSchema)).toBe('sqlite');
  });
});

describe('PostgreSQL resolves the PostgreSQL client', () => {
  it('returns a different constructor from the hoisted SQLite one', () => {
    expect(resolvePrismaConstructor(UNREACHABLE)).not.toBe(PrismaClient);
  });

  it('returns the client generated from the PostgreSQL schema', () => {
    expect(datasourceProviderOf(postgresClientSchema)).toBe('postgresql');
  });

  it('accepts a postgresql:// URL instead of demanding file:', async () => {
    const Client = resolvePrismaConstructor(UNREACHABLE);
    const client = new Client({ datasources: { db: { url: UNREACHABLE } } });

    // It must fail — nothing is listening on port 1 — but it must fail trying
    // to *reach* the database, not validating its protocol. That distinction
    // is the entire bug.
    await expect(client.$queryRawUnsafe('select 1')).rejects.toThrow();
    await expect(client.$queryRawUnsafe('select 1')).rejects.not.toThrow(
      /must start with the protocol `file:`/,
    );

    await client.$disconnect();
  }, 60_000);
});

describe('the consumers resolve it too', () => {
  it('the API path — importing @dash/db under a PostgreSQL URL — is not the SQLite client', () => {
    // apps/api/src/server.ts imports `prisma` from '@dash/db'. This is that
    // same import, so what it resolves to is what the API gets. A client that
    // is not an instance of the hoisted PrismaClient is, by construction, the
    // separately generated PostgreSQL one.
    const { stdout, stderr, ok } = runWithUrl(
      [
        "const { prisma } = await import('@dash/db');",
        "const { PrismaClient } = await import('@prisma/client');",
        'console.log(prisma instanceof PrismaClient ? "SQLITE" : "POSTGRES");',
      ].join('\n'),
      UNREACHABLE,
    );

    expect(ok, stderr).toBe(true);
    expect(stdout.trim()).toContain('POSTGRES');
  }, 120_000);

  it('db:seed:reference reaches the database instead of refusing the URL', () => {
    const { stderr, stdout } = runWithUrl(
      "await import('./packages/db/src/seed-reference.ts');",
      UNREACHABLE,
    );

    const output = `${stdout}\n${stderr}`;

    // It cannot succeed: nothing is listening. What matters is which failure.
    expect(output).not.toMatch(/must start with the protocol `file:`/);
    expect(output).not.toMatch(/provider = "sqlite"/);
  }, 120_000);

  it('says what to run when the PostgreSQL client was never generated', () => {
    // The real failure, not a mocked one: the generated directory is moved
    // aside so the require genuinely cannot resolve. The message an operator
    // gets has to name the fix, because the failure it replaced talked about
    // the `file:` protocol and sent people to inspect a DATABASE_URL that was
    // correct all along.
    //
    // If this throws before the restore, `beforeAll` regenerates the client on
    // the next run, so a crash here cannot leave the working tree broken.
    const live = join(repoRoot, 'packages/db/prisma/postgres/.client');
    const parked = `${live}.parked`;

    renameSync(live, parked);
    try {
      const { stderr, ok } = runWithUrl(
        [
          "const { resolvePrismaConstructor } = await import('@dash/db');",
          'resolvePrismaConstructor(process.env.DATABASE_URL);',
        ].join('\n'),
        UNREACHABLE,
      );

      expect(ok).toBe(false);
      expect(stderr).toMatch(/db:pg:generate/);
    } finally {
      renameSync(parked, live);
    }
  }, 120_000);
});
