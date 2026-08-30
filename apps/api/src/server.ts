/**
 * Fastify server assembly.
 *
 * Exported as a builder so tests can start an instance with substituted
 * adapters and no listening socket.
 */

import Fastify, { type FastifyInstance } from 'fastify';
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
  LocalStorageAdapter,
  MemoryQueueAdapter,
  MockPaymentAdapter,
} from './adapters/index.js';
import { loadConfig, type Config } from './config.js';
import { registerContext, type Services } from './http/context.js';
import { registerErrorHandler } from './http/errors.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerCatalogRoutes } from './routes/catalog.js';
import { registerOrderRoutes } from './routes/orders.js';
import { registerVendorRoutes } from './routes/vendor.js';
import { registerRiderRoutes } from './routes/rider.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerWebhookRoutes } from './routes/webhooks.js';

export interface BuildOptions {
  config?: Config;
  services?: Partial<Services>;
}

export function buildServices(config: Config, overrides: Partial<Services> = {}): Services {
  const prisma = overrides.prisma ?? defaultPrisma;

  return {
    config,
    prisma,
    payments: overrides.payments ?? new MockPaymentAdapter(),
    geo: overrides.geo ?? new LocalGeoAdapter(prisma),
    sms: overrides.sms ?? new ConsoleSmsAdapter(),
    email: overrides.email ?? new ConsoleEmailAdapter(),
    push: overrides.push ?? new ConsolePushAdapter(),
    storage: overrides.storage ?? new LocalStorageAdapter(config.STORAGE_LOCAL_DIR),
    queue: overrides.queue ?? new MemoryQueueAdapter(),
  };
}

export async function buildServer(options: BuildOptions = {}): Promise<FastifyInstance> {
  const config = options.config ?? loadConfig();
  const services = buildServices(config, options.services ?? {});

  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      // Never let a credential reach the logs, even by accident.
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers["idempotency-key"]',
          'req.body.password',
          'req.body.code',
          'req.body.refreshToken',
          'res.headers["set-cookie"]',
        ],
        censor: '[redacted]',
      },
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
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Request-Id'],
    maxAge: 600,
  });

  // --- Rate limiting ---------------------------------------------------------
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    // Authenticated callers are limited per identity; anonymous ones per IP.
    // Keying anonymous traffic by IP alone would let one signed-in user exhaust
    // the budget for everyone behind the same NAT.
    keyGenerator: (request) => request.actor?.identityId ?? request.ip,
    addHeadersOnExceeding: { 'x-ratelimit-remaining': true },
  });

  registerContext(app, services);
  registerErrorHandler(app);

  // --- Health ----------------------------------------------------------------
  app.get('/health', async () => ({ status: 'ok', time: new Date().toISOString() }));

  app.get('/health/ready', async (request) => {
    // Readiness must actually touch the database. A process that is up but
    // cannot query is not ready, and saying otherwise sends it live traffic.
    await request.services.prisma.$queryRaw`SELECT 1`;
    return {
      status: 'ready',
      adapters: {
        payments: services.payments.providerName,
        paymentsLive: services.payments.isLive,
        maps: services.geo.providerName,
        storage: services.storage.providerName,
        queue: services.queue.providerName,
      },
    };
  });

  // --- Routes ----------------------------------------------------------------
  await registerAuthRoutes(app);
  await registerCatalogRoutes(app);
  await registerOrderRoutes(app);
  await registerVendorRoutes(app);
  await registerRiderRoutes(app);
  await registerAdminRoutes(app);
  await registerWebhookRoutes(app);

  return app;
}
