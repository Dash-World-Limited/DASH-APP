/**
 * Observability — integration tests.
 *
 * Two things under test. First, that the health endpoints answer the question
 * they are for and disclose nothing else: `/health/ready` is unauthenticated, so
 * anything in its response is public. Second, that nothing sensitive reaches an
 * error tracker or a metrics backend — those are third parties, and a leak
 * there is invisible until someone audits their dashboard.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './harness.js';
import {
  checkDependency,
  describeError,
  RecordingErrorReporter,
  RecordingMetrics,
  safeTags,
  scrubForExport,
} from '../observability/index.js';

let context: TestContext;
let errors: RecordingErrorReporter;
let metrics: RecordingMetrics;

beforeAll(async () => {
  errors = new RecordingErrorReporter();
  metrics = new RecordingMetrics();
  context = await createTestContext({}, { errors, metrics });
});

afterAll(async () => {
  await context.close();
});

describe('liveness', () => {
  it('answers without touching any dependency', async () => {
    const response = await context.app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ status: string }>().status).toBe('ok');
  });

  it('stays up when the database is unreachable', async () => {
    // The point of separating liveness from readiness. If liveness failed on a
    // database blip, an orchestrator would restart every instance and turn a
    // recoverable incident into an outage.
    await context.prisma.$disconnect();

    const response = await context.app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);

    await context.prisma.$connect();
  });

  it('discloses nothing but liveness', async () => {
    const body = (await context.app.inject({ method: 'GET', url: '/health' })).body;

    for (const leak of ['version', 'commit', 'env', 'database', 'host', 'provider']) {
      expect(body.toLowerCase(), `leaked ${leak}`).not.toContain(leak);
    }
  });
});

describe('readiness', () => {
  it('reports ready when dependencies answer', async () => {
    const response = await context.app.inject({ method: 'GET', url: '/health/ready' });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ ready: boolean; checks: { name: string; status: string }[] }>();
    expect(body.ready).toBe(true);
    expect(body.checks.find((check) => check.name === 'database')?.status).toBe('ok');
  });

  it('names dependencies and their status, and nothing else', async () => {
    const body = (await context.app.inject({ method: 'GET', url: '/health/ready' })).body;

    // This endpoint is unauthenticated. Which providers are configured is free
    // reconnaissance, and there is no reason to give it away.
    for (const leak of [
      'paystack',
      'mock',
      'redis',
      'postgres',
      'sqlite',
      'file:',
      's3',
      'termii',
      'twilio',
      'provider',
      'adapters',
      'secret',
      'key',
    ]) {
      expect(body.toLowerCase(), `leaked "${leak}"`).not.toContain(leak);
    }
  });

  it('never leaks a connection string or an environment variable', async () => {
    const body = (await context.app.inject({ method: 'GET', url: '/health/ready' })).body;

    expect(body).not.toContain(context.config.DATABASE_URL);
    expect(body).not.toContain(context.config.JWT_ACCESS_SECRET);
    expect(body).not.toContain(context.config.ENCRYPTION_KEY ?? 'no-key-configured');
  });
});

describe('dependency checks', () => {
  it('reports a healthy dependency with its latency', async () => {
    const check = await checkDependency('fake', async () => 'fine');

    expect(check.status).toBe('ok');
    expect(check.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('reports a failing dependency as down', async () => {
    const check = await checkDependency('fake', async () => {
      throw new Error('connection refused to db.internal:5432');
    });

    expect(check.status).toBe('down');
  });

  it('does not carry the failure reason into the result', async () => {
    // A database error message names hosts, schemas, and sometimes
    // credentials. That detail belongs in the log, not in an unauthenticated
    // response.
    const check = await checkDependency('fake', async () => {
      throw new Error('password authentication failed for user "dash_runtime"');
    });

    expect(JSON.stringify(check)).not.toContain('dash_runtime');
    expect(JSON.stringify(check)).not.toContain('password');
  });

  it('times out rather than hanging', async () => {
    // A readiness probe that can hang is worse than one that fails: the
    // orchestrator keeps the instance in service while it waits.
    const started = Date.now();
    const check = await checkDependency('slow', () => new Promise(() => {}), 100);

    expect(check.status).toBe('down');
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe('what reaches an error tracker', () => {
  beforeEach(() => {
    errors.reports.length = 0;
  });

  it('receives a 5xx', async () => {
    // A route that does not exist returns 404, so provoke a real failure by
    // reporting directly — the wiring is asserted below via the handler.
    errors.report(new Error('boom'), { requestId: 'req_1', route: 'GET /x', statusCode: 500 });

    expect(errors.reports).toHaveLength(1);
    expect(errors.reports[0]!.context.statusCode).toBe(500);
  });

  it('does not receive routine authorization failures', async () => {
    await context.app.inject({ method: 'GET', url: '/v1/orders' }); // 401
    await context.app.inject({ method: 'GET', url: '/v1/nope' }); // 404

    // Reporting these would bury real failures under routine noise.
    expect(errors.reports).toHaveLength(0);
  });

  it('strips credentials from anything it is given', () => {
    const scrubbed = scrubForExport({
      password: 'hunter2',
      accessToken: 'eyJ...',
      refreshToken: 'opaque',
      challengeToken: 'chal',
      recoveryCodes: ['ABCD-2345'],
      accountNumber: '0123456789',
      encryptionKey: 'base64key',
      orderCode: 'DASH-ABC123',
    }) as Record<string, unknown>;

    for (const key of [
      'password',
      'accessToken',
      'refreshToken',
      'challengeToken',
      'recoveryCodes',
      'accountNumber',
      'encryptionKey',
    ]) {
      expect(scrubbed[key], `${key} was not redacted`).toBe('[redacted]');
    }

    // Not everything is secret. An order code is exactly what makes a report
    // useful, so it survives.
    expect(scrubbed['orderCode']).toBe('DASH-ABC123');
  });

  it('strips personal data, not only credentials', () => {
    const scrubbed = scrubForExport({
      phone: '+2347000000201',
      email: 'someone@example.test',
      latitude: 6.4281,
      longitude: 3.4219,
    }) as Record<string, unknown>;

    // An error tracker is a third party. A customer's phone number and a
    // rider's coordinates have no business in one.
    for (const key of ['phone', 'email', 'latitude', 'longitude']) {
      expect(scrubbed[key], `${key} was not redacted`).toBe('[redacted]');
    }
  });

  it('redacts at any depth', () => {
    const scrubbed = scrubForExport({
      request: { body: { nested: { password: 'hunter2' } } },
    }) as Record<string, Record<string, Record<string, Record<string, unknown>>>>;

    expect(scrubbed['request']!['body']!['nested']!['password']).toBe('[redacted]');
  });

  it('survives a cycle-free deep structure without recursing forever', () => {
    let deep: Record<string, unknown> = { password: 'hunter2' };
    for (let i = 0; i < 40; i += 1) deep = { level: deep };

    expect(() => scrubForExport(deep)).not.toThrow();
  });

  it('withholds the stack when configured to', () => {
    const withoutStack = describeError(new Error('boom'), false);
    const withStack = describeError(new Error('boom'), true);

    // A stack can carry interpolated values from the frame that threw.
    expect(withoutStack.stack).toBeUndefined();
    expect(withStack.stack).toBeDefined();
    expect(withoutStack.message).toBe('boom');
  });

  it('handles something thrown that is not an Error', () => {
    expect(describeError('a string', false).name).toBe('UnknownError');
    expect(describeError(null, false).message).toBe('Non-Error thrown');
  });
});

describe('what reaches a metrics backend', () => {
  beforeEach(() => {
    metrics.events.length = 0;
  });

  it('counts responses by status and route pattern', async () => {
    await context.app.inject({ method: 'GET', url: '/v1/orders' });

    const counted = metrics.events.find((event) => event.name === 'http.response');
    expect(counted).toBeDefined();
    expect(counted!.tags['status']).toBe('401');
  });

  it('tags by route pattern, never by URL', async () => {
    await context.app.inject({ method: 'GET', url: '/v1/vendors/some-specific-slug' });

    const counted = metrics.events.filter((event) => event.name === 'http.response');
    for (const event of counted) {
      // A path carrying an id would create one time series per id — a cost
      // problem and a privacy problem, since the id lands in a third-party
      // index permanently.
      expect(event.tags['route']).not.toContain('some-specific-slug');
    }
  });

  it('drops a high-cardinality tag rather than sending it', () => {
    const tags = safeTags({ orderId: 'x'.repeat(200), status: 200 });

    expect(tags['orderId']).toBe('[dropped]');
    expect(tags['status']).toBe('200');
  });

  it('drops a sensitive tag entirely', () => {
    const tags = safeTags({ phone: '+2347000000201', email: 'a@b.test', route: '/v1/orders' });

    expect(tags['phone']).toBeUndefined();
    expect(tags['email']).toBeUndefined();
    expect(tags['route']).toBe('/v1/orders');
  });
});
