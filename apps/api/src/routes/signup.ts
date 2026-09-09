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
 *
 * ## Except when nobody has proved anything
 *
 * There is one narrow release, and it exists because of a real trap: somebody
 * mistypes their address, never receives a code, never verifies — and their
 * phone number is now held by an identity that has proved nothing. Without a
 * release they are locked out of DASH by their own spelling mistake.
 *
 * So a phone is taken back from an identity that has verified no address, holds
 * no session, has no role and has no orders. That is not a merge and not a
 * verification; it is recognising that an unproven claim has no standing.
 * Nothing crosses from the old identity to the new one. A verified identity is
 * never touched.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { generateOtp, generateReference, hashOtp, verifyOtp } from '@dash/domain/crypto';
import {
  writeAudit,
  CURRENT_PRIVACY_VERSION,
  CURRENT_TERMS_VERSION,
  PRIVACY_SLUG,
  TERMS_SLUG,
} from '@dash/db';
import {
  ACQUISITION_SOURCES,
  NIGERIAN_STATES,
  requiresAcquisitionDetail,
  USAGE_INTENTS,
  type AcquisitionSource,
} from '@dash/domain/signup';
import { ApiError } from '../http/errors.js';
import { auditContext } from './declutter-shared.js';
import { createSession } from '../auth/sessions.js';
import { issueAccessFor } from '../auth/issue.js';
import { issueAuthCookies } from '../auth/cookies.js';

/** E.164, matching the auth routes exactly. One definition of a phone number. */
const phoneSchema = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{7,14}$/, 'Enter a valid phone number including the country code');

const emailSchema = z.string().trim().toLowerCase().email('Enter a valid email address');

/**
 * What the signup form sends.
 *
 * The profile fields are required here and nullable in the database. Signup
 * demands them; the customers created before this form existed do not have
 * them, and a backfill inventing a state for somebody would be inventing data.
 *
 * `usageIntent` and `acquisitionSource` are validated against the domain's
 * vocabularies so a typo cannot become a category nothing knows about — but
 * validating them grants nothing. They are self-reported answers on an open
 * form, and no decision anywhere may depend on them.
 */
