/**
 * Deployment profiles.
 *
 * The blocker these exist for: a Declutters-only production deployment could
 * not boot. The guards refused a mock payment provider, a local geo adapter and
 * console SMS and push — correctly, because each silently does nothing while
 * claiming to charge a card or send a code — but the marketplace has none of
 * those features, so it would have had to be handed Paystack keys and a maps
 * key for functions it never calls.
 *
 * The fix must not be a relaxation. Three groups below, and the middle one is
 * the important one:
 *
 *   1. A Declutters production configuration boots with RDS, Redis, S3 and SES
 *      and nothing else.
 *   2. **A disabled capability cannot perform a fake action.** Not a mock, not
 *      a console stub, not a silent no-op — it throws, and its routes are gone.
 *   3. The full DASH APP profile still refuses every mock provider, unchanged.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { CLOSE } from '@dash/domain/realtime';
import { createTestContext, type TestContext } from './harness.js';
import { useIntegrationTimeouts } from './timeouts.js';
import { seedLegalDocuments } from '@dash/db';
import { loadConfig, resetConfigCache } from '../config.js';
import {
  capabilitiesFor,
  CapabilityDisabledError,
  hasCapability,
  isDeploymentProfile,
} from '../deployment/profile.js';
import {
  DisabledExportArchiveAdapter,
  DisabledMapsGeoAdapter,
  DisabledPaymentAdapter,
  DisabledPushAdapter,
  DisabledSmsAdapter,
} from '../adapters/disabled.js';

useIntegrationTimeouts();

/**
 * A production environment with real infrastructure and nothing pretend.
 *
 * RDS, Redis, S3 and SES. No Paystack key, no maps key, no SMS provider, no
 * FCM credential — because a Declutters deployment calls none of them.
 */
const DECLUTTERS_PRODUCTION = {
  NODE_ENV: 'production',
  DEPLOYMENT_PROFILE: 'declutters',

  DATABASE_URL: 'postgresql://dashadmin:pw@dash-db.eu-west-1.rds.amazonaws.com:5432/dashdb',
  REDIS_URL: 'redis://127.0.0.1:6379',
  RATE_LIMIT_ENABLED: 'true',
  RATE_LIMIT_REDIS: 'true',
  GEO_ZONES_PROVIDER: 'postgis',

  STORAGE_PROVIDER: 's3',
  S3_BUCKET: 'dash-declutters-prod-media',
  S3_REGION: 'eu-west-1',

  EMAIL_PROVIDER: 'ses',
  SES_REGION: 'eu-west-1',
  EMAIL_FROM_ADDRESS: 'no-reply@notify.dashworldng.com',
  EMAIL_REPLY_TO: 'admin@dashworldng.com',

  // Deliberately the values the full profile refuses.
  PAYMENT_PROVIDER: 'mock',
  MAPS_PROVIDER: 'local',
  SMS_PROVIDER: 'console',
  PUSH_PROVIDER: 'console',

  JWT_ACCESS_SECRET: 'Xq7#mP2$vL9!wR4^tY6&zB8*nK1@jH3%cF5',
  JWT_REFRESH_SECRET: 'Bd4!kM8@pW2#hL6$nQ9^rT3&vY7*xZ1%gJ5',
  ENCRYPTION_KEY: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
  // Production refuses the in-memory queue: it loses jobs on restart and
  // cannot be shared across instances. The marketplace uses the same Redis.
  QUEUE_PROVIDER: 'redis',
  PUBLIC_WEB_URL: 'https://declutters.dashworldng.com',
  // Deliberately *not* setting REALTIME_ENABLED or REALTIME_BROADCAST. Production
  // refuses in-process fan-out, and both default to "realtime on, in memory" — so
  // if the capability did not switch realtime off, this fixture would be refused
  // at boot. It is the same shape of problem as the four mock providers, and the
  // earlier version of this fixture hid it by setting REALTIME_ENABLED=false by
  // hand, which is exactly the "configure a feature you do not run" tax the
  // profile exists to remove.
} as const;

function load(overrides: Record<string, string> = {}) {
  resetConfigCache();
  return loadConfig({ ...DECLUTTERS_PRODUCTION, ...overrides });
}

function expectRefusal(overrides: Record<string, string>, mustMention: string) {
  resetConfigCache();
  try {
    loadConfig({ ...DECLUTTERS_PRODUCTION, ...overrides });
    throw new Error(`Expected a refusal mentioning ${mustMention}`);
  } catch (error) {
    expect((error as Error).message, mustMention).toContain(mustMention);
  }
}

// ---------------------------------------------------------------------------
// 1. The Declutters profile boots
// ---------------------------------------------------------------------------

