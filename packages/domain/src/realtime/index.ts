/**
 * Who may listen to what, and how a client catches up after a gap.
 *
 * This module decides subscription authorization and nothing else. It is pure —
 * no socket, no database, no clock it was not given — so the rule that one
 * customer cannot listen to another customer's order is a function with a truth
 * table rather than a property of some connection handler that happened to
 * check the right thing.
 *
 * ## The decision that shapes everything else: notifications, not data
 *
 * A realtime message here carries **identifiers and a version, never domain
 * data**. `{ topic: 'order:abc', orderId: 'abc', version: 12 }` and no more.
 * The client reacts by re-reading through the ordinary authorized HTTP route.
 *
 * That looks like an extra round trip and it is. It is also the only design
 * that cannot leak, and the reason is worth stating plainly: the HTTP layer
 * enforces field-level projection rules that took the whole project to get
 * right — a vendor never sees the customer's phone number, a rider does not see
 * the exact drop-off address until they have accepted, ops sees a different
 * shape again. Those rules live in the route handlers. A socket that pushed row
 * data out of the outbox would bypass every one of them, silently, for every
 * subscriber at once. Pushing an identifier and making the client ask through
 * the front door means the projection rules apply to realtime automatically and
 * can never drift from the ones the API already enforces.
 *
 * The outbox payload rule (`assertPublishable` refuses personal data) is the
 * same instinct one layer down. This module is where it becomes an invariant of
 * the transport rather than a property of each call site.
 *
 * ## Ordering and duplicates
 *
 * Delivery is at-least-once and unordered. Both are fine here *because* the
 * payload is a notification: acting on a duplicate means re-reading state that
 * is already current, and acting on a stale one means re-reading state that is
 * newer than the notification claimed. Neither can corrupt anything. The
 * `version` exists so a client can skip work it has already done, not so it can
 * reconstruct state from the stream — that would be event sourcing, and this is
 * not that.
 */

import {
  can,
  CITY_SCOPED_ROLES,
  VENDOR_SCOPED_ROLES,
  type Actor,
} from '../permissions/index.js';

export * from './protocol.js';
export * from './transport.js';

/** The kinds of subject a client can follow. */
export type TopicKind =
  /** One order, followed by its customer, its vendor, its rider, or ops. */
  | 'order'
  /** A vendor's incoming queue. */
  | 'vendor'
  /** A rider's own offers and active delivery. */
  | 'rider'
  /** A city's dispatch board. */
  | 'city';

export interface Topic {
  readonly kind: TopicKind;
  readonly id: string;
}

/**
 * Topic names are opaque strings on the wire.
 *
 * `kind:id`, with the id constrained to the cuid alphabet so a caller cannot
 * smuggle a separator, a wildcard, or a pattern into the name and widen their
 * own subscription. A topic is matched by exact string equality everywhere; no
 * globbing is supported anywhere in this system, deliberately.
 */
const TOPIC_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export class RealtimeError extends Error {
  constructor(
    readonly reason:
      | 'malformed_topic'
      | 'unknown_kind'
      | 'not_permitted',
    message: string,
  ) {
    super(message);
    this.name = 'RealtimeError';
  }
}

export function formatTopic(topic: Topic): string {
  if (!TOPIC_ID_PATTERN.test(topic.id)) {
    throw new RealtimeError('malformed_topic', `Topic id is not a valid identifier`);
  }
  return `${topic.kind}:${topic.id}`;
}

/**
 * Parse a topic name supplied by a client.
 *
 * Everything about this function assumes the input is hostile. The error
 * messages deliberately say nothing about whether the named resource exists —
 * that is decided later, by the caller, against the database.
 */
export function parseTopic(raw: unknown): Topic {
  if (typeof raw !== 'string' || raw.length > 80) {
    throw new RealtimeError('malformed_topic', 'Topic must be a short string');
  }

  const separator = raw.indexOf(':');
  if (separator <= 0) {
    throw new RealtimeError('malformed_topic', 'Topic must be "kind:id"');
  }

  const kind = raw.slice(0, separator);
  const id = raw.slice(separator + 1);

  if (!TOPIC_ID_PATTERN.test(id)) {
    throw new RealtimeError('malformed_topic', 'Topic id is not a valid identifier');
  }
  if (kind !== 'order' && kind !== 'vendor' && kind !== 'rider' && kind !== 'city') {
    throw new RealtimeError('unknown_kind', 'Unknown topic kind');
  }

  return { kind, id };
}

