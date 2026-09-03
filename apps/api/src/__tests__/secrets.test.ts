/**
 * Secret material must not be able to leave the process.
 *
 * The design rule these tests enforce: **a leak test that names one example
 * proves nothing about the example beside it.** So wherever it is possible,
 * these iterate `SECRET_VARIABLES` rather than asserting a hand-picked name.
 * Classifying a new secret variable therefore extends this suite automatically,
 * and forgetting to classify one is itself caught by the first block below.
 *
 * Four exit routes are covered, because those are the four ways a value that
 * only ever lived in `process.env` has actually reached a third party in
 * systems like this one:
 *
 *   1. The configuration error thrown at boot and printed to stderr.
 *   2. The request and boot logs.
 *   3. The unauthenticated readiness endpoint.
 *   4. The payload handed to an error tracker or a metrics backend.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isSensitiveKey, redactSecretsInText } from '@dash/domain/redaction';
import {
  ALL_VARIABLES,
  ANTICIPATED_SECRET_VARIABLES,
  CREDENTIAL_URL_VARIABLE_NAMES,
  PUBLIC_VARIABLES,
  presentSecretValues,
  SECRET_VARIABLES,
  SECRET_VARIABLE_NAMES,
} from '../secrets/classification.js';
import { buildErrorSerializer, buildLogMethodHook, LOG_REDACT_PATHS } from '../secrets/logging.js';
import { loadConfig, resetConfigCache } from '../config.js';
import {
  describeError,
  RecordingErrorReporter,
  RecordingMetrics,
  safeTags,
  scrubForExport,
} from '../observability/index.js';
import { createTestContext, type TestContext } from './harness.js';
import { useIntegrationTimeouts } from './timeouts.js';

// Real Fastify, real SQLite, real round trips — see timeouts.ts.
useIntegrationTimeouts();

/**
 * A distinctive value per secret variable.
 *
 * Long, random-looking, and unique per variable so an assertion cannot pass by
 * accident because the value happened to be a substring of something else.
 * Every one is invented for this file and unlocks nothing.
 */
function syntheticValue(name: string): string {
  return `SYNTH-${name}-8f3a1c7d9b2e4506`;
}

beforeEach(() => {
  resetConfigCache();
});

// ---------------------------------------------------------------------------
// The classification table itself
// ---------------------------------------------------------------------------

