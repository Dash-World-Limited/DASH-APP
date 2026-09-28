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
import {
  assembleKeyring,
  assertValidKeyId,
  parseKey,
  parseRetiredKeys,
  type Keyring,
} from '@dash/domain/envelope';
import { assertRetentionDays } from '@dash/domain/retention';
import {
  assertCoolingOffDays,
  assertExportTtlHours,
  DELETION_COOLING_OFF_DAYS,
  EXPORT_DOWNLOAD_TTL_HOURS,
} from '@dash/domain/account';
import { redactSecretsInText } from '@dash/domain/redaction';
import { presentSecretValues } from './secrets/classification.js';
import { DEPLOYMENT_PROFILES, effectiveCapabilities } from './deployment/profile.js';

const booleanish = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

const shape = z
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
    /**
     * Per destination (phone or email address), not per client: the IP rate
     * limit alone lets anyone with rotating addresses flood one inbox, and
     * every email or SMS costs money. Within the cooldown, or past the hourly
     * cap, a request is answered exactly like any other and nothing is sent;
     * the code already issued stays valid.
     */
    OTP_RESEND_COOLDOWN_SECONDS: z.coerce.number().int().min(0).default(60),
    OTP_MAX_CODES_PER_HOUR: z.coerce.number().int().positive().default(5),
    DEV_EXPOSE_OTP: booleanish.default('false'),

    DEFAULT_CURRENCY: z.literal('NGN').default('NGN'),
    DEFAULT_CITY_SLUG: z.string().default('lagos'),
    DEFAULT_TIMEZONE: z.string().default('Africa/Lagos'),

    PAYMENT_PROVIDER: z.enum(['mock', 'paystack']).default('mock'),
    PAYSTACK_SECRET_KEY: z.string().optional(),
    /**
     * Not used. Paystack signs webhooks with the secret key itself, so a
     * separate value here can only disagree with it. Accepted, so an existing
     * environment still parses, and refused below unless empty or identical.
     */
    PAYSTACK_WEBHOOK_SECRET: z.string().optional(),
    /**
     * The explicit switch for real money. A `sk_live_` key is refused unless
     * this is true *and* NODE_ENV is production, so a live key pasted into a
     * staging or developer environment cannot charge anybody.
     */
    PAYSTACK_ALLOW_LIVE: booleanish.default('false'),
    /** Where Paystack returns the customer's browser. Defaults to PUBLIC_WEB_URL/pay/complete. */
    PAYSTACK_CALLBACK_URL: z.string().url().optional(),

    MAPS_PROVIDER: z.enum(['local', 'google', 'mapbox']).default('local'),
    GOOGLE_MAPS_API_KEY: z.string().optional(),
    MAPBOX_ACCESS_TOKEN: z.string().optional(),

    SMS_PROVIDER: z.enum(['console', 'termii', 'twilio']).default('console'),
    /**
     * Off in V1. Sign-in is by emailed code and phone numbers are unverified,
     * so no SMS is ever sent and no SMS provider is required — in production
     * included. Switched on together with phone verification.
     */
    SMS_ENABLED: booleanish.default('false'),
    EMAIL_PROVIDER: z.enum(['console', 'ses']).default('console'),

    /**
     * Amazon SES, for transactional email.
     *
     * `smtp` was removed from the enum above rather than left in place. It was
     * never implemented, and a value that passes validation while having no
     * adapter behind it is how a deployment boots believing it sends email.
     *
     * The credential is deliberately absent: the SDK resolves it through its own
     * default chain, so an instance role works and no key need exist in the
     * environment at all.
     */
    SES_REGION: z.string().trim().min(1).optional(),
    /** Must be a verified identity in `SES_REGION`. SES rejects anything else. */
    EMAIL_FROM_ADDRESS: z.string().trim().email().optional(),
    EMAIL_FROM_NAME: z.string().trim().min(1).max(60).default('DASH World'),
    /**
     * Where replies go, and it must be a monitored mailbox.
     *
     * The identity-conflict email tells a genuine user to reply to it. That is
     * their only route through the one case the system deliberately refuses to
     * resolve automatically.
     */
    EMAIL_REPLY_TO: z.string().trim().email().optional(),
    /** Groups messages so bounce and complaint events can be attributed. */
    SES_CONFIGURATION_SET: z.string().trim().min(1).optional(),
    /**
     * The SNS topic bounce and complaint notifications arrive on.
     *
     * When set, a message from any other topic is refused even if its signature
     * is perfect — a valid signature from a topic we never subscribed to is
     * still somebody else's traffic.
     */
    SES_EVENT_TOPIC_ARN: z.string().trim().min(1).optional(),

    /**
     * Who may create an account, while SES is still in the sandbox.
     *
     * A comma-separated list of addresses. Empty — the default — means signup is
     * open to everybody.
     *
     * This exists because of a specific, silent failure. Inside the SES
     * sandbox AWS delivers *only* to addresses verified individually in the
     * console. Signup would otherwise accept anybody, create their identity,
     * report success, and send a verification code that never arrives — and
     * the person has no way to tell that from a code lost in spam. They would
     * simply be stuck, with an account they can never open.
     *
     * So the application mirrors what the mail provider will actually do. An
     * address that cannot receive a code is told signup is not open yet, which
     * is true, instead of being handed an account that cannot work.
     *
     * Remove it once production access is granted. It is not a launch feature
     * and nothing else in the product reads it.
     */
    SIGNUP_ALLOWLIST: z.string().trim().default(''),
    PUSH_PROVIDER: z.enum(['console', 'fcm']).default('console'),
    /**
     * Which engine answers a DASH ValueCheck.
     *
     * Only `local` exists today — the deterministic adapter, which is
     * arithmetic over declared evidence and says so in every result it
     * returns. The enum is here so a live provider is a new value plus an
     * adapter rather than a change to any marketplace code.
     *
     * Deliberately *not* in the production boot guards below yet. Those refuse
     * to start when a development-only adapter is configured, and adding
     * ValueCheck to them today would block a production deploy over a feature
     * that has not launched. The guard belongs in the commit that adds the
     * first live provider, alongside the credential it needs.
     */
    VALUECHECK_PROVIDER: z.enum(['local']).default('local'),
    /**
     * Path to the service-account JSON, read by the Firebase SDK itself.
     *
     * Declared here rather than reached for from `process.env` at the point of
     * use, so it is validated with everything else and a test can supply it.
     * The value is a path and never the credential; nothing in this project
     * opens the file.
     *
     * Optional because a Google-hosted runtime supplies its own service
     * identity with no file at all.
     */
    GOOGLE_APPLICATION_CREDENTIALS: z.string().min(1).optional(),

    /**
     * Which parts of DASH this deployment runs.
     *
     * `full` is DASH APP: payments, delivery, dispatch, SMS, push and maps, and
     * every strict production guard below applies. `declutters` is the
     * marketplace alone — see `deployment/profile.ts` for what each capability
     * means and why the marketplace has none of those.
     *
     * Defaults to `full` deliberately. A deployment that forgets to name its
     * profile gets the strictest checks, not the loosest.
     */
    DEPLOYMENT_PROFILE: z.enum(DEPLOYMENT_PROFILES).default('full'),

    STORAGE_PROVIDER: z.enum(['local', 's3']).default('local'),
    /**
     * Object storage.
     *
     * `S3_ENDPOINT` and `S3_FORCE_PATH_STYLE` are what make this
     * S3-*compatible* rather than S3-only: MinIO, R2, Spaces and B2 differ from
     * AWS by configuration, not by code, and keeping it that way means the
     * storage decision stays reversible.
     */
    S3_BUCKET: z.string().trim().min(1).optional(),
    S3_REGION: z.string().trim().min(1).optional(),
    S3_ENDPOINT: z.string().trim().url().optional(),
    S3_FORCE_PATH_STYLE: z.coerce.boolean().default(false),
    STORAGE_LOCAL_DIR: z.string().default('./.storage'),

    QUEUE_PROVIDER: z.enum(['memory', 'redis']).default('memory'),
    REDIS_URL: z.string().optional(),

    // --- Realtime ------------------------------------------------------------
    // Switches off the WebSocket endpoint. It stays reachable when off and
    // closes each socket with a code that means "this deployment does not do
    // realtime", so clients fall back to polling in one round trip instead of
    // retrying into an opaque connection error. Every screen it feeds worked by
    // polling before this milestone and still does, so turning it off degrades
    // freshness and nothing else.
    REALTIME_ENABLED: booleanish.default('true'),

    // How a notification reaches the *other* instances. `memory` repeats it
    // inside this process only, which is correct on one instance and silently
    // wrong on more than one — the customer watching an order is connected to
    // whichever instance the load balancer picked, and it is rarely the one
    // whose worker handled the job. Production is refused it below, exactly as
    // it is refused the in-memory queue.
    REALTIME_BROADCAST: z.enum(['memory', 'redis']).default('memory'),

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
  });

