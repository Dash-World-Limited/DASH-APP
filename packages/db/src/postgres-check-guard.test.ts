/**
 * The guard that stops `check:postgres` migrating something that matters.
 *
 * These tests exist because the previous guard read correctly and did nothing.
 * Its pre-flight recorded a failed check and execution continued into
 * `migrate deploy`; the comment said the database was "rejected" and no code
 * rejected it. A test asserting that the comment was present would have passed.
 *
 * So every test here proves the *ordering*: that the thing which must not
 * happen did not happen. `migrate` is a spy standing in for the first Prisma
 * command, and `process.exit` is modelled as a thrown sentinel, because an exit
 * does not return and a test needs to observe that control never came back.
 */

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  checkApplicationTables,
  checkDatabaseName,
  databaseNameFrom,
  requireSafeTarget,
  THROWAWAY_DATABASE_PATTERN,
  type TableRef,
} from './postgres-check-guard.js';

/** Stands in for `process.exit`: does not return, and says so in the type. */
class Exited extends Error {
  constructor(readonly reason: string) {
    super('exited');
    this.name = 'Exited';
  }
}

const PASSWORD = 'sup3rs3cr3t-hunter2';
const url = (database: string) =>
  `postgresql://dashadmin:${PASSWORD}@dash-declutters-db.abc123.eu-west-1.rds.amazonaws.com:5432/${database}?sslmode=require`;

/**
 * The script's shape, in miniature.
 *
 * Guard, then migrate. If the guard is doing its job, `migrate` is never
 * reached for an unsafe target — which is the exact property the real script
 * lacked.
 */
async function attemptCheck(
  target: string,
  listApplicationTables: () => Promise<readonly TableRef[]>,
) {
  const migrate = vi.fn(async () => 'migrated');
  const onUnsafe = (reason: string): never => {
    throw new Exited(reason);
  };

  let exited: Exited | null = null;
  try {
    await requireSafeTarget({ url: url(target), listApplicationTables, onUnsafe });
    await migrate();
  } catch (error) {
    if (!(error instanceof Exited)) throw error;
    exited = error;
  }

  return { migrate, exited, queried: listApplicationTables };
}

const empty = () => Promise.resolve([]);
const populated = (): Promise<readonly TableRef[]> =>
  Promise.resolve([
    { schema: 'public', name: '_prisma_migrations' },
    { schema: 'public', name: 'Identity' },
    { schema: 'public', name: 'Order' },
  ]);

// ---------------------------------------------------------------------------
// The four cases the repair has to prove
// ---------------------------------------------------------------------------

