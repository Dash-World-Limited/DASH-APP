/**
 * Bounce and complaint notifications: from SES via SNS, and from Brevo.
 *
 * ## Why this exists
 *
 * A sender that keeps delivering to addresses which hard-bounce, or to people
 * who pressed "this is spam", loses its reputation. When that happens
 * verification codes stop arriving *for everybody*, and the failure looks like
 * a broken signup form rather than a mail problem — which is close to
 * undiagnosable from inside the application.
 *
 * ## Why the signature check is the whole route
 *
 * This endpoint has to be reachable by AWS, so it is reachable by everybody.
 * Unverified, it would be a public form for adding any address to the
 * suppression list, and suppressing an address is a targeted denial of service:
 * it stops one named person receiving the code that opens their account.
 *
 * So nothing is trusted before `verifySnsMessage` returns. Not the topic, not
 * the message, and above all not the certificate URL — which arrives in the
 * body an attacker controls.
 *
 * ## The distinction that matters
 *
 * A hard bounce means the mailbox does not exist: nothing may be sent, ever.
 *
 * A complaint means somebody pressed "spam" on something we sent. That
 * suppresses marketing and **not** transactional mail, because a person who
 * marked a newsletter as spam has not asked to be locked out of their own
 * account, and refusing to send them a sign-in code is what that would mean.
 *
 * A soft bounce — a full mailbox, a transient failure — suppresses nothing. The
 * address is fine and will work tomorrow.
 *
 * ## Brevo
 *
 * Brevo is the V1 provider, so without its events nothing was ever suppressed
 * in production. Brevo does not sign webhooks the way SNS does; it sends a
 * credential we choose. So the Brevo route accepts nothing unless
 * `BREVO_WEBHOOK_TOKEN` is set and the request carries it — as a bearer token,
 * or as the password of HTTP Basic auth (Brevo offers both) — compared in
 * constant time. Unset, the route refuses everything: an unauthenticated
 * suppression endpoint is the denial of service described above.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '@dash/db';
import { ApiError } from '../http/errors.js';
import { verifySnsMessage, SnsVerificationError, type SnsMessage } from '../adapters/sns-signature.js';

/** The SNS envelope. The interesting part is a JSON string inside `Message`. */
const envelopeSchema = z.object({
  Type: z.string().min(1).max(40),
  MessageId: z.string().min(1).max(120),
  TopicArn: z.string().min(1).max(200),
  Subject: z.string().max(200).optional(),
  Message: z.string().max(256_000),
  Timestamp: z.string().min(1).max(40),
  SignatureVersion: z.string().min(1).max(4),
  Signature: z.string().min(1).max(2000),
  SigningCertURL: z.string().max(2000).optional(),
  SigningCertUrl: z.string().max(2000).optional(),
  SubscribeURL: z.string().max(2000).optional(),
  Token: z.string().max(2000).optional(),
});

/** The SES payload carried inside it. Parsed loosely: AWS adds fields. */
const sesNotificationSchema = z.object({
  notificationType: z.enum(['Bounce', 'Complaint', 'Delivery']).optional(),
  eventType: z.enum(['Bounce', 'Complaint', 'Delivery', 'Send', 'Open', 'Click', 'Reject']).optional(),
  bounce: z
    .object({
      bounceType: z.string().optional(),
      bounceSubType: z.string().optional(),
      bouncedRecipients: z.array(z.object({ emailAddress: z.string() })).optional(),
    })
    .optional(),
  complaint: z
    .object({
      complaintFeedbackType: z.string().optional(),
      complainedRecipients: z.array(z.object({ emailAddress: z.string() })).optional(),
    })
    .optional(),
});

/**
 * One Brevo transactional event. Parsed loosely: Brevo adds fields, and an
 * event this does not act on must still be accepted.
 */
const brevoEventSchema = z.object({
  event: z.string().max(40),
  email: z.string().max(320).optional(),
  'message-id': z.string().max(300).optional(),
  ts_event: z.number().optional(),
  reason: z.string().max(500).optional(),
});

/** Brevo posts one event, or an array of them when batching is switched on. */
const brevoBodySchema = z.union([brevoEventSchema, z.array(brevoEventSchema).max(1000)]);

