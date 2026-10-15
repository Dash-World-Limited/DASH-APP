/**
 * Turning queued push events into notifications on handsets.
 *
 * Two consumers. The rider offer's producer lives in the dispatch worker,
 * inside the transaction that creates the offer, and is unchanged. Every other
 * push — order updates, order chat, support replies, payment outcomes — is
 * produced through `enqueuePush` in the transaction that made the change (see
 * ./notify.ts). Both run after their transaction has committed, so by the time
 * they look anything up it definitely exists — and if the transaction rolled
 * back, the job was never published and nobody is told about something that
 * did not happen.
 *
 * Everything they need they look up themselves. The queued payload carries
 * identifiers only, so eligibility is decided on current state rather than
 * whatever was true when the event was recorded.
 *
 * Logged at debug, with counts and reasons only: a push token is a capability
 * to interrupt someone's phone and has no business in a log file, and nor does
 * who was told what.
 */

import type { QueuePort, PushPort } from '@dash/domain/ports';
import { riderOfferNotification } from '@dash/domain/push';
import type { PrismaClient } from '@dash/db';
import type { FastifyBaseLogger } from 'fastify';

import { deliverPushIntent, PUSH_NOTIFY, type PushIntent } from './notify.js';
import { sendToRider } from './send.js';

/** The queue job name. Shared with the dispatch worker that publishes it. */
export const PUSH_RIDER_OFFER = 'push.rider_offer';

interface RiderOfferJob {
  offerId: string;
  riderId: string;
  expiresAt: string;
}

export function registerPushWorker(deps: {
  queue: QueuePort;
  prisma: PrismaClient;
  push: PushPort;
  logger: FastifyBaseLogger;
}): void {
  const { queue, prisma, push, logger } = deps;

  queue.process<RiderOfferJob>(PUSH_RIDER_OFFER, async (job) => {
    const { offerId, riderId, expiresAt } = job.payload;

    // An offer that has already been answered or has expired is not worth
    // interrupting anyone about. This is a cheap check and it catches the
    // common case: a rider who accepted through the socket seconds ago should
    // not then get a push telling them to hurry.
    const offer = await prisma.dispatchOffer.findUnique({
      where: { id: offerId },
      select: { status: true, expiresAt: true },
    });
    if (!offer || offer.status !== 'pending' || offer.expiresAt.getTime() <= Date.now()) {
      logger.debug({ offerId }, 'push skipped: offer no longer pending');
      return;
    }

    const result = await sendToRider(prisma, push, {
      riderId,
      message: riderOfferNotification({ offerId, expiresAt: new Date(expiresAt) }),
      // One push per offer, however many times the job is delivered.
      dedupeKey: `rider_offer:${offerId}`,
    });

    logger.debug(
      {
        offerId,
        sent: result.sent,
        skipped: result.skipped,
        devices: result.deviceCount,
        cleared: result.invalidTokensCleared,
      },
      'rider offer push',
    );
  });

  queue.process<PushIntent>(PUSH_NOTIFY, async (job) => {
    const intent = job.payload;
    // A thrown error (the provider unreachable) is retried by the queue; the
    // dedupe claim was released for that retry. Nothing the push describes
    // depends on it.
    const report = await deliverPushIntent(prisma, push, intent);
    logger.debug(
      {
        kind: intent.kind,
        recipients: report.recipients,
        dropped: report.dropped,
        sent: report.results.filter((result) => result.sent).length,
        skipped: report.results.map((result) => result.skipped).filter(Boolean),
      },
      'push delivered',
    );
  });
}
