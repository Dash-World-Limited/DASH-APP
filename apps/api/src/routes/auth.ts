/**
 * Authentication routes.
 *
 * Customers and riders sign in with a one-time code sent to their phone.
 * Staff and vendor users sign in with a password.
 *
 * Token model:
 *   access   — JWT, 15 minutes, returned in the body, held in memory by the
 *              client and never persisted anywhere.
 *   refresh  — opaque 256-bit value in a HttpOnly, Secure, SameSite cookie
 *              scoped to /v1/auth. Never returned in a response body, never
 *              readable by script. Rotated on every use, with reuse detection.
 *   csrf     — a separate non-HttpOnly cookie echoed back in a header on every
 *              cookie-authenticated state change. See ../auth/cookies.ts.
 *
 * Behaviours worth reading carefully:
 *
 *   1. `POST /otp/request` always returns the same success response, whether or
 *      not the number belongs to an account. Otherwise the endpoint is a free
 *      user-enumeration oracle for anyone with a phone-number list.
 *   2. Password sign-in runs a hash comparison even when no account exists, so
 *      the response time does not reveal which emails are registered.
 *   3. `POST /refresh` reads the cookie, never the body. A refresh token in a
 *      body would mean script could read it, which is the thing this design
 *      exists to prevent.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  generateOtp,
  hashOtp,
  hashPassword,
  verifyOtp,
  verifyPassword,
} from '@dash/domain/crypto';
import { writeAudit } from '@dash/db';
import { requiresMfa } from '@dash/domain/mfa';
import type { Role } from '@dash/domain/permissions';
import { createChallenge, isMfaActive } from '../auth/mfa.js';
import { describeDeliveryFailure, otpReference, sendOtpEmail, sendOtpSms } from '../auth/otp-delivery.js';
import { revokeAllDeviceTokens, revokeDeviceToken } from '../push/registration.js';
import { ApiError } from '../http/errors.js';
import { actorOf, authenticate, requireAuth } from '../http/context.js';
import { issueAccessFor as issueAccessForShared } from '../auth/issue.js';
import {
  createSession,
  SessionError,
  markSteppedUp,
  revokeAllSessions,
  revokeSession,
  rotateSession,
} from '../auth/sessions.js';
import {
  clearAuthCookies,
  ensureCsrfCookie,
  issueAuthCookies,
  readRefreshCookie,
} from '../auth/cookies.js';

/** E.164: a leading +, then 8–15 digits with no leading zero on the country code. */
const phoneSchema = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{7,14}$/, 'Enter a valid phone number including the country code');

const emailSchema = z.string().trim().toLowerCase().email('Enter a valid email address');

/**
 * A code goes to one destination: a phone or an email address, never both.
 *
 * Email was added for the Declutters website, where a visitor signs up with an
 * email address and would otherwise have no way back into their own account:
 * SMS verification is off for V1, and the phone number they typed has never
 * been proved. Rather than build a second sign-in, the destination became a
 * choice — everything after it (the hashed code, the attempt ceiling, the
 * expiry, single use, the session it mints) is the same proven path both
 * channels have always run through.
 */
const destinationSchema = z
  .object({ phone: phoneSchema.optional(), email: emailSchema.optional() })
  .refine((value) => (value.phone === undefined) !== (value.email === undefined), {
    message: 'Give either a phone number or an email address',
  });

const otpRequestSchema = destinationSchema.and(
  z.object({ purpose: z.enum(['login', 'step_up']).default('login') }),
);

const otpVerifySchema = destinationSchema.and(
  z.object({
    code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code'),
    purpose: z.enum(['login', 'step_up']).default('login'),
  }),
);

/** The address a code was sent to, and how it travelled. */
function destinationOf(body: { phone?: string | undefined; email?: string | undefined }): {
  value: string;
  channel: 'sms' | 'email';
} {
  return body.phone !== undefined
    ? { value: body.phone, channel: 'sms' }
    : { value: body.email!, channel: 'email' };
}

const passwordLoginSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address'),
  password: z.string().min(1, 'Enter your password'),
});

