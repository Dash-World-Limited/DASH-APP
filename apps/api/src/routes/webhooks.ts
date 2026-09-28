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
import { z } from 'zod';
import { settlePayment } from '../payments/settle.js';

export async function registerWebhookRoutes(app: FastifyInstance): Promise<void> {
  const { prisma, payments, queue } = app.services;

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
      // The unique constraint on (provider, eventId) records every delivery.
      // An event already *processed* is a replay and does nothing. An event
      // recorded but never processed is a retry of a delivery that failed part
      // way — the provider could not be asked, say — and is processed again:
      // treating it as a replay would drop that payment on the floor for good.
      //
      // Exactly one delivery owns an event: the one whose insert succeeds, or
      // a later one that takes over an event whose earlier attempt failed for
      // want of the provider. Every other delivery is a duplicate — including
      // a concurrent one while the owner is still working.
      let owned = false;
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
        owned = true;
      } catch {
        const retried = await prisma.paymentWebhook.updateMany({
          where: {
            provider: payments.providerName,
            eventId: event.id,
            processedAt: null,
            processingError: 'provider_unreachable',
          },
          data: { processingError: null },
        });
        owned = retried.count === 1;
      }
      if (!owned) {
        request.log.info({ eventId: event.id }, 'ignored duplicate webhook');
        return reply.status(200).send({ received: true, duplicate: true });
      }

      // --- Never trust the body's own claim about status or amount ------------
      // `settlePayment` asks the provider and uses only its answer. When the
      // provider cannot be asked it throws, the event stays unprocessed, and
      // the non-2xx makes the provider deliver it again later.
      let outcome;
      try {
        outcome = await settlePayment({ prisma, payments, queue }, event.providerReference, 'system');
      } catch (error) {
        request.log.error({ eventId: event.id, err: error }, 'webhook could not be settled; awaiting retry');
        await prisma.paymentWebhook.updateMany({
          where: { provider: payments.providerName, eventId: event.id },
          data: { processingError: 'provider_unreachable' },
        });
        return reply.status(503).send({ received: true, processed: false });
      }

      // Refusals are recorded and answered exactly like a bad signature, so
      // nobody probing learns whether a reference exists or what it is for.
      if (outcome === 'unknown_payment' || outcome === 'amount_mismatch') {
        request.log.warn({ eventId: event.id, outcome }, 'webhook refused');
        await prisma.paymentWebhook.updateMany({
          where: { provider: payments.providerName, eventId: event.id },
          data: { processingError: outcome },
        });
        return reply.status(200).send({ received: true });
      }
      if (outcome === 'captured_for_closed_order') {
        request.log.error({ eventId: event.id, outcome }, 'webhook settled into a state that needs a person');
      }

      const payment = await prisma.payment.findUnique({
        where: { providerReference: event.providerReference },
        select: { id: true },
      });
      await prisma.paymentWebhook.updateMany({
        where: { provider: payments.providerName, eventId: event.id },
        data: {
          paymentId: payment?.id ?? null,
          processedAt: new Date(),
          processingError: outcome === 'captured_for_closed_order' ? outcome : null,
        },
      });

      return reply.status(200).send({ received: true, processed: true });
    },
  );

  // -------------------------------------------------------------------------
  // POST /v1/payments/return — the customer's browser is back from checkout
  // -------------------------------------------------------------------------
  // Paystack sends the browser to the web page at /pay/complete with the
  // reference in the query string. That page asks for the reference to be
  // checked now, so the order settles even if the webhook is late and the
  // customer never reopens the app.
  //
  // It is a nudge, not a claim. The body carries only a reference; the
  // outcome comes from `settlePayment`, which asks Paystack and places an
  // order only for a capture of the recorded amount — the same single path
  // the webhook and the app use. The answer is always the same `{ checked:
  // true }`, whatever happened, so the endpoint tells nobody whether a
  // reference exists or what state its order is in.
  app.post(
    '/v1/payments/return',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const parsed = z.object({ reference: z.string().trim().regex(/^[A-Za-z0-9._-]{4,80}$/) }).safeParse(request.body);
      if (parsed.success) {
        try {
          await settlePayment({ prisma, payments, queue }, parsed.data.reference, 'payment_return');
        } catch (error) {
          // Paystack unreachable: the webhook and the app will settle it.
          request.log.warn({ err: error }, 'payment return could not be checked now');
        }
      }
      return reply.status(202).send({ checked: true });
    },
  );
}
