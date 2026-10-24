import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { CONFIG_VARIABLE_NAMES } from '../config.js';
import { ANTICIPATED_SECRET_VARIABLES } from '../secrets/classification.js';

/**
 * The deployment documentation must name variables that exist.
 *
 * This test exists because the same mistake happened three times. The runbook
 * required `ENCRYPTION_KEYS` and `ENCRYPTION_ACTIVE_KEY`, which no code has ever
 * read — the schema wants `ENCRYPTION_KEY`, `ENCRYPTION_KEY_ID` and
 * `ENCRYPTION_KEYS_RETIRED`. It required `REFRESH_TOKEN_PEPPER`, which nothing
 * reads either; refresh tokens are 32 random bytes hashed with SHA-256, and there
 * is no pepper anywhere in the repository. And it omitted `JWT_REFRESH_SECRET`,
 * `QUEUE_PROVIDER` and `GEO_ZONES_PROVIDER`, each of which production refuses to
 * start without.
 *
 * Individually each was a typo. Together they meant somebody could follow the
 * runbook exactly, line by line, and be refused at boot over a variable the
 * runbook never mentioned — while carefully setting three that do nothing. The
 * cost lands entirely on the person doing the deployment, at the worst moment,
 * and proof-reading has already failed at it twice.
 *
 * So the documentation is checked against the schema instead. A variable named in
 * the runbook must be one of: read by this application, read by a library from the
 * process environment, read by the web app at build time, or explicitly described
 * in the document as not read by anything.
 */

const root = fileURLToPath(new URL('../../../../', import.meta.url));

function read(relative: string): string {
  return readFileSync(`${root}${relative}`, 'utf8');
}

/**
 * Variables named in the runbook that this application's schema does not read,
 * each for a stated reason.
 *
 * The list is short on purpose. Anything added here is a claim that a variable
 * matters to the deployment without appearing in `CONFIG_VARIABLE_NAMES`, and
 * that claim should be uncomfortable enough to check.
 */
const NOT_READ_BY_THE_API_SCHEMA: Readonly<Record<string, string>> = {
  // Resolved by the AWS SDK's own credential chain, never by us. They reach the
  // S3 and SES clients without passing through the schema, which is why no guard
  // can check them and why a missing one presents as a runtime failure.
  AWS_ACCESS_KEY_ID: "the AWS SDK's credential chain reads these directly",
  AWS_SECRET_ACCESS_KEY: "the AWS SDK's credential chain reads these directly",

  // Read by `apps/web` at build time, inlined into the bundle. The API never
  // sees them.
  NEXT_PUBLIC_API_URL: 'apps/web, at build time',
  NEXT_PUBLIC_SITE_ORIGIN: 'apps/web, at build time',
  NEXT_PUBLIC_DECLUTTER_INDEXABLE: 'apps/web, at build time',

  // Documented precisely in order to say that nothing reads them. They are
  // classified so that an audit finding them in an environment knows they are
  // inert, and the runbook says so in those words.
  S3_ACCESS_KEY_ID: 'classified but deliberately unread; the runbook says so',
  S3_SECRET_ACCESS_KEY: 'classified but deliberately unread; the runbook says so',
};

/** Variable-looking names that are not variables. */
const NOT_VARIABLES = new Set([
  'CREATE', // `CREATE EXTENSION postgis;`
  'EXTENSION',
  'PLACEHOLDER', // the assertion that the legal text contains no PLACEHOLDER
  'ACCOUNT_ID', // a placeholder inside an example ARN
  'PASSWORD', // a placeholder inside an example connection string
  'DASH', // `DASH ValueChecked`, `DASH APP`
  'AWS',
  'SES',
  'RDS',
  'S3',
  'VPC',
  'DNS',
  'TOTP',
  'KYC',
  'HTTPS',
]);

function documentedVariables(markdown: string): string[] {
  const matches = markdown.match(/`[A-Z][A-Z0-9_]{2,}`/g) ?? [];
  const names = matches.map((m) => m.slice(1, -1)).filter((m) => !NOT_VARIABLES.has(m));
  return [...new Set(names)].sort();
}

