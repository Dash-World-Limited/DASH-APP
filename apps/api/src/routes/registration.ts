/**
 * Public customer registration.
 *
 * Registration is intentionally separate from login. Unknown phone numbers can
 * request a one-time code, prove possession, and only then cause an Identity +
 * Customer row to be created. Existing accounts are never overwritten.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { generateOtp, generateReference, hashOtp, verifyOtp } from '@dash/domain/crypto';
import { writeAudit } from '@dash/db';
import { ApiError } from '../http/errors.js';
import { createSession } from '../auth/sessions.js';
import { issueAccessFor as issueAccessForShared } from '../auth/issue.js';
import { issueAuthCookies } from '../auth/cookies.js';

const phoneSchema = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{7,14}$/, 'Enter a valid phone number including the country code');

const requestSchema = z.object({ phone: phoneSchema });

const verifySchema = z.object({
  phone: phoneSchema,
  code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code'),
  displayName: z.string().trim().min(2).max(80),
  email: z.string().trim().toLowerCase().email().optional().or(z.literal('')),
  marketingOptIn: z.boolean().default(false),
});

export async function registerRegistrationRoutes(app: FastifyInstance): Promise<void> {
  const { prisma, config, sms } = app.services;

  app.post(
    '/v1/auth/register/request',
    { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } },
    async (request) => {
      const body = requestSchema.parse(request.body);
      const existing = await prisma.identity.findUnique({
        where: { phone: body.phone },
        select: { id: true, status: true },
      });

      const code = generateOtp(6);

      await prisma.otpChallenge.updateMany({
        where: { destination: body.phone, purpose: 'register', consumedAt: null },
        data: { consumedAt: new Date() },
      });

      const challenge = await prisma.otpChallenge.create({
        data: {
          identityId: existing?.id ?? null,
          destination: body.phone,
          channel: 'sms',
          codeHash: await hashOtp(code),
          purpose: 'register',
          maxAttempts: config.OTP_MAX_ATTEMPTS,
          expiresAt: new Date(Date.now() + config.OTP_TTL_SECONDS * 1000),
        },
      });

      // Send only when the account is new or active. A suspended/deleted account
      // should not be re-created through self-service registration.
      if (!existing || existing.status === 'active') {
        await sms.send({
          to: body.phone,
          body: `Your DASH code is ${code}. It expires in ${Math.round(config.OTP_TTL_SECONDS / 60)} minutes.`,
          reference: 'otp_register',
        });
      }

      const exposeCode = config.DEV_EXPOSE_OTP && config.NODE_ENV !== 'production';
      return {
        sent: true,
        expiresInSeconds: config.OTP_TTL_SECONDS,
        message: 'If this number can be registered, a code is on its way.',
        ...(exposeCode ? { devCode: code, challengeId: challenge.id } : {}),
      };
    },
  );

  app.post(
    '/v1/auth/register/verify',
    { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      const body = verifySchema.parse(request.body);

      const challenge = await prisma.otpChallenge.findFirst({
        where: {
          destination: body.phone,
          purpose: 'register',
          consumedAt: null,
          expiresAt: { gt: new Date() },
        },
        orderBy: { createdAt: 'desc' },
      });

      const invalid = ApiError.badRequest('That code is not valid or has expired.');
      if (!challenge) throw invalid;

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

      await prisma.otpChallenge.update({
        where: { id: challenge.id },
        data: { consumedAt: new Date() },
      });

      // A verified existing number should sign in instead of creating a second
      // account. We reveal this only after the caller has proved possession of
      // the phone number.
      if (challenge.identityId) {
        throw ApiError.conflict('An account already exists for this number. Please sign in.');
      }

      const email = body.email || null;

      if (email) {
        const emailOwner = await prisma.identity.findUnique({
          where: { email },
          select: { id: true },
        });
        if (emailOwner) {
          throw ApiError.conflict('That email address is already in use.');
        }
      }

      const identity = await prisma.$transaction(async (tx) => {
        // Re-check inside the transaction to close the race between OTP request
        // and verification.
        const duplicate = await tx.identity.findUnique({
          where: { phone: body.phone },
          select: { id: true },
        });
        if (duplicate) {
          throw ApiError.conflict('An account already exists for this number. Please sign in.');
        }

        return tx.identity.create({
          data: {
            phone: body.phone,
            email,
            displayName: body.displayName,
            roles: { create: { role: 'customer' } },
            customer: {
              create: {
                referralCode: generateReference('REF', 8),
                marketingOptIn: body.marketingOptIn,
              },
            },
          },
          select: { id: true },
        });
      });

      const session = await createSession(
        prisma,
        identity.id,
        config.REFRESH_TOKEN_TTL_SECONDS,
        { ipAddress: request.ip, userAgent: request.headers['user-agent'] ?? null },
      );

      const tokens = await issueAccessForShared(prisma, config, identity.id, session.sessionId);
      if (!tokens) throw ApiError.unauthorized('This account is not available.');

      const { csrfToken } = issueAuthCookies(reply, config, session.refreshToken);

      await writeAudit(prisma, {
        identityId: identity.id,
        action: 'auth.register.customer',
        resourceType: 'identity',
        resourceId: identity.id,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
        requestId: request.id,
      });

      return { ...tokens, csrfToken };
    },
  );
}
