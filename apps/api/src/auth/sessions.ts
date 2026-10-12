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
  VENDOR_SCOPED_ROLES,
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

  // --- Reuse detection ------------------------------------------------------
  // This MUST be checked before `revokedAt`.
  //
  // Rotation marks the old session both `rotatedAt` and `revokedAt` (reason
  // `rotated`). When this check sat below the generic revoked check, the
  // revoked branch always won and the reuse branch was unreachable dead code —
  // so a replayed token was dismissed as "revoked" and the session family was
  // never torn down.
  //
  // That is not a cosmetic ordering bug. If an attacker steals a refresh token
  // and uses it BEFORE the victim, the attacker gets a fresh live session, and
  // the victim's subsequent (legitimate) refresh looks like the replay. Without
  // family revocation the attacker simply keeps the account. Detecting reuse
  // and killing every session in the lineage is the whole defence.
  //
  // A token presented after rotation can only be a copy, so both the thief and
  // the legitimate holder are cut off and the user signs in again. Losing a
  // session is far cheaper than leaving a stolen one live.
  if (existing.rotatedAt) {
    await revokeSessionFamily(prisma, existing.id, 'refresh_token_reuse_detected');
    throw new SessionError('reused', 'Session token was reused');
  }

  // Revoked for any other reason — logout, an admin action, or a family
  // revocation triggered by a sibling session's reuse.
  if (existing.revokedAt) {
    throw new SessionError('revoked', 'Session has been revoked');
  }
  if (existing.expiresAt.getTime() < Date.now()) {
    throw new SessionError('expired', 'Session has expired');
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
      rider: { select: { id: true, status: true } },
    },
  });

  if (!identity || identity.status !== 'active') return null;

  // A role row says what someone was granted; the vendor or rider record says
  // whether that grant is currently in force. A suspended vendor's staff and a
  // suspended rider keep their role rows — so the history of who held what
  // survives — but hold none of the permissions while the record is not
  // approved. Read on every request, so a suspension takes effect on the next
  // call rather than when an access token happens to expire.
  const scopedVendorIds = [...new Set(identity.roles.map((row) => row.vendorId).filter((id): id is string => id !== null))];
  const approvedVendorIds = new Set(
    scopedVendorIds.length === 0
      ? []
      : (
          await prisma.vendor.findMany({
            where: { id: { in: scopedVendorIds }, status: 'approved' },
            select: { id: true },
          })
        ).map((vendor) => vendor.id),
  );
  const riderApproved = identity.rider?.status === 'approved';
  const roleRows = identity.roles.filter((row) => {
    if (VENDOR_SCOPED_ROLES.has(row.role as Role)) return row.vendorId !== null && approvedVendorIds.has(row.vendorId);
    if (row.role === 'rider') return riderApproved;
    return true;
  });

  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: { revokedAt: true, expiresAt: true, steppedUpAt: true, impersonatedBy: true },
  });

  // A revoked or expired session invalidates its access tokens immediately,
  // without waiting for the 15-minute access-token TTL to run out.
  if (!session || session.revokedAt || session.expiresAt.getTime() < Date.now()) return null;

  const roles = roleRows.map((row) => row.role as Role);
  const vendorRole = roleRows.find((row) => row.vendorId);
  const cityIds = roleRows
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
    // Only an approved rider is a rider. A pending applicant has a Rider row
    // and nothing else, and must not reach anything scoped by it.
    riderId: riderApproved ? identity.rider?.id : undefined,
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

/**
 * Housekeeping: drop sessions that expired before `before`.
 *
 * Called by the retention job (`apps/api/src/jobs/retention.ts`), which is the
 * only thing that runs it. Kept here rather than inlined in the job so session
 * lifecycle stays in one file, and so `dryRun` counts through exactly the same
 * `where` clause the real delete uses — a count that could diverge from the
 * delete would make the dry run a lie.
 *
 * Takes an explicit cutoff rather than a day count so every rule in one job run
 * shares a single instant.
 */
export async function pruneExpiredSessions(
  prisma: PrismaClient,
  before: Date,
  options: { dryRun?: boolean } = {},
): Promise<number> {
  const where = { expiresAt: { lt: before } };

  if (options.dryRun) return prisma.session.count({ where });
  return (await prisma.session.deleteMany({ where })).count;
}
