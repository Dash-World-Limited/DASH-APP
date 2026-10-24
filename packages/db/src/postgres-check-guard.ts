/**
 * Refusing to run the PostgreSQL verification against a database that matters.
 *
 * `scripts/postgres-check.mjs` migrates its target from zero and then writes to
 * it. Pointed at production that is a catastrophe, and the previous guard did
 * not prevent it: the pre-flight recorded a failed check and **execution
 * continued into `migrate deploy`**. The comment said the database was
 * "rejected". Nothing rejected it. A populated production database would have
 * received every pending migration, and an empty one would have sailed through
 * the pre-flight and been migrated without a murmur.
 *
 * That is the same defect as a config value that is validated and never read:
 * the claim lives in a comment and nothing enforces it. So the decision is
 * extracted here, where it can be tested, rather than left as prose beside a
 * `check()` call that only counts.
 *
 * ## Two independent refusals
 *
 *   1. **The name.** The target must be a database created for this purpose,
 *      named by the `dash_verify` convention. This is the refusal that protects
 *      production, and it is deliberately a whitelist: a blacklist of
 *      `dashdb` would pass `dashdb_prod`, `dash`, or a copy restored under any
 *      other name.
 *   2. **The contents.** Even a correctly-named database must hold no
 *      application tables, because a re-used one produces the most confusing
 *      failure available — `migrate deploy` finds a history it did not write,
 *      and the drift check then reports tables as missing that are missing only
 *      because the history never ran.
 *
 * The name is checked first and short-circuits, so a database that fails it is
 * never even queried. Nothing about an unsafe target is touched.
 *
 * ## Credentials
 *
 * A `PG_CHECK_URL` carries a password in its userinfo. Nothing here ever puts
 * the URL into a message, a log line, or a thrown error — only the database
 * name, which is not a secret. `databaseNameFrom` exists partly so that no
 * caller is tempted to interpolate the URL itself while reporting a problem.
 */

/** A table found in the target, named for a human. */
export interface TableRef {
  readonly schema: string;
  readonly name: string;
}

export type Verdict =
  | { readonly safe: true }
  | { readonly safe: false; readonly reason: string };

const SAFE = { safe: true } as const;
const unsafe = (reason: string): Verdict => ({ safe: false, reason });

/**
 * Database names this check may be run against.
 *
 * `dash_verify`, or `dash_verify_` followed by anything — a date, a ticket, a
 * person. Requiring the separator is what stops `dash_verifyprod` and
 * `dash_verification_live` from qualifying by prefix alone.
 */
export const THROWAWAY_DATABASE_PATTERN = /^dash_verify(?:_|$)/;

/**
 * The database name from a PostgreSQL URL, or null if it cannot be read.
 *
 * Never returns, logs, or throws anything containing the rest of the URL.
 */
export function databaseNameFrom(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!/^postgres(ql)?:$/.test(parsed.protocol)) return null;

  // `/dashdb` -> `dashdb`. A URL with no path, or a path of just `/`, names no
  // database.
  const name = decodeURIComponent(parsed.pathname.replace(/^\//, '')).trim();
  return name === '' ? null : name;
}

/**
 * Is this URL allowed to be migrated from zero and written to?
 *
 * The reason text names the database and never the URL, so it is safe to print.
 */
export function checkDatabaseName(url: string): Verdict {
  const name = databaseNameFrom(url);
  if (name === null) {
    return unsafe(
      'PG_CHECK_URL is not a PostgreSQL URL naming a database. ' +
        'Expected postgresql://…/dash_verify_YYYYMMDD (the URL is not shown here because it carries a password).',
    );
  }
  if (!THROWAWAY_DATABASE_PATTERN.test(name)) {
    return unsafe(
      `Refusing to run against the database "${name}". This check migrates from zero and then ` +
        'writes, so it may only target a database created for it, named `dash_verify` or ' +
        '`dash_verify_<something>` — for example `dash_verify_20260911`. Create a throwaway ' +
        'database and point PG_CHECK_URL at that instead.',
    );
  }
  return SAFE;
}

/** Is the target free of application tables? */
export function checkApplicationTables(tables: readonly TableRef[]): Verdict {
  if (tables.length === 0) return SAFE;
  const listed = tables.map((table) => `${table.schema}.${table.name}`).join(', ');
  return unsafe(
    `The target holds ${tables.length} application table(s): ${listed}. Drop and recreate it — ` +
      'this check migrates from zero, and its results are meaningless against a ' +
      'partially-migrated database.',
  );
}

export interface SafeTargetDeps {
  readonly url: string;
  /**
   * Tables in the target that no extension owns.
   *
   * Injected rather than queried here so that this module stays free of a
   * database client, and so the refusal path can be tested without one.
   */
  listApplicationTables(): Promise<readonly TableRef[]>;
  /**
   * Called with the reason when the target is unsafe. **Must not return** — in
   * the script it disconnects and exits.
   *
   * Passing the abort in, rather than returning a verdict for the caller to
   * act on, is the point of this function. Returning a verdict is exactly what
   * the broken version did: it reported the problem and let the next statement
   * run anyway.
   */
  onUnsafe(reason: string): never | Promise<never>;
}

/**
 * Verify the target, or do not come back.
 *
 * On success this resolves and the caller may proceed. On failure it calls
 * `onUnsafe`, which does not return — so a caller cannot accidentally continue
 * past an unsafe target, whatever it does with the result.
 *
 * A failure of the query itself is treated as unsafe, not as inconclusive. Not
 * knowing what a database contains is not a reason to migrate it.
 */
export async function requireSafeTarget(deps: SafeTargetDeps): Promise<void> {
  const named = checkDatabaseName(deps.url);
  if (!named.safe) {
    await deps.onUnsafe(named.reason);
    // Defensive: `onUnsafe` is typed `never`, but a caller could pass one that
    // returns, and continuing here is precisely the bug this function exists to
    // make impossible.
    throw new Error('onUnsafe returned; refusing to continue against an unverified target');
  }

  let tables: readonly TableRef[];
  try {
    tables = await deps.listApplicationTables();
  } catch (error) {
    await deps.onUnsafe(
      `Could not determine what the target database contains: ${
        error instanceof Error ? error.message : String(error)
      }. Refusing to migrate a database whose contents are unknown.`,
    );
    throw new Error('onUnsafe returned; refusing to continue against an unverified target');
  }

  const empty = checkApplicationTables(tables);
  if (!empty.safe) {
    await deps.onUnsafe(empty.reason);
    throw new Error('onUnsafe returned; refusing to continue against an unverified target');
  }
}
