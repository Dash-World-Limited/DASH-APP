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
import type { EmailPort, StoragePort } from '@dash/domain/ports';
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
import {
  DisabledExportArchiveAdapter,
  DisabledMapsGeoAdapter,
  DisabledPaymentAdapter,
  DisabledPushAdapter,
  DisabledSmsAdapter,
} from './adapters/disabled.js';
import { capabilitiesFor } from './deployment/profile.js';
import { S3StorageAdapter } from './adapters/s3.js';
import { SesEmailAdapter } from './adapters/ses.js';
import { SuppressionAwareEmailAdapter } from './adapters/suppressed-email.js';
import { RedisQueueAdapter } from './adapters/redis-queue.js';
import {
  createBroadcastRedis,
  createQueueRedis,
  createRateLimitRedis,
  pingRedis,
} from './redis/client.js';
import {
  InProcessBroadcastAdapter,
  RedisBroadcastAdapter,
} from './realtime/broadcast.js';
import { RealtimeHub } from './realtime/hub.js';
import { registerRealtimeWorker } from './realtime/worker.js';
import { createFcmAdapter } from './adapters/fcm.js';
import { registerPushWorker } from './push/worker.js';
import { registerRealtimeRoutes } from './routes/realtime.js';
import { parseNotification } from '@dash/domain/realtime';
import { buildKeyring, isEncryptionConfigured, loadConfig, type Config } from './config.js';
import { registerContext, type Services } from './http/context.js';
import {
  checkDependency,
  type DependencyCheck,
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
import { registerDeclutterRoutes } from './routes/declutter.js';
import { registerValueCheckRoutes } from './routes/valuecheck.js';
import { registerDeclutterPricingRoutes } from './routes/declutter-pricing.js';
import { registerDeclutterPhotoRoutes } from './routes/declutter-photos.js';
import { registerDeclutterListingRoutes } from './routes/declutter-listings.js';
import { registerFileRoutes } from './routes/files.js';
import { registerSignupRoutes } from './routes/signup.js';
import { registerEmailEventRoutes } from './routes/email-events.js';
import { DeterministicValuationAdapter } from '@dash/domain/valuecheck';
import { registerWebhookRoutes } from './routes/webhooks.js';
import { registerAccountRoutes } from './routes/account.js';
import { registerDeviceRoutes } from './routes/devices.js';
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
  /**
   * Realtime timings, for tests.
   *
   * A suite cannot wait 25 seconds for a heartbeat or 60 for a revalidation
   * sweep, and making those constants smaller everywhere to suit the tests
   * would change production behaviour to make a test convenient. Overriding
   * them here keeps the defaults honest.
   */
  realtime?: {
    heartbeatMs?: number;
    authenticateDeadlineMs?: number;
    revalidateIntervalMs?: number;
    maxConnectionsPerIdentity?: number;
  };
}