/**
 * What the caller must still check after this function says yes.
 *
 * Permission and ownership are separate checks throughout this codebase, and
 * realtime is no exception. This module answers the first half from the actor
 * alone: does this actor hold a role that could ever listen to this kind of
 * topic, and — where the actor's own scope already names the subject — is this
 * that subject?
 *
 * `requiresOwnershipCheck` is how the second half is demanded rather than
 * assumed. For an order topic no actor's scope names the order, so the caller
 * must load it and confirm the relationship. Returning a flag rather than a
 * bare `true` means a caller that forgets is making a visible omission instead
 * of inheriting a silent yes.
 */
export interface SubscriptionDecision {
  readonly allowed: boolean;
  /** True when the caller must confirm the actor's relationship to the subject. */
  readonly requiresOwnershipCheck: boolean;
  /** Why it was refused. Never disclosed to the client verbatim. */
  readonly reason?: string;
}

const DENY = (reason: string): SubscriptionDecision => ({
  allowed: false,
  requiresOwnershipCheck: false,
  reason,
});

/**
 * Can this actor subscribe to this topic?
 *
 * The answers here mirror what the HTTP routes already allow, and that
 * correspondence is the point rather than a coincidence. A socket that is
 * *stricter* than HTTP silently breaks features for people who can plainly see
 * the data on a page; a socket that is *looser* is a vulnerability that no
 * amount of care in the route handlers can catch. So the reach of an
 * operations actor is decided by the same permission strings the routes gate
 * on — `ops:order:read:all` and `ops:livemap:read` — and never by a role name,
 * which is the rule `permissions/index.ts` exists to enforce.
 *
 * The one deliberate narrowing is the rider stream; see that case.
 */
export function canSubscribe(actor: Actor, topic: Topic): SubscriptionDecision {
  const isVendorScoped = actor.roles.some((role) => VENDOR_SCOPED_ROLES.has(role));
  const isCityScoped = actor.roles.some((role) => CITY_SCOPED_ROLES.has(role));
  const opsReadsOrders = can(actor, 'ops:order:read:all');
  const opsReadsBoard = can(actor, 'ops:livemap:read');

  switch (topic.kind) {
    case 'order':
      // No actor scope names an order id, so every order subscription is
      // resolved against the order row itself. Four relationships qualify —
      // customer, vendor, assigned rider, and operations — and the caller
      // checks which, if any, applies.
      if (
        actor.customerId ||
        actor.riderId ||
        (isVendorScoped && actor.vendorId) ||
        opsReadsOrders
      ) {
        return { allowed: true, requiresOwnershipCheck: true };
      }
      return DENY('no role that can relate to an order');

    case 'vendor':
      // A vendor user reaches exactly one vendor and their own scope names it,
      // so this is settled here with nothing left to confirm.
      if (isVendorScoped) {
        return actor.vendorId === topic.id
          ? { allowed: true, requiresOwnershipCheck: false }
          : DENY('not this vendor');
      }
      // Operations may watch a vendor's queue. A city-scoped dispatcher may
      // only watch a vendor in one of their cities, and the vendor's city is
      // not in the actor — so that half defers to the caller, which loads the
      // vendor and runs `assertScope`. An unscoped ops actor has nothing left
      // to check.
      if (opsReadsOrders) {
        return { allowed: true, requiresOwnershipCheck: isCityScoped };
      }
      return DENY('not this vendor, and no operations reach');

    case 'rider':
      // A rider's own stream, and nobody else's. This is narrower than
      // `ops:rider:read:all` on purpose: a dispatcher's job is the city board,
      // and following one named rider's every movement is a different thing
      // from running a dispatch desk. Widening it is a product decision that
      // should be made deliberately, not inherited from a permission that was
      // granted for the board.
      if (actor.riderId === topic.id) {
        return { allowed: true, requiresOwnershipCheck: false };
      }
      return DENY('a rider stream is private to that rider');

    case 'city':
      // The dispatch board.
      if (!opsReadsBoard) return DENY('not an operations actor');
      // A city-scoped role carries the list of cities it may operate in, so an
      // actor scoped to Lagos cannot watch Abuja. Note this is strictly tighter
      // than `GET /v1/ops/live`, which applies its city filter only when the
      // actor happens to have cities listed — a dispatcher with an empty list
      // sees every city there and nothing here. Failing closed is the right
      // direction for the looser of two checks to be corrected towards.
      if (isCityScoped) {
        return actor.cityIds?.includes(topic.id)
          ? { allowed: true, requiresOwnershipCheck: false }
          : DENY('not scoped to this city');
      }
      // Ops roles that are not city-bound — platform and super admins — reach
      // every city, exactly as they do on the board itself.
      return { allowed: true, requiresOwnershipCheck: false };
  }
}

// ---------------------------------------------------------------------------
// The second half: ownership
// ---------------------------------------------------------------------------