describe('configuration classification', () => {
  it('classifies every secret variable as a name the redaction vocabulary catches', () => {
    // This is the join that keeps two lists honest. Classifying a variable as
    // secret while the redaction vocabulary does not recognise its name would
    // mean it is documented as protected and is not.
    for (const name of SECRET_VARIABLE_NAMES) {
      expect(isSensitiveKey(name), `${name} is classified secret but redaction misses it`).toBe(
        true,
      );
    }
  });

  it('does not redact anything classified public', () => {
    // The inverse failure: a redaction pass so wide it swallows the fields that
    // make a log readable is a redaction pass someone turns off.
    for (const variable of PUBLIC_VARIABLES) {
      expect(isSensitiveKey(variable.name), `${variable.name} is public but is redacted`).toBe(
        false,
      );
    }
  });

  it('classifies each variable exactly once', () => {
    const names = ALL_VARIABLES.map((variable) => variable.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('marks connection-string variables as carrying an embedded credential', () => {
    // These need the text scrubber as well as name matching: the password lives
    // inside a longer string that a driver interpolates into its own errors.
    expect(CREDENTIAL_URL_VARIABLE_NAMES).toContain('DATABASE_URL');
    expect(CREDENTIAL_URL_VARIABLE_NAMES).toContain('REDIS_URL');
  });

  it('is honest that anticipated provider credentials are not read by any code', () => {
    // Milestone III protects these; it does not integrate the providers. The
    // wording matters — a reader must not take their presence for an
    // integration that exists.
    for (const variable of ANTICIPATED_SECRET_VARIABLES) {
      expect(variable.purpose, variable.name).toContain('Not yet read by any code');
    }
  });

  it('collects the secret values actually present, and only those', () => {
    const values = presentSecretValues({
      JWT_ACCESS_SECRET: syntheticValue('JWT_ACCESS_SECRET'),
      PAYSTACK_SECRET_KEY: '',
      NODE_ENV: 'production',
    });

    expect(values).toContain(syntheticValue('JWT_ACCESS_SECRET'));
    // Empty values would turn into a no-op replacement; public ones are not
    // secrets and stripping them would corrupt messages for no gain.
    expect(values).not.toContain('');
    expect(values).not.toContain('production');
  });

  it('collects each retired key individually, not just the whole variable', () => {
    // An error that echoed one entry rather than the entire comma-separated
    // value would slip past a whole-value match.
    const first = Buffer.alloc(32, 11).toString('base64');
    const second = Buffer.alloc(32, 12).toString('base64');

    const values = presentSecretValues({
      ENCRYPTION_KEYS_RETIRED: `k1:${first},k2:${second}`,
    });

    expect(values).toContain(first);
    expect(values).toContain(second);
  });
});

// ---------------------------------------------------------------------------
// 1. Configuration errors
// ---------------------------------------------------------------------------

describe('a refused configuration never echoes a secret', () => {
  /**
   * A production environment carrying a synthetic value for every secret,
   * and one deliberate fault so the load always fails.
   */
  function environmentWithEverySecret(fault: Record<string, string>): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: 'production',
      DATABASE_URL: `postgresql://dash_runtime:${syntheticValue('DATABASE_URL')}@db.internal:5432/dash`,
      JWT_ACCESS_SECRET: syntheticValue('JWT_ACCESS_SECRET'),
      JWT_REFRESH_SECRET: syntheticValue('JWT_REFRESH_SECRET'),
      PUBLIC_WEB_URL: 'https://dashapp.ng',
      PAYMENT_PROVIDER: 'paystack',
      PAYSTACK_SECRET_KEY: syntheticValue('PAYSTACK_SECRET_KEY'),
      PAYSTACK_WEBHOOK_SECRET: syntheticValue('PAYSTACK_WEBHOOK_SECRET'),
      MAPS_PROVIDER: 'google',
      GOOGLE_MAPS_API_KEY: syntheticValue('GOOGLE_MAPS_API_KEY'),
      MAPBOX_ACCESS_TOKEN: syntheticValue('MAPBOX_ACCESS_TOKEN'),
      SMS_PROVIDER: 'termii',
      EMAIL_PROVIDER: 'smtp',
      PUSH_PROVIDER: 'fcm',
      STORAGE_PROVIDER: 's3',
      QUEUE_PROVIDER: 'redis',
      REDIS_URL: `redis://:${syntheticValue('REDIS_URL')}@cache.internal:6379`,
      RATE_LIMIT_REDIS: 'true',
      GEO_ZONES_PROVIDER: 'postgis',
      ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
      ...fault,
    };
    return env;
  }

  function refusalMessage(fault: Record<string, string>): string {
    resetConfigCache();
    try {
      loadConfig(environmentWithEverySecret(fault));
      throw new Error('Expected the configuration to be refused, but it loaded.');
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  it('names the variable that failed', () => {
    expect(refusalMessage({ DEV_EXPOSE_OTP: 'true' })).toContain('DEV_EXPOSE_OTP');
  });

  it('leaks no secret value, whichever variable caused the refusal', () => {
    // Iterating the faults matters as much as iterating the secrets: a message
    // assembled by one `superRefine` branch may interpolate what another does
    // not, and asserting against a single fault would only ever exercise one.
    const faults: Record<string, string>[] = [
      { DEV_EXPOSE_OTP: 'true' },
      { MFA_ENABLED: 'false' },
      { RATE_LIMIT_ENABLED: 'false' },
      { PAYMENT_PROVIDER: 'mock' },
      { STORAGE_PROVIDER: 'local' },
      { PUBLIC_WEB_URL: 'http://dashapp.ng' },
      { DATABASE_URL: 'file:./dev.db' },
      { ENCRYPTION_KEY: 'not-valid-key-material' },
      { ENCRYPTION_KEY_ID: 'has.a.dot' },
      { ENCRYPTION_KEYS_RETIRED: 'malformed-entry' },
      { API_PORT: 'not-a-number' },
    ];

    for (const fault of faults) {
      const message = refusalMessage(fault);
      const label = JSON.stringify(fault);

      for (const name of SECRET_VARIABLE_NAMES) {
        expect(message, `${label} leaked ${name}`).not.toContain(syntheticValue(name));
      }
    }
  });

  it('leaks no database or Redis password even when those variables are the fault', () => {
    const message = refusalMessage({ GEO_ZONES_PROVIDER: 'local' });

    expect(message).not.toContain(syntheticValue('DATABASE_URL'));
    expect(message).not.toContain(syntheticValue('REDIS_URL'));
  });

  it('leaks no encryption key material when the key itself is rejected', () => {
    // Valid length so it survives the base64 check, paired with a fault
    // elsewhere so the load still fails with the key present.
    const key = Buffer.alloc(32, 7).toString('base64');
    resetConfigCache();

    let message = '';
    try {
      loadConfig(environmentWithEverySecret({ ENCRYPTION_KEY: key, DEV_EXPOSE_OTP: 'true' }));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain('DEV_EXPOSE_OTP');
    expect(message).not.toContain(key);
  });

  it('leaks no retired key material', () => {
    const retired = Buffer.alloc(32, 21).toString('base64');
    const message = refusalMessage({
      ENCRYPTION_KEYS_RETIRED: `k0:${retired}`,
      DEV_EXPOSE_OTP: 'true',
    });

    expect(message).toContain('DEV_EXPOSE_OTP');
    expect(message).not.toContain(retired);
  });
});

// ---------------------------------------------------------------------------
// 2. The logger
// ---------------------------------------------------------------------------

describe('the logger', () => {
  const knownSecrets = SECRET_VARIABLE_NAMES.map(syntheticValue);

  it('censors every path it claims to censor', () => {
    // Guards against the list being edited into a shape Pino silently ignores.
    for (const path of LOG_REDACT_PATHS) {
      expect(path, `${path} is not a req/res path`).toMatch(/^(req|res)\./);
    }
    expect(LOG_REDACT_PATHS).toContain('req.headers.authorization');
    expect(LOG_REDACT_PATHS).toContain('req.headers.cookie');
    expect(LOG_REDACT_PATHS).toContain('res.headers["set-cookie"]');
  });

  it('strips a connection string from a serialized error message', () => {
    // The case no `redact.paths` entry can reach, and the one a driver
    // produces without being asked.
    const serialize = buildErrorSerializer(knownSecrets);
    const serialized = serialize(
      new Error("Can't reach database server at postgresql://dash:hunter2@db.internal:5432/dash"),
    );

    expect(serialized.message).not.toContain('hunter2');
    // The host survives, because an error that says only "[redacted]" is
    // useless to whoever is paged.
    expect(serialized.message).toContain('db.internal:5432');
  });

  it('strips a connection string from a stack, not only a message', () => {
    const serialize = buildErrorSerializer(knownSecrets);
    const error = new Error('connect failed');
    error.stack = 'Error: connect failed\n  at redis://:letmein@cache:6379';

    expect(serialize(error).stack).not.toContain('letmein');
  });

  it('follows an error cause chain', () => {
    // The underlying connection failure is almost always the cause, not the
    // wrapper — a serializer that stops at the top level misses every one.
    const serialize = buildErrorSerializer(knownSecrets);
    const serialized = serialize(
      new Error('query failed', {
        cause: new Error('auth to postgresql://dash:deepsecret@db:5432 rejected'),
      }),
    );

    expect(JSON.stringify(serialized)).not.toContain('deepsecret');
  });

  it('strips a known secret value from an error message', () => {
    const serialize = buildErrorSerializer(knownSecrets);
    const serialized = serialize(
      new Error(`signature check used ${syntheticValue('PAYSTACK_WEBHOOK_SECRET')}`),
    );

    expect(serialized.message).not.toContain(syntheticValue('PAYSTACK_WEBHOOK_SECRET'));
  });

  it('always produces the shape Pino requires', () => {
    const serialize = buildErrorSerializer(knownSecrets);
    const fromNonError = serialize('a bare string was thrown');

    expect(typeof fromNonError.type).toBe('string');
    expect(typeof fromNonError.message).toBe('string');
    expect(typeof fromNonError.stack).toBe('string');
  });

  it('scrubs the message argument passed to a log call', () => {
    const hook = buildLogMethodHook(knownSecrets);
    const received: unknown[] = [];
    const method = (...args: unknown[]): void => void received.push(...args);

    hook.call(null, ['connecting to redis://:swordfish@cache:6379'], method);

    expect(String(received[0])).not.toContain('swordfish');
  });

  it('scrubs strings nested in the merging object', () => {
    const hook = buildLogMethodHook(knownSecrets);
    const received: unknown[] = [];
    const method = (...args: unknown[]): void => void received.push(...args);

    hook.call(
      null,
      [{ checks: [{ name: 'database', detail: 'postgresql://dash:nested-pw@db:5432' }] }, 'failed'],
      method,
    );

    expect(JSON.stringify(received)).not.toContain('nested-pw');
  });
});

describe('the real server logger', () => {
  let context: TestContext;
  let written: string[];

  beforeEach(async () => {
    written = [];
    context = await createTestContext(
      // Not `silent`: the point is to make the logger actually write, then read
      // what it wrote. A suite that asserts nothing leaked from a logger that
      // emitted nothing is not a test.
      { LOG_LEVEL: 'info' },
      {},
      { write: (chunk: string) => void written.push(chunk) },
    );
  });

  afterEach(async () => {
    await context.close();
  });

  it('writes something, so the assertions below mean something', async () => {
    context.app.log.info({ route: '/v1/orders' }, 'a routine line');
    expect(written.join('')).toContain('a routine line');
  });

  it('does not write a database or Redis password given one to log', () => {
    context.app.log.error(
      { err: new Error('connect failed for postgresql://dash:live-pw@db.internal:5432/dash') },
      'dependency failure',
    );
    context.app.log.warn('retrying redis://:cache-pw@cache.internal:6379');

    const output = written.join('');
    expect(output).not.toContain('live-pw');
    expect(output).not.toContain('cache-pw');
  });

  it('does not write the configured JWT or encryption secrets', () => {
    // The values the harness actually loaded, not invented ones — so this fails
    // if the wiring between config and the logger is ever cut.
    context.app.log.info(
      { supplied: context.config.JWT_ACCESS_SECRET, key: context.config.ENCRYPTION_KEY },
      'a handler logged its configuration by mistake',
    );

    const output = written.join('');
    expect(output).not.toContain(context.config.JWT_ACCESS_SECRET);
    expect(output).not.toContain(context.config.ENCRYPTION_KEY ?? 'no-key-configured');
  });

  it('censors an Authorization header on a real request', async () => {
    await context.app.inject({
      method: 'GET',
      url: '/health',
      headers: { authorization: 'Bearer a-token-that-must-not-be-logged' },
    });

    expect(written.join('')).not.toContain('a-token-that-must-not-be-logged');
  });

  it('applies the same rules to a child logger', () => {
    // Fastify gives every request its own child. A hook that only covered the
    // root logger would leave the busiest logger in the system unprotected.
    context.app.log
      .child({ requestId: 'req-1' })
      .error('child wrote postgresql://dash:child-pw@db:5432');

    expect(written.join('')).not.toContain('child-pw');
  });

  // --- Review finding 4: redaction by key name ------------------------------
  //
  // Every value below is unique to this file. None is in the environment, none
  // is a known-secret literal, and none sits at a path in LOG_REDACT_PATHS. So
  // the only thing that can protect them is the shared `isSensitiveKey`
  // vocabulary applied to the log object — which the hook did not do.
  //
  // Before that was added, each of these was printed in full.

  const UNIQUE = {
    paystackSecretKey: 'unique-paystack-9f2c4a7e1b60d3',
    apiKey: 'unique-apikey-3d81f5c0a94e2b',
    databaseUrl: 'unique-dburl-77ac1e39b5d840',
    authorizationHeader: 'unique-authz-5b0e2f6c8a1739',
    nested: 'unique-nested-c4a9017de62f5b',
  };

  it('redacts a secret-shaped key whose value is in no config and no known-secret list', () => {
    context.app.log.info(
      {
        paystackSecretKey: UNIQUE.paystackSecretKey,
        apiKey: UNIQUE.apiKey,
        databaseUrl: UNIQUE.databaseUrl,
        authorizationHeader: UNIQUE.authorizationHeader,
      },
      'a handler logged a credential it had just been handed',
    );

    const output = written.join('');
    expect(output).toContain('a handler logged a credential');

    for (const [key, value] of Object.entries(UNIQUE)) {
      if (key === 'nested') continue;
      expect(output, `${key} was printed in full`).not.toContain(value);
    }
  });

  it('redacts a secret-shaped key nested inside an ordinary object', () => {
    context.app.log.warn(
      {
        vendorId: 'vendor_123',
        integration: { provider: 'paystack', config: { apiKey: UNIQUE.nested } },
      },
      'nested credential',
    );

    const output = written.join('');
    expect(output).not.toContain(UNIQUE.nested);
    // The diagnostic fields around it survive — a redaction pass that swallows
    // everything is one people turn off.
    expect(output).toContain('vendor_123');
    expect(output).toContain('paystack');
  });

  it('redacts inside an array of objects', () => {
    context.app.log.info(
      { integrations: [{ name: 'a', apiKey: 'array-secret-0d5f8b2c7e' }] },
      'array credential',
    );

    expect(written.join('')).not.toContain('array-secret-0d5f8b2c7e');
  });

  it('leaves the fields that make a log readable alone', () => {
    context.app.log.info(
      {
        requestId: 'req-abc',
        orderCode: 'DASH-XYZ789',
        route: '/v1/orders',
        statusCode: 200,
        keyId: 'k2',
        // Contains "token" but holds a number of seconds.
        accessTokenTtlSeconds: 900,
      },
      'routine',
    );

    const output = written.join('');
    for (const value of ['req-abc', 'DASH-XYZ789', '/v1/orders', '200', 'k2', '900']) {
      expect(output, `${value} was redacted but should not be`).toContain(value);
    }
  });

  it('still serializes an Error through the error serializer', () => {
    // The hook must not rebuild an Error as a plain object: doing so would
    // strip the non-enumerable message and stack, and silently disable the
    // serializer that scrubs them.
    context.app.log.error(
      { err: new Error('boom at postgresql://dash:err-pw@db:5432/dash') },
      'error path',
    );

    const output = written.join('');
    expect(output).not.toContain('err-pw');
    // The message survived, so the serializer genuinely ran.
    expect(output).toContain('boom at postgresql://');
    expect(output).toContain('"type":"Error"');
  });


  // --- Review finding 2: the depth cap must fail closed ---------------------
  //
  // The cap used to be the first test in the walk and returned the value
  // untouched, so anything nested past it was printed exactly as supplied.
  // Every value here is unique to this file, in no configuration and on no
  // known-secret list, so the *only* thing that can protect it is the walk.

  /** Nest a payload `levels` deep under plain wrapper objects. */
  function nest(levels: number, payload: Record<string, unknown>): Record<string, unknown> {
    let current: Record<string, unknown> = payload;
    for (let index = 0; index < levels; index += 1) current = { level: current };
    return current;
  }

  it('redacts a secret-shaped key nested deeper than the depth cap', () => {
    context.app.log.info(nest(10, { apiKey: 'deep-apikey-4f19c7a2e05b83' }), 'deep credential');

    expect(written.join('')).not.toContain('deep-apikey-4f19c7a2e05b83');
  });

  it('scrubs a credentialed Redis URL nested deeper than the depth cap', () => {
    // A string, not a key name — so this is the primitive-before-cap half of
    // the fix rather than the redact-the-subtree half.
    context.app.log.warn(
      nest(12, { target: 'redis://:deep-redis-pw-7c31@cache.internal:6379' }),
      'deep redis url',
    );

    expect(written.join('')).not.toContain('deep-redis-pw-7c31');
  });

  it('scrubs a credentialed Postgres URL nested deeper than the depth cap', () => {
    context.app.log.error(
      nest(9, { detail: 'connect failed for postgresql://dash:deep-pg-pw-9b04@db.internal:5432/d' }),
      'deep postgres url',
    );

    expect(written.join('')).not.toContain('deep-pg-pw-9b04');
  });

  it('redacts inside a deep array as well as a deep object', () => {
    context.app.log.info(
      nest(8, { items: [{ apiKey: 'deep-array-apikey-6d20fa' }] }),
      'deep array credential',
    );

    expect(written.join('')).not.toContain('deep-array-apikey-6d20fa');
  });

  it('still emits shallow diagnostic fields', () => {
    // The cap must not be so eager that ordinary logs stop being readable.
    context.app.log.info({ route: '/v1/orders', orderCode: 'DASH-DEEP-1' }, 'shallow');

    const output = written.join('');
    expect(output).toContain('/v1/orders');
    expect(output).toContain('DASH-DEEP-1');
  });

  // --- Review finding 3: serializer bypass only where a serializer exists ----
  //
  // `req`, `res`, and `err` are exempt from the walk because Pino and Fastify
  // serialize them. That exemption used to apply at every nesting level, so an
  // ordinary object with a field named `req` skipped the scrub entirely. And
  // `error` was on the exempt list while no `error` serializer is configured at
  // all — an exemption from the only protection it had.

  it('sanitizes a nested key named req', () => {
    context.app.log.info(
      { wrapper: { req: { apiKey: 'nested-req-apikey-1a7f30' } } },
      'nested req bypass',
    );

    expect(written.join('')).not.toContain('nested-req-apikey-1a7f30');
  });

  it('sanitizes a nested key named err', () => {
    context.app.log.info(
      { wrapper: { err: { apiKey: 'nested-err-apikey-2b8e41' } } },
      'nested err bypass',
    );

    expect(written.join('')).not.toContain('nested-err-apikey-2b8e41');
  });

  it('sanitizes a nested key named res', () => {
    context.app.log.info(
      { wrapper: { res: { apiKey: 'nested-res-apikey-3c9f52' } } },
      'nested res bypass',
    );

    expect(written.join('')).not.toContain('nested-res-apikey-3c9f52');
  });

  it('sanitizes a top-level plain object named error, which no serializer owns', () => {
    // server.ts installs `serializers: { err: ... }` and nothing else. Treating
    // a plain `error` field as serializer-owned exempted it from the walk and
    // handed it to no serializer at all.
    context.app.log.info(
      { error: { apiKey: 'toplevel-error-apikey-4d0a63' } },
      'plain error object',
    );

    expect(written.join('')).not.toContain('toplevel-error-apikey-4d0a63');
  });

  it('sanitizes a nested credentialed URL under a req-named key', () => {
    context.app.log.warn(
      { wrapper: { req: { target: 'redis://:nested-req-pw-5e1b74@cache:6379' } } },
      'nested req url',
    );

    expect(written.join('')).not.toContain('nested-req-pw-5e1b74');
  });

  it('still serializes a real top-level Error through the err serializer', () => {
    context.app.log.error(
      { err: new Error('boom at postgresql://dash:real-err-pw@db:5432/dash') },
      'real error',
    );

    const output = written.join('');
    expect(output).not.toContain('real-err-pw');
    // The serializer ran: its shape survived, and the message is still useful.
    expect(output).toContain('"type":"Error"');
    expect(output).toContain('boom at postgresql://');
  });

  it('still serializes a real top-level Fastify request', async () => {
    await context.app.inject({
      method: 'GET',
      url: '/health',
      headers: { authorization: 'Bearer root-req-serializer-check-9f' },
    });

    expect(written.join('')).not.toContain('root-req-serializer-check-9f');
  });

  it('still serializes a real request through Pino, with headers censored', async () => {
    // Fastify hands Pino the raw IncomingMessage. If the hook copied it into a
    // plain object, the standard serializer would produce something else and
    // the header redaction paths would no longer match anything.
    await context.app.inject({
      method: 'GET',
      url: '/health',
      headers: {
        authorization: 'Bearer serializer-check-token-8a3f',
        cookie: 'refresh=serializer-check-cookie-11b7',
      },
    });

    const output = written.join('');
    expect(output).not.toContain('serializer-check-token-8a3f');
    expect(output).not.toContain('serializer-check-cookie-11b7');
  });

});

// ---------------------------------------------------------------------------
// 3. Readiness
// ---------------------------------------------------------------------------

describe('the readiness endpoint', () => {
  let context: TestContext;

  beforeEach(async () => {
    context = await createTestContext();
  });

  afterEach(async () => {
    await context.close();
  });

  it('discloses no secret value, for any classified secret', async () => {
    const response = await context.app.inject({ method: 'GET', url: '/health/ready' });
    const body = response.body;

    for (const variable of SECRET_VARIABLES) {
      const value = (context.config as unknown as Record<string, unknown>)[variable.name];
      if (typeof value !== 'string' || value === '') continue;
      expect(body, `readiness leaked ${variable.name}`).not.toContain(value);
    }
  });

  it('discloses no secret even when a dependency is down', async () => {
    // The failure path is where a reason string would be tempting, and a
    // database error message names hosts and sometimes credentials.
    await context.prisma.$disconnect();
    const response = await context.app.inject({ method: 'GET', url: '/health/ready' });

    expect(response.body).not.toContain(context.config.DATABASE_URL);
  });
});

// ---------------------------------------------------------------------------
// 4. The error-tracker and metrics seams
// ---------------------------------------------------------------------------

describe('what would reach a third party', () => {
  it('redacts secret-shaped field names an exact-match list would miss', () => {
    const scrubbed = scrubForExport({
      jwtAccessSecret: 'a',
      paystackSecretKey: 'b',
      databaseUrl: 'c',
      redisUrl: 'd',
      googleMapsApiKey: 'e',
      authorizationHeader: 'f',
      orderCode: 'DASH-ABC123',
    }) as Record<string, unknown>;

    for (const key of [
      'jwtAccessSecret',
      'paystackSecretKey',
      'databaseUrl',
      'redisUrl',
      'googleMapsApiKey',
      'authorizationHeader',
    ]) {
      expect(scrubbed[key], `${key} was not redacted`).toBe('[redacted]');
    }

    expect(scrubbed['orderCode']).toBe('DASH-ABC123');
  });

  it('scrubs a credential embedded in a reported error message', () => {
    const described = describeError(
      new Error('failed against postgresql://dash:tracker-pw@db:5432/dash'),
      true,
    );

    expect(described.message).not.toContain('tracker-pw');
  });

  it('scrubs a known secret from a reported error', () => {
    const secret = syntheticValue('JWT_ACCESS_SECRET');
    const reporter = new RecordingErrorReporter(false, [secret]);

    reporter.report(new Error(`token signed with ${secret}`), { requestId: 'r1' });

    expect(JSON.stringify(reporter.reports)).not.toContain(secret);
  });

  // --- Review finding 4: a benign tag NAME does not make the VALUE safe ------
  //
  // `safeTags` rejected sensitive key names, then rendered the value with no
  // inspection at all. A tag called `target` is unremarkable, well under the
  // length cap, and can carry a Redis password. Console metrics go out through
  // `console.warn`, not Pino, so nothing downstream would have caught it.

  it('drops a benign tag whose value is a credentialed Redis URL', () => {
    const tags = safeTags({ route: '/v1/orders', target: 'redis://:metric-pw-8a2c@cache:6379' });

    expect(tags['target']).toBeUndefined();
    expect(tags['route']).toBe('/v1/orders');
  });

  it('drops a benign tag whose value is a credentialed Postgres URL', () => {
    const tags = safeTags({ db: 'postgresql://dash:metric-pg-3f7d@db:5432/dash' });

    expect(tags['db']).toBeUndefined();
  });

  it('drops a benign tag carrying a configured secret literal', () => {
    // Shorter than MAX_TAG_LENGTH, so the length rule cannot save it, and the
    // key name is innocuous, so the name rule cannot either.
    const secret = 'metric-jwt-literal-51c9';
    const tags = safeTags({ provider: secret, route: '/v1/auth' }, [secret]);

    expect(tags['provider']).toBeUndefined();
    expect(tags['route']).toBe('/v1/auth');
  });

  it('keeps ordinary route, provider, and status tags', () => {
    const tags = safeTags({
      route: '/v1/orders/:id',
      provider: 'paystack',
      status: 500,
      code: undefined as unknown as string,
    });

    expect(tags['route']).toBe('/v1/orders/:id');
    expect(tags['provider']).toBe('paystack');
    expect(tags['status']).toBe('500');
  });

  it('drops rather than redacting, so a credential never becomes a dimension', () => {
    // A redacted string is still a time series. Dropping is the right trade:
    // the dimension is worthless once its value was a credential.
    const tags = safeTags({ target: 'redis://:metric-pw-8a2c@cache:6379' });

    expect(Object.keys(tags)).toHaveLength(0);
    expect(JSON.stringify(tags)).not.toContain('[redacted]');
  });

  it('the recording metrics adapter applies the same rules end to end', () => {
    const secret = 'metric-adapter-secret-77b1';
    const metrics = new RecordingMetrics([secret]);

    metrics.increment('http.response', {
      route: '/v1/orders',
      target: 'redis://:adapter-pw-4e6a@cache:6379',
      provider: secret,
    });

    const event = metrics.events[0]!;
    expect(event.tags['route']).toBe('/v1/orders');
    expect(event.tags['target']).toBeUndefined();
    expect(event.tags['provider']).toBeUndefined();
    expect(JSON.stringify(metrics.events)).not.toContain('adapter-pw-4e6a');
    expect(JSON.stringify(metrics.events)).not.toContain(secret);
  });

  it('drops a secret-shaped metric tag under any spelling', () => {
    const tags = safeTags({
      route: '/v1/orders',
      apiKey: 'x',
      jwtAccessSecret: 'y',
      databaseUrl: 'z',
    });

    expect(tags['route']).toBe('/v1/orders');
    expect(tags['apiKey']).toBeUndefined();
    expect(tags['jwtAccessSecret']).toBeUndefined();
    expect(tags['databaseUrl']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The scrubber's own limits, stated rather than assumed
// ---------------------------------------------------------------------------

describe('what the text scrubber does and does not promise', () => {
  it('leaves a value it was never told about and that has no URL shape', () => {
    // Stated so nobody reads the suite above as a claim that any string
    // anywhere is safe. The name-based layer and the classification table are
    // what cover this case; the text scrubber is for embedded credentials and
    // for values the caller declared.
    const scrubbed = redactSecretsInText('the token is abcdef123456', []);
    expect(scrubbed).toContain('abcdef123456');
  });
});