export function buildServices(config: Config, overrides: Partial<Services> = {}): Services {
  const prisma = overrides.prisma ?? defaultPrisma;
  // Passed to the error reporter so a secret that reached an error message by
  // some route no pattern matches is still stripped before it leaves.
  const knownSecrets = knownSecretValues(config as unknown as Record<string, unknown>);
  // A test run should not print a wall of fake SMS. `silent` is the level the
  // test harness sets, so it doubles as the signal here.
  const quiet = config.LOG_LEVEL === 'silent';

  /**
   * What this deployment runs.
   *
   * Read once and used for two things: which adapter each port gets, and which
   * routes are registered at all. See `deployment/profile.ts`.
   */
  const capabilities = capabilitiesFor(config.DEPLOYMENT_PROFILE);

  return {
    config,
    // Built once at boot so a malformed key fails immediately rather than at
    // the first enrolment.
    keyring: overrides.keyring ?? (isEncryptionConfigured(config) ? buildKeyring(config) : null),
    prisma,
    // A disabled capability gets an adapter that throws, never a mock. A
    // production deployment whose guards no longer check the payment provider
    // must not still be holding one that reports a successful charge and
    // settles nothing.
    payments:
      overrides.payments ??
      (capabilities.has('payments') ? new MockPaymentAdapter() : new DisabledPaymentAdapter()),
    // PostGIS answers zone containment; everything else geo still comes from
    // the maps provider, which the PostGIS adapter wraps rather than replaces.
    // Zone containment survives with maps off, because PostGIS answers it from
    // the database rather than from a provider. Routing and geocoding are the
    // parts that need a third party, and those throw.
    geo:
      overrides.geo ??
      (() => {
        const zones =
          config.GEO_ZONES_PROVIDER === 'postgis'
            ? new PostgisGeoAdapter(prisma, new LocalGeoAdapter(prisma))
            : new LocalGeoAdapter(prisma);
        return capabilities.has('maps') ? zones : new DisabledMapsGeoAdapter(zones);
      })(),
    sms:
      overrides.sms ??
      (capabilities.has('sms') ? new ConsoleSmsAdapter(quiet) : new DisabledSmsAdapter()),
    // Wrapped, always, and including the override a test supplies: the
    // suppression list is a policy about who may be written to, and a policy
    // that only applies to one adapter is one the next adapter forgets.
    email: new SuppressionAwareEmailAdapter(
      overrides.email ?? createEmailAdapter(config, quiet),
      prisma,
    ),
    // Console unless a provider is configured, so tests and local development
    // never need a Firebase credential and never send a real notification.
    push:
      overrides.push ??
      (!capabilities.has('push')
        ? new DisabledPushAdapter()
        : config.PUSH_PROVIDER === 'fcm'
          ? createFcmAdapter()
          : new ConsolePushAdapter(quiet)),
    storage: overrides.storage ?? createStorageAdapter(config),
    // ValueCheck. One value today; a live provider is a new branch and a new
    // adapter, and no marketplace code changes when one arrives.
    valuation: overrides.valuation ?? new DeterministicValuationAdapter(),
    exportArchive:
      overrides.exportArchive ??
      (capabilities.has('dataExport')
        ? new LocalExportArchiveAdapter(config.STORAGE_LOCAL_DIR)
        : new DisabledExportArchiveAdapter()),
    queue:
      overrides.queue ??
      (config.QUEUE_PROVIDER === 'redis' && config.REDIS_URL
        ? new RedisQueueAdapter(createQueueRedis(config.REDIS_URL))
        : new MemoryQueueAdapter()),
    // Two Redis connections, because a subscriber cannot publish — see
    // `createBroadcastRedis`. The in-process adapter is correct on a single
    // instance and refused in production by `config.ts`.
    broadcast:
      overrides.broadcast ??
      (config.REALTIME_BROADCAST === 'redis' && config.REDIS_URL
        ? new RedisBroadcastAdapter(
            createBroadcastRedis(config.REDIS_URL),
            createBroadcastRedis(config.REDIS_URL),
          )
        : new InProcessBroadcastAdapter()),
    // Stacks are withheld in production: a stack can carry interpolated values
    // from the frame that threw, and those are exactly what must not travel to
    // a third party.
    errors:
      overrides.errors ??
      new ConsoleErrorReporter(config.NODE_ENV !== 'production', quiet, knownSecrets),
    metrics: overrides.metrics ?? new ConsoleMetrics(quiet, knownSecrets),
  };
}

/**
 * Pick the email adapter the configuration actually asked for.
 *
 * This function exists because `EMAIL_PROVIDER` was validated at boot,
 * classified as production-required, refused in production when set to
 * `console` — and then never read. The adapter was hard-wired to the console
 * one. A production deployment could therefore set `EMAIL_PROVIDER=smtp`, pass
 * every guard, boot cleanly, and log every verification code to stdout while
 * believing it was sending email. Nobody would find out until a user said they
 * never received their code.
 *
 * So an unknown provider is now a startup failure rather than a silent
 * downgrade. There is no SMTP adapter and no SES adapter yet: naming one is a
 * request for delivery this process cannot perform, and refusing to start is
 * the only answer that does not quietly lie about it.
 */
/**
 * Pick the storage adapter the configuration asked for.
 *
 * Written for the same reason `createEmailAdapter` was: `STORAGE_PROVIDER` was
 * validated at boot, classified production-required, refused in production when
 * set to `local` — and then never read. The adapter was hard-wired to the
 * local-disk one. A production deployment could set `STORAGE_PROVIDER=s3`,
 * satisfy every guard, boot cleanly, and write every item photograph and every
 * government identity document to a container filesystem discarded on the next
 * deploy.
 *
 * That failure is quieter than the email one and worse. Nothing errors, the
 * photographs are there, the listings look right — and they are gone after the
 * next release, with the KYC evidence behind them.
 */
/**
 * Whether storage can answer for itself, and the memo that keeps it cheap.
 *
 * Structural rather than an `instanceof`: a test can substitute anything with a
 * `reachable()` method, and an adapter without one — the local disk, which is
 * always "reachable" — simply contributes no check rather than a fake pass.
 */
interface SelfChecking {
  reachable(): Promise<boolean>;
}

const STORAGE_OK_TTL_MS = 60_000;
let storageOkUntil = 0;

