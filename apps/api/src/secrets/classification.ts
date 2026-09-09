/**
 * Which configuration variables are secret, and which are merely configuration.
 *
 * This table is the milestone. Everything else in `apps/api/src/secrets` reads
 * from it rather than repeating a list, because every place that keeps its own
 * copy of "what is sensitive" is a place that will fall behind the day someone
 * adds a variable.
 *
 * Four things consume it:
 *
 *   1. **The known-secret list** that the logger's text scrubber and the
 *      error-reporting seam strip literally — `presentSecretValues` below reads
 *      `SECRET_VARIABLES` and pulls those values out of the environment.
 *
 *      Note what this is *not*: Pino's `redact.paths` in `secrets/logging.ts`
 *      is a hand-written list of request and response paths, not generated from
 *      here, and it could not be — those are locations in a request, not
 *      environment variable names. The overlap is deliberate but manual.
 *   2. The leak regression tests — they iterate this table rather than
 *      asserting a handful of hard-coded names, so a new secret variable is
 *      covered the moment it is classified. That includes the assertion that
 *      every name here is one the redaction vocabulary recognises, which is
 *      what ties this table to `@dash/domain/redaction`.
 *   3. The `.env.example` hygiene gate in CI, via `npm run check:secrets`.
 *   4. `docs/RUNBOOKS.md`'s secret inventory, which is checked against this
 *      table by the same script.
 *
 * ## Why there is no secret-store SDK here
 *
 * DASH APP has no deployment platform yet, and inventing one would be worse
 * than having none. The contract this milestone commits to instead:
 *
 *   **Every value below arrives in the process environment. Something outside
 *   this application put it there.**
 *
 * In development that something is a `.env` file. In staging and production it
 * is whatever the platform provides — Kubernetes secrets projected as env vars,
 * AWS Secrets Manager or GCP Secret Manager through the platform's injection,
 * Vault's agent, a hosting provider's own secret UI. The application cannot
 * tell the difference and must not try to. `loadConfig(source)` already takes
 * the environment as an argument, which is the seam: a future adapter that
 * fetches from a store and hands back a populated object needs no change here.
 *
 * That is the whole abstraction. It is deliberately not an interface with one
 * implementation. See ADR-0011.
 */

/** What kind of value this is, and therefore how it may be handled. */
export type Sensitivity =
  /** Safe to log, print in a banner, and include in an error message. */
  | 'public'
  /** Must never appear in a log, an error, a metric, or a health response. */
  | 'secret';

/** When production refuses to start without it. */
export type ProductionRequirement =
  /** Production always requires a value. */
  | 'required'
  /** Required only when a particular provider is selected. */
  | 'conditional'
  /** Production runs fine without it. */
  | 'optional'
  /** Production refuses this value entirely. */
  | 'refused';

export interface ConfigVariable {
  readonly name: string;
  readonly sensitivity: Sensitivity;
  readonly production: ProductionRequirement;
  /** One line, suitable for the runbook inventory. */
  readonly purpose: string;
  /**
   * True when the value is a URI whose userinfo carries a credential. Those
   * need the text scrubber as well as name-based redaction, because the
   * credential travels inside a longer string that library errors interpolate.
   */
  readonly embedsCredential?: boolean;
}

/**
 * Non-secret configuration.
 *
 * These may be logged, printed at boot, and named in an error. The boot banner
 * in `describeAdapters` prints several of them on purpose: if it says
 * `payments=mock`, nothing has ever charged a card, and that is worth shouting.
 */
