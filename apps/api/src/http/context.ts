/**
 * Request context: what the API knows about who is calling.
 *
 * Fastify's request object is augmented with `actor` (the authenticated caller,
 * reconstructed from the database on every request) and `services` (the wired
 * adapters). Route handlers read those; they never read auth data from the body.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  assertPermission,
  assertScope,
  VENDOR_SCOPED_ROLES,
  type Actor,
  type Permission,
} from '@dash/domain/permissions';
import type { PrismaClient } from '@dash/db';
import type {
  EmailPort,
  ExportArchivePort,
  GeoPort,
  PaymentPort,
  PushPort,
  QueuePort,
  SmsPort,
  StoragePort,
} from '@dash/domain/ports';
import type { Keyring } from '@dash/domain/envelope';
import type { ErrorReportPort, MetricsPort } from '../observability/index.js';
import type { Config } from '../config.js';
import { bearerFrom, verifyAccessToken } from '../auth/tokens.js';
import { loadActor } from '../auth/sessions.js';
import { ApiError } from './errors.js';

export interface Services {
  config: Config;
  /**
   * Keys for encrypted-at-rest fields. Null only in a local configuration with
   * MFA disabled; `config.ts` refuses that combination in production.
   */
  keyring: Keyring | null;
  /** Where unhandled failures go. Console by default; never null. */
  errors: ErrorReportPort;
  /** Operational counters and timings. Console by default; never null. */
  metrics: MetricsPort;
  prisma: PrismaClient;
  payments: PaymentPort;
  geo: GeoPort;
  sms: SmsPort;
  email: EmailPort;
  push: PushPort;
  storage: StoragePort;
  /** Where built personal-data export archives are held until download. */
  exportArchive: ExportArchivePort;
  queue: QueuePort;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Present only after `authenticate` has run. */
    actor?: Actor;
    services: Services;
  }
  interface FastifyInstance {
    services: Services;
  }
}

export function registerContext(app: FastifyInstance, services: Services): void {
  app.decorate('services', services);
  app.decorateRequest('actor', undefined);
  // A getter rather than a per-request assignment: the services object is the
  // same for every request, so copying a reference onto each one is waste, and
  // Fastify 5 rejects a null default for an object-typed decorator anyway.
  app.decorateRequest('services', {
    getter(): Services {
      return services;
    },
  });
}

/**
 * Authenticate the caller.
 *
 * The token is verified cryptographically, then the actor is rebuilt from the
 * database. The second step is not redundant: it means a revoked session, a
 * suspended account, or a role that was removed one minute ago takes effect
 * immediately rather than after the access token expires.
 */
export async function authenticate(request: FastifyRequest): Promise<Actor> {
  if (request.actor) return request.actor;

  const token = bearerFrom(request.headers.authorization);
  if (!token) throw ApiError.unauthorized();

  const claims = await verifyAccessToken(token, request.services.config.JWT_ACCESS_SECRET);
  const actor = await loadActor(request.services.prisma, claims.sub, claims.sid);

  if (!actor) {
    throw ApiError.unauthorized('Your session is no longer valid. Please sign in again.');
  }

  request.actor = actor;
  return actor;
}

/**
 * Route guard: authenticate, then require a permission.
 *
 * Returns a preHandler, used as:
 *   { preHandler: requirePermission('vendor:order:accept') }
 *
 * Object-level ownership is a separate check — see `requireScope` — because
 * holding a permission never implies the specific record is yours.
 */
export function requirePermission(...permissions: readonly Permission[]) {
  return async function preHandler(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const actor = await authenticate(request);
    for (const permission of permissions) {
      assertPermission(actor, permission);
    }
  };
}

/** Route guard: authenticate only, with no specific permission required. */
export async function requireAuth(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  await authenticate(request);
}

/**
 * Object-level scope check.
 *
 * Call this immediately after loading any record addressed by an id from the
 * request, before returning or mutating it. Throws a 404-shaped error when the
 * record belongs to someone else.
 */
