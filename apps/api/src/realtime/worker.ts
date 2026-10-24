/**
 * The queue consumer that turns a durable notification into a broadcast.
 *
 * This is the hinge of the whole pipeline, and it is three lines of real work
 * with one important property: the payload is validated before it is believed.
 *
 *   outbox row  ──relay──▶  queue job  ──here──▶  broadcast  ──▶  every hub
 *
 * The job arrives from Redis, which is shared infrastructure that more than one
 * deployment may be pointed at, so `parseNotification` re-checks every field
 * and re-parses every topic name. A crafted `topics: ['order:*']` reaching a
 * fan-out that matches by exact string equality would match nothing today, but
 * "it happens to be safe because every producer is well behaved" is not a
 * property worth relying on at a trust boundary.
 */

import { parseNotification, RealtimeError } from '@dash/domain/realtime';
import type { QueuePort, RealtimeBroadcastPort } from '@dash/domain/ports';
import type { FastifyBaseLogger } from 'fastify';
import { REALTIME_EVENT_NAME } from './notify.js';

export interface RealtimeWorkerDeps {
  readonly queue: QueuePort;
  readonly broadcast: RealtimeBroadcastPort;
  readonly log: FastifyBaseLogger;
}

export function registerRealtimeWorker(deps: RealtimeWorkerDeps): void {
  const { queue, broadcast, log } = deps;

  queue.process<unknown>(REALTIME_EVENT_NAME, async (job) => {
    let notification;
    try {
      notification = parseNotification(job.payload);
    } catch (error) {
      // Retrying cannot repair a payload that is the wrong shape, and throwing
      // would put this job through its full attempt budget to arrive back here
      // every time. It is dropped, loudly, and the reason names the failure
      // rather than the payload — which is unvalidated input and does not
      // belong in a log line.
      log.warn(
        {
          jobId: job.id,
          reason: error instanceof RealtimeError ? error.reason : 'unknown',
        },
        'realtime: discarded a malformed notification',
      );
      return;
    }

    // Throws if the broadcast could not reach the other instances, which fails
    // the job so the queue retries it. Local sockets have already been served
    // by then — see RedisBroadcastAdapter — so a retry is about the rest of the
    // fleet, not about this instance's clients.
    await broadcast.publish(notification);
  });
}
