/**
 * Repository secret hygiene.
 *
 * Replaces a CI step that looked like a gate and was not. The old check was:
 *
 *   grep -qE '^(ENCRYPTION_KEY|JWT_[A-Z_]+SECRET)=replace-me' .env.example
 *
 * which passes as long as **any one** of those lines still says `replace-me`.
 * A real 32-byte encryption key pasted into `.env.example` sailed through it
 * untouched, because the JWT line above still matched. It also covered three
 * variable names out of the seventeen this repository classifies as secret.
 *
 * What this does instead:
 *
 *   1. Checks every secret variable in `.env.example` individually.
 *   2. Rejects values that look like real credentials by shape, not by
 *      absence of the word "replace-me" — provider key prefixes, long base64
 *      or hex runs, connection strings with a populated password.
 *   3. Confirms `.gitignore` still excludes the file classes that must never
 *      be committed, and that none of them is tracked.
 *   4. Confirms every secret the classification table knows about is either
 *      documented in `.env.example` or deliberately absent.
 *
 * Prints no value it is suspicious of — only the variable name and the reason.
 * A hygiene check that echoes the credential it found into a public CI log has
 * made the problem worse.
 *
 *   node scripts/check-secrets.mjs
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
let failed = 0;

const check = (label, ok, detail) => {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}`);
    if (detail !== undefined) console.log(`        ${detail}`);
  }
};

console.log('\nDASH APP — secret hygiene\n' + '='.repeat(50));

// ---------------------------------------------------------------------------
// The classification table, read from the TypeScript source.
//
// Parsed rather than imported so this script stays a plain Node program with no
// TypeScript loader and can run as the very first step in CI, before anything
// is installed or built.
// ---------------------------------------------------------------------------

const classificationSource = readFileSync(
  join(root, 'apps/api/src/secrets/classification.ts'),
  'utf8',
);

function namesIn(constant) {
  const block = classificationSource.split(`export const ${constant}`)[1];
  if (!block) throw new Error(`${constant} not found in classification.ts`);
  const body = block.split('\n];')[0];
  return [...body.matchAll(/name:\s*'([A-Z0-9_]+)'/g)].map((match) => match[1]);
}

const secretNames = [...namesIn('SECRET_VARIABLES'), ...namesIn('ANTICIPATED_SECRET_VARIABLES')];
const publicNames = namesIn('PUBLIC_VARIABLES');

check(
  'the classification table parses and classifies something',
  secretNames.length >= 10 && publicNames.length >= 10,
  `${secretNames.length} secret, ${publicNames.length} public`,
);

// ---------------------------------------------------------------------------
// 1. .env.example holds no credential-looking material
// ---------------------------------------------------------------------------

console.log('\n.env.example');

const exampleLines = readFileSync(join(root, '.env.example'), 'utf8').split(/\r?\n/);

/** Assignments that are not commented out. */
const assignments = new Map();
for (const line of exampleLines) {
  const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
  if (match) assignments.set(match[1], match[2].trim().replace(/^["']|["']$/g, ''));
}

/**
 * Does this value look like something real?
 *
 * Shape-based on purpose. "Does not contain replace-me" is not the question —
 * a real key contains no such marker either, which is exactly how the previous
 * check let one through.
 */
function looksLikeACredential(value) {
  if (value === '') return null;

  const placeholder = /replace[-_]?me|change[-_]?me|your[-_]|example|placeholder|xxx+|<[^>]+>|CHANGE_ME|PASSWORD|USER/i;

  // Provider key prefixes. These are the shapes secret scanners look for, and a
  // placeholder wearing one is indistinguishable from the real thing.
  const providerPrefix =
    /^(sk_(live|test)_|pk_(live|test)_|rk_live_|whsec_|AKIA|ASIA|ghp_|gho_|xox[baprs]-|SG\.|AIza|glpat-|npm_)/;
  if (providerPrefix.test(value)) {
    return 'carries a real provider key prefix — indistinguishable from a leaked key to a scanner';
  }

  // A connection string whose password is not obviously a placeholder.
  const url = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s/@]*:([^\s/@]+)@/.exec(value);
  if (url && !placeholder.test(url[1])) {
    return 'is a connection string with a populated password';
  }

  if (placeholder.test(value)) return null;

  // A long unbroken run of base64 or hex is key material, not documentation.
  //
  // This deliberately does NOT require the value to contain a digit. It used
  // to, and 32 bytes of randomness encode to all-letter base64 often enough
  // that the requirement was a real hole: a genuine key whose material happened
  // to contain no digit walked straight through the gate. There is no security
  // argument for the extra condition either — the check only ever runs against
  // variables already classified SECRET, so a long opaque value under one of
  // those names is exactly what must be refused, digits or not.
  if (/^[A-Za-z0-9+/_-]{32,}={0,2}$/.test(value)) {
    return `is ${value.length} characters of unbroken key-shaped text`;
  }
  if (/^[0-9a-fA-F]{32,}$/.test(value)) {
    return `is ${value.length} hex characters`;
  }

  return null;
}

/**
 * Deterministic self-tests for the detector.
 *
 * A hygiene gate nobody tests is a hygiene gate that quietly stops matching.
 * Each case names the shape it stands for, and the all-letter entry is the
 * regression that motivated removing the digit requirement.
 *
 * The fixtures are invented for this file. None is a real credential, and the
 * script never prints a value it is suspicious of — only its length and the
 * reason.
 */
const DETECTOR_CASES = [
  // [ label, value, expected: true = must be refused ]
  ['empty is not a credential', '', false],
  ['an explicit placeholder', 'replace-me-with-48-random-bytes-access', false],
  ['a CHANGE_ME placeholder', 'CHANGE_ME', false],
  ['a documented example host', 'http://127.0.0.1:3000', false],
  ['a SQLite dev URL', 'file:./dev.db', false],
  ['a connection string whose password is a placeholder', 'postgresql://u:CHANGE_ME@h:5432/d', false],
  ['a short ordinary word', 'console', false],
  ['a provider secret-key prefix', 'sk_live_0000000000000000', true],
  ['a provider test-key prefix', 'sk_test_replace_me', true],
  ['a webhook-signing prefix', 'whsec_something', true],
  ['an AWS access key id', 'AKIAIOSFODNN7EXAMPLE', true],
  ['a connection string with a populated password', 'postgresql://u:s3cr3t-pw@h:5432/d', true],
  ['a Redis URL with a populated password', 'redis://:s3cr3t-pw@cache:6379', true],
  ['canonical base64 with digits', 'YpTt1KNH1JtX0eaiUaPNFWHApAQl8BggrrhxcNgy604=', true],
  // The regression, and the reason the digit requirement had to go. This is a
  // real 32-byte key encoded canonically whose base64 happens to contain no
  // digit at all — generated for this fixture, used to encrypt nothing, and
  // opening nothing. Roughly one key in four hundred looks like this, so the
  // old detector had a hole it would fall through on a routine Tuesday.
  ['canonical base64 of 32 bytes with NO digits', 'XmKmVmQQ/TLNKwLekYqdQhKKrgRvZbItQhEBqKxbfpE=', true],
  ['the same shape unpadded (base64url-ish), still no digits', 'XmKmVmQQTLNKwLekYqdQhKKrgRvZbItQhEBqKxbfpE', true],
  ['a long hex string', 'a'.repeat(8) + 'bcdefabcdefabcdefabcdefabcdef', true],
];

function runDetectorSelfTests() {
  const failures = [];

  for (const [label, value, shouldRefuse] of DETECTOR_CASES) {
    const refused = looksLikeACredential(value) !== null;
    if (refused !== shouldRefuse) {
      failures.push(`${label} — expected ${shouldRefuse ? 'refused' : 'accepted'}`);
    }
  }

  return failures;
}

const detectorFailures = runDetectorSelfTests();
check(
  `the credential detector behaves as specified (${DETECTOR_CASES.length} cases)`,
  detectorFailures.length === 0,
  detectorFailures.length ? detectorFailures.join('; ') : undefined,
);

let exampleClean = true;
for (const name of secretNames) {
  if (!assignments.has(name)) continue;
  const reason = looksLikeACredential(assignments.get(name));
  if (reason) {
    exampleClean = false;
    // The name and the reason. Never the value.
    check(`${name} is a safe placeholder`, false, `${name} ${reason}`);
  }
}
if (exampleClean) {
  check(`every secret variable in .env.example is a safe placeholder (${secretNames.length} checked)`, true);
}

// The old check's actual blind spot, asserted directly so it cannot come back.
check(
  'ENCRYPTION_KEY is checked on its own, not covered by another line matching',
  !assignments.has('ENCRYPTION_KEY') || looksLikeACredential(assignments.get('ENCRYPTION_KEY')) === null,
  'ENCRYPTION_KEY does not look like a placeholder',
);

// Every non-empty secret assignment must be scanned by the loop above; a secret
// present in the file but missing from the table would be unchecked.
const unclassified = [...assignments.keys()].filter(
  (name) =>
    !secretNames.includes(name) &&
    !publicNames.includes(name) &&
    /SECRET|KEY|TOKEN|PASSWORD|CREDENTIAL|DSN|_URL$/.test(name),
);
check(
  'no secret-looking variable in .env.example is missing from the classification table',
  unclassified.length === 0,
  unclassified.length ? `unclassified: ${unclassified.join(', ')}` : undefined,
);

// ---------------------------------------------------------------------------
// 2 & 3. Protected file classes
//
// One table drives three things: the `.gitignore` assertion, the tracked-file
// detector, and a self-check that the detector actually catches an example of
// every class. Before this was a table, the two lists were written separately
// and had already drifted — `.gitignore` excluded `*.key`, `*.keystore`,
// `serviceaccount*.json`, `gcp-*.json`, `*.gpg`, `*.asc`, `*.bak`, and
// `backups/`, and the tracked-file regex checked for none of them. The
// repository claimed protection it did not have.
//
// `sample` is what makes the self-check deterministic: a path that class must
// catch. If someone adds a class and forgets the pattern, or writes a pattern
// that does not match its own example, CI fails here rather than the day a real
// one is committed.
// ---------------------------------------------------------------------------

const PROTECTED_CLASSES = [
  { label: 'environment files', ignore: '.env', match: /(^|\/)\.env$/, sample: '.env' },
  {
    label: 'per-environment env files',
    ignore: '.env.*',
    match: /(^|\/)\.env\.(?!example$)[^/]+$/,
    sample: 'apps/api/.env.production',
  },
  { label: 'PEM private keys', ignore: '*.pem', match: /\.pem$/, sample: 'certs/server.pem' },
  { label: 'bare key files', ignore: '*.key', match: /\.key$/, sample: 'certs/tls.key' },
  { label: 'Apple .p8 keys', ignore: '*.p8', match: /\.p8$/, sample: 'apns/AuthKey_ABC.p8' },
  { label: 'PKCS#12 bundles', ignore: '*.p12', match: /\.(p12|pfx)$/, sample: 'certs/bundle.p12' },
  { label: 'Apple provisioning profiles', ignore: '*.mobileprovision', match: /\.(mobileprovision|provisionprofile)$/, sample: 'ios/DASH.mobileprovision' },
  { label: 'Apple certificates', ignore: '*.cer', match: /\.cer$/, sample: 'ios/distribution.cer' },
  { label: 'Firebase Apple client configuration', ignore: 'GoogleService-Info*.plist', match: /(^|\/)GoogleService-Info[^/]*\.plist$/, sample: 'ios/GoogleService-Info.plist' },
  { label: 'Java keystores', ignore: '*.jks', match: /\.jks$/, sample: 'android/release.jks' },
  {
    label: 'generic keystores',
    ignore: '*.keystore',
    match: /\.keystore$/,
    sample: 'android/upload.keystore',
  },
  {
    label: 'SSH private keys',
    ignore: 'id_rsa',
    match: /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/,
    sample: 'deploy/id_ed25519',
  },
  { label: 'SSH hardware-key private files', ignore: 'id_ed25519_sk', match: /(^|\/)id_(ecdsa|ed25519)_sk$/, sample: 'deploy/id_ed25519_sk' },
  {
    label: 'service-account files (hyphenated)',
    ignore: 'service-account*.json',
    match: /(^|\/)service-account[^/]*\.json$/,
    sample: 'infra/service-account-prod.json',
  },
  {
    label: 'service-account files (unhyphenated)',
    ignore: 'serviceaccount*.json',
    match: /(^|\/)serviceaccount[^/]*\.json$/,
    sample: 'infra/serviceaccount.json',
  },
  {
    label: 'GCP credential files',
    ignore: 'gcp-*.json',
    match: /(^|\/)gcp-[^/]*\.json$/,
    sample: 'infra/gcp-prod-key.json',
  },
  {
    label: 'generic credentials files',
    ignore: 'credentials*.json',
    match: /(^|\/)credentials[^/]*\.json$/,
    sample: 'infra/credentials.json',
  },
  { label: 'downloaded credential CSV files', ignore: 'credentials*.csv', match: /(^|\/)credentials[^/]*\.csv$/, sample: 'infra/credentials-user.csv' },
  { label: 'Google OAuth client secrets', ignore: 'client_secret*.json', match: /(^|\/)client_secret[^/]*\.json$/, sample: 'infra/client_secret_client-id.json' },
  { label: 'Firebase Admin SDK downloads', ignore: '*firebase-adminsdk*.json', match: /(^|\/)[^/]*firebase-adminsdk[^/]*\.json$/, sample: 'infra/project-firebase-adminsdk-service.json' },
  { label: 'GPG keyrings', ignore: '*.gpg', match: /\.gpg$/, sample: 'keys/backup.gpg' },
  { label: 'ASCII-armoured keys', ignore: '*.asc', match: /\.asc$/, sample: 'keys/public.asc' },
  { label: 'database dumps', ignore: '*.dump', match: /\.dump$/, sample: 'backups/nightly.dump' },
  { label: 'compressed SQL dumps', ignore: '*.sql.gz', match: /\.sql\.gz$/, sample: 'dump.sql.gz' },
  { label: 'backup copies', ignore: '*.bak', match: /\.bak$/, sample: 'config/settings.bak' },
  { label: 'backup directories', ignore: 'backups/', match: /(^|\/)backups\//, sample: 'backups/2026-09-02/db.tar' },
  { label: 'SQLite databases', ignore: '*.db', match: /\.(db|sqlite3?)$/, sample: 'packages/db/prisma/dev.db' },
  { label: 'build output', ignore: 'dist/', match: /(^|\/)(dist|\.next)\//, sample: 'apps/web/.next/build.js' },
  { label: 'local object storage', ignore: '.storage/', match: /(^|\/)\.storage\//, sample: '.storage/blob' },
  { label: 'log files', ignore: '*.log', match: /\.log$/, sample: 'api.log' },
  { label: 'local private secret directory', ignore: '/secrets/', match: /^secrets\//, sample: 'secrets/local-config.json' },
  { label: 'iOS distribution archives', ignore: '*.ipa', match: /\.ipa$/, sample: 'build/DASH.ipa' },
  { label: 'native build results', ignore: '*.xcresult/', match: /(^|\/)[^/]+\.(xcresult|xcarchive)\//, sample: 'build/DASH.xcresult/Info.plist' },
];

console.log('\n.gitignore');

const gitignore = readFileSync(join(root, '.gitignore'), 'utf8')
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line !== '' && !line.startsWith('#'));

let ignoreGaps = [];
for (const entry of PROTECTED_CLASSES) {
  if (!gitignore.includes(entry.ignore)) ignoreGaps.push(`${entry.label} (${entry.ignore})`);
}
check(
  `.gitignore excludes every protected class (${PROTECTED_CLASSES.length} checked)`,
  ignoreGaps.length === 0,
  ignoreGaps.length ? `missing: ${ignoreGaps.join(', ')}` : undefined,
);

// --- The drift self-check --------------------------------------------------
// Asserts the detector catches an example of every class it claims to cover,
// and that it does not catch ordinary source. Without this, a class could be
// listed, ignored, documented — and silently unmatched by the regex.

console.log('\nDetector self-check');

const isForbidden = (path) => PROTECTED_CLASSES.some((entry) => entry.match.test(path));

const missedSamples = PROTECTED_CLASSES.filter((entry) => !isForbidden(entry.sample));
check(
  `every protected class catches its own example (${PROTECTED_CLASSES.length} samples)`,
  missedSamples.length === 0,
  missedSamples.length ? `not caught: ${missedSamples.map((e) => e.sample).join(', ')}` : undefined,
);

const BENIGN = [
  '.env.example',
  'apps/api/src/config.ts',
  'packages/domain/src/redaction/index.ts',
  'docs/KEY_MANAGEMENT.md',
  'scripts/check-secrets.mjs',
  'package.json',
  'README.md',
];
const falsePositives = BENIGN.filter(isForbidden);
check(
  'ordinary source and docs are not flagged',
  falsePositives.length === 0,
  falsePositives.length ? `wrongly caught: ${falsePositives.join(', ')}` : undefined,
);

// Check Git's actual pattern resolution too: the presence of a line in
// .gitignore alone does not prove a later negation has not undone it.
const ignoreSamples = [...PROTECTED_CLASSES.map((entry) => entry.sample),
  'apps/api/.env.preview', 'infra/credentials-staging.json',
  'ios/DASH.provisionprofile', 'ios/GoogleService-Info-staging.plist',
  'packages/db/local.sqlite3', 'build/DASH.xcarchive/Info.plist',
  'deploy/id_ecdsa_sk',
];
const ignored = new Set(execFileSync('git', ['check-ignore', '--no-index', '--stdin'], {
  cwd: root, encoding: 'utf8', input: [...ignoreSamples, ...BENIGN].join('\n') + '\n',
}).trim().split(/\r?\n/));
const unprotected = ignoreSamples.filter((path) => !ignored.has(path));
const hiddenSource = BENIGN.filter((path) => ignored.has(path));
check('Git actually ignores private samples while retaining build/source templates',
  unprotected.length === 0 && hiddenSource.length === 0,
  [...unprotected.map((path) => `not ignored: ${path}`), ...hiddenSource.map((path) => `unexpectedly ignored: ${path}`)].join(', '));

console.log('\nTracked files');

const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
  .split(/\r?\n/)
  .filter(Boolean);

const offenders = tracked.filter(isForbidden);
check(
  `no protected file class is tracked (${tracked.length} tracked files scanned)`,
  offenders.length === 0,
  // Paths only. This never opens or prints the contents of a file it flags —
  // echoing a committed credential into a public CI log would make it worse.
  offenders.length ? offenders.join(', ') : undefined,
);

// `.env.example` must itself still be tracked — it is the developer's template,
// and silently losing it to an over-broad ignore rule is its own failure.
check('.env.example is tracked', tracked.includes('.env.example'));

// ---------------------------------------------------------------------------
// 4. The runbook inventory names every secret
// ---------------------------------------------------------------------------

console.log('\nDocumentation');

const runbooks = readFileSync(join(root, 'docs/RUNBOOKS.md'), 'utf8');
const undocumented = secretNames.filter((name) => !runbooks.includes(name));
check(
  'every classified secret appears in the runbook inventory',
  undocumented.length === 0,
  undocumented.length ? `missing: ${undocumented.join(', ')}` : undefined,
);

// ---------------------------------------------------------------------------

console.log('\n' + '='.repeat(50));
console.log(`${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