/** A throwaway hash, compared against when no account exists, to equalise timing. */
let decoyHash: string | null = null;
async function getDecoyHash(): Promise<string> {
  decoyHash ??= await hashPassword('decoy-password-that-never-matches');
  return decoyHash;
}

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  const { prisma, config, sms, email } = app.services;

  /** Delegates to the shared issuer so both flows mint identical claims. */
  const issueAccessFor = (identityId: string, sessionId: string) =>
    issueAccessForShared(prisma, config, identityId, sessionId);

  /**
   * True when this destination was sent a code within the cooldown, or has
   * reached the hourly cap. Counts every purpose: each one is a message sent
   * to the same person at DASH's cost.
   */
  async function destinationThrottled(destination: string): Promise<boolean> {
    const recent = await prisma.otpChallenge.findMany({
      where: { destination, createdAt: { gt: new Date(Date.now() - 3_600_000) } },
      orderBy: { createdAt: 'desc' },
      take: config.OTP_MAX_CODES_PER_HOUR,
      select: { createdAt: true },
    });
    if (recent.length >= config.OTP_MAX_CODES_PER_HOUR) return true;
    const latest = recent[0];
    return (
      latest !== undefined &&
      Date.now() - latest.createdAt.getTime() < config.OTP_RESEND_COOLDOWN_SECONDS * 1000
    );
  }

  // -------------------------------------------------------------------------
  // GET /v1/auth/csrf
  // -------------------------------------------------------------------------
  // The CSRF bootstrap. A cross-subdomain client cannot read the host-only
  // cookie, so it asks for the value instead — see `ensureCsrfCookie`.
  //
  // Unauthenticated on purpose: the token is needed *before* sign-in, which is
  // the first state-changing request a visitor makes. It authorises nothing on
  // its own; it only proves a request came from script that an allowed origin
  // was able to read a response on.
  //
  // A GET, so the global CSRF hook does not demand a token in order to obtain
  // a token.
  app.get(
    '/v1/auth/csrf',
    { config: { rateLimit: { max: 60, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      const csrfToken = ensureCsrfCookie(request, reply, config);

      // Never cached. A stored copy served to a second person would put one
      // browser's token into another's page, where it matches no cookie and
      // every write fails.
      void reply.header('Cache-Control', 'no-store');

      return { csrfToken };
    },
  );

  // -------------------------------------------------------------------------
  // POST /v1/auth/otp/request
  // -------------------------------------------------------------------------
  app.post(
    '/v1/auth/otp/request',
    {
      config: {
        // Tight limit: this endpoint sends SMS, which costs money and can be
        // weaponised to spam a stranger's phone.
        rateLimit: { max: 5, timeWindow: '10 minutes' },
      },
    },
    async (request) => {
      const body = otpRequestSchema.parse(request.body);
      const destination = destinationOf(body);

      const identity = await prisma.identity.findUnique({
        where:
          destination.channel === 'sms'
            ? { phone: destination.value }
            : { email: destination.value },
        // `emailVerifiedAt` gates the email channel only. An address nobody has
        // proved must not be able to receive a sign-in code, or signup would be
        // a way to take over an account by claiming somebody else's address.
        select: { id: true, status: true, emailVerifiedAt: true, displayName: true },
      });

      // Always return the same shape, account or not.
      let issuedCode: string | null = null;

      const usable =
        identity !== null &&
        identity.status === 'active' &&
        (destination.channel === 'sms' || identity.emailVerifiedAt !== null);

      // Per-destination throttle (see OTP_RESEND_COOLDOWN_SECONDS). Only an
      // account can have codes, so only an account can be throttled, and a
      // throttled request is answered exactly like every other one.
      const throttled = usable && (await destinationThrottled(destination.value));

      if (identity && usable && !throttled) {
        const code = generateOtp(6);

        // Invalidate any outstanding codes for this destination so an older code
        // cannot be used after a new one is requested.
        await prisma.otpChallenge.updateMany({
          where: { destination: destination.value, purpose: body.purpose, consumedAt: null },
          data: { consumedAt: new Date() },
        });

        const challenge = await prisma.otpChallenge.create({
          data: {
            identityId: identity.id,
            destination: destination.value,
            channel: destination.channel,
            codeHash: await hashOtp(code),
            purpose: body.purpose,
            maxAttempts: config.OTP_MAX_ATTEMPTS,
            expiresAt: new Date(Date.now() + config.OTP_TTL_SECONDS * 1000),
          },
          select: { id: true },
        });

        const message = {
          code,
          ttlSeconds: config.OTP_TTL_SECONDS,
          purpose: body.purpose,
          displayName: identity.displayName,
        };
        try {
          if (destination.channel === 'sms') await sendOtpSms(sms, destination.value, message);
          else await sendOtpEmail(email, destination.value, message);
          issuedCode = code;
        } catch (error) {
          // A delivery failure (SES refusing an unverified address while the
          // account is sandboxed, a provider outage) happens only for a real
          // account, so answering it differently would tell a caller the
          // account exists. Answer as usual, retire the code that never
          // arrived, and record the failure without the body.
          await prisma.otpChallenge.update({
            where: { id: challenge.id },
            data: { consumedAt: new Date() },
          });
          request.log.warn(
            {
              channel: destination.channel,
              reference: otpReference(body.purpose),
              provider: destination.channel === 'sms' ? sms.providerName : email.providerName,
              ...describeDeliveryFailure(error),
            },
            'otp delivery failed',
          );
        }
      } else {
        // The issuing path's dominant cost is the hash; pay it here too.
        await hashOtp(generateOtp(6));
      }

      // Development convenience: return the code in the response so local work
      // and automated tests do not need to scrape a log.
      //
      // Two independent guards, because leaking this in production would hand
      // every account to anyone who knows a phone number:
      //   1. NODE_ENV must not be production — checked here.
      //   2. DEV_EXPOSE_OTP must be true — and `config.ts` refuses to start a
      //      production process with that flag set at all.
      // Either one alone would be sufficient; both are cheap.
      const exposeCode =
        config.DEV_EXPOSE_OTP && config.NODE_ENV !== 'production' && issuedCode !== null;

      return {
        sent: true,
        expiresInSeconds: config.OTP_TTL_SECONDS,
        // A constant, never account-dependent: the client counts down before
        // offering "Send again", which is also when the server would send.
        resendAfterSeconds: config.OTP_RESEND_COOLDOWN_SECONDS,
        message: 'If that account exists, a code is on its way.',
        // Note this is only ever present for a real account, so it cannot be
        // used to distinguish one — the absence of the field is identical to
        // the response for an unknown number in production, where it is never
        // present at all.
        ...(exposeCode ? { devCode: issuedCode } : {}),
      };
    },
  );

  // -------------------------------------------------------------------------
  // POST /v1/auth/otp/verify
  // -------------------------------------------------------------------------
  app.post(
    '/v1/auth/otp/verify',
    { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      const body = otpVerifySchema.parse(request.body);
      const destination = destinationOf(body);

      const challenge = await prisma.otpChallenge.findFirst({
        where: {
          destination: destination.value,
          purpose: body.purpose,
          consumedAt: null,
          expiresAt: { gt: new Date() },
        },
        orderBy: { createdAt: 'desc' },
      });

      const invalid = ApiError.badRequest('That code is not valid or has expired.');
      if (!challenge || !challenge.identityId) throw invalid;

      // Burn an attempt before checking, so a crash mid-verify cannot be used to
      // get unlimited tries.
      if (challenge.attempts >= challenge.maxAttempts) {
        await prisma.otpChallenge.update({
          where: { id: challenge.id },
          data: { consumedAt: new Date() },
        });
        throw ApiError.tooManyRequests('Too many incorrect attempts. Request a new code.');
      }
      await prisma.otpChallenge.update({
        where: { id: challenge.id },
        data: { attempts: { increment: 1 } },
      });

      if (!(await verifyOtp(body.code, challenge.codeHash))) throw invalid;

      // Single use.
      await prisma.otpChallenge.update({
        where: { id: challenge.id },
        data: { consumedAt: new Date() },
      });

      if (body.purpose === 'step_up') {
        const actor = await authenticate(request);
        await markSteppedUp(prisma, actor.sessionId);
        await writeAudit(prisma, {
          identityId: actor.identityId,
          action: 'auth.step_up.completed',
          resourceType: 'session',
          resourceId: actor.sessionId,
          ipAddress: request.ip,
          requestId: request.id,
        });
        return { steppedUp: true };
      }

      const session = await createSession(
        prisma,
        challenge.identityId,
        config.REFRESH_TOKEN_TTL_SECONDS,
        { ipAddress: request.ip, userAgent: request.headers['user-agent'] ?? null },
      );

      const tokens = await issueAccessFor(challenge.identityId, session.sessionId);
      if (!tokens) throw ApiError.unauthorized('This account is not available.');

      const { csrfToken } = issueAuthCookies(reply, config, session.refreshToken);

      await writeAudit(prisma, {
        identityId: challenge.identityId,
        action: 'auth.login.otp',
        resourceType: 'identity',
        resourceId: challenge.identityId,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
        requestId: request.id,
      });

      return { ...tokens, csrfToken };
    },
  );

  // -------------------------------------------------------------------------
  // POST /v1/auth/login  (staff and vendor users)
  // -------------------------------------------------------------------------
  app.post(
    '/v1/auth/login',
    { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const body = passwordLoginSchema.parse(request.body);

      const identity = await prisma.identity.findUnique({
        where: { email: body.email },
        select: {
          id: true,
          status: true,
          passwordHash: true,
          mfaSecretCipher: true,
          mfaEnrolledAt: true,
          roles: { select: { role: true } },
        },
      });

      // Compare against a decoy when the account does not exist, so the response
      // time is the same either way and cannot be used to enumerate emails.
      const storedHash = identity?.passwordHash ?? (await getDecoyHash());
      const passwordMatches = await verifyPassword(body.password, storedHash);

      if (!identity || !identity.passwordHash || !passwordMatches) {
        // Deliberately vague — never "no such account" or "wrong password".
        throw ApiError.unauthorized('Those sign-in details are not correct.');
      }
      if (identity.status !== 'active') {
        throw ApiError.unauthorized('Those sign-in details are not correct.');
      }

      // --- Second factor -------------------------------------------------
      // A staff password on its own must never produce a session. If this
      // identity holds a role that requires MFA, the password stage ends here
      // with a short-lived challenge and nothing else: no access token, no
      // refresh cookie, no CSRF token.
      const roles = identity.roles.map((row) => row.role as Role);

      if (config.MFA_ENABLED && requiresMfa(roles)) {
        const challenge = await createChallenge(prisma, identity.id, 'login', {
          ipAddress: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
        });

        await writeAudit(prisma, {
          identityId: identity.id,
          action: 'auth.login.password_stage_passed',
          resourceType: 'identity',
          resourceId: identity.id,
          after: { stage: isMfaActive(identity) ? 'verify' : 'enrol' },
          ipAddress: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
          requestId: request.id,
        });

        return {
          mfaRequired: true,
          // "verify" means prove possession of an existing authenticator.
          // "enrol" means set one up now — the account holds a privileged role
          // but has never completed enrolment, so it cannot be let in either.
          stage: isMfaActive(identity) ? ('verify' as const) : ('enrol' as const),
          challengeToken: challenge.challengeToken,
          expiresAt: challenge.expiresAt,
        };
      }

      const session = await createSession(
        prisma,
        identity.id,
        config.REFRESH_TOKEN_TTL_SECONDS,
        { ipAddress: request.ip, userAgent: request.headers['user-agent'] ?? null },
      );

      const tokens = await issueAccessFor(identity.id, session.sessionId);
      if (!tokens) throw ApiError.unauthorized('This account is not available.');

      const { csrfToken } = issueAuthCookies(reply, config, session.refreshToken);

      await writeAudit(prisma, {
        identityId: identity.id,
        action: 'auth.login.password',
        resourceType: 'identity',
        resourceId: identity.id,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
        requestId: request.id,
      });

      return { ...tokens, csrfToken };
    },
  );

  // -------------------------------------------------------------------------
  // POST /v1/auth/refresh
  // -------------------------------------------------------------------------
  app.post(
    '/v1/auth/refresh',
    { config: { rateLimit: { max: 60, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      // Read from the cookie only. Accepting a body field as a fallback would
      // reopen exactly the hole the cookie closes, and would let an attacker who
      // phished a token replay it without ever touching the browser.
      const presented = readRefreshCookie(request);
      if (!presented) {
        // No cookie at all: clear anything stale and make the client sign in.
        clearAuthCookies(reply, config);
        throw ApiError.unauthorized('Your session has expired. Please sign in again.');
      }

      let rotated;
      try {
        rotated = await rotateSession(prisma, presented, config.REFRESH_TOKEN_TTL_SECONDS, {
          ipAddress: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
        });
      } catch (error) {
        // Any failure — unknown, expired, revoked, or REUSED — ends with the
        // cookies cleared. On reuse, rotateSession has already revoked the whole
        // session family; leaving the cookie in place would just produce a retry
        // loop against a dead session.
        clearAuthCookies(reply, config);
        if (error instanceof SessionError && error.reason === 'reused') {
          request.log.warn(
            { ip: request.ip, userAgent: request.headers['user-agent'] },
            'refresh token reuse detected — session family revoked',
          );
        }
        throw error;
      }

      const tokens = await issueAccessFor(rotated.identityId, rotated.sessionId);
      if (!tokens) {
        clearAuthCookies(reply, config);
        throw ApiError.unauthorized('This account is not available.');
      }

      // Rotation means a NEW refresh token every time, so the cookie is reset
      // on every call. A CSRF token is reissued alongside it.
      const { csrfToken } = issueAuthCookies(reply, config, rotated.refreshToken);

      return { ...tokens, csrfToken };
    },
  );

  // -------------------------------------------------------------------------
  // POST /v1/auth/logout
  // -------------------------------------------------------------------------
  app.post('/v1/auth/logout', { preHandler: requireAuth }, async (request, reply) => {
    const actor = actorOf(request);

    // Silence this installation before the session goes, while the link from
    // session to device is still readable. Signing out on a shared handset is
    // the case that matters: the next person to sign in must not keep
    // receiving the last person's offers, and rebinding on their registration
    // only helps once they actually register.
    const session = await prisma.session.findUnique({
      where: { id: actor.sessionId },
      select: { device: { select: { pushToken: true } } },
    });
    const token = session?.device?.pushToken;
    if (token) await revokeDeviceToken(prisma, token);

    await revokeSession(prisma, actor.sessionId, 'user_logout');

    // Clearing the cookies matters as much as revoking the session: a browser
    // that keeps sending a dead refresh cookie gets a 401 loop on every page
    // load, and the user cannot tell that from a broken app.
    clearAuthCookies(reply, config);
    await writeAudit(prisma, {
      identityId: actor.identityId,
      action: 'auth.logout',
      resourceType: 'session',
      resourceId: actor.sessionId,
      ipAddress: request.ip,
      requestId: request.id,
    });
    return { signedOut: true };
  });

  // -------------------------------------------------------------------------
  // POST /v1/auth/logout-everywhere
  // -------------------------------------------------------------------------
  app.post('/v1/auth/logout-everywhere', { preHandler: requireAuth }, async (request, reply) => {
    const actor = actorOf(request);
    const count = await revokeAllSessions(prisma, actor.identityId, 'user_logout_all');

    // Push tokens go with the sessions.
    //
    // Someone signing out everywhere has usually lost a device, and a session
    // revocation that left notifications arriving on it would be a promise
    // half kept — the phone in someone else's hand would keep buzzing with
    // their work. The push path never consults the session, so it has to be
    // told separately.
    const devicesSilenced = await revokeAllDeviceTokens(prisma, actor.identityId);

    clearAuthCookies(reply, config);
    await writeAudit(prisma, {
      identityId: actor.identityId,
      action: 'auth.logout_all',
      resourceType: 'identity',
      resourceId: actor.identityId,
      after: { sessionsRevoked: count, devicesSilenced },
      ipAddress: request.ip,
      requestId: request.id,
    });
    return { signedOut: true, sessionsRevoked: count };
  });

  // -------------------------------------------------------------------------
  // GET /v1/auth/me
  // -------------------------------------------------------------------------
  app.get('/v1/auth/me', { preHandler: requireAuth }, async (request) => {
    const actor = actorOf(request);

    const identity = await prisma.identity.findUnique({
      where: { id: actor.identityId },
      select: {
        id: true,
        phone: true,
        email: true,
        displayName: true,
        locale: true,
        createdAt: true,
      },
    });
    if (!identity) throw ApiError.unauthorized();

    // A rider's own working state, so their app can recover it after a restart.
    //
    // Without this the client had no way to learn it: availability was only
    // ever set locally by the "go online" button, so relaunching the app reset
    // it to `offline` in the UI while the server still had the rider working.
    // Everything gated on that flag — the offer subscription and the GPS
    // reporting loop — then stopped silently, and the rider was invisible to
    // dispatch while their own screen looked normal.
    const riderState = actor.riderId
      ? await prisma.rider.findUnique({
          where: { id: actor.riderId },
          select: { availability: true, status: true },
        })
      : null;

    return {
      identity,
      roles: actor.roles,
      // The client uses this to decide which buttons to render. It is a
      // convenience only — every permission is re-checked server-side.
      permissions: [...actor.permissions],
      vendorId: actor.vendorId ?? null,
      riderId: actor.riderId ?? null,
      riderAvailability: riderState?.availability ?? null,
      // Whether this identity may actually work as a rider, which is not the
      // same question as whether it has a rider profile. A pending, suspended
      // or rejected rider still has a `riderId`; only `approved` may switch
      // into rider mode, and the server refuses the rider routes to the rest
      // regardless of what any client believes. Returned so the app can hide
      // an option it would not be allowed to use, never so it can grant one.
      riderStatus: riderState?.status ?? null,
      customerId: actor.customerId ?? null,
      // The cities this actor is scoped to, so the dispatch board knows which
      // `city:` topics to follow. Their own scope, derived server-side from
      // their role rows and already implicit in every ops response they get —
      // this discloses nothing they could not infer from the board itself.
      // Empty for an unscoped ops role, which reaches every city.
      cityIds: actor.cityIds ? [...actor.cityIds] : [],
      steppedUpAt: actor.steppedUpAt ?? null,
    };
  });

  // -------------------------------------------------------------------------
  // GET /v1/auth/sessions — device management
  // -------------------------------------------------------------------------
  app.get('/v1/auth/sessions', { preHandler: requireAuth }, async (request) => {
    const actor = actorOf(request);
    const sessions = await prisma.session.findMany({
      where: { identityId: actor.identityId, revokedAt: null, expiresAt: { gt: new Date() } },
      select: {
        id: true,
        ipAddress: true,
        userAgent: true,
        createdAt: true,
        lastSeenAt: true,
        expiresAt: true,
      },
      orderBy: { lastSeenAt: 'desc' },
    });

    return {
      sessions: sessions.map((session) => ({
        ...session,
        isCurrent: session.id === actor.sessionId,
      })),
    };
  });

  // -------------------------------------------------------------------------
  // DELETE /v1/auth/sessions/:id
  // -------------------------------------------------------------------------
  app.delete<{ Params: { id: string } }>(
    '/v1/auth/sessions/:id',
    { preHandler: requireAuth },
    async (request) => {
      const actor = actorOf(request);

      // Scope check: you may only revoke your own sessions. Without this, any
      // signed-in user could sign out any other user by guessing a session id.
      const target = await prisma.session.findUnique({
        where: { id: request.params.id },
        select: { id: true, identityId: true },
      });
      if (!target || target.identityId !== actor.identityId) {
        throw ApiError.notFound();
      }

      await revokeSession(prisma, target.id, 'revoked_by_user');
      return { revoked: true };
    },
  );
}
