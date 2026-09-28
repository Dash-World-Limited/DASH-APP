/**
 * Production boot guards.
 *
 * Every assertion here is a configuration that would be an incident if it
 * reached production. The point of the guards is that the process refuses to
 * start; the point of these tests is that the guards actually fire.
 *
 * A guard nobody tests is a guard that quietly stops working the day someone
 * reorders a `superRefine` block.
 */

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildKeyring,
  describeAdapters,
  loadConfig,
  parseRetiredKeys,
  resetConfigCache,
} from '../config.js';
import { assertSecureCookieConfig } from '../auth/cookies.js';

beforeEach(() => {
  resetConfigCache();
});

const FAKE_LIVE_KEY = ['sk', 'live', 'notarealkey'.repeat(4)].join('_');
const FAKE_TEST_KEY = ['sk', 'test', 'notarealkey'.repeat(4)].join('_');

/** A production environment that is otherwise entirely valid. */
function productionEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://dash_runtime:pw@db.internal:5432/dash?schema=public',
    JWT_ACCESS_SECRET: 'gJ7xQ2mV9wL4pR8sT1uY6zA3bC5dE0fH-access-KnMqPrSt',
    JWT_REFRESH_SECRET: 'Zx4Vn8Bq2Wr6Ty0Ui3Op5As7Df9Gh1Jk-refresh-LmNoPqRs',
    DEV_EXPOSE_OTP: 'false',
    PUBLIC_WEB_URL: 'https://dashapp.ng',
    PAYMENT_PROVIDER: 'paystack',
    // Assembled from parts so no scanner mistakes it for a leaked key.
    PAYSTACK_SECRET_KEY: FAKE_LIVE_KEY,
    PAYSTACK_ALLOW_LIVE: 'true',
    MAPS_PROVIDER: 'google',
    GOOGLE_MAPS_API_KEY: 'not-a-real-key',
    SMS_PROVIDER: 'termii',
    EMAIL_PROVIDER: 'ses',
    SES_REGION: 'eu-west-1',
    EMAIL_FROM_ADDRESS: 'no-reply@notify.dashworldng.com',
    EMAIL_REPLY_TO: 'admin@dashworldng.com',
    PUSH_PROVIDER: 'fcm',
    // A path, never a credential. Firebase reads the file; nothing here does.
    GOOGLE_APPLICATION_CREDENTIALS: '/var/secrets/firebase-service-account.json',
    STORAGE_PROVIDER: 's3',
    S3_BUCKET: 'dash-declutters',
    S3_REGION: 'eu-west-1',
    QUEUE_PROVIDER: 'redis',
    REDIS_URL: 'redis://cache.internal:6379',
    RATE_LIMIT_REDIS: 'true',
    REALTIME_BROADCAST: 'redis',
    GEO_ZONES_PROVIDER: 'postgis',
    // Obviously fake, generated for this file, and only ever used against
    // an in-memory config object. Never decrypts anything real.
    ENCRYPTION_KEY: 'YpTt1KNH1JtX0eaiUaPNFWHApAQl8BggrrhxcNgy604=',
    ...overrides,
  };
}

