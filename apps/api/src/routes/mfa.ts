/**
 * Administrator MFA routes.
 *
 * The login state machine:
 *
 *   POST /v1/auth/login
 *     ├─ not staff ─────────────────────► session + refresh cookie
 *     ├─ staff, MFA active ────────────► { mfaRequired, stage: "verify" }
 *     └─ staff, MFA not set up ────────► { mfaRequired, stage: "enrol" }
 *                                          │
 *   POST /v1/auth/mfa/enrol/start  ◄───────┤  (challenge token, not a session)
 *   POST /v1/auth/mfa/enrol/confirm ───────┼─► session + recovery codes
 *   POST /v1/auth/mfa/verify ──────────────┴─► session
 *
 * The bootstrapping case — a new administrator who has never enrolled — is the
 * one most systems get wrong by handing out a real session "just to let them
 * set it up". Here they get the same short-lived challenge token as anyone
 * else, it is accepted only by the two enrolment routes, and the session is
 * minted at the moment possession is proved. There is no window in which a
 * password alone carries privilege.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '@dash/db';
import { summariseRecoveryCodes } from '@dash/domain/mfa';
import { STEP_UP_MAX_AGE_SECONDS } from '@dash/domain/permissions';
import { ApiError } from '../http/errors.js';
import { actorOf, authenticate, requireAuth } from '../http/context.js';
import { issueAuthCookies } from '../auth/cookies.js';
import { createSession, markSteppedUp, revokeAllSessions } from '../auth/sessions.js';
import { issueAccessFor } from '../auth/issue.js';
import {
  claimChallengeAttempt,
  confirmEnrolment,
  consumeChallenge,
  consumeRecoveryCode,
  disableMfa,
  isMfaActive,
  regenerateRecoveryCodes,
  startEnrolment,
  verifyTotp,
} from '../auth/mfa.js';

/** Six digits. Whitespace tolerated because authenticator apps display `123 456`. */
const totpCodeSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/\s/g, ''))
  .pipe(z.string().regex(/^\d{6}$/, 'Enter the 6-digit code from your authenticator app'));

const challengeTokenSchema = z.string().trim().min(10).max(200);

const verifySchema = z
  .object({
    challengeToken: challengeTokenSchema,
    code: totpCodeSchema.optional(),
    recoveryCode: z.string().trim().min(4).max(64).optional(),
  })
  // Exactly one factor. Accepting both would let a caller probe a recovery code
  // and a TOTP against a single attempt.
  .refine(
    (body) => Boolean(body.code) !== Boolean(body.recoveryCode),
    'Provide either an authenticator code or a recovery code, not both',
  );

