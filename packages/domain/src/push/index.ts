/**
 * What a push notification is allowed to say.
 *
 * A push payload leaves our infrastructure entirely. It is handed to Google,
 * relayed through their servers, held in their queues while a handset is
 * offline, and delivered to a lock screen that anyone standing nearby can
 * read. None of those are places where a customer's address, phone number or
 * order contents belong.
 *
 * So DASH pushes the same shape it broadcasts over the socket: **a
 * notification, not the data**. The message says that something happened and
 * carries the identifier needed to go and look; the app then re-reads through
 * an authorized route, where the caller is known and the projection rules
 * apply. A stolen or intercepted push therefore reveals that a rider was
 * offered *a* job, and nothing whatsoever about whose, from where, or to whom.
 *
 * The functions here are pure and total, which is the point: the rule that
 * payloads carry no personal data is enforced by there being no code path that
 * can put any in, rather than by reviewers remembering to check.
 */

/** Every kind of push DASH sends. */
export type PushKind = 'rider_offer' | 'order_update' | 'order_chat' | 'support_reply' | 'payment_update' | 'test';

/** Which side of the app a push is for — the face a tap opens. */
export type PushAudience = 'customer' | 'rider';

/**
 * Android notification channels. The app creates these on the handset (see
 * apps/mobile/src/v2/push) and every push names one, so a person can silence,
 * say, order updates in Android's settings without losing delivery offers.
 * Ids are permanent once shipped: Android keeps a channel's settings by id.
 */
export type PushChannelId = 'offers' | 'orders' | 'messages' | 'account';

export interface PushChannel {
  readonly id: PushChannelId;
  readonly name: string;
  readonly description: string;
  /** Android importance: `max` may show as a heads-up banner over other apps. */
  readonly importance: 'max' | 'high' | 'default';
}

export const PUSH_CHANNELS: readonly PushChannel[] = [
  { id: 'offers', name: 'Delivery offers', description: 'New delivery offers while you are online as a rider.', importance: 'max' },
  { id: 'orders', name: 'Order updates', description: 'When an order is accepted, collected, arriving, delivered or cancelled.', importance: 'high' },
  { id: 'messages', name: 'Messages', description: 'Messages about an order, and replies from DASH Support.', importance: 'high' },
  { id: 'account', name: 'Payments and account', description: 'Refunds and payment updates.', importance: 'default' },
];

export interface PushMessage {
  readonly kind: PushKind;
  readonly title: string;
  readonly body: string;
  /**
   * Identifiers only, all strings — the transport requires string values.
   * Deliberately not a free-form record at the call site: see `assertNoPersonalData`.
   */
  readonly data: Readonly<Record<string, string>>;
  /** The Android channel it is shown on. */
  readonly channel: PushChannelId;
  /**
   * Sent even when the person has switched DASH notifications off on that
   * phone. Only for work the person explicitly asked to be interrupted for —
   * an offer while they are Online, a delivery they are carrying being
   * cancelled — never for news.
   */
  readonly essential: boolean;
  /**
   * Pushes sharing a key replace each other, on the handset and in FCM's queue
   * for an offline phone, rather than stacking: one notification per order,
   * per order chat, per support conversation.
   */
  readonly collapseKey: string;
  /** How long FCM may hold it for a phone that is offline before dropping it. */
  readonly ttlSeconds: number;
}

/**
 * The offer notification.
 *
 * Wording is deliberately incurious. "New delivery offer" tells a rider to
 * open the app, which is all a notification needs to do when the app is about
 * to show them everything anyway — and it is safe on a lock screen in a shared
 * space. Pickup names, distances and payouts are all things the rider will see
 * one tap later, from a route that checked who they are.
 *
 * `expiresAt` is included because it is not personal and it is genuinely
 * useful: a client that wakes to a notification already stale can decide not
 * to interrupt the rider at all.
 */
export function riderOfferNotification(input: {
  offerId: string;
  expiresAt: Date;
  /** Injected for tests; defaults to the clock. */
  now?: Date;
}): PushMessage {
  // Held for an offline phone only while the offer can still be accepted: a
  // fresh offer runs thirty seconds and a grace offer ninety.
  const remaining = Math.ceil((input.expiresAt.getTime() - (input.now ?? new Date()).getTime()) / 1000);
  return {
    kind: 'rider_offer',
    title: 'New delivery offer',
    body: 'Open DASH to accept it before it expires.',
    data: {
      type: 'rider_offer',
      offerId: input.offerId,
      expiresAt: input.expiresAt.toISOString(),
    },
    channel: 'offers',
    essential: true,
    collapseKey: input.offerId,
    ttlSeconds: Math.min(Math.max(remaining, 1), 90),
  };
}

/** Order statuses a customer is told about, with what they are told. */
const CUSTOMER_ORDER_COPY: Readonly<Record<string, { title: string; body: string }>> = {
  accepted: { title: 'Order accepted', body: 'The shop has accepted your order and is getting it ready.' },
  rider_assigned: { title: 'Rider on the way', body: 'A rider is heading to collect your order.' },
  picked_up: { title: 'Order picked up', body: 'Your rider has your order and is on the way.' },
  arrived: { title: 'Your rider has arrived', body: 'Your rider is at the delivery point. Have your delivery PIN ready.' },
  delivered: { title: 'Order delivered', body: 'Your order has been delivered. Enjoy!' },
  cancelled: { title: 'Order cancelled', body: 'Your order was cancelled. Open DASH for details.' },
  rejected: { title: 'Order not accepted', body: 'The shop could not take your order. Open DASH for details.' },
};

