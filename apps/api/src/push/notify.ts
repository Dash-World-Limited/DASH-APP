/**
 * The pushes DASH owes people, recorded with the change that caused them.
 *
 * A push is a side effect, never a precondition: the order, message, reply or
 * refund it describes has already committed, and nothing about it waits on
 * Google. So the intent is written to the transactional outbox inside the
 * transaction that made the change — the mechanism dispatch, refunds and
 * realtime already use — and delivered after the commit by the queue. If the
 * transaction rolls back, nobody is told about something that did not happen;
 * if the queue or the provider is down, the outbox and the queue's retries
 * deliver it later.
 *
 * The intent carries identifiers only (the outbox refuses anything else). Who
 * is told, and what, is decided when the job runs, from current state: a chat
 * message's other participant, an order's customer, a support conversation's
 * owner. A push whose subject has already moved on is dropped rather than
 * delivered late.
 */

import {
  orderChatNotification,
  orderUpdateNotification,
  paymentUpdateNotification,
  PUSH_ORDER_STATUSES,
  supportReplyNotification,
  type PaymentPushOutcome,
  type PushAudience,
} from '@dash/domain/push';
import type { PushPort } from '@dash/domain/ports';
import type { DbClient, PrismaClient } from '@dash/db';

import { enqueueViaOutbox } from '../events/outbox.js';
import { deliverToIdentity, type SendResult } from './send.js';

/** The queue job name for every push except the rider offer, which has its own. */
export const PUSH_NOTIFY = 'push.notify';

export type PushIntent =
  | { kind: 'order_update'; orderId: string; status: string; revision: number; riderId: string | null }
  | { kind: 'order_chat'; messageId: string }
  | { kind: 'support_reply'; actionId: string }
  | { kind: 'payment_update'; orderId: string; outcome: PaymentPushOutcome; refundId?: string | undefined };

/** The outbox and queue dedupe key: one per event, whatever retries it. */
export function pushJobKey(intent: PushIntent): string {
  switch (intent.kind) {
    case 'order_update':
      return `push_order_${intent.orderId}_${intent.revision}`;
    case 'order_chat':
      return `push_chat_${intent.messageId}`;
    case 'support_reply':
      return `push_support_${intent.actionId}`;
    case 'payment_update':
      return `push_payment_${intent.outcome}_${intent.refundId ?? intent.orderId}`;
  }
}

/**
 * Record that a push is owed, inside the caller's transaction. No network I/O;
 * the caller flushes the outbox after committing, and the scheduled relay is
 * the guarantee if it cannot.
 */
export async function enqueuePush(db: DbClient, intent: PushIntent): Promise<void> {
  await enqueueViaOutbox(db, {
    name: PUSH_NOTIFY,
    payload: { ...intent },
    idempotencyKey: pushJobKey(intent),
    // A push delivered hours late is noise. Five publish attempts covers a
    // queue outage of a few minutes; the relay's backoff does the rest.
    maxAttempts: 5,
  });
}

export interface DeliveryReport {
  readonly recipients: number;
  readonly results: readonly SendResult[];
  /** Set when nothing was attempted, and why. */
  readonly dropped?: 'not_found' | 'superseded' | 'not_applicable' | undefined;
}

const nothing = (dropped: DeliveryReport['dropped']): DeliveryReport => ({ recipients: 0, results: [], dropped });

/** Deliver one queued intent. Every lookup reads current state. */
export async function deliverPushIntent(prisma: PrismaClient, push: PushPort, intent: PushIntent): Promise<DeliveryReport> {
  switch (intent.kind) {
    case 'order_update':
      return deliverOrderUpdate(prisma, push, intent);
    case 'order_chat':
      return deliverOrderChat(prisma, push, intent);
    case 'support_reply':
      return deliverSupportReply(prisma, push, intent);
    case 'payment_update':
      return deliverPaymentUpdate(prisma, push, intent);
  }
}