describe('a Declutters production configuration', () => {
  it('boots with RDS, Redis, S3 and SES and nothing pretend', () => {
    const config = load();
    expect(config.DEPLOYMENT_PROFILE).toBe('declutters');
    expect(config.STORAGE_PROVIDER).toBe('s3');
    expect(config.EMAIL_PROVIDER).toBe('ses');
  });

  it('needs no Paystack key, no maps key, no SMS provider and no FCM credential', () => {
    // The blocker, stated as a test. None of these is configured and the
    // configuration is still valid, because the marketplace calls none of them.
    const config = load();
    expect(config.PAYMENT_PROVIDER).toBe('mock');
    expect(config.MAPS_PROVIDER).toBe('local');
    expect(config.SMS_PROVIDER).toBe('console');
    expect(config.PUSH_PROVIDER).toBe('console');
  });

  it('still refuses a console email adapter', () => {
    // Email is a capability the marketplace *has*, so its guard still applies.
    expectRefusal({ EMAIL_PROVIDER: 'console' }, 'EMAIL_PROVIDER');
  });

  it('still refuses local disk storage', () => {
    expectRefusal({ STORAGE_PROVIDER: 'local' }, 'STORAGE_PROVIDER');
  });

  it('still refuses SQLite', () => {
    expectRefusal({ DATABASE_URL: 'file:./dev.db' }, 'DATABASE_URL');
  });

  it('still refuses per-process rate limiting', () => {
    expectRefusal({ RATE_LIMIT_REDIS: '' }, 'RATE_LIMIT_REDIS');
  });

  it('still refuses a disabled rate limiter and a weak secret', () => {
    expectRefusal({ RATE_LIMIT_ENABLED: 'false' }, 'RATE_LIMIT_ENABLED');
    expectRefusal({ JWT_ACCESS_SECRET: 'development-secret' }, 'JWT_ACCESS_SECRET');
  });

  it('still requires SES to be fully configured', () => {
    expectRefusal({ SES_REGION: '' }, 'SES_REGION');
    expectRefusal({ EMAIL_FROM_ADDRESS: '' }, 'EMAIL_FROM_ADDRESS');
    expectRefusal({ EMAIL_REPLY_TO: '' }, 'EMAIL_REPLY_TO');
  });

  it('boots without being told anything about realtime', () => {
    // The regression this guards. `REALTIME_ENABLED` defaults to true and
    // `REALTIME_BROADCAST` defaults to memory, which production refuses — so
    // before realtime was a capability, a Declutters deployment following the
    // runbook was refused at boot over a variable the runbook never mentioned.
    const config = load();
    expect(config.REALTIME_BROADCAST).toBe('memory');
    expect(capabilitiesFor(config.DEPLOYMENT_PROFILE).has('realtime')).toBe(false);
  });

  it('cannot be talked into in-process fan-out by setting the flag', () => {
    // Boot is permitted, because the guard is about a capability this profile
    // does not have. What must then be true is that no socket is actually served
    // — proved against a running server below, not inferred from here.
    expect(() => load({ REALTIME_ENABLED: 'true' })).not.toThrow();
  });

  it('still requires the bucket and region', () => {
    expectRefusal({ S3_BUCKET: '' }, 'S3_BUCKET');
    expectRefusal({ S3_REGION: '' }, 'S3_REGION');
  });
});

// ---------------------------------------------------------------------------
// 3. The full profile is unchanged
// ---------------------------------------------------------------------------

describe('the full DASH APP profile still refuses every mock provider', () => {
  const FULL = { ...DECLUTTERS_PRODUCTION, DEPLOYMENT_PROFILE: 'full' };

  function expectFullRefusal(overrides: Record<string, string>, mustMention: string) {
    resetConfigCache();
    try {
      loadConfig({ ...FULL, ...overrides });
      throw new Error(`Expected a refusal mentioning ${mustMention}`);
    } catch (error) {
      expect((error as Error).message, mustMention).toContain(mustMention);
    }
  }

  it('refuses the mock payment provider', () => {
    expectFullRefusal({}, 'PAYMENT_PROVIDER');
  });

  it('refuses the local geo adapter', () => {
    expectFullRefusal({ PAYMENT_PROVIDER: 'paystack', PAYSTACK_SECRET_KEY: 'sk', PAYSTACK_WEBHOOK_SECRET: 'wh' }, 'MAPS_PROVIDER');
  });

  it('refuses the console SMS and push adapters', () => {
    expectFullRefusal({}, 'SMS_PROVIDER');
    expectFullRefusal({}, 'PUSH_PROVIDER');
  });

  it('still refuses in-process realtime fan-out', () => {
    // The guard is now capability-scoped like the other four, so this is the
    // assertion that scoping it did not switch it off for DASH APP. Realtime
    // defaults to on, broadcasting in memory, which in production means most
    // clients silently never get notified.
    expectFullRefusal({}, 'REALTIME_BROADCAST');
  });

  it('is the default when no profile is named', () => {
    // A deployment that forgets to declare itself gets the strictest checks.
    resetConfigCache();
    const { DEPLOYMENT_PROFILE: _omitted, ...withoutProfile } = FULL;
    expect(() => loadConfig(withoutProfile)).toThrow(/PAYMENT_PROVIDER/);
  });
});