export function requireScope(
  actor: Actor,
  resource: Parameters<typeof assertScope>[1],
): void {
  assertScope(actor, resource);
}

/** The actor, or a 401. For handlers that ran behind an auth guard. */
export function actorOf(request: FastifyRequest): Actor {
  if (!request.actor) throw ApiError.unauthorized();
  return request.actor;
}

/**
 * Which kind of party this caller is, for the order state machine and the
 * status-event record.
 *
 * This exists because the vendor routes used to hardcode `actorType: 'vendor'`.
 * A super admin holds every permission and is bound to no vendor, so the scope
 * check does not stop them from accepting or rejecting on a vendor's behalf —
 * which is the intended operational escape hatch. But the event was then
 * written as though the vendor had done it, and the audit entry said
 * `vendor.order.accepted`.
 *
 * That makes the record wrong at exactly the moment it matters: a vendor
 * disputing "we never rejected that order" would be contradicted by a log
 * entry naming them. The escape hatch is meant to be wide and never silent;
 * attributing it to someone else is worse than silent.
 *
 * Vendor-bound roles are recorded as `vendor`. Everyone else exercising a
 * vendor permission is recorded as `ops`, which is what they are.
 */
export function transitionActorFor(actor: Actor): 'customer' | 'vendor' | 'rider' | 'ops' {
  if (actor.roles.some((role) => VENDOR_SCOPED_ROLES.has(role))) return 'vendor';
  if (actor.riderId && actor.roles.includes('rider')) return 'rider';
  if (actor.customerId && actor.roles.includes('customer')) return 'customer';
  return 'ops';
}

/**
 * Idempotency.
 *
 * Wraps a side-effecting handler so that replaying the same key returns the
 * original response instead of performing the action twice. Required on order
 * creation, payments, refunds, and payouts.
 *
 * The row is claimed with `create` — if a concurrent request already claimed it,
 * the unique constraint fails and we treat it as in-flight rather than running
 * the body a second time.
 */
export async function withIdempotency<T>(
  request: FastifyRequest,
  endpoint: string,
  handler: () => Promise<T>,
): Promise<T> {
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || key.trim().length === 0) {
    throw ApiError.badRequest('An Idempotency-Key header is required for this request.');
  }
  if (key.length > 200) {
    throw ApiError.badRequest('Idempotency-Key is too long.');
  }

  const { prisma } = request.services;
  const scopedKey = `${endpoint}:${request.actor?.identityId ?? 'anonymous'}:${key}`;

  const existing = await prisma.idempotencyKey.findUnique({ where: { key: scopedKey } });
  if (existing?.completedAt && existing.responseBody) {
    return JSON.parse(existing.responseBody) as T;
  }
  if (existing && !existing.completedAt) {
    // Claimed but unfinished — a retry arrived while the first is still running.
    // 409 rather than running it again, which is the whole point of the key.
    throw ApiError.conflict('That request is already being processed.');
  }

  try {
    await prisma.idempotencyKey.create({
      data: {
        key: scopedKey,
        identityId: request.actor?.identityId ?? null,
        endpoint,
        lockedAt: new Date(),
        expiresAt: new Date(Date.now() + 24 * 3_600_000),
      },
    });
  } catch {
    throw ApiError.conflict('That request is already being processed.');
  }

  try {
    const result = await handler();
    await prisma.idempotencyKey.update({
      where: { key: scopedKey },
      data: {
        completedAt: new Date(),
        statusCode: 200,
        responseBody: JSON.stringify(result),
      },
    });
    return result;
  } catch (error) {
    // Release the claim so a genuine retry can succeed. A failed attempt must
    // not permanently burn the key.
    await prisma.idempotencyKey.delete({ where: { key: scopedKey } }).catch(() => undefined);
    throw error;
  }
}
