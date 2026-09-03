/**
 * Token issuing and verification.
 *
 * Two token classes with separate secrets and separate audiences:
 *
 *   access   — short-lived (15 min), sent on every request, never stored server-side
 *   refresh  — long-lived (30 days), stored as a SHA-256 hash, single-use, rotating
 *
 * The separation matters. If one secret signed both, a refresh token would
 * verify as an access token and a stolen refresh token would be a permanent
 * session. `config.ts` refuses to start if the two secrets are equal.
 */

import { jwtVerify, SignJWT, type JWTPayload } from 'jose';
import type { Role } from '@dash/domain/permissions';

const ISSUER = 'dash-app';
const ACCESS_AUDIENCE = 'dash-app/access';
const REFRESH_AUDIENCE = 'dash-app/refresh';

export interface AccessTokenClaims {
  /** Identity id. */
  sub: string;
  /** Session id, so a revoked session invalidates its access tokens too. */
  sid: string;
  roles: readonly Role[];
  /** Scope qualifiers, resolved server-side at issue time. */
  vendorId?: string;
  branchId?: string;
  riderId?: string;
  customerId?: string;
  cityIds?: readonly string[];
  /** Epoch seconds of the last step-up, when one has happened. */
  sua?: number;
  /** Set when an admin is impersonating this identity. */
  imp?: string;
  /**
   * Expiry, epoch seconds, as verification read it.
   *
   * Surfaced because a WebSocket needs it and an HTTP request does not. A
   * request is authorized once and finishes; a socket authenticates once and
   * then lives for hours, so it has to know when the authority it was granted
   * runs out and close itself. Without this the only way to find out would be
   * to decode the token a second time somewhere else.
   *
   * Set by `verifyAccessToken` from the verified payload — never read from an
   * unverified token, and never supplied by a caller when issuing, where the
   * TTL argument decides it.
   */
  exp?: number;
}

export interface RefreshTokenClaims {
  sub: string;
  sid: string;
}

export class TokenError extends Error {
  constructor(
    readonly reason: 'expired' | 'invalid' | 'wrong_audience',
    message: string,
  ) {
    super(message);
    this.name = 'TokenError';
  }
}

function secretFor(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

export async function issueAccessToken(
  claims: AccessTokenClaims,
  secret: string,
  ttlSeconds: number,
): Promise<string> {
  const payload: JWTPayload = {
    sid: claims.sid,
    roles: claims.roles,
    ...(claims.vendorId ? { vendorId: claims.vendorId } : {}),
    ...(claims.branchId ? { branchId: claims.branchId } : {}),
    ...(claims.riderId ? { riderId: claims.riderId } : {}),
    ...(claims.customerId ? { customerId: claims.customerId } : {}),
    ...(claims.cityIds ? { cityIds: claims.cityIds } : {}),
    ...(claims.sua ? { sua: claims.sua } : {}),
    ...(claims.imp ? { imp: claims.imp } : {}),
  };

  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(claims.sub)
    .setIssuer(ISSUER)
    .setAudience(ACCESS_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(secretFor(secret));
}

export async function verifyAccessToken(
  token: string,
  secret: string,
): Promise<AccessTokenClaims> {
  try {
    const { payload } = await jwtVerify(token, secretFor(secret), {
      issuer: ISSUER,
      // Pinning the audience is what stops a refresh token being replayed here.
      audience: ACCESS_AUDIENCE,
      algorithms: ['HS256'],
    });

    if (!payload.sub || typeof payload['sid'] !== 'string') {
      throw new TokenError('invalid', 'Token is missing required claims');
    }

    return {
      sub: payload.sub,
      sid: payload['sid'],
      roles: (payload['roles'] as Role[] | undefined) ?? [],
      ...(typeof payload['vendorId'] === 'string' ? { vendorId: payload['vendorId'] } : {}),
      ...(typeof payload['branchId'] === 'string' ? { branchId: payload['branchId'] } : {}),
      ...(typeof payload['riderId'] === 'string' ? { riderId: payload['riderId'] } : {}),
      ...(typeof payload['customerId'] === 'string' ? { customerId: payload['customerId'] } : {}),
      ...(Array.isArray(payload['cityIds']) ? { cityIds: payload['cityIds'] as string[] } : {}),
      ...(typeof payload['sua'] === 'number' ? { sua: payload['sua'] } : {}),
      ...(typeof payload['imp'] === 'string' ? { imp: payload['imp'] } : {}),
      // `jwtVerify` has already rejected an expired token, so this is a future
      // instant by the time it is read here.
      ...(typeof payload.exp === 'number' ? { exp: payload.exp } : {}),
    };
  } catch (error) {
    if (error instanceof TokenError) throw error;
    const code = (error as { code?: string }).code;
    if (code === 'ERR_JWT_EXPIRED') {
      throw new TokenError('expired', 'Access token has expired');
    }
    if (code === 'ERR_JWT_CLAIM_VALIDATION_FAILED') {
      throw new TokenError('wrong_audience', 'Token was not issued for this purpose');
    }
    throw new TokenError('invalid', 'Access token is not valid');
  }
}

export async function issueRefreshToken(
  claims: RefreshTokenClaims,
  secret: string,
  ttlSeconds: number,
): Promise<string> {
  return new SignJWT({ sid: claims.sid })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(claims.sub)
    .setIssuer(ISSUER)
    .setAudience(REFRESH_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(secretFor(secret));
}

export async function verifyRefreshToken(
  token: string,
  secret: string,
): Promise<RefreshTokenClaims> {
  try {
    const { payload } = await jwtVerify(token, secretFor(secret), {
      issuer: ISSUER,
      audience: REFRESH_AUDIENCE,
      algorithms: ['HS256'],
    });

    if (!payload.sub || typeof payload['sid'] !== 'string') {
      throw new TokenError('invalid', 'Token is missing required claims');
    }
    return { sub: payload.sub, sid: payload['sid'] };
  } catch (error) {
    if (error instanceof TokenError) throw error;
    const code = (error as { code?: string }).code;
    if (code === 'ERR_JWT_EXPIRED') {
      throw new TokenError('expired', 'Refresh token has expired');
    }
    throw new TokenError('invalid', 'Refresh token is not valid');
  }
}

/** Extract a bearer token from an Authorization header. */
export function bearerFrom(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}