// ---------------------------------------------------------------------------
// The capability table
// ---------------------------------------------------------------------------

describe('the capability table', () => {
  it('gives the full profile everything', () => {
    for (const capability of ['payments', 'sms', 'push', 'maps', 'delivery', 'dataExport', 'email', 'storage', 'realtime'] as const) {
      expect(hasCapability('full', capability), capability).toBe(true);
    }
  });

  it('gives Declutters only email and storage', () => {
    expect([...capabilitiesFor('declutters')].sort()).toEqual(['email', 'storage']);
  });

  it('does not give Declutters realtime, because no topic kind is its own', () => {
    // Every topic the protocol accepts is `order`, `vendor`, `rider` or `city`.
    // A Declutters socket could only ever carry notifications about deliveries
    // this deployment does not make.
    expect(hasCapability('declutters', 'realtime')).toBe(false);
    expect(hasCapability('full', 'realtime')).toBe(true);
  });

  it('keeps email and storage in both, because both products need them', () => {
    for (const profile of ['full', 'declutters'] as const) {
      expect(hasCapability(profile, 'email'), profile).toBe(true);
      expect(hasCapability(profile, 'storage'), profile).toBe(true);
    }
  });

  it('recognises only the two profiles', () => {
    expect(isDeploymentProfile('full')).toBe(true);
    expect(isDeploymentProfile('declutters')).toBe(true);
    expect(isDeploymentProfile('lite')).toBe(false);
    expect(isDeploymentProfile('')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. A disabled capability cannot fake anything
// ---------------------------------------------------------------------------

describe('a disabled adapter refuses rather than pretending', () => {
  it('reports itself as not live before anybody calls it', () => {
    for (const adapter of [
      new DisabledPaymentAdapter(),
      new DisabledSmsAdapter(),
      new DisabledPushAdapter(),
      new DisabledExportArchiveAdapter(),
    ]) {
      expect(adapter.isLive).toBe(false);
      expect(adapter.providerName).toBe('disabled');
    }
  });

  it('never reports a successful charge', async () => {
    // The failure the strict guard existed to prevent. Leaving the *mock*
    // adapter wired would have reproduced it exactly.
    const payments = new DisabledPaymentAdapter();
    await expect(payments.initialize()).rejects.toBeInstanceOf(CapabilityDisabledError);
    await expect(payments.verify()).rejects.toBeInstanceOf(CapabilityDisabledError);
    await expect(payments.refund()).rejects.toBeInstanceOf(CapabilityDisabledError);
  });

  it('treats every payment webhook as unverified', () => {
    // Null already means "did not verify, act on nothing", which is exactly
    // right for a deployment that takes no payments.
    expect(new DisabledPaymentAdapter().parseWebhook()).toBeNull();
  });

  it('never claims to have sent an SMS or a push', async () => {
    await expect(new DisabledSmsAdapter().send()).rejects.toBeInstanceOf(CapabilityDisabledError);
    await expect(new DisabledPushAdapter().send()).rejects.toBeInstanceOf(CapabilityDisabledError);
  });

  it('never produces a data export that would be lost on redeploy', async () => {
    const archive = new DisabledExportArchiveAdapter();
    await expect(archive.write()).rejects.toBeInstanceOf(CapabilityDisabledError);
    await expect(archive.read()).rejects.toBeInstanceOf(CapabilityDisabledError);
  });

  it('refuses to geocode or route, but still answers zone containment', async () => {
    // PostGIS answers containment from the database, so it needs no maps
    // provider. Routing and geocoding are the parts that need a third party.
    const geo = new DisabledMapsGeoAdapter({
      zonesContaining: async () => ['zone-1'],
    });

    await expect(geo.geocode()).rejects.toBeInstanceOf(CapabilityDisabledError);
    await expect(geo.reverseGeocode()).rejects.toBeInstanceOf(CapabilityDisabledError);
    await expect(
      geo.route({ latitude: 6.4, longitude: 3.4 }, { latitude: 6.5, longitude: 3.5 }),
    ).rejects.toBeInstanceOf(CapabilityDisabledError);

    expect(await geo.zonesContaining({ latitude: 6.4, longitude: 3.4 }, 'city-1')).toEqual([
      'zone-1',
    ]);
  });

  it('says which capability, and that nothing happened', () => {
    const error = new CapabilityDisabledError('payments');
    expect(error.capability).toBe('payments');
    expect(error.message).toContain('Nothing was done');
    // A wiring error should read as one, so it is investigated rather than
    // retried.
    expect(error.message).toContain('wiring error');
  });
});

// ---------------------------------------------------------------------------
// 2b. The routes are actually gone
// ---------------------------------------------------------------------------

describe('routes for a disabled capability are not mounted', () => {
  let declutters: TestContext;

  beforeAll(async () => {
    declutters = await createTestContext({ DEPLOYMENT_PROFILE: 'declutters' });
    // The legal endpoint serves a row; without the documents it would answer
    // 404 for a reason that has nothing to do with capabilities.
    await seedLegalDocuments(declutters.prisma);
  }, 180_000);

  afterAll(async () => {
    await declutters?.close();
  });

  async function status(method: 'GET' | 'POST', url: string) {
    const response = await declutters.app.inject({ method, url, payload: {} });
    return response.statusCode;
  }

  it('answers 404 for orders, not 401 or 500', async () => {
    // 404 because the endpoint genuinely does not exist. A 401 would imply that
    // signing in would let somebody place an order this deployment cannot
    // fulfil.
    expect(await status('POST', '/v1/orders')).toBe(404);
    expect(await status('GET', '/v1/orders')).toBe(404);
  });

  it('answers 404 for the vendor catalogue and the rider app', async () => {
    expect(await status('GET', '/v1/vendors')).toBe(404);
    expect(await status('GET', '/v1/rider/offers')).toBe(404);
  });

  it('answers 404 for the payment webhook', async () => {
    // An endpoint accepting payment notifications a deployment cannot act on is
    // an invitation.
    expect(await status('POST', '/v1/webhooks/paystack')).toBe(404);
  });

  it('answers 404 for device registration', async () => {
    expect(await status('POST', '/v1/devices')).toBe(404);
  });

  it('answers 404 for a data export', async () => {
    expect(await status('POST', '/v1/account/export')).toBe(404);
  });

  it('still serves everything the marketplace needs', async () => {
    // The other half of the claim: switching capabilities off must not have
    // switched off the product.
    expect(await status('GET', '/v1/declutter/taxonomy')).toBe(200);
    expect(await status('GET', '/v1/declutter/listings')).toBe(200);
    expect(await status('GET', '/v1/legal/terms-of-service')).toBe(200);
    expect(await status('GET', '/health/ready')).toBe(200);
    // Unauthenticated, so 401 rather than 404: the endpoint exists.
    expect(await status('GET', '/v1/auth/me')).toBe(401);
  });

  it('accepts no realtime socket, even with the flag forced on', async () => {
    // The other half of the config test above. Boot is permitted with
    // `REALTIME_ENABLED=true` because the guard is about a capability this
    // profile does not have — so what has to be true is that nothing is actually
    // served. If the capability were ignored here, this deployment would fan out
    // in process: sockets on one instance notified, every other client silently
    // never told, and no guard left to object.
    const forced = await createTestContext({
      DEPLOYMENT_PROFILE: 'declutters',
      REALTIME_ENABLED: 'true',
    });
    try {
      await forced.app.listen({ port: 0, host: '127.0.0.1' });
      const address = forced.app.server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/realtime`);
      const closed = await new Promise<number>((resolve, reject) => {
        socket.on('close', (code: number) => resolve(code));
        socket.once('error', reject);
      });
      expect(closed).toBe(CLOSE.disabled);
    } finally {
      await forced.close();
    }
  }, 180_000);

  it('refuses a phone code cleanly instead of throwing', async () => {
    // SMS is off, so this must not reach the disabled adapter and produce a
    // 500. The email channel is the one this deployment supports.
    const response = await declutters.app.inject({
      method: 'POST',
      url: '/v1/auth/otp/request',
      payload: { phone: '+2348030000001' },
    });
    expect(response.statusCode).toBeLessThan(500);
  });
});

// ---------------------------------------------------------------------------

describe('the full profile still mounts everything', () => {
  let full: TestContext;

  beforeAll(async () => {
    full = await createTestContext({ DEPLOYMENT_PROFILE: 'full' });
  }, 180_000);

  afterAll(async () => {
    await full?.close();
  });

  it('mounts orders, vendors, the rider app and devices', async () => {
    for (const url of ['/v1/orders', '/v1/vendors', '/v1/rider/offers']) {
      const response = await full.app.inject({ method: 'GET', url });
      // Anything but 404: the route exists, whatever it decides about auth.
      expect(response.statusCode, url).not.toBe(404);
    }

    // `/v1/devices` is POST-only, so a GET would be a 404 for the wrong reason.
    const devices = await full.app.inject({ method: 'POST', url: '/v1/devices', payload: {} });
    expect(devices.statusCode).not.toBe(404);
  });
});
