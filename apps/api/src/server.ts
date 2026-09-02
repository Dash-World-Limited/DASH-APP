/**
 * Fastify server assembly.
 *
 * Exported as a builder so tests can start an instance with substituted
 * adapters and no listening socket.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { randomUUID } from 'node:crypto';
import { prisma as defaultPrisma } from '@dash/db';
import {
  ConsoleEmailAdapter,
  ConsolePushAdapter,
  ConsoleSmsAdapter,
  LocalGeoAdapter,
  LocalExportArchiveAdapter,
  LocalStorageAdapter,
  MemoryQueueAdapter,
  MockPaymentAdapter,
} from './adapters/index.js';
import { PostgisGeoAdapter } from './adapters/postgis.js';
import { RedisQueueAdapter } from './adapters/redis-queue.js';
import { createQueueRedis, createRateLimitRedis, pingRedis } from './redis/client.js';
import { buildKeyring, isEncryptionConfigured, loadConfig, type Config } from './config.js';
import { registerContext, type Services } from './http/context.js';
import {
  checkDependency,
  ConsoleErrorReporter,
  ConsoleMetrics,
} from './observability/index.js';
import {
  buildErrorSerializer,
  buildLogMethodHook,
  knownSecretValues,
  LOG_REDACT_PATHS,
  REDACTED,
} from './secrets/logging.js';
import { assertCsrf, assertSecureCookieConfig, requiresCsrf } from './auth/cookies.js';
import { registerErrorHandler } from './http/errors.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerMfaRoutes } from './routes/mfa.js';
import { registerCatalogRoutes } from './routes/catalog.js';
import { registerOrderRoutes } from './routes/orders.js';
import { registerVendorRoutes } from './routes/vendor.js';
import { registerRiderRoutes } from './routes/rider.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerWebhookRoutes } from './routes/webhooks.js';
import { registerAccountRoutes } from './routes/account.js';
import { registerDispatchWorker } from './workers/dispatch.js';
import { registerAccountExportWorker } from './workers/account-export.js';

export interface BuildOptions {
  config?: Config;
  services?: Partial<Services>;
  /**
   * Where the logger writes.
   *
   * Exists so the secret-leak suite can assert against the *real* logger — the
   * same redact paths, the same `err` serializer, the same hook — rather than
   * rebuilding an approximation of this configuration in a test and proving
   * only that the approximation works. Unset everywhere else, which leaves
   * Pino's default destination untouched.
   */
  logDestination?: { write(chunk: string): void };
}

export function buildServices(config: Config, overrides: Partial<Services> = {}): Services {
  const prisma = overrides.prisma ?? defaultPrisma;
  // Passed to the error reporter so a secret that reached an error message by
  // some route no pattern matches is still stripped before it leaves.
  const knownSecrets = knownSecretValues(config as unknown as Record<string, unknown>);
  // A test run should not print a wall of fake SMS. `silent` is the level the
  // test harness sets, so it doubles as the signal here.
  const quiet = config.LOG_LEVEL === 'silent';

  return {
    config,
    // Built once at boot so a malformed key fails immediately rather than at
    // the first enrolment.
    keyring: overrides.keyring ?? (isEncryptionConfigured(config) ? buildKeyring(config) : null),
    prisma,
    payments: overrides.payments ?? new MockPaymentAdapter(),
    // PostGIS answers zone containment; everything else geo still comes from
    // the maps provider, which the PostGIS adapter wraps rather than replaces.
    geo:
      overrides.geo ??
      (config.GEO_ZONES_PROVIDER === 'postgis'
        ? new PostgisGeoAdapter(prisma, new LocalGeoAdapter(prisma))
        : new LocalGeoAdapter(prisma)),
    sms: overrides.sms ?? new ConsoleSmsAdapter(quiet),
    email: overrides.email ?? new ConsoleEmailAdapter(quiet),
    push: overrides.push ?? new ConsolePushAdapter(quiet),
    storage: overrides.storage ?? new LocalStorageAdapter(config.STORAGE_LOCAL_DIR),
    exportArchive:
      overrides.exportArchive ?? new LocalExportArchiveAdapter(config.STORAGE_LOCAL_DIR),
    queue:
      overrides.queue ??
      (config.QUEUE_PROVIDER === 'redis' && config.REDIS_URL
        ? new RedisQueueAdapter(createQueueRedis(config.REDIS_URL))
        : new MemoryQueueAdapter()),
    // Stacks are withheld in production: a stack can carry interpolated values
    // from the frame that threw, and those are exactly what must not travel to
    // a third party.
    errors:
      overrides.errors ??
      new ConsoleErrorReporter(config.NODE_ENV !== 'production', quiet, knownSecrets),
    metrics: overrides.metrics ?? new ConsoleMetrics(quiet, knownSecrets),
  };
}