/**
 * What each Brevo event means for the address. Anything unlisted — delivered,
 * opened, a soft bounce, a deferral — changes nothing.
 *
 * `blocked` is deliberately absent: Brevo refused the send because the address
 * is on *its* blocklist, which says nothing about why, and suppressing on a
 * guess could lock somebody out of their account.
 */
const BREVO_ACTIONS: Record<string, { reason: 'hard_bounce' | 'complaint'; transactionalAllowed: boolean }> = {
  // The mailbox does not exist, or the address is malformed: nothing may be sent.
  hard_bounce: { reason: 'hard_bounce', transactionalAllowed: false },
  invalid_email: { reason: 'hard_bounce', transactionalAllowed: false },
  // Marked as spam: marketing stops, a sign-in code does not.
  spam: { reason: 'complaint', transactionalAllowed: true },
};

/** The credential Brevo sent, from `Authorization: Bearer …` or Basic auth's password. */
function presentedBrevoToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return null;
  const [scheme, value] = header.split(' ', 2);
  if (!value) return null;
  if (scheme?.toLowerCase() === 'bearer') return value.trim();
  if (scheme?.toLowerCase() === 'basic') {
    const decoded = Buffer.from(value, 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    return colon === -1 ? null : decoded.slice(colon + 1);
  }
  return null;
}

/** Constant time, whatever the lengths: both sides are hashed first. */
function sameSecret(presented: string, expected: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();
  return timingSafeEqual(digest(presented), digest(expected));
}

