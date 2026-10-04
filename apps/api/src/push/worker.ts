/**
 * Turning a queued push event into a notification on a handset.
 *
 * The producer side lives in the dispatch worker, inside the transaction that
 * creates the offer. This is the consumer: it runs after that transaction has
 * committed, so by the time it looks up the rider the offer definitely exists —
 * and if the transaction rolled back, this job was never published and no
 * notification is sent about work that does not exist.
 *
 * Everything it needs it looks up itself. The queued payload carries
 * identifiers only, so the eligibility check reads current state rather than
 * whatever was true when the offer was created — a rider suspended in the
 * intervening seconds is not contacted.
 */

import type { QueuePort, PushPort } from '@dash/domain/ports';
import { riderOfferNotification } from '@dash/domain/push';
import type { PrismaClient } from '@dash/db';
import type { FastifyBaseLogger } from 'fastify';

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
    });

    // Logged at debug, and without the token: a push token is a capability to
    // interrupt someone's phone and has no business in a log file.
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
}