export async function buildServer(options: BuildOptions = {}): Promise<FastifyInstance> {
  const config = options.config ?? loadConfig();
  const services = buildServices(config, options.services ?? {});

  // Captured once. The values do not change while the process runs, and
  // re-reading them per log line would be both slow and a second place secret
  // material is handled.
  const knownSecrets = knownSecretValues(config as unknown as Record<string, unknown>);

  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      // Three layers, because one is not enough. Paths censor the fields whose
      // location is known; the `err` serializer and the log-method hook scrub
      // credentials that arrive *inside* a string, which no path can reach —
      // a Prisma or ioredis connection failure carries the whole URL, password
      // included, in its message. See secrets/logging.ts.
      redact: {
        paths: [...LOG_REDACT_PATHS],
        censor: REDACTED,
      },
      serializers: { err: buildErrorSerializer(knownSecrets) },
      // Pino copies hooks onto child loggers, so this covers every per-request
      // logger as well as the root.
      hooks: { logMethod: buildLogMethodHook(knownSecrets) },
      ...(options.logDestination ? { stream: options.logDestination } : {}),
      ...(config.NODE_ENV === 'development'
        ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } } }
        : {}),
    },
    // A caller-supplied request id is echoed for tracing, but never trusted as
    // an identifier — it is bounded and sanitised.
    genReqId: (request) => {
      const supplied = request.headers['x-request-id'];
      if (typeof supplied === 'string' && /^[\w-]{8,64}$/.test(supplied)) return supplied;
      return randomUUID();
    },
    trustProxy: true,
    bodyLimit: 1_048_576, // 1MB
    // Per-request logging is noise in the test suite, and only there. The
    // option is deprecated in Fastify 5 (its `logController` replacement
    // demands a full controller object, which is far more than this needs), so
    // it is passed only when it actually applies — no deprecation warning is
    // emitted in development or production, where the key is absent entirely.
    ...(config.NODE_ENV === 'test' ? { disableRequestLogging: true } : {}),
  });

  // --- Security headers ------------------------------------------------------
  await app.register(helmet, {
    // This is a JSON API; it serves no HTML, so the CSP is maximally strict.
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginResourcePolicy: { policy: 'same-site' },
    referrerPolicy: { policy: 'no-referrer' },
  });

  // --- Cookies ---------------------------------------------------------------
  // Registered before CORS and the routes, because the CSRF hook below reads
  // `request.cookies` and the parser must already be in place.
  await app.register(cookie, {});

  // --- CORS ------------------------------------------------------------------
  // An explicit allowlist. Never a reflected origin, and never `*` alongside
  // credentials, which browsers would reject anyway but which signals intent.
  const allowedOrigins = new Set([config.PUBLIC_WEB_URL, 'http://localhost:3000', 'http://127.0.0.1:3000']);
  await app.register(cors, {
    origin: (origin, callback) => {
      // Same-origin and server-to-server requests carry no Origin header.
      if (!origin) return callback(null, true);
      callback(null, allowedOrigins.has(origin));
    },
    // `credentials: true` is what lets the browser send and store the auth
    // cookies cross-origin. It is only safe alongside the explicit origin
    // allowlist above — a reflected origin plus credentials would let any site
    // read authenticated responses.
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'Idempotency-Key',
      'X-Request-Id',
      // Without this the preflight fails and every state-changing request from
      // the web app is blocked by the browser before it is ever sent.
      'X-CSRF-Token',
    ],
    maxAge: 600,
  });

  // --- Rate limiting ---------------------------------------------------------
  // Counters live in Redis when configured, so a limit is shared across
  // instances instead of being multiplied by the instance count. `skipOnError`
  // is the security-critical option here: its default is `true`, which fails
  // *open* and would silently remove the only defence against credential
  // stuffing and OTP brute force during a Redis outage. See redis/client.ts.
  const rateLimitRedis =
    config.RATE_LIMIT_REDIS && config.REDIS_URL
      ? createRateLimitRedis(config.REDIS_URL)
      : null;

  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    ...(rateLimitRedis ? { redis: rateLimitRedis, skipOnError: false } : {}),
    // Registered unconditionally so the plugin, its hooks, and the route-level
    // `config.rateLimit` declarations are exercised identically everywhere.
    // When disabled, every request is allow-listed rather than the plugin being
    // skipped — so a test runs the same code path a production request does.
    ...(config.RATE_LIMIT_ENABLED ? {} : { allowList: () => true }),
    // Authenticated callers are limited per identity; anonymous ones per IP.
    // Keying anonymous traffic by IP alone would let one signed-in user exhaust
    // the budget for everyone behind the same NAT.
    keyGenerator: (request) => request.actor?.identityId ?? request.ip,
    addHeadersOnExceeding: { 'x-ratelimit-remaining': true },
  });

  if (rateLimitRedis) {
    app.addHook('onClose', async () => {
      await rateLimitRedis.quit().catch(() => rateLimitRedis.disconnect());
    });
  }

  registerContext(app, services);
  registerErrorHandler(app);

  // --- CSRF ------------------------------------------------------------------
  // Applied globally rather than per-route so a new endpoint is protected by
  // default. `requiresCsrf` narrows it to state-changing requests that actually
  // carry the refresh cookie — a pure Bearer request has no ambient credential
  // for an attacker to ride on, so demanding a token there would be noise.
  //
  // Webhooks are exempt: they are server-to-server, carry no cookie, and are
  // authenticated by provider signature instead.
  app.addHook('onRequest', async (request) => {
    if (request.url.startsWith('/v1/webhooks/')) return;
    if (requiresCsrf(request)) assertCsrf(request);
  });

  assertSecureCookieConfig(config);

  // --- Health ----------------------------------------------------------------
  // --- Liveness --------------------------------------------------------------
  // "Is this process running?" and nothing more. It touches no dependency on
  // purpose: if liveness failed when the database was briefly unreachable, an
  // orchestrator would restart every instance during a blip and turn a
  // recoverable incident into an outage.
  //
  // Exempt from rate limiting. With the Redis-backed limiter failing closed
  // (see below), a Redis outage would otherwise make an instance unable to
  // answer "am I healthy?" at the exact moment an orchestrator most needs to
  // know — and readiness would return 429 instead of 503, which a load
  // balancer reads as "throttled", not "take me out of rotation". This route
  // touches no dependency at all, so there is nothing to amplify.
  app.get('/health', { config: { rateLimit: false } }, async () => ({ status: 'ok' }));

  // --- Readiness -------------------------------------------------------------
  // "Should this instance receive traffic?" This one does check dependencies:
  // a process that is up but cannot query is not ready, and saying otherwise
  // sends it live requests it will fail.
  //
  // The response names dependencies and their status, and nothing else. It is
  // unauthenticated, so it must not disclose which providers are configured,
  // which hosts they live on, what version is deployed, or why a check failed.
  // A payment provider name is a small thing to leak, but it is free
  // reconnaissance and there is no reason to give it away.
  // Exempt from rate limiting for the same reason as `/health`, and at a
  // similar cost: one `SELECT 1` plus, when configured, one Redis `PING`.
  // Volumetric protection for these belongs at the load balancer, which is
  // also the thing polling them.
  app.get('/health/ready', { config: { rateLimit: false } }, async (request, reply) => {
    const checks = [
      await checkDependency('database', () => request.services.prisma.$queryRaw`SELECT 1`),
    ];

    // Named for its role, not its technology, exactly as `database` is. The
    // response must not disclose that the queue is Redis any more than it
    // discloses that the database is PostgreSQL — an unauthenticated endpoint
    // naming its infrastructure is free reconnaissance.
    if (rateLimitRedis) {
      checks.push(
        await checkDependency('queue', async () => {
          if (!(await pingRedis(rateLimitRedis))) throw new Error('unavailable');
          return true;
        }),
      );
    }

    const ready = checks.every((check) => check.status === 'ok');

    if (!ready) {
      // 503 so a load balancer removes this instance rather than a 200 that
      // says "fine" while every request fails.
      request.log.error({ checks }, 'readiness check failed');
      return reply.status(503).send({ ready: false, checks });
    }

    return { ready: true, checks };
  });

  // --- Routes ----------------------------------------------------------------
  await registerAuthRoutes(app);
  await registerMfaRoutes(app);
  await registerCatalogRoutes(app);
  await registerOrderRoutes(app);
  await registerVendorRoutes(app);
  await registerRiderRoutes(app);
  await registerAdminRoutes(app);
  await registerWebhookRoutes(app);
  await registerAccountRoutes(app);

  // --- Background workers ----------------------------------------------------
  // Registered after routes so the queue handlers exist before the first job
  // can be enqueued by a request.
  registerDispatchWorker({ prisma: services.prisma, queue: services.queue, log: app.log });
  registerAccountExportWorker({
    prisma: services.prisma,
    queue: services.queue,
    archive: services.exportArchive,
    ttlHours: config.DATA_EXPORT_TTL_HOURS,
    log: app.log,
  });

  return app;
}