/**
 * Order statuses the assigned rider is told about. Only a cancellation: every
 * other change on a delivery is one the rider made themselves, in the app.
 */
const RIDER_ORDER_COPY: Readonly<Record<string, { title: string; body: string }>> = {
  cancelled: { title: 'Delivery cancelled', body: 'The order you were delivering was cancelled. Open DASH for details.' },
};

/** Statuses worth a push to someone. Everything else is seen in the app. */
export const PUSH_ORDER_STATUSES: ReadonlySet<string> = new Set([...Object.keys(CUSTOMER_ORDER_COPY), ...Object.keys(RIDER_ORDER_COPY)]);

/**
 * An order moved to `status`. `null` when that status is not news for this
 * side of the order. No shop, item, address or amount: the app shows those
 * one tap later from a route that checked who is asking.
 */
export function orderUpdateNotification(input: { orderId: string; status: string; audience: PushAudience }): PushMessage | null {
  const copy = (input.audience === 'customer' ? CUSTOMER_ORDER_COPY : RIDER_ORDER_COPY)[input.status];
  if (!copy) return null;
  return {
    kind: 'order_update',
    ...copy,
    data: { type: 'order_update', audience: input.audience, orderId: input.orderId, status: input.status },
    channel: 'orders',
    // A rider carrying an order needs to know it no longer exists, whatever
    // they chose about news.
    essential: input.audience === 'rider',
    collapseKey: `order_${input.orderId}`,
    ttlSeconds: 60 * 60,
  };
}

/** A message in an order's chat. Never the words: they are read in the app. */
export function orderChatNotification(input: { orderId: string; audience: PushAudience }): PushMessage {
  return {
    kind: 'order_chat',
    title: input.audience === 'customer' ? 'New message from your rider' : 'New message from your customer',
    body: 'Open DASH to read it and reply.',
    data: { type: 'order_chat', audience: input.audience, orderId: input.orderId },
    channel: 'messages',
    essential: false,
    collapseKey: `chat_${input.orderId}`,
    ttlSeconds: 6 * 60 * 60,
  };
}

/** The DASH team answered in the in-app support chat. Never the words. */
export function supportReplyNotification(input: { conversationId: string; audience: PushAudience }): PushMessage {
  return {
    kind: 'support_reply',
    title: 'DASH Support replied',
    body: 'Open DASH to read the reply.',
    data: { type: 'support_reply', audience: input.audience, conversationId: input.conversationId },
    channel: 'messages',
    essential: false,
    collapseKey: `support_${input.conversationId}`,
    ttlSeconds: 24 * 60 * 60,
  };
}

export type PaymentPushOutcome = 'refund_completed' | 'payment_not_completed';

/** A payment or refund reached an outcome the customer should hear about. No amounts. */
export function paymentUpdateNotification(input: { orderId: string; outcome: PaymentPushOutcome }): PushMessage {
  const copy =
    input.outcome === 'refund_completed'
      ? { title: 'Refund completed', body: 'Your refund has been sent. Your bank may take a few days to show it.' }
      : { title: 'Order cancelled', body: 'We did not receive payment for your order, so it was cancelled.' };
  return {
    kind: 'payment_update',
    ...copy,
    data: { type: 'payment_update', audience: 'customer', orderId: input.orderId, status: input.outcome },
    channel: 'account',
    essential: false,
    collapseKey: `payment_${input.orderId}`,
    ttlSeconds: 24 * 60 * 60,
  };
}

/**
 * A notification someone asked for, to check that push works on their own
 * phones. Sent even with their switch off — they just asked for it — and
 * only ever to the asker's own devices.
 */
export function testNotification(): PushMessage {
  return {
    kind: 'test',
    title: 'DASH test notification',
    body: 'Notifications are working on this phone.',
    data: { type: 'test' },
    channel: 'account',
    essential: true,
    collapseKey: 'dash_test',
    ttlSeconds: 10 * 60,
  };
}

/**
 * Keys a push payload may carry. Anything else is a mistake.
 *
 * An allowlist rather than a denylist of forbidden words: a denylist has to
 * anticipate every way personal data might be named, and the first field
 * someone adds called `recipient` or `note` slips straight through. This way
 * the default answer to a new key is no.
 */
const ALLOWED_DATA_KEYS: ReadonlySet<string> = new Set([
  'type',
  'audience',
  'offerId',
  'orderId',
  'conversationId',
  'status',
  'expiresAt',
]);

export class PushPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PushPayloadError';
  }
}

/**
 * Refuse a payload that carries anything but identifiers.
 *
 * Called on the way out, so a mistake fails where it is made rather than
 * arriving on a stranger's lock screen. This mirrors `assertPublishable` on
 * the outbox, and for the same reason: the boundary is the only place the rule
 * can be enforced once rather than remembered everywhere.
 */
export function assertNoPersonalData(data: Readonly<Record<string, string>>): void {
  for (const key of Object.keys(data)) {
    if (!ALLOWED_DATA_KEYS.has(key)) {
      throw new PushPayloadError(
        `Push payloads carry identifiers only; "${key}" is not an allowed key. ` +
          'If a client needs more, it re-reads through an authorized route.',
      );
    }
  }

  // Identifiers are short. A value long enough to be prose is a name, an
  // address or a note that has found its way in under an allowed key.
  for (const [key, value] of Object.entries(data)) {
    if (typeof value !== 'string') {
      throw new PushPayloadError(`Push payload "${key}" must be a string.`);
    }
    if (value.length > 200) {
      throw new PushPayloadError(
        `Push payload "${key}" is ${value.length} characters — too long to be an identifier.`,
      );
    }
  }
}
