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

/** Every kind of push DASH sends. One, for now. */
export type PushKind = 'rider_offer';

export interface PushMessage {
  readonly kind: PushKind;
  readonly title: string;
  readonly body: string;
  /**
   * Identifiers only, all strings — the transport requires string values.
   * Deliberately not a free-form record at the call site: see `assertNoPersonalData`.
   */
  readonly data: Readonly<Record<string, string>>;
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
}): PushMessage {
  return {
    kind: 'rider_offer',
    title: 'New delivery offer',
    body: 'Open DASH to accept it before it expires.',
    data: {
      type: 'rider_offer',
      offerId: input.offerId,
      expiresAt: input.expiresAt.toISOString(),
    },
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
  'offerId',
  'orderId',
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