describe('the production runbook names variables that exist', () => {
  const runbook = read('docs/RUNBOOK-DECLUTTERS-PRODUCTION.md');
  const known = new Set(CONFIG_VARIABLE_NAMES);

  it('reads the schema, so the comparison is against something real', () => {
    // A guard on the guard. If the export ever came back empty the test below
    // would pass trivially while proving nothing.
    expect(CONFIG_VARIABLE_NAMES.length).toBeGreaterThan(40);
    expect(known.has('DEPLOYMENT_PROFILE')).toBe(true);
    expect(known.has('DATABASE_URL')).toBe(true);
  });

  it('names no variable that nothing reads', () => {
    const unread = documentedVariables(runbook).filter(
      (name) => !known.has(name) && !(name in NOT_READ_BY_THE_API_SCHEMA),
    );
    expect(
      unread,
      `The runbook names ${unread.length} variable(s) that no code reads. ` +
        'Either the name is wrong, or it belongs in NOT_READ_BY_THE_API_SCHEMA with a reason.',
    ).toEqual([]);
  });

  it('does not resurrect a name that was wrong before', () => {
    // The three the runbook actually carried. Named individually so that
    // reintroducing one fails with the history rather than with a generic message.
    //
    // Matched as whole names, not substrings: `ENCRYPTION_KEYS_RETIRED` is a real
    // variable that contains the dead `ENCRYPTION_KEYS` inside it, and a
    // `toContain` check fails on the correct name — which it did, on the first run
    // of this test.
    const named = new Set(documentedVariables(runbook));
    for (const stale of ['ENCRYPTION_KEYS', 'ENCRYPTION_ACTIVE_KEY', 'REFRESH_TOKEN_PEPPER']) {
      expect(known.has(stale), `${stale} is not read by any code`).toBe(false);
      expect(named.has(stale), `${stale} was documented as required; nothing reads it`).toBe(false);
    }
  });

  it('names every variable production refuses to start without', () => {
    // Derived from the guards in `config.ts`, and the omission that started this:
    // a deployment following the runbook hit `QUEUE_PROVIDER` and
    // `GEO_ZONES_PROVIDER` at boot without having been told about either.
    for (const required of [
      'NODE_ENV',
      'DEPLOYMENT_PROFILE',
      'DATABASE_URL',
      'PUBLIC_WEB_URL',
      'JWT_ACCESS_SECRET',
      'JWT_REFRESH_SECRET',
      'ENCRYPTION_KEY',
      'REDIS_URL',
      'RATE_LIMIT_ENABLED',
      'RATE_LIMIT_REDIS',
      'QUEUE_PROVIDER',
      'GEO_ZONES_PROVIDER',
      'STORAGE_PROVIDER',
      'S3_BUCKET',
      'S3_REGION',
      'EMAIL_PROVIDER',
      'SES_REGION',
      'EMAIL_FROM_ADDRESS',
      'EMAIL_REPLY_TO',
    ]) {
      expect(runbook, `${required} is required at boot and must be documented`).toContain(
        `\`${required}\``,
      );
    }
  });
});

describe('.env.example names variables that exist', () => {
  const example = read('.env.example');
  const known = new Set(CONFIG_VARIABLE_NAMES);

  /**
   * Assignments, not prose.
   *
   * `.env.example` is mostly commentary, and the commentary legitimately mentions
   * provider names, AWS services and variables belonging to other workspaces. An
   * assignment is the part a developer copies, so that is the part checked —
   * including the commented-out assignments in the worked production example,
   * which exist precisely to be uncommented.
   */
  function assignments(text: string): string[] {
    const names: string[] = [];
    for (const line of text.split('\n')) {
      const match = /^#?\s*#?\s*([A-Z][A-Z0-9_]{2,})=/.exec(line.trim());
      if (match?.[1]) names.push(match[1]);
    }
    return [...new Set(names)].sort();
  }

  /**
   * Names that nothing reads *yet*, and say so.
   *
   * `.env.example` legitimately documents a variable before its integration
   * exists — it is how the placeholder gate covers a credential from the start
   * rather than from the day somebody first pastes a real value beside an
   * unguarded name. `ANTICIPATED_SECRET_VARIABLES` is the existing register of
   * those, each carrying the words "Not yet read by any code", and it is reused
   * here rather than duplicated: a second list would be a second thing to drift.
   */
  const anticipated = new Set(ANTICIPATED_SECRET_VARIABLES.map((variable) => variable.name));

  /**
   * Read by a workspace other than the API, or reserved in the open.
   *
   * Kept separate from the anticipated register because these are not secrets
   * and so have no business in a list about credential hygiene.
   */
  const ELSEWHERE: Readonly<Record<string, string>> = {
    PUBLIC_API_URL: 'apps/web/src/lib/api.ts, and the mobile build scripts',
    WEB_PORT: 'apps/android-shell/scripts/configure.mjs',
    PAYSTACK_PUBLIC_KEY: "reserved: Paystack's browser SDK will need it; nothing reads it today",
    DEFAULT_COUNTRY: 'reserved for internationalisation; nothing reads it today',
  };

  it('assigns nothing that no code reads and nothing admits to', () => {
    const unread = assignments(example).filter(
      (name) =>
        !known.has(name) &&
        !anticipated.has(name) &&
        !(name in ELSEWHERE) &&
        !(name in NOT_READ_BY_THE_API_SCHEMA) &&
        // The web app's own variables are documented here for one-stop
        // convenience and are read by `apps/web`, not by the API.
        !name.startsWith('NEXT_PUBLIC_'),
    );
    expect(
      unread,
      `.env.example assigns ${unread.length} variable(s) nothing reads: ${unread.join(', ')}. ` +
        'Either delete the line, or register the name as anticipated with a reason.',
    ).toEqual([]);
  });

  it('documents the deployment profile, since it changes which guards apply', () => {
    expect(example).toContain('DEPLOYMENT_PROFILE=');
    expect(example).toContain('declutters');
  });
});