/**
 * Every variable this application reads, as a sorted list.
 *
 * Exported so documentation can be checked against it rather than proof-read.
 * `.env.example` and the production runbook twice drifted into naming variables
 * no code reads: `ENCRYPTION_KEYS`, `ENCRYPTION_ACTIVE_KEY` and
 * `REFRESH_TOKEN_PEPPER` were all documented as required while the schema knew
 * nothing about them. Each looked harmless on its own. Together they meant a
 * deployment could follow the runbook exactly and still be refused at boot over a
 * variable the runbook never mentioned — which is the same failure as a
 * validated-but-never-read provider setting, arriving from the other direction.
 *
 * A list derived from the schema cannot drift from the schema.
 */
export const CONFIG_VARIABLE_NAMES: readonly string[] = Object.keys(shape.shape).sort();

const schema = shape
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

    // The active key id travels inside every envelope this key writes and must
    // survive being parsed back out. An id the format cannot carry produces
    // ciphertext that encrypts fine and can never be decrypted — the loss is
    // silent until someone tries to read it, which is why it is refused here
    // rather than discovered later.
    try {
      assertValidKeyId(env.ENCRYPTION_KEY_ID, 'ENCRYPTION_KEY_ID');
    } catch (error) {
      fail('ENCRYPTION_KEY_ID', error instanceof Error ? error.message : 'is not a valid key id');
    }

    // --- Rotation coherence ---------------------------------------------------
    // A keyring that is ambiguous about which key is which must not boot. Every
    // rule below describes a rotation that has been half-applied, and each of
    // them fails in the same expensive way: rows that cannot be decrypted, found
    // weeks later.
    if (env.ENCRYPTION_KEYS_RETIRED.trim() !== '') {
      try {
        const retired = parseRetiredKeys(env.ENCRYPTION_KEYS_RETIRED);

        // Retired keys with nothing active is not a decrypt-only mode — it is a
        // configuration that can read old rows and write none, which fails at
        // the first write instead of at boot.
        if (!env.ENCRYPTION_KEY) {
          fail(
            'ENCRYPTION_KEYS_RETIRED',
            'Retired keys are configured but ENCRYPTION_KEY is not — there would be nothing to encrypt new values with',
          );
        }

        // One id naming two different keys makes decryption non-deterministic.
        // Refused rather than resolved in favour of one, because "the active
        // entry wins" is a guess about which rotation step was skipped.
        if (retired.some((entry) => entry.keyId === env.ENCRYPTION_KEY_ID)) {
          fail(
            'ENCRYPTION_KEYS_RETIRED',
            `Key id "${env.ENCRYPTION_KEY_ID}" is both the active key and a retired key — a rotation has been half-applied, and which key a row named cannot be answered`,
          );
        }

        // The same bytes under two ids means a rotation that did not rotate.
        // Comparing material rather than ids catches the case where someone
        // copied the active key into the retired list under a new name.
        if (env.ENCRYPTION_KEY) {
          const active = parseKey(env.ENCRYPTION_KEY, 'ENCRYPTION_KEY');
          if (retired.some((entry) => entry.key.equals(active))) {
            fail(
              'ENCRYPTION_KEYS_RETIRED',
              'A retired key holds the same material as the active key under a different id — nothing has actually been rotated',
            );
          }
        }
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

    // Account-deletion and export windows, against the domain policy's bounds.
    try {
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

    // --- Paystack (every environment) ---------------------------------------
    // Staging is where a live key is most likely to be pasted by mistake, so
    // these are not production-only.
    if (env.PAYMENT_PROVIDER === 'paystack') {
      const key = env.PAYSTACK_SECRET_KEY ?? '';
      if (!/^sk_(test|live)_[A-Za-z0-9]{16,}$/.test(key)) {
        fail('PAYSTACK_SECRET_KEY', 'PAYMENT_PROVIDER=paystack needs a Paystack secret key (sk_test_… or sk_live_…)');
      } else if (key.startsWith('sk_live_') && !(env.NODE_ENV === 'production' && env.PAYSTACK_ALLOW_LIVE)) {
        fail(
          'PAYSTACK_SECRET_KEY',
          'A live Paystack key is refused unless NODE_ENV=production and PAYSTACK_ALLOW_LIVE=true — use the sk_test_ key everywhere else',
        );
      }
      if (env.PAYSTACK_WEBHOOK_SECRET && env.PAYSTACK_WEBHOOK_SECRET !== key) {
        fail(
          'PAYSTACK_WEBHOOK_SECRET',
          'Paystack signs webhooks with the secret key; a different value here would reject every genuine event. Leave it empty',
        );
      }
    }
    if (env.PAYSTACK_ALLOW_LIVE && env.NODE_ENV !== 'production') {
      fail('PAYSTACK_ALLOW_LIVE', 'Live payments can only be switched on in production');
    }

    if (env.NODE_ENV !== 'production') return;

    // --- Production-only guards ---------------------------------------------
    // Each of these is a configuration that would be a serious incident in
    // production. The process refuses to start rather than warning, because a
    // warning in a startup log is a warning nobody reads.

    if (env.DEV_EXPOSE_OTP) {
      fail('DEV_EXPOSE_OTP', 'DEV_EXPOSE_OTP must be false in production — it returns login codes in the API response');
    }

    if (env.OTP_RESEND_COOLDOWN_SECONDS < 30) {
      fail(
        'OTP_RESEND_COOLDOWN_SECONDS',
        'OTP_RESEND_COOLDOWN_SECONDS must be at least 30 in production — without it one address can be sent a code on every request',
      );
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
    //
    // Each check applies only to a capability this deployment actually has.
    // Nothing is weakened: on the `full` profile every one of them runs exactly
    // as before. On `declutters` the capability is switched off, its adapter
    // throws on every call, and its routes are never registered — so the
    // question the guard asks ("is this provider real?") has no subject.
    //
    // Checking a switched-off feature would force a Declutters deployment to be
    // handed Paystack keys it will never use and a maps key for addresses it
    // never geocodes, which is how unused credentials end up in production
    // environments.
    const capabilities = effectiveCapabilities(env);

    if (capabilities.has('payments') && env.PAYMENT_PROVIDER === 'mock') {
      fail('PAYMENT_PROVIDER', 'The mock payment provider must never run in production — it settles nothing');
    }
    if (capabilities.has('maps') && env.MAPS_PROVIDER === 'local') {
      fail('MAPS_PROVIDER', 'The local geo adapter cannot geocode an address; production needs a real provider');
    }
    if (capabilities.has('sms') && env.SMS_PROVIDER === 'console') {
      fail('SMS_PROVIDER', 'The console SMS adapter only logs — no customer would ever receive a login code');
    }
    if (env.EMAIL_PROVIDER === 'console') {
      fail('EMAIL_PROVIDER', 'The console email adapter only logs — nothing is delivered');
    }
    if (env.EMAIL_PROVIDER === 'ses') {
      // Checked at boot rather than at the first send. A missing sender is not
      // discovered until somebody tries to create an account, and by then the
      // failure looks like a broken signup form.
      if (!env.SES_REGION) {
        fail('SES_REGION', 'SES is regional, and the sending identity is verified per region');
      }
      if (!env.EMAIL_FROM_ADDRESS) {
        fail('EMAIL_FROM_ADDRESS', 'SES refuses any sender that is not a verified identity');
      }
      if (!env.EMAIL_REPLY_TO) {
        fail(
          'EMAIL_REPLY_TO',
          'The identity-conflict email tells people to reply to it; an unset address leaves them nowhere to go',
        );
      }
    }
    if (capabilities.has('push') && env.PUSH_PROVIDER === 'console') {
      fail('PUSH_PROVIDER', 'The console push adapter only logs — no device is notified');
    }
    if (env.STORAGE_PROVIDER === 'local') {
      fail('STORAGE_PROVIDER', 'Local disk storage is development-only and is lost on redeploy');
    }
    if (env.STORAGE_PROVIDER === 's3') {
      // Checked at boot, not at the first upload. A wrong bucket name is
      // otherwise discovered by the first seller to photograph an item, and it
      // presents as a broken upload form.
      if (!env.S3_BUCKET) fail('S3_BUCKET', 'Object storage needs a bucket to write to');
      if (!env.S3_REGION) fail('S3_REGION', 'S3 is regional and the bucket lives in one region');
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
    // Only when realtime is on: a deployment that has deliberately turned it
    // off has no fan-out to get wrong, and demanding Redis for a feature that
    // is switched off would be a startup failure with no cause.
    //
    // The capability is checked first and the env flag second, because the
    // capability is the stronger statement. On a profile without `realtime` the
    // socket is never served whatever `REALTIME_ENABLED` says, so requiring
    // Redis for its fan-out would be asking a deployment to configure the
    // plumbing of a feature it cannot reach.
    if (
      capabilities.has('realtime') &&
      env.REALTIME_ENABLED &&
      env.REALTIME_BROADCAST === 'memory'
    ) {
      fail(
        'REALTIME_BROADCAST',
        'In-process fan-out reaches only the sockets on one instance, so most clients would silently never be notified; production must broadcast through Redis',
      );
    }

    // --- Credentials required by the chosen providers ------------------------
    // Paystack's key rules run in every environment, above.
    if (env.QUEUE_PROVIDER === 'redis' && !env.REDIS_URL) {
      fail('REDIS_URL', 'Required when QUEUE_PROVIDER is redis');
    }
    if (env.REALTIME_BROADCAST === 'redis' && !env.REDIS_URL) {
      fail('REDIS_URL', 'Required when REALTIME_BROADCAST is redis');
    }
    if (env.MAPS_PROVIDER === 'google' && !env.GOOGLE_MAPS_API_KEY) {
      fail('GOOGLE_MAPS_API_KEY', 'Required when MAPS_PROVIDER is google');
    }
    if (env.MAPS_PROVIDER === 'mapbox' && !env.MAPBOX_ACCESS_TOKEN) {
      fail('MAPBOX_ACCESS_TOKEN', 'Required when MAPS_PROVIDER is mapbox');
    }

    // Firebase resolves its credential from the environment, so a missing one
    // surfaces as an opaque SDK error on the first send rather than at boot —
    // by which time a rider has already missed an offer. Named here instead.
    if (env.PUSH_PROVIDER === 'fcm' && !env.GOOGLE_APPLICATION_CREDENTIALS) {
      fail(
        'GOOGLE_APPLICATION_CREDENTIALS',
        'Required when PUSH_PROVIDER is fcm, unless the host supplies its own service identity',
      );
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

    // Every message above is written to name the variable, never its value, and
    // the tests assert that. The scrub is the second lock on the same door: Zod
    // echoes the received value for some built-in checks, a future refinement
    // could interpolate one by accident, and this message is printed to stderr
    // by `main.ts` where a container platform will capture it. Being wrong here
    // means a secret in a boot log, so one belt and one set of braces.
    const message = redactSecretsInText(
      `Invalid environment configuration:\n${lines.join('\n')}`,
      presentSecretValues(source),
    );

    throw new Error(message);
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
    // `off` rather than the broadcast provider when disabled: printing
    // `realtime=memory` on a deployment that serves no sockets at all would
    // describe a fan-out that is never reached.
    `realtime=${config.REALTIME_ENABLED ? config.REALTIME_BROADCAST : 'off'}`,
  ].join('  ');
}

// ---------------------------------------------------------------------------
// Encryption keyring
// ---------------------------------------------------------------------------

/**
 * Parse `id:base64key,id2:base64key2` into retired keys.
 *
 * Re-exported rather than implemented here. The rules about what makes a set of
 * keys coherent live in `@dash/domain/envelope` so that the seed — which sits
 * below `apps/api` and cannot import this module — applies exactly the same
 * ones. See the keyring-assembly section there.
 */
export { parseRetiredKeys };

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

  return assembleKeyring({
    activeKey: config.ENCRYPTION_KEY,
    activeKeyId: config.ENCRYPTION_KEY_ID,
    retired: config.ENCRYPTION_KEYS_RETIRED,
  });
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