export async function registerEmailEventRoutes(app: FastifyInstance): Promise<void> {
  const { prisma, config } = app.services;

  /**
   * Record a suppression, or refresh one that already exists.
   *
   * Idempotent on the SNS message id: AWS delivers at least once, and applying
   * the same bounce twice must not look like two bounces.
   */
  async function suppress(input: {
    address: string;
    reason: 'hard_bounce' | 'complaint';
    transactionalAllowed: boolean;
    detail: string | null;
    notificationId: string;
  }) {
    const address = input.address.trim().toLowerCase();
    if (!address.includes('@')) return;

    const existing = await prisma.emailSuppression.findUnique({ where: { address } });
    if (existing?.lastNotificationId === input.notificationId) return;

    await prisma.emailSuppression.upsert({
      where: { address },
      create: {
        address,
        reason: input.reason,
        transactionalAllowed: input.transactionalAllowed,
        detail: input.detail,
        lastNotificationId: input.notificationId,
      },
      update: {
        reason: input.reason,
        // Only ever tightens. An address that hard-bounced and later drew a
        // complaint must not have transactional mail switched back on by the
        // complaint's more permissive rule.
        transactionalAllowed: existing
          ? existing.transactionalAllowed && input.transactionalAllowed
          : input.transactionalAllowed,
        detail: input.detail,
        lastNotificationId: input.notificationId,
        lastSeenAt: new Date(),
        clearedAt: null,
        clearedBy: null,
      },
    });

    await writeAudit(prisma, {
      identityId: null,
      action: `email.suppressed.${input.reason}`,
      resourceType: 'EmailSuppression',
      resourceId: address,
      after: { reason: input.reason, detail: input.detail },
    });
  }

  /**
   * POST /v1/webhooks/email-events
   *
   * Answers 200 to anything it has verified, whether or not it understood the
   * contents. SNS retries a non-2xx and eventually disables the subscription,
   * so returning an error for an event type we simply do not act on would
   * gradually switch off bounce handling altogether.
   *
   * A message that fails verification gets 400 and is never retried into
   * working, which is correct: it did not come from us.
   */
  app.post(
    '/v1/webhooks/email-events',
    {
      config: {
        // Generous: a bounce storm is exactly when this must keep working, and
        // the signature check is what actually protects it.
        rateLimit: { max: 300, timeWindow: '1 minute' },
      },
    },
    async (request) => {
      const envelope = envelopeSchema.parse(request.body);

      try {
        await verifySnsMessage(envelope as SnsMessage, {
          expectedTopicArn: config.SES_EVENT_TOPIC_ARN,
        });
      } catch (error) {
        if (error instanceof SnsVerificationError) {
          // The reason is logged, never returned. Telling a caller which check
          // they failed is a tutorial in passing it.
          request.log.warn({ reason: error.reason, topic: envelope.TopicArn }, 'SNS message rejected');
          throw ApiError.badRequest('That notification could not be verified.');
        }
        throw error;
      }

      // --- subscription handshake -------------------------------------------
      if (envelope.Type === 'SubscriptionConfirmation') {
        // Confirmed by fetching the URL AWS supplied — and only after the
        // signature proved AWS supplied it. Confirming an unverified
        // subscription would let anybody point our endpoint at their topic.
        if (envelope.SubscribeURL) {
          try {
            await fetch(envelope.SubscribeURL);
            request.log.info({ topic: envelope.TopicArn }, 'SNS subscription confirmed');
          } catch {
            request.log.warn({ topic: envelope.TopicArn }, 'SNS subscription confirmation failed');
          }
        }
        return { received: true };
      }

      if (envelope.Type !== 'Notification') return { received: true };

      // --- the SES payload ---------------------------------------------------
      let payload: z.infer<typeof sesNotificationSchema>;
      try {
        payload = sesNotificationSchema.parse(JSON.parse(envelope.Message));
      } catch {
        // Verified as ours, but not a shape this understands. Accepted so SNS
        // stops retrying, and logged so somebody can look.
        request.log.warn({ messageId: envelope.MessageId }, 'Unrecognised SES notification');
        return { received: true };
      }

      const kind = payload.notificationType ?? payload.eventType;

      if (kind === 'Bounce' && payload.bounce) {
        // Only a permanent bounce suppresses. A full mailbox or a transient
        // failure is an address that will work tomorrow.
        const permanent = payload.bounce.bounceType === 'Permanent';
        if (permanent) {
          for (const recipient of payload.bounce.bouncedRecipients ?? []) {
            await suppress({
              address: recipient.emailAddress,
              reason: 'hard_bounce',
              // The mailbox does not exist. Nothing may be sent to it.
              transactionalAllowed: false,
              detail: payload.bounce.bounceSubType ?? null,
              notificationId: envelope.MessageId,
            });
          }
        }
        return { received: true };
      }

      if (kind === 'Complaint' && payload.complaint) {
        for (const recipient of payload.complaint.complainedRecipients ?? []) {
          await suppress({
            address: recipient.emailAddress,
            reason: 'complaint',
            // Marketing stops. A sign-in code does not: somebody who marked a
            // newsletter as spam has not asked to be locked out of their own
            // account.
            transactionalAllowed: true,
            detail: payload.complaint.complaintFeedbackType ?? null,
            notificationId: envelope.MessageId,
          });
        }
        return { received: true };
      }

      return { received: true };
    },
  );

  /**
   * POST /v1/webhooks/brevo-events
   *
   * Brevo's transactional webhook. 401 for anything without the configured
   * credential — including every request while none is configured — and the
   * reason is logged, never returned. 200 for anything authenticated, whether
   * or not it is an event this acts on, so Brevo never stops delivering.
   */
  app.post(
    '/v1/webhooks/brevo-events',
    { config: { rateLimit: { max: 300, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const expected = config.BREVO_WEBHOOK_TOKEN;
      const presented = presentedBrevoToken(request);
      if (!expected || !presented || !sameSecret(presented, expected)) {
        request.log.warn(
          { configured: Boolean(expected), credential: presented ? 'wrong' : 'missing' },
          'Brevo event rejected',
        );
        return reply.status(401).send({ received: false });
      }

      const parsed = brevoBodySchema.safeParse(request.body);
      if (!parsed.success) {
        // Authenticated, but not a shape this understands. Accepted so Brevo
        // keeps delivering, and logged so somebody can look.
        request.log.warn('Unrecognised Brevo event');
        return { received: true };
      }

      const events = Array.isArray(parsed.data) ? parsed.data : [parsed.data];
      for (const event of events) {
        const action = BREVO_ACTIONS[event.event];
        if (!action || !event.email) continue;
        await suppress({
          address: event.email,
          reason: action.reason,
          transactionalAllowed: action.transactionalAllowed,
          detail: `brevo:${event.event}`,
          // Brevo delivers at least once. One message and one kind of event is
          // one notification, however many times it arrives.
          notificationId: `brevo:${event['message-id'] ?? event.ts_event ?? 'unknown'}:${event.event}`.slice(0, 300),
        });
      }
      return { received: true };
    },
  );
}
