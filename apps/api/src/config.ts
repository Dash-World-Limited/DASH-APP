/**
 * Environment configuration.
 *
 * Validated once at boot with Zod. A missing or malformed variable stops the
 * process immediately with a readable message, rather than surfacing as
 * `undefined` in a request handler three hours later.
 *
 * Several rules here exist specifically to make an unsafe production
 * configuration impossible rather than merely discouraged.
 */

import { z } from 'zod';
import { parseKey, type EncryptionKey, type Keyring } from '@dash/domain/envelope';
import { assertRetentionDays } from '@dash/domain/retention';
import {
  assertCoolingOffDays,
  assertExportTtlHours,
  DELETION_COOLING_OFF_DAYS,
  EXPORT_DOWNLOAD_TTL_HOURS,
} from '@dash/domain/account';

const booleanish = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

    API_PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
    API_HOST: z.string().default('127.0.0.1'),
    PUBLIC_WEB_URL: z.string().url().default('http://127.0.0.1:3000'),

    // 32 characters is the floor for an HMAC secret worth having. The default
    // values shipped in .env.example are deliberately long enough to pass this
    // check but are rejected separately below.
    JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
    JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
    ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
    REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(2_592_000),

    OTP_TTL_SECONDS: z.coerce.number().int().positive().default(300),
    OTP_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
    DEV_EXPOSE_OTP: booleanish.default('false'),

    DEFAULT_CURRENCY: z.literal('NGN').default('NGN'),
    DEFAULT_CITY_SLUG: z.string().default('lagos'),
    DEFAULT_TIMEZONE: z.string().default('Africa/Lagos'),

    PAYMENT_PROVIDER: z.enum(['mock', 'paystack']).default('mock'),
    PAYSTACK_SECRET_KEY: z.string().optional(),
    PAYSTACK_WEBHOOK_SECRET: z.string().optional(),

    MAPS_PROVIDER: z.enum(['local', 'google', 'mapbox']).default('local'),
    GOOGLE_MAPS_API_KEY: z.string().optional(),
    MAPBOX_ACCESS_TOKEN: z.string().optional(),

    SMS_PROVIDER: z.enum(['console', 'termii', 'twilio']).default('console'),
    EMAIL_PROVIDER: z.enum(['console', 'smtp']).default('console'),
    PUSH_PROVIDER: z.enum(['console', 'fcm']).default('console'),

    STORAGE_PROVIDER: z.enum(['local', 's3']).default('local'),
    STORAGE_LOCAL_DIR: z.string().default('./.storage'),

    QUEUE_PROVIDER: z.enum(['memory', 'redis']).default('memory'),
    REDIS_URL: z.string().optional(),

    // Which implementation answers `GeoPort.zonesContaining`. `postgis` pushes
    // the point-in-polygon test into the database as `ST_Contains`; `local`
    // tests rings in process. Kept separate from MAPS_PROVIDER because PostGIS
    // answers containment but cannot route or geocode — the PostGIS adapter
    // delegates those to the maps provider unchanged.
    GEO_ZONES_PROVIDER: z.enum(['local', 'postgis']).default('local'),

    // Backs rate limiting with Redis so a limit is shared across instances
    // rather than counted per process. Off by default; production requires it
    // (see below) because per-process counters multiply the real limit by the
    // instance count.
    RATE_LIMIT_REDIS: booleanish.default('false'),

    // `silent` is a real Pino level and the right one for tests — a passing
    // suite should not print a wall of request logs.
    LOG_LEVEL: z
      .enum(['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace'])
      .default('info'),

    // Rate limiting is on everywhere by default. A test suite that signs in
    // twenty times legitimately trips the login limiter, so the harness turns
    // it off explicitly — and `superRefine` below refuses to let production do
    // the same. Turning it off is a decision someone has to make in writing,
    // not a silent side effect of NODE_ENV.
    RATE_LIMIT_ENABLED: booleanish.default('true'),

    // --- Encryption at rest --------------------------------------------------
    // One keyring serves every encrypted field (the TOTP secret today, vendor
    // bank details next). The fields are separated cryptographically rather
    // than by holding separate keys: every ciphertext is bound to a purpose and
    // a subject as additional authenticated data, so a TOTP envelope cannot be
    // decrypted as a bank account, and one vendor's row cannot be read as
    // another's. See packages/domain/src/envelope.
    //
    // Base64 of exactly 32 bytes. Generate with:
    //   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
    ENCRYPTION_KEY: z.string().optional(),

    // Names the active key inside every envelope it writes, so a key can be
    // rotated without rewriting existing rows in a single deploy.
    ENCRYPTION_KEY_ID: z.string().min(1).max(64).default('k1'),

    // Keys that no longer encrypt new values but must still decrypt old ones.
    // Format: `id:base64key` entries separated by commas.
    ENCRYPTION_KEYS_RETIRED: z.string().default(''),

    // Whether staff accounts must carry TOTP. On by default; the only reason to
    // turn it off is a local environment with no key configured, and production
    // refuses that below.
    MFA_ENABLED: booleanish.default('true'),

    // --- Retention overrides ----------------------------------------------
    // One variable per tunable period. Unset means the policy default in
    // @dash/domain/retention applies. Each is validated against that policy's
    // ceiling below, so a value that would be refused in production is refused
    // in staging too. Shortening a period is always fine — less data held is
    // never a compliance risk — but lengthening one past its ceiling needs a
    // documented decision, not an environment variable.
    RETENTION_SESSIONS_DAYS: z.coerce.number().int().positive().optional(),
    RETENTION_RIDER_LOCATION_DAYS: z.coerce.number().int().positive().optional(),
    // Governs both OTP and MFA challenges — the same class of spent, short-lived
    // credential — so the two cannot drift apart.
    RETENTION_OTP_DAYS: z.coerce.number().int().positive().optional(),
    RETENTION_IDEMPOTENCY_DAYS: z.coerce.number().int().positive().optional(),

    // --- Account deletion and data export -------------------------------
    // How long a scheduled deletion waits before it is finalised, and how long
    // a built export archive stays downloadable. Both are validated against the
    // domain policy's floor and ceiling below.
    ACCOUNT_DELETION_COOLING_OFF_DAYS: z.coerce
      .number()
      .int()
      .positive()
      .default(DELETION_COOLING_OFF_DAYS),
    DATA_EXPORT_TTL_HOURS: z.coerce.number().int().positive().default(EXPORT_DOWNLOAD_TTL_HOURS),
  })
  .superRefine((env, ctx) => {
    const fail = (path: string, message: string): void => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
    };

    // The two token secrets signing different token classes must differ. If they
    // are equal, a refresh token verifies as an access token — a full auth
    // bypass that is invisible until someone tries it.
    if (env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET) {
      fail('JWT_REFRESH_SECRET', 'JWT_REFRESH_SECRET must differ from JWT_ACCESS_SECRET');
    }

    // A weak secret in a non-production environment is fine — the whole point of
    // the placeholder values is that development needs no ceremony.
    // Key material is validated wherever it is supplied, not only in
    // production. A malformed key must fail at boot; discovering it at the
    // first enrolment means discovering it in front of a user.
    if (env.ENCRYPTION_KEY) {
      try {
        parseKey(env.ENCRYPTION_KEY, 'ENCRYPTION_KEY');
      } catch (error) {
        fail('ENCRYPTION_KEY', error instanceof Error ? error.message : 'is not valid key material');
      }
    }

    if (env.ENCRYPTION_KEYS_RETIRED.trim() !== '') {
      try {
        parseRetiredKeys(env.ENCRYPTION_KEYS_RETIRED);
      } catch (error) {
        fail(
          'ENCRYPTION_KEYS_RETIRED',
          error instanceof Error ? error.message : 'is not valid key material',
        );
      }
    }

    // MFA without a key is not "MFA off", it is MFA that fails at enrolment.
    // Refuse the combination outright rather than deferring the error.
    if (env.MFA_ENABLED && !env.ENCRYPTION_KEY) {
      fail(
        'ENCRYPTION_KEY',
        'MFA_ENABLED is true but no ENCRYPTION_KEY is set — the TOTP secret could not be stored safely',
      );
    }

    // Retention periods are checked against the policy's per-rule ceilings
    // wherever they are supplied, not only in production: a period refused in
    // production must be refused in staging too, or staging stops being a
    // rehearsal.
    for (const [variable, rule, value] of [
      ['RETENTION_SESSIONS_DAYS', 'expired_sessions', env.RETENTION_SESSIONS_DAYS],
      ['RETENTION_RIDER_LOCATION_DAYS', 'rider_location_history', env.RETENTION_RIDER_LOCATION_DAYS],
      ['RETENTION_OTP_DAYS', 'consumed_otp_challenges', env.RETENTION_OTP_DAYS],
      ['RETENTION_IDEMPOTENCY_DAYS', 'expired_idempotency_keys', env.RETENTION_IDEMPOTENCY_DAYS],
    ] as const) {
      if (value === undefined) continue;
      try {
        assertRetentionDays(rule, value);
      } catch (error) {
        fail(variable, error instanceof Error ? error.message : 'is not a valid retention period');
      }
    }

    // Account-deletion and export windows, against the domain policy's bounds.
    try {
      // --- Redis and PostGIS coherence (every environment) --------------------
    // A misconfiguration that only surfaces in production is a misconfiguration
    // staging never rehearsed, so these run everywhere rather than inside the
    // production block below.
    if (env.RATE_LIMIT_REDIS && !env.REDIS_URL) {
      fail('REDIS_URL', 'Required when RATE_LIMIT_REDIS is true — the limiter has nowhere to keep its counters');
    }
    if (env.GEO_ZONES_PROVIDER === 'postgis' && env.DATABASE_URL.startsWith('file:')) {
      fail(
        'GEO_ZONES_PROVIDER',
        'PostGIS zone containment needs a PostgreSQL database; DATABASE_URL points at SQLite',
      );
    }

    assertCoolingOffDays(env.ACCOUNT_DELETION_COOLING_OFF_DAYS);
    } catch (error) {
      fail(
        'ACCOUNT_DELETION_COOLING_OFF_DAYS',
        error instanceof Error ? error.message : 'is out of range',
      );
    }
    try {
      assertExportTtlHours(env.DATA_EXPORT_TTL_HOURS);
    } catch (error) {
      fail('DATA_EXPORT_TTL_HOURS', error instanceof Error ? error.message : 'is out of range');
    }

    if (env.NODE_ENV !== 'production') return;

    // --- Production-only guards ---------------------------------------------
    // Each of these is a configuration that would be a serious incident in
    // production. The process refuses to start rather than warning, because a
    // warning in a startup log is a warning nobody reads.

    if (env.DEV_EXPOSE_OTP) {
      fail('DEV_EXPOSE_OTP', 'DEV_EXPOSE_OTP must be false in production — it returns login codes in the API response');
    }

    if (!env.MFA_ENABLED) {
      fail(
        'MFA_ENABLED',
        'Administrator MFA cannot be disabled in production — a single leaked staff password would otherwise reach the money',
      );
    }

    if (!env.ENCRYPTION_KEY) {
      fail(
        'ENCRYPTION_KEY',
        'ENCRYPTION_KEY is required in production — without it the TOTP secret would have nowhere safe to live',
      );
    }

    if (!env.RATE_LIMIT_ENABLED) {
      fail('RATE_LIMIT_ENABLED', 'Rate limiting cannot be disabled in production — it is the only defence against credential stuffing and OTP brute force');
    }

    for (const key of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'] as const) {
      const weakness = describeSecretWeakness(env[key]);
      if (weakness) fail(key, `${key} ${weakness}`);
    }

    if (env.DATABASE_URL.startsWith('file:')) {
      fail('DATABASE_URL', 'SQLite is development-only; production requires PostgreSQL (ADR-0003)');
    }

    // --- Mock adapters -------------------------------------------------------
    // Every one of these reports `isLive: false`. Running any of them in
    // production means the platform silently does nothing where it claims to
    // charge a card, send a code, or store a document.
    if (env.PAYMENT_PROVIDER === 'mock') {
      fail('PAYMENT_PROVIDER', 'The mock payment provider must never run in production — it settles nothing');
    }
    if (env.MAPS_PROVIDER === 'local') {
      fail('MAPS_PROVIDER', 'The local geo adapter cannot geocode an address; production needs a real provider');
    }
    if (env.SMS_PROVIDER === 'console') {
      fail('SMS_PROVIDER', 'The console SMS adapter only logs — no customer would ever receive a login code');
    }
    if (env.EMAIL_PROVIDER === 'console') {
      fail('EMAIL_PROVIDER', 'The console email adapter only logs — nothing is delivered');
    }
    if (env.PUSH_PROVIDER === 'console') {
      fail('PUSH_PROVIDER', 'The console push adapter only logs — no device is notified');
    }
    if (env.STORAGE_PROVIDER === 'local') {
      fail('STORAGE_PROVIDER', 'Local disk storage is development-only and is lost on redeploy');
    }
    if (env.QUEUE_PROVIDER === 'memory') {
      fail('QUEUE_PROVIDER', 'The in-memory queue loses jobs on restart and cannot be shared across instances');
    }
    if (env.GEO_ZONES_PROVIDER === 'local') {
      fail(
        'GEO_ZONES_PROVIDER',
        'The local adapter loads every zone in a city and tests rings in process; production runs the containment test in PostGIS',
      );
    }
    if (!env.RATE_LIMIT_REDIS) {
      fail(
        'RATE_LIMIT_REDIS',
        'Per-process rate-limit counters multiply the real limit by the number of instances; production must share them through Redis',
      );
    }

    // --- Credentials required by the chosen providers ------------------------
    if (env.PAYMENT_PROVIDER === 'paystack') {
      if (!env.PAYSTACK_SECRET_KEY) fail('PAYSTACK_SECRET_KEY', 'Required when using Paystack');
      if (!env.PAYSTACK_WEBHOOK_SECRET) {
        fail('PAYSTACK_WEBHOOK_SECRET', 'Required — unsigned webhooks cannot be trusted');
      }
    }
    if (env.QUEUE_PROVIDER === 'redis' && !env.REDIS_URL) {
      fail('REDIS_URL', 'Required when QUEUE_PROVIDER is redis');
    }
    if (env.MAPS_PROVIDER === 'google' && !env.GOOGLE_MAPS_API_KEY) {
      fail('GOOGLE_MAPS_API_KEY', 'Required when MAPS_PROVIDER is google');
    }
    if (env.MAPS_PROVIDER === 'mapbox' && !env.MAPBOX_ACCESS_TOKEN) {
      fail('MAPBOX_ACCESS_TOKEN', 'Required when MAPS_PROVIDER is mapbox');
    }

    // --- Transport -----------------------------------------------------------
    // The refresh cookie is issued with `Secure`, so a browser will refuse to
    // store it over plain HTTP. Catching that here turns a baffling "login does
    // nothing" bug into a startup error naming the cause.
    if (env.PUBLIC_WEB_URL.startsWith('http://')) {
      fail('PUBLIC_WEB_URL', 'Production must be HTTPS — Secure cookies are not stored over http://');
    }
  });