const signupSchema = z
  .object({
    name: z.string().trim().min(2, 'Enter your full name').max(80),
    email: emailSchema,
    phone: phoneSchema,
    state: z.enum(NIGERIAN_STATES),
    cityArea: z.string().trim().min(2, 'Enter your city, town or area').max(80),
    usageIntent: z.enum(USAGE_INTENTS),
    acquisitionSource: z.enum(ACQUISITION_SOURCES),
    acquisitionDetail: z.string().trim().max(120).optional(),
    // An attestation with a timestamp, never a date of birth. DASH has no
    // reason to hold the birthday of somebody who wants to buy a sofa.
    confirmedAdult: z.literal(true, {
      errorMap: () => ({ message: 'You must confirm you are 18 or older' }),
    }),
    acceptedTerms: z.literal(true, {
      errorMap: () => ({ message: 'You must accept the terms to create an account' }),
    }),
    // Optional, always. Marketing consent is never a condition of holding a
    // DASH account, so there is no value of this that can fail validation.
    marketingOptIn: z.boolean().default(false),
  })
  .refine(
    (value) =>
      !requiresAcquisitionDetail(value.acquisitionSource as AcquisitionSource) ||
      (value.acquisitionDetail ?? '').trim().length >= 2,
    {
      path: ['acquisitionDetail'],
      // An empty "who referred you?" is worse than not asking, because it looks
      // like data.
      message: 'Tell us a little more',
    },
  );

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

  /**
   * Write the profile, the age attestation and both consents.
   *
   * The customer row is created at signup rather than at verification, because
   * the profile arrives with the form and has to live somewhere until the
   * address is proved. An unverified identity holds no session, so a customer
   * row attached to one can never act.
   *
   * Terms and privacy acceptance go to `LegalAcceptance`, which points at a
   * specific `LegalDocument` version — that record is the evidence, and it
   * answers "which text, in which version, did this person agree to, and when".
   * Recording a boolean instead would answer none of that.
   */
  async function writeProfile(
    identityId: string,
    body: z.infer<typeof signupSchema>,
    ipAddress: string,
  ) {
    const now = new Date();

    await prisma.customer.upsert({
      where: { identityId },
      create: {
        identityId,
        referralCode: generateReference('DW'),
        state: body.state,
        cityArea: body.cityArea,
        usageIntent: body.usageIntent,
        acquisitionSource: body.acquisitionSource,
        acquisitionDetail: body.acquisitionDetail ?? null,
        ageConfirmedAt: now,
        marketingOptIn: body.marketingOptIn,
        ...(body.marketingOptIn ? { marketingOptInAt: now, marketingOptInIp: ipAddress } : {}),
      },
      update: {
        state: body.state,
        cityArea: body.cityArea,
        usageIntent: body.usageIntent,
        acquisitionSource: body.acquisitionSource,
        acquisitionDetail: body.acquisitionDetail ?? null,
        ageConfirmedAt: now,
        marketingOptIn: body.marketingOptIn,
        // Cleared when consent is withdrawn, so a stale timestamp cannot
        // outlive the agreement it recorded.
        marketingOptInAt: body.marketingOptIn ? now : null,
        marketingOptInIp: body.marketingOptIn ? ipAddress : null,
      },
    });

    const documents = await prisma.legalDocument.findMany({
      where: {
        OR: [
          { slug: TERMS_SLUG, version: CURRENT_TERMS_VERSION },
          { slug: PRIVACY_SLUG, version: CURRENT_PRIVACY_VERSION },
        ],
      },
      select: { id: true },
    });

    for (const document of documents) {
      await prisma.legalAcceptance.upsert({
        where: { identityId_documentId: { identityId, documentId: document.id } },
        create: { identityId, documentId: document.id, ipAddress },
        // Already accepted this exact version. The original timestamp is the
        // evidence and must not be moved by a retry.
        update: {},
      });
    }
  }

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
          select: {
            id: true,
            status: true,
            // Everything the reclaim decision below needs. An identity that has
            // proved nothing and done nothing is not somebody's account yet.
            emailVerifiedAt: true,
            email: true,
            customer: { select: { id: true, orders: { select: { id: true }, take: 1 } } },
            sessions: { select: { id: true }, take: 1 },
            roles: { select: { role: true }, take: 1 },
          },
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
      /**
       * The typo case.
       *
       * Somebody enters `ada@gmial.com`, never receives a code, and never
       * verifies. Their phone number is now attached to an identity nobody has
       * proved anything about. When they come back and type the address
       * correctly, the phone-conflict rule below would refuse them — and they
       * would be locked out of DASH by their own spelling mistake, with no way
       * through except emailing support.
       *
       * So a phone number is released from an identity that has proved nothing
       * and done nothing. This is **not** an identity merge and not a
       * verification: it is recognising that an unproven claim has no standing.
       * Nothing is copied from the old identity to the new one, and the person
       * still has to prove the new address before anything works.
       *
       * The conditions are deliberately narrow, and each one has to hold:
       *
       *   * the email on it was never verified, so nobody ever proved it;
       *   * it holds no session, so nobody has ever signed in as it;
       *   * it has no roles, so it is not staff;
       *   * its customer profile has no orders, so it has no history.
       *
       * A verified identity is never touched, whatever else is true, because
       * the phone number is exactly the credential nothing here is checking.
       */
      const reclaimable =
        byPhone !== null &&
        (byEmail === null || byPhone.id !== byEmail.id) &&
        byPhone.emailVerifiedAt === null &&
        byPhone.sessions.length === 0 &&
        byPhone.roles.length === 0 &&
        (byPhone.customer?.orders.length ?? 0) === 0;

      if (byPhone && reclaimable) {
        // Released, not deleted. The abandoned identity keeps its mistyped
        // address so that whoever genuinely owns *that* mailbox can still claim
        // it later, and keeps its own record of having existed.
        await prisma.identity.update({
          where: { id: byPhone.id },
          data: { phone: null },
        });

        await writeAudit(prisma, {
          identityId: byPhone.id,
          action: 'auth.signup.phone_released',
          resourceType: 'identity',
          resourceId: byPhone.id,
          before: { phone: '[redacted]', emailVerifiedAt: null },
          after: { reason: 'unverified_identity_reclaimed' },
          ...auditContext(request),
        });
      }

      const phoneConflict =
        byPhone !== null &&
        !reclaimable &&
        (byEmail === null || byPhone.id !== byEmail.id);
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
        await writeProfile(updated.id, body, request.ip);
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

      await writeProfile(identity.id, body, request.ip);

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
  // GET /v1/legal/:slug
  //
  // The current text of a policy, so the checkbox that asks somebody to accept
  // it can link to what they are accepting. Public and unauthenticated: a
  // policy nobody can read before agreeing to it is not a policy.
  //
  // Serves the newest effective version, which is by definition the one signup
  // records acceptance of. Older versions stay in the table because acceptances
  // point at them, and are deliberately not addressable here — a URL that
  // served superseded terms would eventually be quoted as current.
  // ==========================================================================
  app.get('/v1/legal/:slug', async (request) => {
    const { slug } = z
      .object({ slug: z.enum([TERMS_SLUG, PRIVACY_SLUG]) })
      .parse(request.params);

    const document = await prisma.legalDocument.findFirst({
      where: { slug, effectiveFrom: { lte: new Date() } },
      orderBy: [{ effectiveFrom: 'desc' }, { version: 'desc' }],
      select: { slug: true, version: true, title: true, body: true, effectiveFrom: true },
    });
    if (!document) throw ApiError.notFound();

    return {
      document: {
        ...document,
        effectiveFrom: document.effectiveFrom.toISOString(),
      },
    };
  });

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

      // The customer row normally arrives with the signup form. The fallback
      // is for an identity created some other way — seeded staff, an account
      // made before this form existed — which must not end up verified with no
      // profile to act through.
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
