/**
 * Session lifecycle.
 *
 * A session is the server-side record behind a refresh token. Access tokens are
 * stateless and short-lived; the session is what can actually be revoked.
 *
 * The important behaviour here is refresh-token rotation with reuse detection:
 * every refresh mints a new token and retires the old one. If a retired token is
 * ever presented again, that token was copied — so the whole session family is
 * revoked immediately rather than allowing the thief and the victim to take
 * turns refreshing.
 */

import { generateToken, hashToken } from '@dash/domain/crypto';
import {
  buildActor,
  type Actor,
  type Role,
} from '@dash/domain/permissions';
import type { PrismaClient } from '@dash/db';

export interface SessionContext {
  ipAddress?: string | null;
  userAgent?: string | null;
  deviceId?: string | null;
}

export interface IssuedSession {
  sessionId: string;
  refreshToken: string;
  expiresAt: Date;
}

export class SessionError extends Error {
  constructor(
    readonly reason: 'not_found' | 'expired' | 'revoked' | 'reused',
    message: string,
  ) {
    super(message);
    this.name = 'SessionError';
  }
}

export async function createSession(
  prisma: PrismaClient,
  identityId: string,
  ttlSeconds: number,
  context: SessionContext = {},
): Promise<IssuedSession> {
  const refreshToken = generateToken(32);
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

  const session = await prisma.session.create({
    data: {
      identityId,
      refreshTokenHash: hashToken(refreshToken),
      ipAddress: context.ipAddress ?? null,
      userAgent: context.userAgent ?? null,
      deviceId: context.deviceId ?? null,
      expiresAt,
    },
    select: { id: true },
  });

  return { sessionId: session.id, refreshToken, expiresAt };
}

/**
 * Rotate a refresh token.
 *
 * Returns a brand-new session row rather than mutating the old one, linked by
 * `previousSessionId`, so the lineage is visible in the database and a support
 * agent can see how many times a session has been refreshed.
 */
export async function rotateSession(
  prisma: PrismaClient,
  presentedToken: string,
  ttlSeconds: number,
  context: SessionContext = {},
): Promise<IssuedSession & { identityId: string }> {
  const presentedHash = hashToken(presentedToken);

  const existing = await prisma.session.findUnique({
    where: { refreshTokenHash: presentedHash },
    select: {
      id: true,
      identityId: true,
      expiresAt: true,
      revokedAt: true,
      rotatedAt: true,
    },
  });

  if (!existing) {
    throw new SessionError('not_found', 'Session not found');
  }
  if (existing.revokedAt) {
    throw new SessionError('revoked', 'Session has been revoked');
  }
  if (existing.expiresAt.getTime() < Date.now()) {
    throw new SessionError('expired', 'Session has expired');
  }

  // --- Reuse detection ------------------------------------------------------
  // This token was already rotated. Only a copy of it could be presented now,
  // so both the legitimate holder and the attacker are cut off and the user is
  // forced to sign in again. Losing a session is far cheaper than leaving a
  // stolen one live.
  if (existing.rotatedAt) {
    await revokeSessionFamily(prisma, existing.id, 'refresh_token_reuse_detected');
    throw new SessionError('reused', 'Session token was reused');
  }

  const rotated = await prisma.$transaction(async (tx) => {
    const refreshToken = generateToken(32);
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

    const created = await tx.session.create({
      data: {
        identityId: existing.identityId,
        refreshTokenHash: hashToken(refreshToken),
        previousSessionId: existing.id,
        ipAddress: context.ipAddress ?? null,
        userAgent: context.userAgent ?? null,
        deviceId: context.deviceId ?? null,
        expiresAt,
      },
      select: { id: true },
    });

    await tx.session.update({
      where: { id: existing.id },
      data: { rotatedAt: new Date(), revokedAt: new Date(), revokedReason: 'rotated' },
    });

    return { sessionId: created.id, refreshToken, expiresAt };
  });

  return { ...rotated, identityId: existing.identityId };
}

/**
 * Revoke a session and every session descended from it.
 *
 * Walks the `previousSessionId` chain forward. Bounded so a corrupted chain
 * cannot loop forever.
 */