export const PUBLIC_VARIABLES: readonly ConfigVariable[] = [
  { name: 'NODE_ENV', sensitivity: 'public', production: 'required', purpose: 'Which environment this process believes it is' },
  { name: 'API_PORT', sensitivity: 'public', production: 'optional', purpose: 'Listening port' },
  { name: 'API_HOST', sensitivity: 'public', production: 'optional', purpose: 'Listening interface' },
  { name: 'PUBLIC_WEB_URL', sensitivity: 'public', production: 'required', purpose: 'CORS allowlist origin; must be HTTPS in production' },
  { name: 'ACCESS_TOKEN_TTL_SECONDS', sensitivity: 'public', production: 'optional', purpose: 'Access token lifetime' },
  { name: 'REFRESH_TOKEN_TTL_SECONDS', sensitivity: 'public', production: 'optional', purpose: 'Refresh token lifetime' },
  { name: 'OTP_TTL_SECONDS', sensitivity: 'public', production: 'optional', purpose: 'OTP lifetime' },
  { name: 'OTP_MAX_ATTEMPTS', sensitivity: 'public', production: 'optional', purpose: 'OTP attempt ceiling' },
  { name: 'DEV_EXPOSE_OTP', sensitivity: 'public', production: 'refused', purpose: 'Returns login codes in the API response; a development affordance only' },
  { name: 'DEFAULT_CURRENCY', sensitivity: 'public', production: 'optional', purpose: 'Market currency' },
  { name: 'DEFAULT_CITY_SLUG', sensitivity: 'public', production: 'optional', purpose: 'Default city' },
  { name: 'DEFAULT_TIMEZONE', sensitivity: 'public', production: 'optional', purpose: 'Default timezone' },
  { name: 'PAYMENT_PROVIDER', sensitivity: 'public', production: 'required', purpose: 'Selector; `mock` is refused in production' },
  { name: 'MAPS_PROVIDER', sensitivity: 'public', production: 'required', purpose: 'Selector; `local` is refused in production' },
  { name: 'SMS_PROVIDER', sensitivity: 'public', production: 'required', purpose: 'Selector; `console` is refused in production' },
  { name: 'EMAIL_PROVIDER', sensitivity: 'public', production: 'required', purpose: 'Selector; `console` is refused in production' },
  { name: 'PUSH_PROVIDER', sensitivity: 'public', production: 'required', purpose: 'Selector; `console` is refused in production' },
  { name: 'SES_REGION', sensitivity: 'public', production: 'optional', purpose: 'SES is regional; the sending identity is verified per region' },
  { name: 'EMAIL_FROM_ADDRESS', sensitivity: 'public', production: 'optional', purpose: 'Must be a verified SES identity' },
  { name: 'EMAIL_FROM_NAME', sensitivity: 'public', production: 'optional', purpose: 'Display name on transactional email' },
  { name: 'EMAIL_REPLY_TO', sensitivity: 'public', production: 'optional', purpose: 'Monitored mailbox; the identity-conflict email tells people to reply to it' },
  { name: 'SES_CONFIGURATION_SET', sensitivity: 'public', production: 'optional', purpose: 'Groups messages so bounce and complaint events can be attributed' },
  { name: 'SES_EVENT_TOPIC_ARN', sensitivity: 'public', production: 'optional', purpose: 'Only bounce/complaint notifications from this topic are accepted' },
  { name: 'STORAGE_PROVIDER', sensitivity: 'public', production: 'required', purpose: 'Selector; `local` is refused in production' },
  { name: 'STORAGE_LOCAL_DIR', sensitivity: 'public', production: 'optional', purpose: 'Local storage directory in development' },
  { name: 'QUEUE_PROVIDER', sensitivity: 'public', production: 'required', purpose: 'Selector; `memory` is refused in production' },
  { name: 'GEO_ZONES_PROVIDER', sensitivity: 'public', production: 'required', purpose: 'Selector; `local` is refused in production' },
  { name: 'RATE_LIMIT_REDIS', sensitivity: 'public', production: 'required', purpose: 'Share rate-limit counters through Redis; production refuses false' },
  { name: 'RATE_LIMIT_ENABLED', sensitivity: 'public', production: 'required', purpose: 'Production refuses false' },
  { name: 'LOG_LEVEL', sensitivity: 'public', production: 'optional', purpose: 'Pino level' },
  { name: 'ENCRYPTION_KEY_ID', sensitivity: 'public', production: 'optional', purpose: 'Names the active key inside every envelope it writes. An identifier, not key material.' },
  { name: 'MFA_ENABLED', sensitivity: 'public', production: 'required', purpose: 'Production refuses false' },
  { name: 'RETENTION_SESSIONS_DAYS', sensitivity: 'public', production: 'optional', purpose: 'Retention override' },
  { name: 'RETENTION_RIDER_LOCATION_DAYS', sensitivity: 'public', production: 'optional', purpose: 'Retention override' },
  { name: 'RETENTION_OTP_DAYS', sensitivity: 'public', production: 'optional', purpose: 'Retention override' },
  { name: 'RETENTION_IDEMPOTENCY_DAYS', sensitivity: 'public', production: 'optional', purpose: 'Retention override' },
  { name: 'ACCOUNT_DELETION_COOLING_OFF_DAYS', sensitivity: 'public', production: 'optional', purpose: 'Deletion cooling-off window' },
  { name: 'DATA_EXPORT_TTL_HOURS', sensitivity: 'public', production: 'optional', purpose: 'Export archive lifetime' },

  // Documented in `.env.example` and read by the web app or by tooling rather
  // than by `loadConfig`. Classified anyway: an unclassified variable sitting
  // next to the secrets is one nobody has decided about, and `check-secrets`
  // flags any name that looks credential-shaped and is absent from this table.
  { name: 'WEB_PORT', sensitivity: 'public', production: 'optional', purpose: 'Web app port. Not read by the API.' },
  { name: 'PUBLIC_API_URL', sensitivity: 'public', production: 'optional', purpose: 'API origin the web app calls. Not read by the API.' },
  { name: 'DEFAULT_COUNTRY', sensitivity: 'public', production: 'optional', purpose: 'Market country. Not read by the API.' },
  {
    name: 'PAYSTACK_PUBLIC_KEY',
    sensitivity: 'public',
    production: 'optional',
    purpose:
      'Publishable key, designed to be embedded in a client. Genuinely not a secret — pairing it with PAYSTACK_SECRET_KEY in one block is how the two get confused.',
  },
  { name: 'S3_ENDPOINT', sensitivity: 'public', production: 'optional', purpose: 'Bucket endpoint. Not read by any code yet.' },
  { name: 'S3_BUCKET', sensitivity: 'public', production: 'optional', purpose: 'Bucket name. Not read by any code yet.' },
];