async function deliverOrderUpdate(
  prisma: PrismaClient,
  push: PushPort,
  intent: Extract<PushIntent, { kind: 'order_update' }>,
): Promise<DeliveryReport> {
  const order = await prisma.order.findUnique({
    where: { id: intent.orderId },
    select: { status: true, customer: { select: { identityId: true } } },
  });
  if (!order) return nothing('not_found');
  // Moved on to something else worth a push: that push replaces this one, so
  // a slow queue never shows "picked up" after "arrived". Moved on to
  // something that is not news (en route, refunded), and this is still the
  // latest thing worth saying.
  if (order.status !== intent.status && PUSH_ORDER_STATUSES.has(order.status)) return nothing('superseded');

  const results: SendResult[] = [];
  const customerMessage = orderUpdateNotification({ orderId: intent.orderId, status: intent.status, audience: 'customer' });
  if (customerMessage) {
    results.push(
      await deliverToIdentity(prisma, push, {
        identityId: order.customer.identityId,
        message: customerMessage,
        dedupeKey: `order_update:${intent.orderId}:${intent.revision}:customer`,
      }),
    );
  }

  const riderMessage = intent.riderId ? orderUpdateNotification({ orderId: intent.orderId, status: intent.status, audience: 'rider' }) : null;
  if (riderMessage && intent.riderId) {
    // The rider who was on the order when it changed, even if the change took
    // them off it — a cancellation is exactly that.
    const rider = await prisma.rider.findUnique({ where: { id: intent.riderId }, select: { identityId: true } });
    if (rider) {
      results.push(
        await deliverToIdentity(prisma, push, {
          identityId: rider.identityId,
          message: riderMessage,
          dedupeKey: `order_update:${intent.orderId}:${intent.revision}:rider`,
        }),
      );
    }
  }
  return results.length === 0 ? nothing('not_applicable') : { recipients: results.length, results };
}

async function deliverOrderChat(
  prisma: PrismaClient,
  push: PushPort,
  intent: Extract<PushIntent, { kind: 'order_chat' }>,
): Promise<DeliveryReport> {
  const message = await prisma.chatMessage.findUnique({
    where: { id: intent.messageId },
    select: {
      senderRole: true,
      senderIdentityId: true,
      conversation: {
        select: {
          orderId: true,
          order: { select: { customer: { select: { identityId: true } }, rider: { select: { identityId: true } } } },
        },
      },
    },
  });
  if (!message) return nothing('not_found');

  const { order, orderId } = message.conversation;
  // The other participant, by role — never the sender, even when one person
  // is both the order's customer and its rider.
  const audience: PushAudience = message.senderRole === 'customer' ? 'rider' : 'customer';
  const identityId = audience === 'rider' ? order.rider?.identityId : order.customer.identityId;
  if (!identityId || identityId === message.senderIdentityId) return nothing('not_applicable');

  const result = await deliverToIdentity(prisma, push, {
    identityId,
    message: orderChatNotification({ orderId, audience }),
    dedupeKey: `order_chat:${intent.messageId}`,
  });
  return { recipients: 1, results: [result] };
}

async function deliverSupportReply(
  prisma: PrismaClient,
  push: PushPort,
  intent: Extract<PushIntent, { kind: 'support_reply' }>,
): Promise<DeliveryReport> {
  const action = await prisma.supportAction.findUnique({
    where: { id: intent.actionId },
    select: {
      kind: true,
      isInternal: true,
      supportCase: { select: { id: true, category: true, customerId: true, riderId: true } },
    },
  });
  // Only a team reply in an in-app conversation. An internal note is never
  // announced to anyone.
  if (!action || action.kind !== 'reply' || action.isInternal || action.supportCase.category !== 'in_app_chat') return nothing('not_found');

  const { supportCase } = action;
  // The conversation's owner, in the role they wrote as.
  const audience: PushAudience = supportCase.riderId ? 'rider' : 'customer';
  const owner = supportCase.riderId
    ? await prisma.rider.findUnique({ where: { id: supportCase.riderId }, select: { identityId: true } })
    : supportCase.customerId
      ? await prisma.customer.findUnique({ where: { id: supportCase.customerId }, select: { identityId: true } })
      : null;
  const identityId = owner?.identityId;
  if (!identityId) return nothing('not_applicable');

  const result = await deliverToIdentity(prisma, push, {
    identityId,
    message: supportReplyNotification({ conversationId: supportCase.id, audience }),
    dedupeKey: `support_reply:${intent.actionId}`,
  });
  return { recipients: 1, results: [result] };
}

async function deliverPaymentUpdate(
  prisma: PrismaClient,
  push: PushPort,
  intent: Extract<PushIntent, { kind: 'payment_update' }>,
): Promise<DeliveryReport> {
  const order = await prisma.order.findUnique({
    where: { id: intent.orderId },
    select: { customer: { select: { identityId: true } } },
  });
  if (!order) return nothing('not_found');

  const result = await deliverToIdentity(prisma, push, {
    identityId: order.customer.identityId,
    message: paymentUpdateNotification({ orderId: intent.orderId, outcome: intent.outcome }),
    dedupeKey: `payment_update:${intent.outcome}:${intent.refundId ?? intent.orderId}`,
  });
  return { recipients: 1, results: [result] };
}