export async function revokeSessionFamily(
  prisma: PrismaClient,
  sessionId: string,
  reason: string,
): Promise<number> {
  const toRevoke = new Set<string>([sessionId]);
  let frontier = [sessionId];

  for (let depth = 0; depth < 64 && frontier.length > 0; depth += 1) {
    const children = await prisma.session.findMany({
      where: { previousSessionId: { in: frontier } },
      select: { id: true },
    });
    frontier = children.map((child) => child.id).filter((id) => !toRevoke.has(id));
    for (const id of frontier) toRevoke.add(id);
  }

  // Also revoke ancestors — the whole family is compromised, not just forward.
  let cursor: string | null = sessionId;
  for (let depth = 0; depth < 64 && cursor; depth += 1) {
    const parent: { previousSessionId: string | null } | null = await prisma.session.findUnique({
      where: { id: cursor },
      select: { previousSessionId: true },
    });
    cursor = parent?.previousSessionId ?? null;
    if (cursor) toRevoke.add(cursor);
  }

  const result = await prisma.session.updateMany({
    where: { id: { in: [...toRevoke] }, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: reason },
  });
  return result.count;
}

export async function revokeSession(
  prisma: PrismaClient,
  sessionId: string,
  reason: string,
): Promise<void> {
  await prisma.session.updateMany({
    where: { id: sessionId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: reason },
  });
}

/** Revoke every live session for an identity — "sign out everywhere". */
export async function revokeAllSessions(
  prisma: PrismaClient,
  identityId: string,
  reason: string,
): Promise<number> {
  const result = await prisma.session.updateMany({
    where: { identityId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: reason },
  });
  return result.count;
}

/**
 * Build the authenticated `Actor` from the database.
 *
 * Everything is read server-side from the identity's role rows. Nothing is
 * taken from the request. This is the function that makes a client-supplied
 * `roles` field meaningless.
 */
export async function loadActor(
  prisma: PrismaClient,
  identityId: string,
  sessionId: string,
): Promise<Actor | null> {
  const identity = await prisma.identity.findUnique({
    where: { id: identityId },
    select: {
      id: true,
      status: true,
      roles: { select: { role: true, vendorId: true, branchId: true, cityId: true } },
      customer: { select: { id: true } },
      rider: { select: { id: true } },
    },
  });

  if (!identity || identity.status !== 'active') return null;

  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: { revokedAt: true, expiresAt: true, steppedUpAt: true, impersonatedBy: true },
  });

  // A revoked or expired session invalidates its access tokens immediately,
  // without waiting for the 15-minute access-token TTL to run out.
  if (!session || session.revokedAt || session.expiresAt.getTime() < Date.now()) return null;

  const roles = identity.roles.map((row) => row.role as Role);
  const vendorRole = identity.roles.find((row) => row.vendorId);
  const cityIds = identity.roles
    .map((row) => row.cityId)
    .filter((id): id is string => id !== null);

  return buildActor({
    identityId: identity.id,
    sessionId,
    roles,
    vendorId: vendorRole?.vendorId ?? undefined,
    branchId: vendorRole?.branchId ?? undefined,
    cityIds: cityIds.length > 0 ? cityIds : undefined,
    customerId: identity.customer?.id ?? undefined,
    riderId: identity.rider?.id ?? undefined,
    steppedUpAt: session.steppedUpAt ?? undefined,
    impersonating: session.impersonatedBy !== null,
  });
}

/** Record a completed step-up challenge against the session. */
export async function markSteppedUp(prisma: PrismaClient, sessionId: string): Promise<void> {
  await prisma.session.update({
    where: { id: sessionId },
    data: { steppedUpAt: new Date() },
  });
}

/** Housekeeping: drop sessions that expired long ago. */
export async function pruneExpiredSessions(
  prisma: PrismaClient,
  olderThanDays = 60,
): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * 86_400_000);
  const result = await prisma.session.deleteMany({
    where: { expiresAt: { lt: cutoff } },
  });
  return result.count;
}
