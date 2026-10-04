/**
 * The one vocabulary of what is sensitive, and the primitives that strip it.
 *
 * Three different places needed to answer "is this safe to emit?" and each had
 * grown its own answer: `redact()` in `@dash/db` for the audit log,
 * `scrubForExport()` in the API's observability seam for an error tracker, and
 * Pino's `redact.paths` for request logs. Three lists drift. This module is the
 * single list they now share.
 *
 * It lives in `@dash/domain` because it is pure — no I/O, no configuration, no
 * clock — and because `@dash/db`, `apps/api`, and the verification scripts all
 * depend on this package already. Putting it anywhere else would mean one of
 * them could not reach it.
 *
 * Two kinds of redaction are needed, and conflating them is how leaks survive:
 *
 *   1. **By key.** A structured object has a field called `apiKey`. Match the
 *      key, drop the value. This is what the old lists did, but they matched
 *      the key *exactly* — so `secret` was caught and `paystackSecretKey` was
 *      not. Matching by fragment fixes a whole class of near-misses at once.
 *   2. **By shape, inside free text.** An error message is a string. No amount
 *      of key matching reaches the password inside
 *      `postgresql://dash:hunter2@db.internal:5432/dash`. A Prisma or ioredis
 *      failure carries exactly that, and it reaches the log through `err`.
 *
 * Both are needed. Neither is sufficient alone.
 */

/**
 * Fragments that make a key name sensitive, matched case-insensitively as
 * substrings of the normalised key.
 *
 * Fragments rather than whole names: `secret` here catches `secret`,
 * `jwtAccessSecret`, `PAYSTACK_WEBHOOK_SECRET`, and `client_secret` in one
 * entry. The cost is the occasional false positive, and a redacted field that
 * did not need to be is a far cheaper mistake than the reverse.
 */
const SENSITIVE_KEY_FRAGMENTS: readonly string[] = [
  'apikey',
  'accesskey',
  'secretkey',
  'authorization',
  'bearer',
  'cipher',
  'cookie',
  'credential',
  'dsn',
  'jwt',
  'passphrase',
  'password',
  'passwd',
  'privatekey',
  'secret',
  // Google/Firebase service-account JSON is a private key in a wrapper.
  'serviceaccount',
  'sessionid',
  'signature',
  'token',
  // Connection strings carry an embedded password. The value is redacted
  // wholesale here; `redactSecretsInText` handles the case where one is
  // interpolated into a longer string.
  'databaseurl',
  'redisurl',
  'smtpurl',
  'connectionstring',
];

/**
 * Whole normalised key names that are sensitive but contain no fragment above.
 *
 * Kept separate so the fragment list stays readable and so an exact name cannot
 * accidentally widen into a fragment that matches something innocuous.
 */
const SENSITIVE_KEY_NAMES: readonly string[] = [
  'code',
  'devcode',
  'otp',
  'pin',
  'totp',
  'mfasecret',
  'recoverycode',
  'recoverycodes',
  'accountnumber',
  'bankaccountnumber',
  'cardnumber',
  'cvv',
  'codehash',
  'deliverypinhash',
  'pickupcodehash',
  // Both are exact names rather than an `encryptionkey` fragment on purpose:
  // a fragment would also swallow `encryptionKeyId`, which must stay visible.
  // The key id is not secret — it travels in plaintext inside every envelope it
  // writes — and it is the one field a rotation log is read for.
  'encryptionkey',
  'encryptionkeysretired',
  'key',
];

/**
 * Personal data that is not a credential but must not reach a third party.
 *
 * Separated from the credential lists because the audit log legitimately holds
 * some of it — an audit entry naming which phone number an operator changed is
 * the point of an audit entry — while an error tracker never should. Callers
 * opt in.
 */
const PERSONAL_KEY_NAMES: readonly string[] = [
  'phone',
  'phonenumber',
  'email',
  'emailaddress',
  'latitude',
  'longitude',
  'lat',
  'lng',
];

/**
 * Names that contain a sensitive fragment but hold nothing sensitive.
 *
 * Fragment matching is deliberately broad, and breadth has a cost: a name like
 * `ACCESS_TOKEN_TTL_SECONDS` contains `token` and holds a number of seconds.
 * Redacting it protects nothing and removes a field an operator diagnosing a
 * session problem actually needs.
 *
 * This list is checked before anything else, so it is an override rather than
 * an omission. It is kept short on purpose: the bar for an entry is that the
 * value is a duration, an identifier, or a flag *about* a secret, never
 * material. `apps/api/src/__tests__/secrets.test.ts` asserts that every
 * variable classified public survives redaction, which is what keeps this list
 * and the classification table from drifting apart.
 */
const NEVER_SENSITIVE_KEY_NAMES: readonly string[] = [
  'accesstokenttlseconds',
  'refreshtokenttlseconds',
  // The key id travels in plaintext inside every envelope it writes and is the
  // one field a rotation log is read for.
  'keyid',
  'encryptionkeyid',
];

export const REDACTED = '[redacted]';