/**
 * The fields of an order that decide who may watch it.
 *
 * Deliberately not the order — five identifiers and nothing else, so this
 * cannot accidentally come to depend on the order's contents and so a caller is
 * never tempted to pass a row it selected too much of.
 */
export interface OrderSubject {
  readonly customerId: string;
  readonly vendorId: string;
  /** Set when the vendor runs branches and the order belongs to one. */
  readonly branchId?: string | null;
  /** Null until a rider is assigned. */
  readonly riderId?: string | null;
  /** The vendor's city, which is what puts this order on a dispatch board. */
  readonly cityId?: string | null;
}

/**
 * Does this actor stand in any relationship to this order?
 *
 * `canSubscribe` answers whether an actor could ever watch an order; this
 * answers whether they may watch *this* one. Both must pass, which is the same
 * two-part rule `assertPermission` plus `assertScope` enforce over HTTP.
 *
 * Any relationship is enough, and that matters: one identity can be both a
 * customer and a rider, and a rider carrying their own order must not be
 * refused because the first relationship checked was not the one that applied.
 * Checking them in sequence and taking the first match would do exactly that.
 *
 * Every clause mirrors the check the corresponding HTTP route already makes —
 * the vendor routes scope by vendor and branch, the rider routes by rider, the
 * customer route by customer, and the operations board by city. Where they
 * differ, the route is the specification and this is the bug.
 */
export function canReachOrder(actor: Actor, order: OrderSubject): boolean {
  // The customer who placed it.
  if (actor.customerId && order.customerId === actor.customerId) return true;

  // The rider currently carrying it. `riderId` is null until dispatch assigns
  // one, which is what stops an unassigned rider learning the order exists.
  if (actor.riderId && order.riderId && order.riderId === actor.riderId) return true;

  // The vendor fulfilling it, and — when the vendor runs branches and the staff
  // member is bound to one — only their own branch.
  const isVendorScoped = actor.roles.some((role) => VENDOR_SCOPED_ROLES.has(role));
  if (isVendorScoped && actor.vendorId && order.vendorId === actor.vendorId) {
    const branchMismatch =
      actor.branchId !== undefined &&
      actor.branchId !== null &&
      order.branchId !== undefined &&
      order.branchId !== null &&
      actor.branchId !== order.branchId;
    if (!branchMismatch) return true;
  }

  // Operations. A city-bound role reaches only its own cities; an unbound one
  // — platform and super admin — reaches every order, as it does on the board.
  if (can(actor, 'ops:order:read:all')) {
    const isCityScoped = actor.roles.some((role) => CITY_SCOPED_ROLES.has(role));
    if (!isCityScoped) return true;
    if (order.cityId && actor.cityIds?.includes(order.cityId)) return true;
  }

  return false;
}

/**
 * May this actor watch this vendor's queue?
 *
 * Only reached for an actor that is not the vendor themselves — `canSubscribe`
 * settles that case without a lookup — so this is the operations path, and the
 * single question left is whether the vendor's city is one of theirs.
 */
export function canReachVendor(actor: Actor, vendor: { readonly cityId?: string | null }): boolean {
  if (!can(actor, 'ops:order:read:all')) return false;

  const isCityScoped = actor.roles.some((role) => CITY_SCOPED_ROLES.has(role));
  if (!isCityScoped) return true;

  return Boolean(vendor.cityId && actor.cityIds?.includes(vendor.cityId));
}

/**
 * The topics an order change should be announced on.
 *
 * One state change reaches several audiences, and each of them is following a
 * different topic. Computed from the order's own relationships so the fan-out
 * cannot include an audience the order has no connection to — a rider that has
 * not been assigned yet gets nothing, which is what stops an unassigned rider
 * learning that an order exists.
 */
export function orderTopics(order: {
  readonly orderId: string;
  readonly vendorId?: string | null;
  readonly riderId?: string | null;
  readonly cityId?: string | null;
}): string[] {
  const topics = [formatTopic({ kind: 'order', id: order.orderId })];

  if (order.vendorId) topics.push(formatTopic({ kind: 'vendor', id: order.vendorId }));
  if (order.riderId) topics.push(formatTopic({ kind: 'rider', id: order.riderId }));
  if (order.cityId) topics.push(formatTopic({ kind: 'city', id: order.cityId }));

  return topics;
}

// ---------------------------------------------------------------------------
// The notification itself
// ---------------------------------------------------------------------------

/**
 * One change, addressed to the topics that should hear about it.
 *
 * Identifiers and a version. Nothing else, ever — see the module note. This
 * shape is what travels through the outbox, through the queue, and across the
 * broadcast channel between instances, so widening it widens all three at once.
 */