export async function registerMfaRoutes(app: FastifyInstance): Promise<void> {
  const { prisma, config } = app.services;

  /**
   * The keyring, resolved once at registration.
   *
   * `config.ts` guarantees a key exists whenever MFA is enabled, so this cannot
   * be null in any configuration that reaches these routes.
   */
  const keyring = app.services.keyring;

  function requireKeyring() {
    if (!keyring) {
      // Unreachable via config validation; kept as a loud failure rather than a
      // confusing null dereference if that validation is ever loosened.
      throw ApiError.internal('MFA is enabled but no encryption keyring is configured');
    }
    return keyring;
  }

  /** Mint the real session once a second factor has actually been proved. */
  async function completeSignIn(
    request: FastifyRequest,
    reply: FastifyReply,
    identityId: string,
    method: 'totp' | 'recovery_code',
  ) {
    const session = await createSession(prisma, identityId, config.REFRESH_TOKEN_TTL_SECONDS, {
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
    });

    const tokens = await issueAccessFor(prisma, config, identityId, session.sessionId);
    if (!tokens) throw ApiError.unauthorized('This account is not available.');

    const { csrfToken } = issueAuthCookies(reply, config, session.refreshToken);

    await writeAudit(prisma, {
      identityId,
      action: 'auth.mfa.login_completed',
      resourceType: 'identity',
      resourceId: identityId,
      // Which factor was used, never the value of it.
      after: { method },
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
      requestId: request.id,
    });

    return { ...tokens, csrfToken };
  }

  // -------------------------------------------------------------------------
  // POST /v1/auth/mfa/enrol/start
  //
  // Two callers: a staff member finishing first-time setup (challenge token),
  // and a signed-in user replacing their authenticator (session + step-up).
  // -------------------------------------------------------------------------
  app.post(
    '/v1/auth/mfa/enrol/start',
    { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } },
    async (request) => {
      const body = z
        .object({ challengeToken: challengeTokenSchema.optional() })
        .parse(request.body ?? {});

      let identityId: string;

      if (body.challengeToken) {
        const challenge = await claimChallengeAttempt(prisma, body.challengeToken, 'login');
        identityId = challenge.identityId;

        const existing = await prisma.identity.findUnique({
          where: { id: identityId },
          select: { mfaSecretCipher: true, mfaEnrolledAt: true },
        });
        // A challenge token is for first-time setup only. Someone already
        // enrolled must prove possession of the current authenticator before
        // replacing it, which means going through a session and a step-up.
        if (existing && isMfaActive(existing)) {
          throw ApiError.conflict('This account already has an authenticator set up.');
        }
      } else {
        await authenticate(request);
        identityId = actorOf(request).identityId;
      }

      const identity = await prisma.identity.findUnique({
        where: { id: identityId },
        select: { id: true, email: true, phone: true },
      });
      if (!identity) throw ApiError.unauthorized();

      const offer = await startEnrolment(prisma, requireKeyring(), identity);

      await writeAudit(prisma, {
        identityId,
        action: 'auth.mfa.enrolment_started',
        resourceType: 'identity',
        resourceId: identityId,
        ipAddress: request.ip,
        requestId: request.id,
      });

      // The secret is returned exactly once, here, so it can be rendered as a
      // QR code. Every later read path returns status only.
      return { secret: offer.secret, otpauthUri: offer.otpauthUri };
    },
  );

  // -------------------------------------------------------------------------
  // POST /v1/auth/mfa/enrol/confirm
  // -------------------------------------------------------------------------
  app.post(
    '/v1/auth/mfa/enrol/confirm',
    { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const body = z
        .object({
          challengeToken: challengeTokenSchema.optional(),
          code: totpCodeSchema,
        })
        .parse(request.body);

      let identityId: string;
      let challengeId: string | null = null;

      if (body.challengeToken) {
        const challenge = await claimChallengeAttempt(prisma, body.challengeToken, 'login');
        identityId = challenge.identityId;
        challengeId = challenge.id;
      } else {
        await authenticate(request);
        identityId = actorOf(request).identityId;
      }

      const { recoveryCodes } = await confirmEnrolment(
        prisma,
        requireKeyring(),
        identityId,
        body.code,
      );

      await writeAudit(prisma, {
        identityId,
        action: 'auth.mfa.enrolment_confirmed',
        resourceType: 'identity',
        resourceId: identityId,
        after: { recoveryCodesIssued: recoveryCodes.length },
        ipAddress: request.ip,
        requestId: request.id,
      });

      // First-time setup completes the sign-in it started; re-enrolment from an
      // existing session does not need a second one.
      if (challengeId) {
        await consumeChallenge(prisma, challengeId);
        const tokens = await completeSignIn(request, reply, identityId, 'totp');
        return { ...tokens, recoveryCodes };
      }

      return { enrolled: true, recoveryCodes };
    },
  );

  // -------------------------------------------------------------------------
  // POST /v1/auth/mfa/verify — second stage of a normal sign-in
  // -------------------------------------------------------------------------
  app.post(
    '/v1/auth/mfa/verify',
    { config: { rateLimit: { max: 15, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const body = verifySchema.parse(request.body);

      const challenge = await claimChallengeAttempt(prisma, body.challengeToken, 'login');

      if (body.recoveryCode) {
        await consumeRecoveryCode(prisma, challenge.identityId, body.recoveryCode, request.ip);
      } else {
        await verifyTotp(prisma, requireKeyring(), challenge.identityId, body.code!);
      }

      await consumeChallenge(prisma, challenge.id);

      const tokens = await completeSignIn(
        request,
        reply,
        challenge.identityId,
        body.recoveryCode ? 'recovery_code' : 'totp',
      );

      // Tell the user how many codes are left so an exhausted set is noticed
      // before it is a lockout.
      if (body.recoveryCode) {
        const codes = await prisma.mfaRecoveryCode.findMany({
          where: { identityId: challenge.identityId },
          select: { usedAt: true },
        });
        return { ...tokens, recoveryCodes: summariseRecoveryCodes(codes) };
      }

      return tokens;
    },
  );

  // -------------------------------------------------------------------------
  // POST /v1/auth/mfa/step-up — prove possession again inside a live session
  // -------------------------------------------------------------------------
  app.post(
    '/v1/auth/mfa/step-up',
    {
      preHandler: requireAuth,
      config: { rateLimit: { max: 15, timeWindow: '15 minutes' } },
    },
    async (request) => {
      const body = z.object({ code: totpCodeSchema }).parse(request.body);
      const actor = actorOf(request);

      await verifyTotp(prisma, requireKeyring(), actor.identityId, body.code);
      await markSteppedUp(prisma, actor.sessionId);

      await writeAudit(prisma, {
        identityId: actor.identityId,
        action: 'auth.mfa.step_up_completed',
        resourceType: 'session',
        resourceId: actor.sessionId,
        ipAddress: request.ip,
        requestId: request.id,
      });

      return { steppedUp: true };
    },
  );

  // -------------------------------------------------------------------------
  // GET /v1/auth/mfa — status only, never the secret
  // -------------------------------------------------------------------------
  app.get('/v1/auth/mfa', { preHandler: requireAuth }, async (request) => {
    const actor = actorOf(request);

    const identity = await prisma.identity.findUnique({
      where: { id: actor.identityId },
      select: { mfaSecretCipher: true, mfaEnrolledAt: true },
    });
    if (!identity) throw ApiError.unauthorized();

    const codes = await prisma.mfaRecoveryCode.findMany({
      where: { identityId: actor.identityId },
      select: { usedAt: true },
    });

    // Note what is absent: no secret, no ciphertext, no otpauth URI, no code
    // hashes. Only whether it is on and how many backups remain.
    return {
      active: isMfaActive(identity),
      enrolledAt: identity.mfaEnrolledAt,
      recoveryCodes: summariseRecoveryCodes(codes),
    };
  });

  // -------------------------------------------------------------------------
  // POST /v1/auth/mfa/recovery/regenerate
  // -------------------------------------------------------------------------
  app.post(
    '/v1/auth/mfa/recovery/regenerate',
    {
      preHandler: requireAuth,
      config: { rateLimit: { max: 5, timeWindow: '60 minutes' } },
    },
    async (request) => {
      const actor = actorOf(request);
      assertFreshStepUp(actor.steppedUpAt);

      const codes = await regenerateRecoveryCodes(prisma, actor.identityId);

      await writeAudit(prisma, {
        identityId: actor.identityId,
        action: 'auth.mfa.recovery_codes_regenerated',
        resourceType: 'identity',
        resourceId: actor.identityId,
        after: { issued: codes.length },
        ipAddress: request.ip,
        requestId: request.id,
      });

      return { recoveryCodes: codes };
    },
  );

  // -------------------------------------------------------------------------
  // POST /v1/auth/mfa/disable
  // -------------------------------------------------------------------------
  app.post(
    '/v1/auth/mfa/disable',
    {
      preHandler: requireAuth,
      config: { rateLimit: { max: 5, timeWindow: '60 minutes' } },
    },
    async (request) => {
      const actor = actorOf(request);
      assertFreshStepUp(actor.steppedUpAt);

      await disableMfa(prisma, actor.identityId);

      // Every existing session dies. Turning off a second factor is exactly the
      // moment an attacker who has one foot in the door would act, so the door
      // is closed on everyone including them — and including the caller, who
      // must sign in again.
      const revoked = await revokeAllSessions(prisma, actor.identityId, 'mfa_disabled');

      await writeAudit(prisma, {
        identityId: actor.identityId,
        action: 'auth.mfa.disabled',
        resourceType: 'identity',
        resourceId: actor.identityId,
        after: { sessionsRevoked: revoked },
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
        requestId: request.id,
      });

      return { disabled: true, sessionsRevoked: revoked };
    },
  );

}

/**
 * Require a recent step-up.
 *
 * Regenerating recovery codes and disabling MFA both let someone who has
 * borrowed a live session lock the real owner out. Neither is reachable without
 * proving possession again within the step-up window.
 */
function assertFreshStepUp(steppedUpAt: Date | undefined): void {
  if (!steppedUpAt) {
    throw new ApiError(403, 'step_up_required', 'Confirm your identity to continue.');
  }
  const ageSeconds = (Date.now() - steppedUpAt.getTime()) / 1000;
  if (ageSeconds > STEP_UP_MAX_AGE_SECONDS || ageSeconds < 0) {
    throw new ApiError(403, 'step_up_required', 'Confirm your identity to continue.');
  }
}