/**
 * Secret material.
 *
 * Every name here is redacted from logs by `secrets/logging.ts`, asserted
 * absent from error text and health responses by the leak regression suite, and
 * required to carry an obvious placeholder in `.env.example`.
 *
 * `ENCRYPTION_KEY_ID` is deliberately **not** here: it is an identifier that
 * travels in plaintext inside every envelope it writes. Classifying it secret
 * would be theatre, and would redact it out of exactly the rotation logs where
 * it is the useful field.
 */
export const SECRET_VARIABLES: readonly ConfigVariable[] = [
  {
    name: 'JWT_ACCESS_SECRET',
    sensitivity: 'secret',
    production: 'required',
    purpose: 'Signs access tokens. Must differ from the refresh secret, or a refresh token verifies as an access token.',
  },
  {
    name: 'JWT_REFRESH_SECRET',
    sensitivity: 'secret',
    production: 'required',
    purpose: 'Signs refresh tokens. Rotating it invalidates every session.',
  },
  {
    name: 'ENCRYPTION_KEY',
    sensitivity: 'secret',
    production: 'required',
    purpose: 'Base64 of 32 bytes. Encrypts TOTP secrets and vendor payout details at rest.',
  },
  {
    name: 'ENCRYPTION_KEYS_RETIRED',
    sensitivity: 'secret',
    production: 'optional',
    purpose: 'Decrypt-only keys still needed by rows not yet re-encrypted. Losing one makes those rows unreadable.',
  },
  {
    name: 'DATABASE_URL',
    sensitivity: 'secret',
    production: 'required',
    purpose: 'PostgreSQL connection string. Carries the database password in its userinfo.',
    embedsCredential: true,
  },
  {
    name: 'REDIS_URL',
    sensitivity: 'secret',
    production: 'required',
    purpose: 'Redis connection string. Carries the Redis password in its userinfo.',
    embedsCredential: true,
  },
  {
    name: 'PAYSTACK_SECRET_KEY',
    sensitivity: 'secret',
    production: 'conditional',
    purpose: 'Authenticates API calls to Paystack. Required when PAYMENT_PROVIDER=paystack.',
  },
  {
    name: 'PAYSTACK_WEBHOOK_SECRET',
    sensitivity: 'secret',
    production: 'conditional',
    purpose: 'Verifies inbound webhook signatures. Required when PAYMENT_PROVIDER=paystack.',
  },
  {
    name: 'GOOGLE_MAPS_API_KEY',
    sensitivity: 'secret',
    production: 'conditional',
    purpose: 'Required when MAPS_PROVIDER=google.',
  },
  {
    name: 'MAPBOX_ACCESS_TOKEN',
    sensitivity: 'secret',
    production: 'conditional',
    purpose: 'Required when MAPS_PROVIDER=mapbox.',
  },
];