/** Strip everything a key name could vary by, so one entry matches all spellings. */
function normaliseKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Is a value under this key unsafe to emit?
 *
 * `includePersonal` widens the answer to personal data. An error tracker and a
 * metrics backend pass true; the audit log passes false.
 */
export function isSensitiveKey(key: string, includePersonal = false): boolean {
  const normalised = normaliseKey(key);
  if (normalised === '') return false;

  // Checked first: an entry here is an override of the fragment match below,
  // not a gap in it.
  if (NEVER_SENSITIVE_KEY_NAMES.includes(normalised)) return false;

  if (SENSITIVE_KEY_NAMES.includes(normalised)) return true;
  if (includePersonal && PERSONAL_KEY_NAMES.includes(normalised)) return true;

  return SENSITIVE_KEY_FRAGMENTS.some((fragment) => normalised.includes(fragment));
}

/**
 * Replace the credentials in any URI-with-userinfo found in free text.
 *
 * Matches the `scheme://user:password@host` shape wherever it appears, so it
 * works on a bare connection string and on one interpolated into a sentence
 * such as `Can't reach database server at postgresql://dash:pw@db:5432`.
 *
 * The host, port, and scheme survive on purpose: those are what make the error
 * diagnosable, and none of them is a secret. Only the userinfo is replaced.
 */
export function redactUrlCredentials(text: string): string {
  // `[^\s/@:]*` for the user and `[^\s/@]*` for the password: a password may
  // contain a colon, a username may not, and neither may contain whitespace or
  // a slash without being percent-encoded first.
  //
  // The username group is `*` rather than `+` on purpose. Redis URLs are
  // conventionally written `redis://:password@host` with no username at all,
  // which is the single most likely credentialed URL this system will ever log
  // — requiring a username here would have missed exactly the case that matters
  // most. Excluding `/` from both groups is what stops the match running across
  // a path segment that merely happens to contain an `@`.
  return text.replace(
    /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^\s/@:]*)(?::([^\s/@]*))?@/g,
    (_match, scheme: string, user: string, password: string | undefined) =>
      password === undefined ? `${scheme}${REDACTED}@` : `${scheme}${user}:${REDACTED}@`,
  );
}

/**
 * Scrub free text before it is logged or printed.
 *
 * Two passes:
 *
 *   1. Credentials embedded in a URI, as above.
 *   2. Any literal value in `knownSecrets`. This is the belt to the URI
 *      braces: a secret that reached a string by some route this module cannot
 *      pattern-match is still caught, because the caller knows what its own
 *      secrets are.
 *
 * Empty and very short known secrets are skipped — replacing every occurrence
 * of a two-character value would corrupt the message without protecting
 * anything.
 */
export function redactSecretsInText(text: string, knownSecrets: readonly string[] = []): string {
  let output = redactUrlCredentials(text);

  for (const secret of knownSecrets) {
    if (typeof secret !== 'string' || secret.length < 8) continue;
    output = output.split(secret).join(REDACTED);
  }

  return output;
}

export interface RedactOptions {
  /** Also redact personal data, not only credentials. Default false. */
  readonly includePersonal?: boolean;
  /** Literal values to strip from any string encountered. Default none. */
  readonly knownSecrets?: readonly string[];
  /** How deep to walk before giving up. Default 8. */
  readonly maxDepth?: number;
}

/**
 * Walk a structure and redact everything sensitive in it.
 *
 * Key matching and text scrubbing both apply: a field called `apiKey` is
 * dropped by name, and a field called `message` that happens to contain a
 * connection string is scrubbed by shape.
 *
 * The depth cap is what stops a deeply nested or accidentally recursive
 * structure from taking the process down at the exact moment it is already
 * trying to report a failure.
 */
export function redactDeep(value: unknown, options: RedactOptions = {}): unknown {
  const { includePersonal = false, knownSecrets = [], maxDepth = 8 } = options;

  const walk = (input: unknown, depth: number): unknown => {
    if (depth > maxDepth) return REDACTED;
    if (input === null || input === undefined) return input;

    if (typeof input === 'string') return redactSecretsInText(input, knownSecrets);
    if (typeof input !== 'object') return input;

    if (Array.isArray(input)) return input.map((entry) => walk(entry, depth + 1));

    // An Error is not a plain object: its message and stack are non-enumerable,
    // so `Object.entries` would return {} and the interesting part would pass
    // through untouched.
    if (input instanceof Error) {
      return {
        name: input.name,
        message: redactSecretsInText(input.message, knownSecrets),
        ...(input.stack === undefined
          ? {}
          : { stack: redactSecretsInText(input.stack, knownSecrets) }),
      };
    }

    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(input as Record<string, unknown>)) {
      output[key] = isSensitiveKey(key, includePersonal) ? REDACTED : walk(nested, depth + 1);
    }
    return output;
  };

  return walk(value, 0);
}

/** The fragment and name lists, exported so tests can assert coverage over them. */
export const SENSITIVE_VOCABULARY = {
  fragments: SENSITIVE_KEY_FRAGMENTS,
  names: SENSITIVE_KEY_NAMES,
  personal: PERSONAL_KEY_NAMES,
  exempt: NEVER_SENSITIVE_KEY_NAMES,
} as const;