describe('what the guard refuses, and when', () => {
  it('rejects dashdb before any Prisma migration command runs', async () => {
    // The one that matters. Production is named `dashdb`.
    const listApplicationTables = vi.fn(empty);
    const { migrate, exited } = await attemptCheck('dashdb', listApplicationTables);

    expect(exited).toBeInstanceOf(Exited);
    expect(migrate).not.toHaveBeenCalled();
    expect(exited?.reason).toContain('dashdb');
  });

  it('does not even query a wrongly-named database', async () => {
    // Stronger than "does not migrate it": an unsafe target is not touched at
    // all, because the name is checked before the connection is used.
    const listApplicationTables = vi.fn(empty);
    await attemptCheck('dashdb', listApplicationTables);
    expect(listApplicationTables).not.toHaveBeenCalled();
  });

  it('rejects a non-empty dash_verify database before migration', async () => {
    // Correctly named, so the name check passes and the contents are read. A
    // re-used throwaway is still refused: migrating it produces results that
    // look like drift and are not.
    const listApplicationTables = vi.fn(populated);
    const { migrate, exited } = await attemptCheck('dash_verify_20260911', listApplicationTables);

    expect(listApplicationTables).toHaveBeenCalledOnce();
    expect(exited).toBeInstanceOf(Exited);
    expect(migrate).not.toHaveBeenCalled();
    expect(exited?.reason).toContain('_prisma_migrations');
  });

  it('rejects a preflight-query error before migration', async () => {
    // Not knowing what a database holds is not a reason to migrate it. The
    // previous version caught the error, recorded a failure, and carried on.
    const listApplicationTables = vi.fn(() =>
      Promise.reject(new Error('permission denied for schema public')),
    );
    const { migrate, exited } = await attemptCheck('dash_verify', listApplicationTables);

    expect(exited).toBeInstanceOf(Exited);
    expect(migrate).not.toHaveBeenCalled();
    expect(exited?.reason).toContain('contents are unknown');
    expect(exited?.reason).toContain('permission denied');
  });

  it('lets a clean dash_verify database proceed', async () => {
    // The guard must not be so strict that the check cannot run at all.
    const listApplicationTables = vi.fn(empty);
    const { migrate, exited } = await attemptCheck('dash_verify_20260911', listApplicationTables);

    expect(exited).toBeNull();
    expect(migrate).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

describe('the guard never discloses the connection credentials', () => {
  it('keeps the password out of every refusal reason', async () => {
    // A refusal is printed to a terminal and often pasted into a chat or an
    // issue. The URL carries a production password in its userinfo, so no
    // message may contain it.
    const reasons: string[] = [];

    for (const [target, list] of [
      ['dashdb', empty],
      ['dash_verify', populated],
      ['dash_verify', () => Promise.reject(new Error('nope'))],
    ] as const) {
      const { exited } = await attemptCheck(target, list);
      if (exited) reasons.push(exited.reason);
    }

    expect(reasons).toHaveLength(3);
    for (const reason of reasons) {
      expect(reason).not.toContain(PASSWORD);
      expect(reason).not.toContain('dashadmin');
      expect(reason).not.toContain('rds.amazonaws.com');
    }
  });

  it('says why an unparseable URL was refused without quoting it', () => {
    const verdict = checkDatabaseName(`postgresql://user:${PASSWORD}@host:5432/`);
    expect(verdict.safe).toBe(false);
    if (verdict.safe) return;
    expect(verdict.reason).not.toContain(PASSWORD);
    expect(verdict.reason).toContain('dash_verify');
  });
});

// ---------------------------------------------------------------------------
// The pieces, directly
// ---------------------------------------------------------------------------

describe('reading the database name', () => {
  it('reads it from a realistic RDS URL', () => {
    expect(databaseNameFrom(url('dash_verify_20260911'))).toBe('dash_verify_20260911');
  });

  it('handles a URL with no query string and a plain host', () => {
    expect(databaseNameFrom('postgresql://u:p@localhost:5432/dash_verify')).toBe('dash_verify');
  });

  it('accepts the postgres:// spelling as well as postgresql://', () => {
    expect(databaseNameFrom('postgres://u:p@localhost:5432/dash_verify')).toBe('dash_verify');
  });

  it('returns null rather than guessing', () => {
    for (const bad of [
      '',
      'not-a-url',
      'postgresql://host:5432', // no database
      'postgresql://host:5432/', // empty database
      'mysql://u:p@host:3306/dash_verify', // wrong engine
      'file:./dev.db',
    ]) {
      expect(databaseNameFrom(bad), bad).toBeNull();
    }
  });
});

describe('the throwaway naming convention', () => {
  it('accepts the names meant for this check', () => {
    for (const name of ['dash_verify', 'dash_verify_20260911', 'dash_verify_pr_412']) {
      expect(THROWAWAY_DATABASE_PATTERN.test(name), name).toBe(true);
    }
  });

  it('refuses names that only look close', () => {
    // A whitelist rather than a blacklist of `dashdb`, because a blacklist
    // passes every other name a production database could be restored under.
    for (const name of [
      'dashdb',
      'dashdb_prod',
      'dash',
      'dash_verifyprod', // no separator: prefix alone must not qualify
      'dash_verification_live',
      'postgres',
      'template1',
      'DASH_VERIFY', // case matters; a different name is a different database
    ]) {
      expect(THROWAWAY_DATABASE_PATTERN.test(name), name).toBe(false);
    }
  });

  it('refuses every one of those through the public check too', () => {
    for (const name of ['dashdb', 'dash', 'postgres', 'dash_verifyprod']) {
      expect(checkDatabaseName(url(name)).safe, name).toBe(false);
    }
    expect(checkDatabaseName(url('dash_verify_20260911')).safe).toBe(true);
  });
});

describe('reading the target contents', () => {
  it('treats an empty list as safe', () => {
    expect(checkApplicationTables([]).safe).toBe(true);
  });

  it('names what it found, so the fix is obvious', () => {
    const verdict = checkApplicationTables([{ schema: 'public', name: 'Identity' }]);
    expect(verdict.safe).toBe(false);
    if (verdict.safe) return;
    expect(verdict.reason).toContain('public.Identity');
  });

  it('counts _prisma_migrations, which is the signal that matters most', () => {
    // A database that has been migrated before must be refused even if it holds
    // nothing else: `migrate deploy` would find a history it did not write.
    const verdict = checkApplicationTables([{ schema: 'public', name: '_prisma_migrations' }]);
    expect(verdict.safe).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The wiring
// ---------------------------------------------------------------------------

describe('the script is actually wired to the guard', () => {
  /**
   * Run `scripts/postgres-check.mjs` for real, pointed at a production name.
   *
   * The unit tests above prove the guard decides correctly. They cannot prove
   * the script *asks* it — and that was the whole defect: the decision existed,
   * was printed, and was then ignored by the next line. So this runs the real
   * entry point.
   *
   * Safe to run in a suite: the host below does not exist and is never
   * contacted, because refusing the name happens before anything connects.
   * That is itself part of what is asserted.
   */
  it('refuses a production database name, and reaches no Prisma command', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const script = join(here, '../../../scripts/postgres-check.mjs');
    const tsx = createRequire(import.meta.url).resolve('tsx/cli');

    let status = 0;
    let output = '';
    try {
      output = execFileSync(process.execPath, [tsx, script], {
        env: {
          ...process.env,
          PG_CHECK_URL: `postgresql://dashadmin:${PASSWORD}@db.invalid:5432/dashdb`,
        },
        encoding: 'utf8',
        stdio: 'pipe',
      });
    } catch (error) {
      const failure = error as { status?: number; stdout?: string; stderr?: string };
      status = failure.status ?? -1;
      output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`;
    }

    // Non-zero, so a CI step or a shell `&&` cannot continue past it.
    expect(status, output).not.toBe(0);
    expect(output).toContain('dashdb');

    // No Prisma command ran. These strings appear in `migrate deploy` and
    // `migrate status` output, and their absence is the property that matters:
    // the previous version printed FAIL and then migrated the database.
    for (const evidence of [
      'migrations found',
      'Applying migration',
      'successfully applied',
      'Datasource',
    ]) {
      expect(output, `${evidence} must not appear`).not.toContain(evidence);
    }

    // And the password is not in the refusal.
    expect(output).not.toContain(PASSWORD);
  }, 120_000);
});

describe('the abort must not return', () => {
  it('refuses to continue if onUnsafe hands control back', async () => {
    // `onUnsafe` is typed `never`, but types are not enforcement at runtime and
    // a caller could pass one that returns. Continuing then would reintroduce
    // the original bug exactly, so the guard throws instead.
    const listApplicationTables = vi.fn(empty);
    await expect(
      requireSafeTarget({
        url: url('dashdb'),
        listApplicationTables,
        onUnsafe: (() => undefined) as unknown as (reason: string) => never,
      }),
    ).rejects.toThrow(/refusing to continue/i);
    expect(listApplicationTables).not.toHaveBeenCalled();
  });
});
