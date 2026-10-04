/**
 * Announcing that an order changed.
 *
 * ## Why this goes through the outbox rather than straight to the hub
 *
 * The obvious implementation is one line at the end of each route handler:
 * commit the transition, then call `hub.publish`. It is also a dual write, and
 * Milestone IV exists because of what dual writes do here.
 *
 * Two ways it fails. If the publish happens *before* the commit, a transaction
 * that then rolls back has already told every watching client that an order
 * moved to a state it never reached; they re-read, see the old state, and the
 * screen flickers backwards. If it happens *after*, a crash in the gap loses
 * the notification permanently — and because nothing recorded that it was owed,
 * nothing will ever send it. The customer's tracking screen simply stops
 * updating, with no error anywhere.
 *
 * Writing the intent inside the transaction removes both. The notification
 * commits with the change that caused it or not at all, and once committed it
 * is durable, so the relay delivers it whenever the queue comes back. This is
 * the same mechanism, and the same table, that Milestone IV built for dispatch
 * and refunds — deliberately not a second one.
 *
 * ## Delivery is at-least-once, and that costs nothing here
 *
 * The relay may publish a row twice. For a dispatch job that would matter; for
 * a notification it does not, because the notification says only "this order is
 * now at version N". Acting on it twice means re-reading state that is already
 * current. The duplicate is suppressed anyway — by the queue's idempotency key
 * upstream and by the hub's per-connection event-id set downstream — but
 * nothing depends on that suppression working.
 */

import { enqueueViaOutbox } from '../events/outbox.js';
import { orderTopics } from '@dash/domain/realtime';
import type { DbClient } from '@dash/db';

/** The queue job name. One name, so there is one worker and one place to look. */
export const REALTIME_EVENT_NAME = 'realtime.notify';

/**
 * The identifier a client deduplicates on.
 *
 * Derived from the subject and its version rather than allocated, which makes
 * it stable across every redelivery of the same change without having to read
 * the outbox row back to learn its id. Two notifications share an id only if
 * they describe the same version of the same order, in which case they *are*
 * the same notification however many times the relay published it.
 */
export function eventIdFor(subject: string, version: number): string {
  return `${subject}@${version}`;
}

export interface OrderChangeNotification {
  readonly eventId: string;
  readonly subject: string;
  readonly topics: readonly string[];
  readonly version: number;
  readonly occurredAt: number;
}

export interface RecordOrderChangeOptions {
  readonly occurredAt?: Date;
  /**
   * Topics to announce on beyond the ones the order's own relationships imply.
   *
   * The one caller is dispatch, which offers an order to riders who are not on
   * it yet — and deliberately never will be if they decline. Their relationship
   * is to the *offer*, not the order, so `orderTopics` correctly leaves them
   * out and they are named here instead.
   *
   * Adding a topic here grants no reach: a rider hears about this on their own
   * `rider:` topic, which only they can subscribe to, and answers it by
   * re-reading their own offer list through the authorized route. Nothing about
   * the order travels with it.
   */
  readonly extraTopics?: readonly string[];
}

/**
 * Record that an order changed, inside the caller's transaction.
 *
 * Takes a `DbClient` rather than a `PrismaClient` for the same reason
 * `enqueueViaOutbox` does: that type is what a `$transaction` handle satisfies,
 * so calling this outside a transaction has to be a deliberate act.
 *
 * The revision is incremented here rather than by each caller. Every call site
 * would otherwise have to remember to fold `revision: { increment: 1 }` into
 * its own update, and the failure mode of forgetting is not a crash — it is a
 * notification whose version equals the last one, which every client correctly
 * discards as already-seen. A silently stale screen is precisely what this
 * milestone is for, so the increment lives where it cannot be omitted.
 *
 * Returns the notification that was recorded, mostly so tests can assert on it
 * without reading the outbox table.
 */
export async function recordOrderChange(
  db: DbClient,
  orderId: string,
  options: RecordOrderChangeOptions = {},
): Promise<OrderChangeNotification> {
  const occurredAt = options.occurredAt ?? new Date();
  // One statement: bump the counter and read back everything the fan-out needs.
  // The vendor's city is what puts this order on a dispatch board, and it lives
  // on the vendor rather than the order, so it is joined here rather than being
  // passed in by callers who would each have to remember to select it.
  const order = await db.order.update({
    where: { id: orderId },
    data: { revision: { increment: 1 } },
    select: {
      id: true,
      revision: true,
      vendorId: true,
      riderId: true,
      vendor: { select: { cityId: true } },
    },
  });

  const subject = `order:${order.id}`;
  // Deduplicated: an extra topic that the order's own relationships already
  // imply — offering an order back to the rider currently on it, say — must not
  // become two entries, because a repeated topic would deliver twice to every
  // socket holding it.
  const topics = [
    ...new Set([
      ...orderTopics({
        orderId: order.id,
        vendorId: order.vendorId,
        riderId: order.riderId,
        cityId: order.vendor.cityId,
      }),
      ...(options.extraTopics ?? []),
    ]),
  ];

  const notification: OrderChangeNotification = {
    eventId: eventIdFor(subject, order.revision),
    subject,
    topics,
    version: order.revision,
    occurredAt: occurredAt.getTime(),
  };

  await enqueueViaOutbox(db, {
    name: REALTIME_EVENT_NAME,
    // Identifiers and a version. `assertPublishable` enforces that this table
    // never receives personal data, and a notification has none to give it —
    // the whole design is that clients re-read through the authorized routes.
    payload: {
      eventId: notification.eventId,
      subject: notification.subject,
      topics: [...notification.topics],
      version: notification.version,
      occurredAt: notification.occurredAt,
    },
    // Unique per change because the revision is monotonic, so the queue's
    // deduplication absorbs a republished row without ever collapsing two
    // genuinely different changes into one.
    idempotencyKey: notification.eventId,
    // Ordinary notifications have no business being retried eight times: by the
    // third attempt the client has re-read on its poll fallback anyway, and a
    // pile of stale notifications is worth less than a short backlog.
    maxAttempts: 3,
  });

  return notification;
}

/**
 * The topics an order's change reaches, without recording anything.
 *
 * Exists for the reassignment path, which needs to know which rider *used to*
 * be on an order in order to reason about who stops hearing about it.
 */
export function topicsForOrder(order: {
  orderId: string;
  vendorId?: string | null;
  riderId?: string | null;
  cityId?: string | null;
}): string[] {
  return orderTopics(order);
}
