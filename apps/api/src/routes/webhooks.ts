/**
 * Inbound webhooks.
 *
 * Webhooks are the one place where an unauthenticated request is allowed to
 * move money, so the handling is deliberately paranoid:
 *
 *   1. Verify the signature before parsing anything meaningful.
 *   2. Store the raw event, keyed on the provider's event id.
 *   3. Refuse to process an event id that has been seen before (replay).
 *   4. Re-verify the payment with the provider rather than believing the body.
 *   5. Return 200 to a hostile request, so an attacker learns nothing.
 *
 * Point 5 is worth stating plainly: an invalid signature is logged and answered
 * with 200. Returning 401 would tell someone probing the endpoint that their
 * signature was the only thing wrong.
 */

import type { FastifyInstance } from 'fastify';
import { confirmOrderPaid } from './orders.js';

export async function registerWebhookRoutes(app: FastifyInstance): Promise<void> {
  const { prisma, payments } = app.services;

  // The raw body is required for signature verification — a re-serialized JSON
  // object will not produce the same bytes, so the signature would never match.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (request, body, done) => {
      if (request.url.startsWith('/v1/webhooks/')) {
        (request as { rawBody?: string }).rawBody = body as string;
      }
      try {
        done(null, body === '' ? {} : JSON.parse(body as string));
      } catch {
        done(null, {});
      }
    },
  );

  app.post(
    '/v1/webhooks/payments',
    {
      // Higher than a user endpoint — providers retry aggressively — but still
      // bounded so the endpoint cannot be used to exhaust the database.
      config: { rateLimit: { max: 600, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const rawBody = (request as { rawBody?: string }).rawBody ?? '';

      const headers: Record<string, string | undefined> = {};
      for (const [key, value] of Object.entries(request.headers)) {
        headers[key] = Array.isArray(value) ? value[0] : value;
      }

      const event = payments.parseWebhook({ rawBody, headers });

      if (!event) {
        // Logged with the source IP so a pattern is visible, answered blandly.
        request.log.warn(
          { ip: request.ip, provider: payments.providerName },
          'rejected webhook with invalid signature',
        );
        return reply.status(200).send({ received: true });
      }

      // --- Replay protection --------------------------------------------------
      // The unique constraint on (provider, eventId) is what actually enforces
      // this; the create failing means we have already seen this event.
      try {
        await prisma.paymentWebhook.create({
          data: {
            provider: payments.providerName,
            eventId: event.id,
            eventType: event.type,
            signatureValid: true,
            rawPayload: rawBody.slice(0, 20_000),
          },
        });
      } catch {
        request.log.info({ eventId: event.id }, 'ignored duplicate webhook');
        return reply.status(200).send({ received: true, duplicate: true });
      }

      // --- Never trust the body's own claim about status or amount ------------
      // A forged-but-correctly-signed body is unlikely, but asking the provider
      // costs one call and removes the question entirely.
      const verified = await payments.verify(event.providerReference);

      const payment = await prisma.payment.findUnique({
        where: { providerReference: event.providerReference },
        select: { id: true, orderId: true, amount: true, status: true },
      });

      if (!payment) {
        request.log.warn(
          { reference: event.providerReference },
          'webhook referenced an unknown payment',
        );
        return reply.status(200).send({ received: true });
      }

      // The amount must match what we asked for. A mismatch is either a provider
      // bug or tampering; either way it must not silently fulfil an order.
      if (verified.amount !== payment.amount) {
        request.log.error(
          { paymentId: payment.id, expected: payment.amount, actual: verified.amount },
          'webhook amount does not match the payment record',
        );
        await prisma.paymentWebhook.updateMany({
          where: { provider: payments.providerName, eventId: event.id },
          data: { processingError: 'amount_mismatch' },
        });
        return reply.status(200).send({ received: true });
      }

      await prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: verified.status,
          ...(verified.status === 'captured' ? { capturedAt: new Date() } : {}),
          ...(verified.status === 'failed'
            ? { failedAt: new Date(), failureReason: verified.providerMessage ?? null }
            : {}),
        },
      });

      if (verified.status === 'captured') {
        // Idempotent by order state — a second capture event for the same order
        // finds it already placed and does nothing.
        await confirmOrderPaid(prisma, payment.orderId, 'system');
      }

      await prisma.paymentWebhook.updateMany({
        where: { provider: payments.providerName, eventId: event.id },
        data: { paymentId: payment.id, processedAt: new Date() },
      });

      return reply.status(200).send({ received: true, processed: true });
    },
  );
}