function expectRefusal(overrides: Record<string, string>, expectedFragment: string): void {
  resetConfigCache();
  let message = '';
  try {
    loadConfig(productionEnv(overrides));
    throw new Error('Expected the configuration to be refused, but it loaded.');
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toContain(expectedFragment);
}

describe('a fully valid production configuration', () => {
  it('loads', () => {
    const config = loadConfig(productionEnv());
    expect(config.NODE_ENV).toBe('production');
    expect(config.PAYMENT_PROVIDER).toBe('paystack');
  });

  it('produces secure cookie settings', () => {
    const config = loadConfig(productionEnv());
    expect(() => assertSecureCookieConfig(config)).not.toThrow();
  });
});

describe('mock adapters are refused in production', () => {
  // Each of these reports isLive: false. Running one in production means the
  // platform silently does nothing where it claims to act.
  it('refuses the mock payment provider', () => {
    expectRefusal({ PAYMENT_PROVIDER: 'mock' }, 'PAYMENT_PROVIDER');
  });

  it('refuses the local geo adapter', () => {
    expectRefusal({ MAPS_PROVIDER: 'local' }, 'MAPS_PROVIDER');
  });

  it('refuses the console SMS adapter once SMS is switched on', () => {
    // With console SMS and SMS enabled, no customer would ever receive a phone
    // code, and the platform is unusable in a way that looks like a bug.
    expectRefusal({ SMS_ENABLED: 'true', SMS_PROVIDER: 'console' }, 'SMS_PROVIDER');
  });

  it('starts without any SMS provider while SMS is off, as in V1', () => {
    // Sign-in is by emailed code and phones are unverified, so production
    // must not demand — or pay for — an SMS provider it never uses.
    const config = loadConfig(productionEnv({ SMS_PROVIDER: 'console' }));
    expect(config.SMS_ENABLED).toBe(false);
  });

  it('refuses the console email adapter', () => {
    expectRefusal({ EMAIL_PROVIDER: 'console' }, 'EMAIL_PROVIDER');
  });

  it('refuses the console push adapter', () => {
    expectRefusal({ PUSH_PROVIDER: 'console' }, 'PUSH_PROVIDER');
  });

  it('refuses local disk storage', () => {
    expectRefusal({ STORAGE_PROVIDER: 'local' }, 'STORAGE_PROVIDER');
  });

  it('refuses the in-memory queue', () => {
    expectRefusal({ QUEUE_PROVIDER: 'memory' }, 'QUEUE_PROVIDER');
  });

  it('refuses in-process realtime fan-out', () => {
    // The failure this prevents is the quiet kind: in-process fan-out works
    // perfectly on one instance and, on several, reaches only the sockets that
    // happen to be on the instance whose worker took the job.
    expectRefusal({ REALTIME_BROADCAST: 'memory' }, 'REALTIME_BROADCAST');
  });

  it('allows in-process fan-out when realtime is switched off entirely', () => {
    // Nothing to get wrong when there is no socket to feed, and failing the
    // boot over an unused setting would be a startup error with no cause.
    resetConfigCache();
    const config = loadConfig(
      productionEnv({ REALTIME_ENABLED: 'false', REALTIME_BROADCAST: 'memory' }),
    );
    expect(config.REALTIME_ENABLED).toBe(false);
  });

  it('requires a Redis URL for realtime broadcast', () => {
    expectRefusal({ REALTIME_BROADCAST: 'redis', REDIS_URL: '' }, 'REDIS_URL');
  });

  it('does not claim realtime is live when it is disabled', () => {
    resetConfigCache();
    const off = loadConfig(productionEnv({ REALTIME_ENABLED: 'false' }));
    expect(describeAdapters(off)).toContain('realtime=off');

    resetConfigCache();
    const on = loadConfig(productionEnv());
    expect(describeAdapters(on)).toContain('realtime=redis');
  });

  it('refuses SQLite', () => {
    expectRefusal({ DATABASE_URL: 'file:./dev.db' }, 'DATABASE_URL');
  });
});

describe('DEV_EXPOSE_OTP is refused in production', () => {
  it('refuses when true', () => {
    expectRefusal({ DEV_EXPOSE_OTP: 'true' }, 'DEV_EXPOSE_OTP');
  });

  it('refuses when set to 1', () => {
    expectRefusal({ DEV_EXPOSE_OTP: '1' }, 'DEV_EXPOSE_OTP');
  });

  it('allows it outside production', () => {
    resetConfigCache();
    const config = loadConfig({
      ...productionEnv({ DEV_EXPOSE_OTP: 'true' }),
      NODE_ENV: 'development',
      DATABASE_URL: 'file:./dev.db',
      // SQLite cannot answer an ST_Contains, so the zone adapter comes back
      // with it. The guard that enforces this pairing runs in every
      // environment, which is why it applies here.
      GEO_ZONES_PROVIDER: 'local',
      // Likewise the Paystack rules: a live key and the go-live switch are
      // refused outside production, so a development environment carries the
      // test key.
      PAYSTACK_SECRET_KEY: FAKE_TEST_KEY,
      PAYSTACK_ALLOW_LIVE: 'false',
    });
    expect(config.DEV_EXPOSE_OTP).toBe(true);
  });
});

describe('the per-destination OTP resend cooldown', () => {
  it('refuses a cooldown under 30 seconds in production', () => {
    expectRefusal({ OTP_RESEND_COOLDOWN_SECONDS: '0' }, 'OTP_RESEND_COOLDOWN_SECONDS');
    expectRefusal({ OTP_RESEND_COOLDOWN_SECONDS: '29' }, 'OTP_RESEND_COOLDOWN_SECONDS');
  });

  it('defaults to a minute and five codes an hour', () => {
    resetConfigCache();
    const config = loadConfig(productionEnv());
    expect(config.OTP_RESEND_COOLDOWN_SECONDS).toBe(60);
    expect(config.OTP_MAX_CODES_PER_HOUR).toBe(5);
  });
});

describe('development secrets are refused in production', () => {
  it('refuses the .env.example placeholder', () => {
    expectRefusal(
      { JWT_ACCESS_SECRET: 'replace-me-with-48-random-bytes-access-padding-x' },
      'JWT_ACCESS_SECRET',
    );
  });

  it('refuses a secret containing "changeme"', () => {
    expectRefusal(
      { JWT_REFRESH_SECRET: 'changeme-abcdefghijklmnopqrstuvwxyz0123456789' },
      'JWT_REFRESH_SECRET',
    );
  });

  it('refuses a secret containing "password"', () => {
    expectRefusal(
      { JWT_ACCESS_SECRET: 'password-abcdefghijklmnopqrstuvwxyz0123456789xy' },
      'JWT_ACCESS_SECRET',
    );
  });

  it('refuses a long but low-entropy secret', () => {
    // 48 characters and worthless. A length check alone waves this through,
    // which is exactly why the guard counts distinct characters.
    expectRefusal({ JWT_ACCESS_SECRET: 'a'.repeat(48) }, 'distinct characters');
  });

  it('refuses a repeating pattern that passes a length check', () => {
    expectRefusal({ JWT_REFRESH_SECRET: 'abcabcabc'.repeat(6) }, 'distinct characters');
  });

  it('refuses identical access and refresh secrets', () => {
    // If one secret signed both classes, a refresh token would verify as an
    // access token — a full authentication bypass.
    const shared = 'gJ7xQ2mV9wL4pR8sT1uY6zA3bC5dE0fH-shared-KnMqPrSt';
    expectRefusal(
      { JWT_ACCESS_SECRET: shared, JWT_REFRESH_SECRET: shared },
      'JWT_REFRESH_SECRET',
    );
  });

  it('refuses identical secrets even outside production', () => {
    // This one is not production-gated: a shared secret is a bypass everywhere,
    // and finding it in development is how you avoid shipping it.
    resetConfigCache();
    const shared = 'gJ7xQ2mV9wL4pR8sT1uY6zA3bC5dE0fH-shared-KnMqPrSt';
    expect(() =>
      loadConfig({
        NODE_ENV: 'development',
        DATABASE_URL: 'file:./dev.db',
        JWT_ACCESS_SECRET: shared,
        JWT_REFRESH_SECRET: shared,
      }),
    ).toThrow(/JWT_REFRESH_SECRET/);
  });

  it('accepts a genuinely random secret', () => {
    resetConfigCache();
    const config = loadConfig(
      productionEnv({
        JWT_ACCESS_SECRET: 'k9Xm2Qp7Rt4Vw8Zb1Nc5Hj3Lf6Yg0Ds-aVbNmQwErTyUi',
        JWT_REFRESH_SECRET: 'Pq3Wz8Rx1Ty6Ui4Op9As2Df7Gh5Jk0Lm-zXcVbNmQwErT',
      }),
    );
    expect(config.JWT_ACCESS_SECRET).not.toBe(config.JWT_REFRESH_SECRET);
  });
});

describe('a fresh copy of .env.example', () => {
  /** The committed template, read the way a copied .env is: KEY=value lines, comments ignored. */
  function templateEnv(): NodeJS.ProcessEnv {
    const text = readFileSync(fileURLToPath(new URL('../../../../.env.example', import.meta.url)), 'utf8');
    const env: NodeJS.ProcessEnv = {};
    for (const line of text.split(/\r?\n/)) {
      const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
      if (match) env[match[1]!] = match[2]!.replace(/^"(.*)"$/, '$1');
    }
    return env;
  }

  it('boots after its one documented step — its empty optional values mean "not set"', () => {
    // Regression: `S3_BUCKET=` and `S3_ENDPOINT=` were parsed as supplied
    // empty strings, failed their format checks, and the API refused to start
    // from the template people are told to copy.
    //
    // The one step the template requires is generating ENCRYPTION_KEY: its
    // placeholder is deliberately invalid so nobody runs on a shared key.
    // This does that step, the way .env.example says to, and nothing else.
    resetConfigCache();
    const config = loadConfig({ ...templateEnv(), ENCRYPTION_KEY: randomBytes(32).toString('base64') });
    expect(config.S3_BUCKET).toBeUndefined();
    expect(config.S3_ENDPOINT).toBeUndefined();
  });

  it('still refuses a required value left empty, as missing', () => {
    resetConfigCache();
    expect(() =>
      loadConfig({ ...templateEnv(), ENCRYPTION_KEY: randomBytes(32).toString('base64'), JWT_ACCESS_SECRET: '' }),
    ).toThrow(/JWT_ACCESS_SECRET/);
  });
});

describe('Brevo email', () => {
  // Assembled from parts so no scanner mistakes a fixture for a leaked key.
  const FAKE_BREVO_KEY = ['xkeysib', 'notarealkey'.repeat(4)].join('-');
  const brevo = { EMAIL_PROVIDER: 'brevo', BREVO_API_KEY: FAKE_BREVO_KEY };

  it('is a valid production email provider — SES is not needed', () => {
    const env = productionEnv(brevo);
    delete env['SES_REGION'];
    const config = loadConfig(env);
    expect(config.EMAIL_PROVIDER).toBe('brevo');
    expect(config.SES_REGION).toBeUndefined();
  });

  it('refuses a missing or malformed key, and a missing sender', () => {
    expectRefusal({ ...brevo, BREVO_API_KEY: '' }, 'BREVO_API_KEY');
    expectRefusal({ ...brevo, BREVO_API_KEY: 'not-a-brevo-key' }, 'BREVO_API_KEY');
    expectRefusal({ ...brevo, EMAIL_FROM_ADDRESS: '' }, 'EMAIL_FROM_ADDRESS');
  });

  it('is checked outside production too', () => {
    resetConfigCache();
    expect(() =>
      loadConfig({
        NODE_ENV: 'development',
        DATABASE_URL: 'file:./dev.db',
        JWT_ACCESS_SECRET: 'a'.repeat(40),
        JWT_REFRESH_SECRET: 'b'.repeat(40),
        EMAIL_PROVIDER: 'brevo',
      }),
    ).toThrow(/BREVO_API_KEY/);
  });
});

describe('required provider credentials', () => {
  it('refuses Paystack without a secret key', () => {
    expectRefusal({ PAYSTACK_SECRET_KEY: '' }, 'PAYSTACK_SECRET_KEY');
  });

  it('refuses a webhook secret that differs from the secret key', () => {
    // Paystack signs webhooks with the secret key itself. A separate value
    // could only disagree with it, and then every genuine event is rejected
    // and paid orders never place. Empty (the default) is correct.
    expectRefusal({ PAYSTACK_WEBHOOK_SECRET: 'something-else' }, 'PAYSTACK_WEBHOOK_SECRET');
    expect(() => loadConfig(productionEnv({ PAYSTACK_WEBHOOK_SECRET: '' }))).not.toThrow();
  });

  it('refuses a key that is not shaped like a Paystack secret key', () => {
    for (const key of ['sk', 'pk_live_' + 'x'.repeat(20), 'sk_live_not_a_real_key']) {
      expectRefusal({ PAYSTACK_SECRET_KEY: key }, 'PAYSTACK_SECRET_KEY');
    }
  });

  it('refuses a live key without the explicit go-live switch', () => {
    expectRefusal({ PAYSTACK_ALLOW_LIVE: 'false' }, 'PAYSTACK_SECRET_KEY');
  });

  it('accepts the test key in production without the switch', () => {
    // Staging runs NODE_ENV=production on test keys.
    const config = loadConfig(productionEnv({ PAYSTACK_SECRET_KEY: FAKE_TEST_KEY, PAYSTACK_ALLOW_LIVE: 'false' }));
    expect(config.PAYSTACK_SECRET_KEY).toBe(FAKE_TEST_KEY);
  });

  it('refuses a live key outside production, even with the switch', () => {
    // The switch itself is refused outside production, so a developer cannot
    // turn a pasted live key into real charges.
    for (const allowLive of ['true', 'false']) {
      resetConfigCache();
      expect(() =>
        loadConfig({
          NODE_ENV: 'development',
          DATABASE_URL: 'file:./dev.db',
          JWT_ACCESS_SECRET: 'a'.repeat(40),
          JWT_REFRESH_SECRET: 'b'.repeat(40),
          PAYMENT_PROVIDER: 'paystack',
          PAYSTACK_SECRET_KEY: FAKE_LIVE_KEY,
          PAYSTACK_ALLOW_LIVE: allowLive,
        }),
      ).toThrow(/PAYSTACK_/);
    }
  });

  it('refuses Redis without a URL', () => {
    expectRefusal({ REDIS_URL: '' }, 'REDIS_URL');
  });

  it('refuses Google maps without an API key', () => {
    expectRefusal({ GOOGLE_MAPS_API_KEY: '' }, 'GOOGLE_MAPS_API_KEY');
  });

  it('refuses Mapbox without a token', () => {
    expectRefusal({ MAPS_PROVIDER: 'mapbox', MAPBOX_ACCESS_TOKEN: '' }, 'MAPBOX_ACCESS_TOKEN');
  });
});

describe('transport', () => {
  it('refuses a plain-HTTP public URL in production', () => {
    // The refresh cookie is issued Secure, so a browser will not store it over
    // http://. Catching it here turns "login silently does nothing" into a
    // startup error that names the cause.
    expectRefusal({ PUBLIC_WEB_URL: 'http://dashapp.ng' }, 'PUBLIC_WEB_URL');
  });
});

describe('reporting', () => {
  it('names every problem at once, not just the first', () => {
    resetConfigCache();
    let message = '';
    try {
      loadConfig(
        productionEnv({
          DEV_EXPOSE_OTP: 'true',
          PAYMENT_PROVIDER: 'mock',
          QUEUE_PROVIDER: 'memory',
        }),
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    // Fixing one misconfiguration only to discover the next on the following
    // boot is a miserable loop. Report them together.
    expect(message).toContain('DEV_EXPOSE_OTP');
    expect(message).toContain('PAYMENT_PROVIDER');
    expect(message).toContain('QUEUE_PROVIDER');
  });

  it('never echoes a secret value into the error message', () => {
    resetConfigCache();
    const secret = 'a'.repeat(48);
    let message = '';
    try {
      loadConfig(productionEnv({ JWT_ACCESS_SECRET: secret }));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain('JWT_ACCESS_SECRET');
    expect(message).not.toContain(secret);
  });
});

describe('MFA and encryption configuration', () => {
  it('refuses production with MFA turned off', () => {
    // A single leaked staff password would otherwise reach the money.
    expectRefusal({ MFA_ENABLED: 'false' }, 'MFA_ENABLED');
  });

  it('refuses production with no encryption key', () => {
    resetConfigCache();
    const env = productionEnv();
    delete env['ENCRYPTION_KEY'];

    let message = '';
    try {
      loadConfig(env);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('ENCRYPTION_KEY');
  });

  it('refuses MFA enabled without a key in ANY environment', () => {
    // Not merely a production rule: MFA without a key is not "MFA off", it is
    // MFA that fails at enrolment, in front of a user.
    resetConfigCache();
    let message = '';
    try {
      loadConfig({
        NODE_ENV: 'development',
        DATABASE_URL: 'file:./dev.db',
        JWT_ACCESS_SECRET: 'gJ7xQ2mV9wL4pR8sT1uY6zA3bC5dE0fH-access-KnMqPrSt',
        JWT_REFRESH_SECRET: 'Zx4Vn8Bq2Wr6Ty0Ui3Op5As7Df9Gh1Jk-refresh-LmNoPqRs',
        MFA_ENABLED: 'true',
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('ENCRYPTION_KEY');
  });

  it('refuses a key that is not valid base64 of 32 bytes', () => {
    for (const bad of ['not-base64!!', 'c2hvcnQ=', '']) {
      resetConfigCache();
      let message = '';
      try {
        loadConfig(productionEnv({ ENCRYPTION_KEY: bad }));
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message, `key ${JSON.stringify(bad)}`).toContain('ENCRYPTION_KEY');
    }
  });

  it('refuses an all-zero key', () => {
    const zeroes = Buffer.alloc(32).toString('base64');
    expectRefusal({ ENCRYPTION_KEY: zeroes }, 'ENCRYPTION_KEY');
  });

  it('never echoes the key into the error message', () => {
    resetConfigCache();
    // Valid length, but paired with a fault elsewhere so the load fails.
    const key = Buffer.alloc(32, 7).toString('base64');
    let message = '';
    try {
      loadConfig(productionEnv({ ENCRYPTION_KEY: key, DEV_EXPOSE_OTP: 'true' }));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('DEV_EXPOSE_OTP');
    expect(message).not.toContain(key);
  });

  it('builds a keyring with the active key named', () => {
    resetConfigCache();
    const config = loadConfig(productionEnv({ ENCRYPTION_KEY_ID: 'live-1' }));
    const keyring = buildKeyring(config);

    expect(keyring.active.keyId).toBe('live-1');
    expect(keyring.active.key).toHaveLength(32);
    expect(keyring.retired).toHaveLength(0);
  });

  it('carries retired keys so rotation does not need a migration', () => {
    const older = Buffer.alloc(32, 3).toString('base64');
    resetConfigCache();
    const config = loadConfig(
      productionEnv({ ENCRYPTION_KEY_ID: 'k2', ENCRYPTION_KEYS_RETIRED: `k1:${older}` }),
    );
    const keyring = buildKeyring(config);

    expect(keyring.active.keyId).toBe('k2');
    expect(keyring.retired.map((entry) => entry.keyId)).toEqual(['k1']);
  });

  it('rejects a retired key list with a duplicate id', () => {
    const a = Buffer.alloc(32, 3).toString('base64');
    const b = Buffer.alloc(32, 4).toString('base64');
    expect(() => parseRetiredKeys(`k1:${a},k1:${b}`)).toThrow(/more than once/);
  });

  it('rejects a malformed retired key entry', () => {
    expectRefusal({ ENCRYPTION_KEYS_RETIRED: 'no-colon-here' }, 'ENCRYPTION_KEYS_RETIRED');
  });

  it('refuses a retired entry that duplicates the active key id', () => {
    // This used to load, dropping the retired entry on the grounds that the
    // active one should win. Milestone III refuses it instead, because the two
    // entries hold *different* key material — that is what a half-applied
    // rotation looks like — and picking one silently makes every row written
    // under the other unreadable, with no error anywhere. Nothing in the
    // configuration can say which of the two rotation steps was skipped, so it
    // does not guess.
    const older = Buffer.alloc(32, 5).toString('base64');
    expectRefusal(
      { ENCRYPTION_KEY_ID: 'k1', ENCRYPTION_KEYS_RETIRED: `k1:${older}` },
      'ENCRYPTION_KEYS_RETIRED',
    );
  });

  it('refuses a key id the envelope format could not carry', () => {
    // The envelope is dot-separated, so an id containing a dot is written into
    // ciphertext that can never be parsed back out. The value encrypts fine and
    // is then permanently unreadable, which is the worst failure mode available
    // — nothing complains until a decrypt, and by then the rows exist.
    expectRefusal({ ENCRYPTION_KEY_ID: 'live.1' }, 'ENCRYPTION_KEY_ID');
  });
});

// ---------------------------------------------------------------------------
// Milestone II: the PostgreSQL and Redis production path.
//
// Each of these is a way to reach production with the new infrastructure only
// half-wired — the failure mode being that everything appears to work while a
// security control is quietly absent or a query is silently slower.
// ---------------------------------------------------------------------------

describe('the PostgreSQL and Redis production path', () => {
  it('refuses per-process rate-limit counters in production', () => {
    // Without Redis, each instance keeps its own counters, so the real limit is
    // the configured one multiplied by the instance count. Ten pods means ten
    // times the login attempts before anyone is throttled.
    expectRefusal({ RATE_LIMIT_REDIS: 'false' }, 'RATE_LIMIT_REDIS');
  });

  it('refuses the in-process zone adapter in production', () => {
    expectRefusal({ GEO_ZONES_PROVIDER: 'local' }, 'GEO_ZONES_PROVIDER');
  });

  it('refuses Redis-backed rate limiting with nowhere to keep the counters', () => {
    expectRefusal({ REDIS_URL: '' }, 'REDIS_URL');
  });

  it('refuses PostGIS against a SQLite database', () => {
    // The guard runs in every environment, not just production — a
    // misconfiguration that only surfaces in production is one staging never
    // rehearsed.
    resetConfigCache();
    let message = '';
    try {
      loadConfig({
        NODE_ENV: 'development',
        DATABASE_URL: 'file:./dev.db',
        JWT_ACCESS_SECRET: 'gJ7xQ2mV9wL4pR8sT1uY6zA3bC5dE0fH-access-KnMqPrSt',
        JWT_REFRESH_SECRET: 'Zx4Vn8Bq2Wr6Ty0Ui3Op5As7Df9Gh1Jk-refresh-LmNoPqRs',
        ENCRYPTION_KEY: 'YpTt1KNH1JtX0eaiUaPNFWHApAQl8BggrrhxcNgy604=',
        GEO_ZONES_PROVIDER: 'postgis',
      });
      throw new Error('Expected the configuration to be refused, but it loaded.');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('GEO_ZONES_PROVIDER');
  });

  it('accepts the local zone adapter against SQLite in development', () => {
    resetConfigCache();
    const config = loadConfig({
      NODE_ENV: 'development',
      DATABASE_URL: 'file:./dev.db',
      JWT_ACCESS_SECRET: 'gJ7xQ2mV9wL4pR8sT1uY6zA3bC5dE0fH-access-KnMqPrSt',
      JWT_REFRESH_SECRET: 'Zx4Vn8Bq2Wr6Ty0Ui3Op5As7Df9Gh1Jk-refresh-LmNoPqRs',
      ENCRYPTION_KEY: 'YpTt1KNH1JtX0eaiUaPNFWHApAQl8BggrrhxcNgy604=',
    });
    // The development default is unchanged by this milestone: SQLite, the
    // in-process zone adapter, the in-memory queue, and local rate limiting.
    expect(config.GEO_ZONES_PROVIDER).toBe('local');
    expect(config.QUEUE_PROVIDER).toBe('memory');
    expect(config.RATE_LIMIT_REDIS).toBe(false);
  });

  it('still refuses SQLite in production', () => {
    expectRefusal({ DATABASE_URL: 'file:./dev.db' }, 'DATABASE_URL');
  });

  it('never echoes a Redis URL or a database password in a refusal', () => {
    resetConfigCache();
    let message = '';
    try {
      loadConfig(
        productionEnv({
          RATE_LIMIT_REDIS: 'false',
          REDIS_URL: 'redis://:sup3rs3cret@cache.internal:6379',
          DATABASE_URL: 'postgresql://dash:hunter2@db.internal:5432/dash',
        }),
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain('sup3rs3cret');
    expect(message).not.toContain('hunter2');
  });
});
