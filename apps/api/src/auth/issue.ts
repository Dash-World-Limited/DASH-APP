/**
 * Access-token issuing.
 *
 * Extracted so the password flow and the MFA flow mint tokens through exactly
 * one code path. Two copies of this would be two places for a claim to be
 * forgotten, and a missing `sua` or `vendorId` claim is an authorization bug
 * rather than a cosmetic one.
 */

import { loadActor } from './sessions.js';
import { issueAccessToken } from './tokens.js';
import type { Config } from '../config.js';
import type { PrismaClient } from '@dash/db';

export interface IssuedAccess {
  readonly accessToken: string;
  readonly expiresIn: number;
}

/**
 * Mint an access token for an existing session.
 *
 * Only the access token is produced here. The refresh token is the opaque value
 * `createSession`/`rotateSession` returns, and it goes straight into a cookie —
 * it is never assembled into a response body, so there is no path by which it
 * can be returned to script.
 *
 * Returns null when the session or identity is no longer usable, which the
 * caller must treat as a failed sign-in rather than ignoring.
 */
export async function issueAccessFor(
  prisma: PrismaClient,
  config: Config,
  identityId: string,
  sessionId: string,
): Promise<IssuedAccess | null> {
  const actor = await loadActor(prisma, identityId, sessionId);
  if (!actor) return null;

  const accessToken = await issueAccessToken(
    {
      sub: actor.identityId,
      sid: sessionId,
      roles: actor.roles,
      ...(actor.vendorId ? { vendorId: actor.vendorId } : {}),
      ...(actor.branchId ? { branchId: actor.branchId } : {}),
      ...(actor.riderId ? { riderId: actor.riderId } : {}),
      ...(actor.customerId ? { customerId: actor.customerId } : {}),
      ...(actor.cityIds ? { cityIds: actor.cityIds } : {}),
      ...(actor.steppedUpAt ? { sua: Math.floor(actor.steppedUpAt.getTime() / 1000) } : {}),
    },
    config.JWT_ACCESS_SECRET,
    config.ACCESS_TOKEN_TTL_SECONDS,
  );

  return { accessToken, expiresIn: config.ACCESS_TOKEN_TTL_SECONDS };
}