export interface RealtimeNotification {
  /**
   * Stable across redeliveries of the same change.
   *
   * Derived from the subject and its version rather than allocated, so a relay
   * that republishes a row it had already published — the ordinary
   * at-least-once case — produces a byte-identical id. That stability is the
   * entire basis of duplicate suppression downstream, and deriving it means no
   * layer has to read a row back to learn what to call the event.
   */
  readonly eventId: string;
  /** What changed, as `kind:id`. */
  readonly subject: string;
  /** Where it should be announced. Exact topic names; never patterns. */
  readonly topics: readonly string[];
  /** Monotonic for this subject. Compared only against the same subject. */
  readonly version: number;
  /** Epoch milliseconds, informational. Never used for ordering. */
  readonly occurredAt: number;
}

/**
 * Parse a notification that arrived from outside this process.
 *
 * Notifications reach a server instance from two places that are not it: a
 * queue job, and the broadcast channel every instance listens on. Both are
 * shared infrastructure. A second deployment pointed at the same Redis, a
 * malformed republish, or anything else that can put bytes on that channel must
 * not be able to turn them into a frame on somebody's socket — so nothing is
 * trusted merely because it arrived on an internal channel.
 *
 * The topic list is re-parsed rather than taken at face value, which is what
 * stops a crafted `topics: ['order:*']` from reaching a fan-out that matches by
 * string equality only because every producer happens to be well behaved today.
 */
export function parseNotification(raw: unknown): RealtimeNotification {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new RealtimeError('malformed_topic', 'Notification must be an object');
  }

  const value = raw as Record<string, unknown>;
  const eventId = value['eventId'];
  const subject = value['subject'];
  const topics = value['topics'];
  const version = value['version'];
  const occurredAt = value['occurredAt'];

  if (typeof eventId !== 'string' || eventId.length === 0 || eventId.length > 128) {
    throw new RealtimeError('malformed_topic', 'Notification is missing an event id');
  }
  if (typeof subject !== 'string') {
    throw new RealtimeError('malformed_topic', 'Notification is missing a subject');
  }
  // Throws if the subject is not a well-formed `kind:id`.
  parseTopic(subject);

  if (!Array.isArray(topics) || topics.length === 0 || topics.length > 64) {
    throw new RealtimeError('malformed_topic', 'Notification names no topics');
  }
  const parsedTopics = topics.map((topic) => formatTopic(parseTopic(topic)));

  // A version must be a finite, non-negative integer: `shouldRefresh` compares
  // it with `>`, and NaN would make every comparison false, silently dropping
  // every notification for that subject rather than failing visibly.
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0) {
    throw new RealtimeError('malformed_topic', 'Notification version must be a whole number');
  }
  if (typeof occurredAt !== 'number' || !Number.isFinite(occurredAt) || occurredAt < 0) {
    throw new RealtimeError('malformed_topic', 'Notification timestamp is not a number');
  }

  return { eventId, subject, topics: parsedTopics, version, occurredAt };
}

// ---------------------------------------------------------------------------
// Duplicate and out-of-order handling
// ---------------------------------------------------------------------------

/**
 * A bounded set of recently seen event ids.
 *
 * At-least-once delivery means the same event arrives more than once, and a
 * client that re-reads on every duplicate wastes a request per redelivery. An
 * unbounded set would be a memory leak on a long-lived connection, so this
 * forgets the oldest ids once it is full — which is safe, because forgetting
 * causes at worst one extra re-read, exactly the thing it exists to avoid but
 * never a wrong answer.
 */
export class SeenEvents {
  private readonly seen = new Set<string>();

  constructor(private readonly capacity = 512) {}

  /** True when this id has not been seen before. Records it either way. */
  admit(eventId: string): boolean {
    if (this.seen.has(eventId)) return false;

    if (this.seen.size >= this.capacity) {
      // Sets iterate in insertion order, so the first key is the oldest.
      const oldest = this.seen.values().next();
      if (!oldest.done) this.seen.delete(oldest.value);
    }

    this.seen.add(eventId);
    return true;
  }

  get size(): number {
    return this.seen.size;
  }
}

/**
 * Should a notification at `incoming` cause a re-read, given `current`?
 *
 * Versions are advisory. A notification older than what the client already
 * holds is dropped, because the client's state is newer than the news. Equal
 * versions are dropped as a duplicate. Anything else is worth a re-read.
 *
 * `undefined` for either side means "unknown", and unknown always re-reads: a
 * missed update is a stale screen, while an unnecessary read is one request.
 */
export function shouldRefresh(current: number | undefined, incoming: number | undefined): boolean {
  if (current === undefined || incoming === undefined) return true;
  return incoming > current;
}