/**
 * Reject a secret that is a placeholder, a recognisable development string, or
 * too low-entropy to be worth having.
 *
 * The length floor alone is not enough: `aaaaaaaa…` is 48 characters and
 * worthless. Counting distinct characters catches the padded-placeholder case
 * that a length check waves through.
 *
 * Returns a human-readable description of the problem, or null when the secret
 * looks acceptable.
 */
function describeSecretWeakness(secret: string): string | null {
  const lower = secret.toLowerCase();

  const bannedFragments = [
    'replace-me',
    'replace_me',
    'changeme',
    'change-me',
    'placeholder',
    'example',
    'dev-secret',
    'devsecret',
    'test-secret',
    'testsecret',
    'notasecret',
    'password',
    'insecure',
    'dashdev',
  ];
  for (const fragment of bannedFragments) {
    if (lower.includes(fragment)) {
      return `contains the development placeholder "${fragment}"`;
    }
  }

  const distinct = new Set(secret).size;
  if (distinct < 16) {
    return `has only ${distinct} distinct characters — it is not random enough to be a secret`;
  }

  return null;
}

export type Config = z.infer<typeof schema>;

let cached: Config | null = null;

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  if (cached) return cached;

  const result = schema.safeParse(source);
  if (!result.success) {
    const lines = result.error.issues.map(
      (issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`,
    );
    // Written to stderr and thrown — never log the values themselves, only the
    // names of what failed.
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }

  cached = result.data;
  return cached;
}

/** Test helper. Never called in normal operation. */
export function resetConfigCache(): void {
  cached = null;
}

export const isProduction = (config: Config): boolean => config.NODE_ENV === 'production';
export const isDevelopment = (config: Config): boolean => config.NODE_ENV === 'development';

/**
 * A one-line summary of which adapters are live, printed at boot.
 *
 * This exists so nobody can mistake a mock for a working integration: if the
 * banner says `payments=mock`, no payment has ever reached a bank.
 */
export function describeAdapters(config: Config): string {
  return [
    `payments=${config.PAYMENT_PROVIDER}`,
    `maps=${config.MAPS_PROVIDER}`,
    `sms=${config.SMS_PROVIDER}`,
    `storage=${config.STORAGE_PROVIDER}`,
    `queue=${config.QUEUE_PROVIDER}`,
  ].join('  ');
}

// ---------------------------------------------------------------------------
// Encryption keyring
// ---------------------------------------------------------------------------

/**
 * Parse `id:base64key,id2:base64key2` into retired keys.
 *
 * Exported for validation at boot. Duplicated ids are rejected: two different
 * keys claiming the same id makes decryption non-deterministic, which is the
 * kind of bug that only shows up on the rows you can no longer read.
 */
export function parseRetiredKeys(raw: string): EncryptionKey[] {
  const trimmed = raw.trim();
  if (trimmed === '') return [];

  const seen = new Set<string>();

  return trimmed.split(',').map((entry, index) => {
    const separator = entry.indexOf(':');
    if (separator <= 0) {
      throw new Error(`retired key ${index + 1} is not in "id:base64key" form`);
    }

    const keyId = entry.slice(0, separator).trim();
    const encoded = entry.slice(separator + 1).trim();

    if (seen.has(keyId)) throw new Error(`retired key id "${keyId}" appears more than once`);
    seen.add(keyId);

    return { keyId, key: parseKey(encoded, `retired key "${keyId}"`) };
  });
}

/**
 * Build the keyring from validated configuration.
 *
 * Throws when no key is configured. Callers that can legitimately run without
 * encryption (a local environment with MFA off) must check `isEncryptionConfigured`
 * first rather than catching this.
 */
export function buildKeyring(config: Config): Keyring {
  if (!config.ENCRYPTION_KEY) {
    throw new Error('No ENCRYPTION_KEY is configured, so nothing can be encrypted or decrypted');
  }

  const active: EncryptionKey = {
    keyId: config.ENCRYPTION_KEY_ID,
    key: parseKey(config.ENCRYPTION_KEY, 'ENCRYPTION_KEY'),
  };

  const retired = parseRetiredKeys(config.ENCRYPTION_KEYS_RETIRED).filter(
    // A key that is both active and retired is a rotation half-applied. The
    // active entry wins; keeping both would be harmless but confusing.
    (entry) => entry.keyId !== active.keyId,
  );

  return { active, retired };
}

export function isEncryptionConfigured(config: Config): boolean {
  return Boolean(config.ENCRYPTION_KEY);
}

// ---------------------------------------------------------------------------
// Retention overrides
// ---------------------------------------------------------------------------

/**
 * Retention overrides, in the shape the job expects: `{ rule_name: days }`.
 *
 * Only the variables actually set appear, so an unset one falls through to the
 * policy default in `@dash/domain/retention` rather than being silently
 * overridden. Every value here has already passed `assertRetentionDays` at boot.
 */
export function retentionOverrides(config: Config): Record<string, number> {
  const overrides: Record<string, number> = {};

  if (config.RETENTION_SESSIONS_DAYS !== undefined) {
    overrides['expired_sessions'] = config.RETENTION_SESSIONS_DAYS;
  }
  if (config.RETENTION_RIDER_LOCATION_DAYS !== undefined) {
    overrides['rider_location_history'] = config.RETENTION_RIDER_LOCATION_DAYS;
  }
  if (config.RETENTION_OTP_DAYS !== undefined) {
    overrides['consumed_otp_challenges'] = config.RETENTION_OTP_DAYS;
    // MFA challenges are the same class of spent, short-lived credential, so one
    // variable governs both rather than two that could drift apart.
    overrides['consumed_mfa_challenges'] = config.RETENTION_OTP_DAYS;
  }
  if (config.RETENTION_IDEMPOTENCY_DAYS !== undefined) {
    overrides['expired_idempotency_keys'] = config.RETENTION_IDEMPOTENCY_DAYS;
  }

  return overrides;
}
