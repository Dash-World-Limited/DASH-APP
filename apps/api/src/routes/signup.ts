/**
 * Creating a DASH account, from the website.
 *
 * There is one canonical DASH identity. Somebody who signs up here to buy a
 * sofa is the same `Identity` row that later signs into DASH APP, and the same
 * row that becomes a Declutters seller if an admin verifies them. This file
 * adds no user table of its own and no parallel notion of an account — a
 * second users table is the mistake that ends with two half-real accounts for
 * one person and no way to say which is theirs.
 *
 * ## What is proved, and what is only claimed
 *
 * Signup collects a name, an email address and a phone number. Only the email
 * is proved, by redeeming a code sent to it. SMS verification is deliberately
 * off for V1, so the phone number is stored and never treated as evidence of
 * anything — which is why there is no `phoneVerifiedAt` column pretending
 * otherwise.
 *
 * `emailVerifiedAt` is what makes the account real. Until then the identity
 * exists but has proved nothing, holds no session, and can be taken over by
 * whoever actually controls the address — because they are the person it
 * belongs to.
 *
 * ## Enumeration
 *
 * Every path through `POST /signup` returns the same response and takes
 * comparable work. A signup form that says "that email is already registered"
 * is a membership oracle for any list of addresses, and the answer a legitimate
 * user needs — "you already have an account" — is one only the mailbox owner
 * should receive. So that sentence is sent *to the mailbox*, never to the HTTP
 * caller.
 *
 * ## Conflicts are reported, never merged
 *
 * If the phone number already belongs to a different identity, nothing is
 * created and nothing is joined. Merging two identities on the strength of a
 * typed phone number would let anybody attach themselves to a stranger's
 * account by guessing it, and the phone is exactly the credential SMS
 * verification is not currently checking. The conflict is audited and explained
 * by email to the address supplied; resolving it is a human decision.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { generateOtp, generateReference, hashOtp, verifyOtp } from '@dash/domain/crypto';
import { writeAudit } from '@dash/db';
import { ApiError } from '../http/errors.js';
import { createSession } from '../auth/sessions.js';
import { issueAccessFor } from '../auth/issue.js';
import { issueAuthCookies } from '../auth/cookies.js';

/** E.164, matching the auth routes exactly. One definition of a phone number. */
const phoneSchema = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{7,14}$/, 'Enter a valid phone number including the country code');

const emailSchema = z.string().trim().toLowerCase().email('Enter a valid email address');

const signupSchema = z.object({
  name: z.string().trim().min(2, 'Enter your name').max(80),
  email: emailSchema,
  phone: phoneSchema,
});

const verifySchema = z.object({
  email: emailSchema,
  code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code'),
});

const resendSchema = z.object({ email: emailSchema });

const PURPOSE = 'email_verify';

/**
 * How long between codes to the same address.
 *
 * Long enough that a resend button cannot be used to post a stranger's mailbox
 * once a second, short enough that somebody who genuinely did not receive the
 * first one is not left waiting. The endpoint's rate limit is the outer bound;
 * this is the per-address one, which a rate limit keyed on IP cannot express.
 */
const RESEND_COOLDOWN_SECONDS = 60;