/**
 * Secrets that the future provider integrations will need.
 *
 * These are **not** read by any code today — Milestone III protects their
 * future credentials, it does not integrate the providers (that is Phase 4).
 * They are listed so that `.env.example` and the runbook inventory stay honest
 * about what a real deployment will eventually hold, and so the placeholder
 * gate covers them from the start rather than the day someone first pastes a
 * real value next to an unguarded name.
 */
export const ANTICIPATED_SECRET_VARIABLES: readonly ConfigVariable[] = [
  { name: 'TERMII_API_KEY', sensitivity: 'secret', production: 'conditional', purpose: 'Not yet read by any code. Reserved for the Termii SMS adapter.' },
  { name: 'TWILIO_AUTH_TOKEN', sensitivity: 'secret', production: 'conditional', purpose: 'Not yet read by any code. Reserved for the Twilio SMS adapter.' },
  { name: 'SMTP_URL', sensitivity: 'secret', production: 'conditional', purpose: 'Not yet read by any code. Reserved for the SMTP email adapter.', embedsCredential: true },
  { name: 'FCM_SERVICE_ACCOUNT_JSON', sensitivity: 'secret', production: 'conditional', purpose: 'Not yet read by any code. Reserved for the FCM push adapter.' },
  { name: 'S3_ACCESS_KEY_ID', sensitivity: 'secret', production: 'conditional', purpose: 'Not yet read by any code. Reserved for the S3 storage adapter.' },
  { name: 'S3_SECRET_ACCESS_KEY', sensitivity: 'secret', production: 'conditional', purpose: 'Not yet read by any code. Reserved for the S3 storage adapter.' },
  { name: 'ERROR_TRACKING_DSN', sensitivity: 'secret', production: 'optional', purpose: 'Not yet read by any code. Reserved for the error-reporting adapter.', embedsCredential: true },
];

/** Every classified variable, secret and public, including anticipated ones. */
export const ALL_VARIABLES: readonly ConfigVariable[] = [
  ...PUBLIC_VARIABLES,
  ...SECRET_VARIABLES,
  ...ANTICIPATED_SECRET_VARIABLES,
];

/** Names of everything classified secret, including not-yet-integrated providers. */
export const SECRET_VARIABLE_NAMES: readonly string[] = [
  ...SECRET_VARIABLES,
  ...ANTICIPATED_SECRET_VARIABLES,
].map((variable) => variable.name);

/** Names of secrets whose value is a URI carrying a credential in its userinfo. */
export const CREDENTIAL_URL_VARIABLE_NAMES: readonly string[] = [
  ...SECRET_VARIABLES,
  ...ANTICIPATED_SECRET_VARIABLES,
]
  .filter((variable) => variable.embedsCredential === true)
  .map((variable) => variable.name);

export function isSecretVariable(name: string): boolean {
  return SECRET_VARIABLE_NAMES.includes(name);
}

/**
 * The secret values actually present, for the text scrubber.
 *
 * Returned as literal strings so `redactSecretsInText` can strip them from a
 * message that carries one by a route no pattern would catch. The list is built
 * per call and never stored, so nothing here extends the lifetime of a secret
 * beyond the environment object that already holds it.
 */
export function presentSecretValues(source: Record<string, unknown>): string[] {
  const values: string[] = [];

  for (const name of SECRET_VARIABLE_NAMES) {
    const value = source[name];
    if (typeof value === 'string' && value.trim() !== '') values.push(value);
  }

  // Retired keys are a compound value. Each key inside it is a secret in its
  // own right, and an error that echoed one entry rather than the whole
  // variable would slip past a whole-value match.
  const retired = source['ENCRYPTION_KEYS_RETIRED'];
  if (typeof retired === 'string') {
    for (const entry of retired.split(',')) {
      const separator = entry.indexOf(':');
      if (separator > 0) values.push(entry.slice(separator + 1).trim());
    }
  }

  return values.filter((value) => value.length >= 8);
}