async function checkStorageReadiness(storage: unknown): Promise<DependencyCheck | null> {
  const candidate = storage as Partial<SelfChecking>;
  if (typeof candidate?.reachable !== 'function') return null;

  if (Date.now() < storageOkUntil) return { name: 'storage', status: 'ok', latencyMs: 0 };

  // Through `checkDependency` for its timeout: a readiness probe that can hang
  // is worse than one that fails, because an orchestrator waiting on it keeps
  // the instance in service.
  const check = await checkDependency('storage', async () => {
    if (!(await (candidate as SelfChecking).reachable())) throw new Error('unreachable');
    return true;
  });

  // A failure is never cached, so a bucket that comes back is noticed at the
  // next poll rather than a minute later.
  storageOkUntil = check.status === 'ok' ? Date.now() + STORAGE_OK_TTL_MS : 0;
  return check;
}

function createStorageAdapter(config: Config): StoragePort {
  if (config.STORAGE_PROVIDER === 'local') return new LocalStorageAdapter(config.STORAGE_LOCAL_DIR);

  if (config.STORAGE_PROVIDER === 's3') {
    // The config guards already refused to start without these in production.
    // Re-checked because `buildServer` is also called by tests and scripts that
    // never went through them.
    if (!config.S3_BUCKET || !config.S3_REGION) {
      throw new Error('STORAGE_PROVIDER=s3 needs S3_BUCKET and S3_REGION.');
    }
    return new S3StorageAdapter({
      bucket: config.S3_BUCKET,
      region: config.S3_REGION,
      endpoint: config.S3_ENDPOINT,
      forcePathStyle: config.S3_FORCE_PATH_STYLE,
    });
  }

  throw new Error(
    `STORAGE_PROVIDER is "${config.STORAGE_PROVIDER}", but no adapter for it is built into ` +
      'this service. Uploads would go nowhere durable.',
  );
}

function createEmailAdapter(config: Config, quiet: boolean): EmailPort {
  if (config.EMAIL_PROVIDER === 'console') return new ConsoleEmailAdapter(quiet);

  if (config.EMAIL_PROVIDER === 'ses') {
    // The config guards already refused to start without these in production.
    // Re-checked here because `buildServer` can also be called by a test or a
    // script that did not go through them, and a partially configured SES
    // client fails at the first send rather than at boot.
    if (!config.SES_REGION || !config.EMAIL_FROM_ADDRESS || !config.EMAIL_REPLY_TO) {
      throw new Error(
        'EMAIL_PROVIDER=ses needs SES_REGION, EMAIL_FROM_ADDRESS and EMAIL_REPLY_TO.',
      );
    }
    return new SesEmailAdapter({
      region: config.SES_REGION,
      fromAddress: config.EMAIL_FROM_ADDRESS,
      fromName: config.EMAIL_FROM_NAME,
      replyTo: config.EMAIL_REPLY_TO,
      configurationSet: config.SES_CONFIGURATION_SET,
    });
  }

  throw new Error(
    `EMAIL_PROVIDER is "${config.EMAIL_PROVIDER}", but no adapter for it is built into this ` +
      'service. Email would silently go nowhere.',
  );
}