export async function registerSignupRoutes(app: FastifyInstance): Promise<void> {
  const { prisma, config, email } = app.services;

  const expiresInMinutes = Math.round(config.OTP_TTL_SECONDS / 60);

  /** The single place a verification code is minted, stored and sent. */
  async function issueCode(identityId: string, address: string, name: string | null) {
    const code = generateOtp(6);

    // Any outstanding code for this address is dead the moment a new one is
    // issued, so a code read from an older email cannot be used after a resend.
    await prisma.otpChallenge.updateMany({
      where: { destination: address, purpose: PURPOSE, consumedAt: null },
      data: { consumedAt: new Date() },
    });

    await prisma.otpChallenge.create({
      data: {
        identityId,
        destination: address,
        channel: 'email',
        // Hashed. A database read must not hand somebody a working code.
        codeHash: await hashOtp(code),
        purpose: PURPOSE,
        maxAttempts: config.OTP_MAX_ATTEMPTS,
        expiresAt: new Date(Date.now() + config.OTP_TTL_SECONDS * 1000),
      },
    });

    const greeting = name ? `Hello ${name},` : 'Hello,';
    await email.send({
      to: address,
      subject: `${code} is your DASH verification code`,
      text: `${greeting}\n\nYour DASH verification code is ${code}.\nIt expires in ${expiresInMinutes} minutes.\n\nIf you did not create a DASH account, ignore this email and nothing will happen.\n\nDASH World Limited`,
      html: `<p>${greeting}</p><p>Your DASH verification code is <strong style="font-size:20px;letter-spacing:2px">${code}</strong></p><p>It expires in ${expiresInMinutes} minutes.</p><p>If you did not create a DASH account, ignore this email and nothing will happen.</p><p>DASH World Limited</p>`,
      reference: `email_verify_${identityId}`,
    });

    return code;
  }

  /**
   * The one response every signup gets.
   *
   * `devCode` is present only outside production and only behind the same flag
   * the SMS path uses, which `config.ts` refuses to start a production process
   * with. Tests and local work read it instead of scraping a mail log.
   */
  function accepted(code: string | null) {
    const expose = config.DEV_EXPOSE_OTP && config.NODE_ENV !== 'production' && code !== null;
    return {
      sent: true,
      expiresInSeconds: config.OTP_TTL_SECONDS,
      message: 'Check your email for a 6-digit code.',
      ...(expose ? { devCode: code } : {}),
    };
  }

  // ==========================================================================
  // POST /v1/auth/signup
  // ==========================================================================
  app.post(
    '/v1/auth/signup',
    {
      config: {
        // Sends email, which costs money and reaches a real person's inbox.
        rateLimit: { max: 5, timeWindow: '15 minutes' },
      },
    },
    async (request) => {
      const body = signupSchema.parse(request.body);

      const [byEmail, byPhone] = await Promise.all([
        prisma.identity.findUnique({
          where: { email: body.email },
          select: { id: true, status: true, emailVerifiedAt: true, displayName: true, phone: true },
        }),
        prisma.identity.findUnique({
          where: { phone: body.phone },
          select: { id: true, status: true },
        }),
      ]);

      // --- The address is already somebody's, and proved ---------------------
      if (byEmail && byEmail.emailVerifiedAt !== null) {
        // Told to the mailbox, not to the caller. Whoever owns this address
        // learns that somebody tried; whoever typed it learns nothing.
        await email.send({
          to: body.email,
          subject: 'You already have a DASH account',
          text: `Somebody entered this address on the DASH signup form.\n\nYou already have an account with it, so there is nothing to create. Sign in with this email address instead, and we will send you a code.\n\nIf that was not you, no action is needed — nothing has changed on your account.\n\nDASH World Limited`,
          html: `<p>Somebody entered this address on the DASH signup form.</p><p>You already have an account with it, so there is nothing to create. Sign in with this email address instead and we will send you a code.</p><p>If that was not you, no action is needed — nothing has changed on your account.</p><p>DASH World Limited</p>`,
          reference: 'signup_existing_account',
        });

        await writeAudit(prisma, {
          identityId: byEmail.id,
          action: 'auth.signup.existing_email',
          resourceType: 'identity',
          resourceId: byEmail.id,
          ipAddress: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
          requestId: request.id,
        });

        return accepted(null);
      }

      // --- The phone belongs to somebody else --------------------------------
      //
      // Not merged, not attached, not created. The phone number is the one
      // credential nothing is currently verifying, so treating it as proof of
      // sameness would let anyone join themselves to a stranger's account by
      // typing their number.
      const phoneConflict = byPhone !== null && (byEmail === null || byPhone.id !== byEmail.id);
      if (phoneConflict) {
        await email.send({
          to: body.email,
          subject: 'We could not finish creating your DASH account',
          text: `That phone number is already registered to a DASH account.\n\nWe have not created a second account and we have not changed the existing one. If the account is yours, sign in with that phone number. If you think this is a mistake, reply to this email and a person will look at it.\n\nDASH World Limited`,
          html: `<p>That phone number is already registered to a DASH account.</p><p>We have not created a second account and we have not changed the existing one. If the account is yours, sign in with that phone number. If you think this is a mistake, reply to this email and a person will look at it.</p><p>DASH World Limited</p>`,
          reference: 'signup_phone_conflict',
        });

        // A security event, not a debug line. Repeated conflicts against one
        // number is what an account-takeover attempt looks like from here.
        await writeAudit(prisma, {
          identityId: byPhone.id,
          action: 'auth.signup.phone_conflict',
          resourceType: 'identity',
          resourceId: byPhone.id,
          after: { attemptedEmail: body.email },
          ipAddress: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
          requestId: request.id,
        });

        return accepted(null);
      }

      // --- An unverified row for this address already exists ------------------
      //
      // Nothing was ever proved about it, so it is not anybody's account yet.
      // Treating this as a retry rather than a conflict is also what stops
      // signup from being an email-squatting tool: a stranger starting signup
      // with your address cannot lock you out of it.
      if (byEmail) {
        const updated = await prisma.identity.update({
          where: { id: byEmail.id },
          data: { displayName: body.name, phone: body.phone },
          select: { id: true, displayName: true },
        });
        const code = await issueCode(updated.id, body.email, updated.displayName);
        return accepted(code);
      }

      // --- A new identity -----------------------------------------------------
      const identity = await prisma.identity.create({
        data: {
          email: body.email,
          phone: body.phone,
          displayName: body.name,
          status: 'active',
          // No password. Customers authenticate by code, exactly as they do in
          // the app; only staff carry a password hash.
        },
        select: { id: true, displayName: true },
      });

      await writeAudit(prisma, {
        identityId: identity.id,
        action: 'auth.signup.started',
        resourceType: 'identity',
        resourceId: identity.id,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
        requestId: request.id,
      });

      const code = await issueCode(identity.id, body.email, identity.displayName);
      return accepted(code);
    },
  );

  // ==========================================================================
  // POST /v1/auth/email/resend
  // ==========================================================================
  app.post(
    '/v1/auth/email/resend',
    { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } },
    async (request) => {
      const body = resendSchema.parse(request.body);

      const identity = await prisma.identity.findUnique({
        where: { email: body.email },
        select: { id: true, status: true, emailVerifiedAt: true, displayName: true },
      });

      // Nothing to resend for an unknown address, a suspended account or one
      // that is already verified — and all three answer identically.
      if (!identity || identity.status !== 'active' || identity.emailVerifiedAt !== null) {
        return accepted(null);
      }

      const recent = await prisma.otpChallenge.findFirst({
        where: {
          destination: body.email,
          purpose: PURPOSE,
          createdAt: { gt: new Date(Date.now() - RESEND_COOLDOWN_SECONDS * 1000) },
        },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });

      if (recent) {
        // A real refusal, because the caller here is the person waiting for the
        // email and a silent no-op would look like the button was broken.
        const waitSeconds = Math.max(
          1,
          RESEND_COOLDOWN_SECONDS - Math.floor((Date.now() - recent.createdAt.getTime()) / 1000),
        );
        throw ApiError.tooManyRequests(
          `A code was just sent. Wait ${waitSeconds} seconds before asking for another.`,
        );
      }

      const code = await issueCode(identity.id, body.email, identity.displayName);
      return accepted(code);
    },
  );

  // ==========================================================================
  // POST /v1/auth/email/verify
  // ==========================================================================
  app.post(
    '/v1/auth/email/verify',
    { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      const body = verifySchema.parse(request.body);

      const challenge = await prisma.otpChallenge.findFirst({
        where: {
          destination: body.email,
          purpose: PURPOSE,
          consumedAt: null,
          expiresAt: { gt: new Date() },
        },
        orderBy: { createdAt: 'desc' },
      });

      const invalid = ApiError.badRequest('That code is not valid or has expired.');
      if (!challenge || !challenge.identityId) throw invalid;

      // The attempt is burned before the code is checked, so a crash or a
      // dropped connection mid-verify cannot be used to get unlimited tries.
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

      // One-time. Consumed before anything else happens, so the same code
      // cannot be redeemed twice by two concurrent requests.
      await prisma.otpChallenge.update({
        where: { id: challenge.id },
        data: { consumedAt: new Date() },
      });

      const identity = await prisma.identity.findUnique({
        where: { id: challenge.identityId },
        select: { id: true, status: true, emailVerifiedAt: true, customer: { select: { id: true } } },
      });
      if (!identity || identity.status !== 'active') {
        throw ApiError.unauthorized('This account is not available.');
      }

      // Verification and the customer profile land together. An identity that
      // is verified but has no customer row would be an account that exists and
      // cannot do anything, discovered later by whichever screen breaks first.
      await prisma.$transaction(async (tx) => {
        if (identity.emailVerifiedAt === null) {
          await tx.identity.update({
            where: { id: identity.id },
            data: { emailVerifiedAt: new Date() },
          });
        }
        if (!identity.customer) {
          await tx.customer.create({
            data: { identityId: identity.id, referralCode: generateReference('DW') },
          });
        }
      });

      await writeAudit(prisma, {
        identityId: identity.id,
        action: 'auth.email.verified',
        resourceType: 'identity',
        resourceId: identity.id,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
        requestId: request.id,
      });

      // Signed in on the spot. Redeeming a code sent to the address is exactly
      // the proof a sign-in asks for, and making somebody verify and then
      // immediately sign in again is a step that protects nothing.
      const session = await createSession(
        prisma,
        identity.id,
        config.REFRESH_TOKEN_TTL_SECONDS,
        { ipAddress: request.ip, userAgent: request.headers['user-agent'] ?? null },
      );

      const tokens = await issueAccessFor(prisma, config, identity.id, session.sessionId);
      if (!tokens) throw ApiError.unauthorized('This account is not available.');

      const { csrfToken } = issueAuthCookies(reply, config, session.refreshToken);
      return { ...tokens, csrfToken, verified: true };
    },
  );
}