export async function buildServer(options: BuildOptions = {}): Promise<FastifyInstance> {
  const config = options.config ?? loadConfig();
  const services = buildServices(config, options.services ?? {});

  /**
   * What this deployment runs, for the route registration at the foot of this
   * function. `buildServices` reads the same set to decide which adapters to
   * wire, so the two answers cannot diverge: both come from the profile.
   */
  const capabilities = capabilitiesFor(config.DEPLOYMENT_PROFILE);

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

    // Storage, when the adapter can answer for itself.
    //
    // Worth checking because a wrong bucket name or a missing credential is
    // otherwise invisible: the service boots, the marketplace renders, and the
    // first seller to photograph an item discovers it. Named for its role like
    // the others — this endpoint is unauthenticated and must not disclose that
    // storage happens to be S3.
    //
    // A success is cached briefly. A load balancer polls this every few
    // seconds, and an unbounded HeadBucket per poll is a bill and a rate limit
    // for no extra safety. A *failure* is never cached, so recovery is noticed
    // at the next poll.
    const storageCheck = await checkStorageReadiness(request.services.storage);
    if (storageCheck) checks.push(storageCheck);

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
  // Always. Authentication, the admin console, the marketplace, the files it
  // serves and the mail it receives back.
  await registerAuthRoutes(app);
  await registerMfaRoutes(app);
  await registerAdminRoutes(app);
  await registerDeclutterRoutes(app);
  await registerValueCheckRoutes(app);
  await registerDeclutterPricingRoutes(app);
  await registerDeclutterPhotoRoutes(app);
  await registerDeclutterListingRoutes(app);
  await registerFileRoutes(app);
  await registerSignupRoutes(app);
  await registerEmailEventRoutes(app);
  await registerAccountRoutes(app);

  /**
   * Registered only where the capability exists.
   *
   * A route left mounted on a deployment that cannot fulfil it is worse than a
   * 404. `POST /v1/orders` on a service with no payments and no dispatch would
   * accept an order, take no money, and send nobody — so the honest answer to
   * a request the deployment cannot perform is that the endpoint is not there.
   *
   * Delivery covers the whole basket-to-doorstep path: the vendor catalogue a
   * basket is built from, the orders themselves, the vendor console and the
   * rider app.
   */
  if (capabilities.has('delivery')) {
    await registerCatalogRoutes(app);
    await registerOrderRoutes(app);
    await registerVendorRoutes(app);
    await registerRiderRoutes(app);
  }

  // The Paystack webhook. Without payments there is nothing for it to confirm,
  // and an endpoint that accepts payment notifications a deployment cannot act
  // on is an invitation.
  if (capabilities.has('payments')) {
    await registerWebhookRoutes(app);
  }

  // Device tokens exist to be pushed to.
  if (capabilities.has('push')) {
    await registerDeviceRoutes(app);
  }

  // --- Realtime --------------------------------------------------------------
  // The hub is per instance and holds only sockets, so it needs no shutdown
  // beyond the `preClose` hook the route registers.
  const hub = new RealtimeHub({
    log: app.log,
    ...(options.realtime?.maxConnectionsPerIdentity === undefined
      ? {}
      : { maxConnectionsPerIdentity: options.realtime.maxConnectionsPerIdentity }),
  });

  // Every notification that reaches this instance — from its own worker or from
  // another instance's — arrives here. It is validated before it is believed:
  // the broadcast channel is shared infrastructure, and `parseNotification`
  // re-parses every topic name rather than trusting that whatever published it
  // was one of ours.
  services.broadcast.subscribe((raw) => {
    try {
      hub.publish(parseNotification(raw));
    } catch {
      app.log.warn({}, 'realtime: discarded an invalid broadcast');
    }
  });

  /**
   * Both must agree before a socket is served.
   *
   * The capability decides whether this deployment has realtime at all; the env
   * flag decides whether a deployment that has it wants it on right now. A
   * profile without the capability therefore cannot be talked into serving the
   * socket by setting `REALTIME_ENABLED=true` — which matters, because that
   * combination would otherwise fan out in process, past the guard that exists
   * to stop exactly that in production.
   */
  await registerRealtimeRoutes(app, {
    hub,
    enabled: capabilities.has('realtime') && config.REALTIME_ENABLED,
    ...(options.realtime?.heartbeatMs === undefined
      ? {}
      : { heartbeatMs: options.realtime.heartbeatMs }),
    ...(options.realtime?.authenticateDeadlineMs === undefined
      ? {}
      : { authenticateDeadlineMs: options.realtime.authenticateDeadlineMs }),
    ...(options.realtime?.revalidateIntervalMs === undefined
      ? {}
      : { revalidateIntervalMs: options.realtime.revalidateIntervalMs }),
  });

  // --- Background workers ----------------------------------------------------
  // Registered after routes so the queue handlers exist before the first job
  // can be enqueued by a request.
  registerDispatchWorker({
    // The hub is this instance's own socket registry, so this answers "is this
    // rider connected *here*". In a multi-instance deployment a rider attached
    // to another instance reads as not-live, which gives them the longer wake
    // deadline — the safe direction, and the reason this needs no cross-node
    // presence protocol to be correct.
    isIdentityLive: (identityId) => hub.connectionsFor(identityId) > 0,
    prisma: services.prisma,
    queue: services.queue,
    log: app.log,
  });
  registerAccountExportWorker({
    prisma: services.prisma,
    queue: services.queue,
    archive: services.exportArchive,
    ttlHours: config.DATA_EXPORT_TTL_HOURS,
    log: app.log,
  });
  // Consumes the notifications the outbox relay published and repeats each to
  // every instance. Registered even when the endpoint is disabled: the jobs are
  // still produced by the order routes, and a worker that is not listening
  // would leave them to expire in the queue rather than be consumed and
  // harmlessly dropped by a hub with no sockets.
  registerRealtimeWorker({ queue: services.queue, broadcast: services.broadcast, log: app.log });

  // Push complements the socket rather than replacing it. Both are published
  // by the same transaction; this consumer delivers the half that reaches a
  // rider whose app is closed.
  registerPushWorker({
    queue: services.queue,
    prisma: services.prisma,
    push: services.push,
    logger: app.log,
  });

  return app;
}
