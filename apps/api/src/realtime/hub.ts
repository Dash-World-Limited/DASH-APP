/**
 * The connection registry, and the only place a notification becomes a frame.
 *
 * The hub holds every socket this instance is serving, what each one is
 * subscribed to, and the authority each one authenticated with. It is
 * deliberately ignorant of `ws`: connections arrive as `SocketLike`, which is
 * the three things fan-out actually needs. That is what lets the whole delivery
 * path — matching, deduplication, backpressure, eviction — be tested without
 * opening a port, while the route file below stays a thin adapter over the real
 * socket.
 *
 * ## Authority on a socket may not outlive authority on a request
 *
 * Over HTTP, every request re-reads the session, so revoking one takes effect
 * on the next call. A socket has no next call — it authenticates once and could
 * then sit there for a day. Left alone, that would make a WebSocket a way to
 * keep using a session that has been revoked, which is precisely the kind of
 * quiet bypass this codebase spends its effort avoiding.
 *
 * Two things prevent it. Every socket carries the expiry of the token that
 * authenticated it and is closed when that passes unless the client sends a
 * fresh one, so authority is never staler than an access token. And
 * `revalidate` re-reads the session from the database on a timer, closing
 * sockets whose session has since been revoked, suspended, or expired — which
 * closes the window from fifteen minutes to the sweep interval.
 *
 * The sweep is grouped by identity rather than run per socket: a hundred
 * sockets belonging to one dispatcher cost one query, not a hundred.
 */

import {
  canSubscribe,
  CLOSE,
  encodeFrame,
  MAX_SUBSCRIPTIONS_PER_CONNECTION,
  parseTopic,
  SeenEvents,
  type CloseCode,
  type RealtimeNotification,
  type ServerFrame,
} from '@dash/domain/realtime';
import type { Actor } from '@dash/domain/permissions';

/**
 * What the hub needs from a socket.
 *
 * `bufferedAmount` is not optional decoration — it is the only way to notice a
 * client that has stopped reading, and without it a slow consumer is an
 * unbounded memory leak that looks like a healthy connection.
 */
export interface SocketLike {
  send(data: string): void;
  close(code: number, reason?: string): void;
  readonly bufferedAmount: number;
}

/**
 * Bytes allowed to queue for one client before it is disconnected.
 *
 * Frames here are a couple of hundred bytes, so this is roughly a thousand
 * undelivered notifications — far more than any real client falls behind by,
 * and a firm ceiling on what one dead TCP connection can cost.
 *
 * The client is closed rather than skipped. Dropping individual frames would
 * leave it silently missing updates with no way to know; closing makes it
 * reconnect, and reconnecting re-subscribes, and re-subscribing resyncs. The
 * recovery path already exists, so the cheapest correct thing is to use it.
 */
export const MAX_BUFFERED_BYTES = 256 * 1_024;

/**
 * Sockets one identity may hold open at once.
 *
 * A person legitimately has a few — a phone, a laptop, a second tab. This stops
 * a single credential from being a way to occupy the server's connection
 * budget, which the per-IP limits on the upgrade cannot catch on their own
 * because they are per IP, not per account.
 */
export const MAX_CONNECTIONS_PER_IDENTITY = 10;

export interface HubLogger {
  debug(payload: unknown, message: string): void;
  info(payload: unknown, message: string): void;
  warn(payload: unknown, message: string): void;
}

/**
 * One connected socket.
 *
 * Created unauthenticated. `actor` stays null until an `authenticate` frame is
 * accepted, and every subscription path refuses to do anything while it is
 * null — so there is no ordering in which a socket can subscribe before it has
 * proved who it is.
 */
export class Connection {
  readonly subscriptions = new Set<string>();

  /** Redeliveries of the same event must not become two frames on one socket. */
  private readonly seen = new SeenEvents();

  actor: Actor | null = null;

  /**
   * Epoch milliseconds at which this socket's authority lapses — the `exp` of
   * the token that authenticated it. Zero while unauthenticated.
   */
  authorityExpiresAt = 0;

  private closed = false;

  constructor(
    readonly id: string,
    private readonly socket: SocketLike,
    /** When the socket opened, for the unauthenticated-handshake deadline. */
    readonly openedAt: number,
  ) {}

  get isClosed(): boolean {
    return this.closed;
  }

  get isAuthenticated(): boolean {
    return this.actor !== null;
  }

  send(frame: ServerFrame): void {
    if (this.closed) return;
    this.socket.send(encodeFrame(frame));
  }

  close(code: CloseCode, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.subscriptions.clear();
    this.socket.close(code, reason);
  }

  /** True when this connection is too far behind to keep. */
  isOverBuffered(): boolean {
    return this.socket.bufferedAmount > MAX_BUFFERED_BYTES;
  }

  /** True the first time this event id is offered. Records it either way. */
  admit(eventId: string): boolean {
    return this.seen.admit(eventId);
  }

  /** Marks the connection closed without touching the socket, for teardown. */
  markClosed(): void {
    this.closed = true;
    this.subscriptions.clear();
  }
}

export interface HubOptions {
  readonly log?: HubLogger;
  /** Sockets one identity may hold. Lowered by tests. */
  readonly maxConnectionsPerIdentity?: number;
}

export class RealtimeHub {
  private readonly connections = new Map<string, Connection>();

  /**
   * Topic name to the connections watching it.
   *
   * A reverse index rather than a scan over every connection: a city board
   * event on an instance holding ten thousand customer sockets should cost the
   * length of that city's subscriber list, not ten thousand set lookups.
   * Delivery is on the hot path of every order transition, and the naive
   * version degrades exactly when the system is busiest.
   */
  private readonly byTopic = new Map<string, Set<Connection>>();

  private readonly maxPerIdentity: number;
  private readonly log: HubLogger | undefined;

  constructor(options: HubOptions = {}) {
    this.log = options.log;
    this.maxPerIdentity = options.maxConnectionsPerIdentity ?? MAX_CONNECTIONS_PER_IDENTITY;
  }

  get size(): number {
    return this.connections.size;
  }

  /** Connections currently subscribed to a topic. Test and metrics use only. */
  subscriberCount(topic: string): number {
    return this.byTopic.get(topic)?.size ?? 0;
  }

  add(connection: Connection): void {
    this.connections.set(connection.id, connection);
  }

  remove(connection: Connection): void {
    for (const topic of connection.subscriptions) {
      this.unindex(topic, connection);
    }
    connection.markClosed();
    this.connections.delete(connection.id);
  }

  /**
   * How many sockets this identity already holds.
   *
   * Counted at the moment of authentication rather than at the upgrade, because
   * the upgrade does not yet know who is connecting — that is the cost of
   * authenticating in-band, and it is the right trade: an unauthenticated
   * socket is already bounded by the handshake deadline and the per-IP HTTP
   * limit on the upgrade.
   */
  connectionsFor(identityId: string): number {
    let count = 0;
    for (const connection of this.connections.values()) {
      if (connection.actor?.identityId === identityId) count += 1;
    }
    return count;
  }

  /** True when this identity is at its socket limit. */
  isAtConnectionLimit(identityId: string): boolean {
    return this.connectionsFor(identityId) >= this.maxPerIdentity;
  }

  subscribe(connection: Connection, topic: string): boolean {
    if (!connection.isAuthenticated) return false;
    if (connection.subscriptions.size >= MAX_SUBSCRIPTIONS_PER_CONNECTION) return false;

    connection.subscriptions.add(topic);
    let watchers = this.byTopic.get(topic);
    if (!watchers) {
      watchers = new Set();
      this.byTopic.set(topic, watchers);
    }
    watchers.add(connection);
    return true;
  }

  unsubscribe(connection: Connection, topic: string): void {
    connection.subscriptions.delete(topic);
    this.unindex(topic, connection);
  }

  private unindex(topic: string, connection: Connection): void {
    const watchers = this.byTopic.get(topic);
    if (!watchers) return;
    watchers.delete(connection);
    // Emptied sets are removed rather than left behind: topics are per-order,
    // so a long-running instance would otherwise accumulate one dead entry for
    // every order it has ever seen.
    if (watchers.size === 0) this.byTopic.delete(topic);
  }

  /**
   * Deliver one notification to every socket entitled to it.
   *
   * Entitlement is not re-derived here. A connection is in `byTopic` only
   * because `canSubscribe` and the caller's ownership check both passed when it
   * subscribed, so matching is exact string equality and nothing else — no
   * globbing, no prefix matching, no "does this look like one of theirs".
   *
   * Returns how many sockets were written to, which is what the tests assert on
   * and what the metrics count.
   */
  publish(notification: RealtimeNotification): number {
    // A notification names several topics and one connection may hold more than
    // one of them. Collected first so each socket receives a single frame
    // naming every topic it matched, rather than one frame per match.
    const matched = new Map<Connection, string[]>();

    for (const topic of notification.topics) {
      const watchers = this.byTopic.get(topic);
      if (!watchers) continue;

      for (const connection of watchers) {
        if (connection.isClosed) continue;
        const topics = matched.get(connection);
        if (topics) topics.push(topic);
        else matched.set(connection, [topic]);
      }
    }

    let delivered = 0;

    for (const [connection, topics] of matched) {
      // At-least-once delivery upstream means this can be the second or third
      // arrival of an event already sent to this socket. The client would
      // handle it — a duplicate causes a re-read of state that is already
      // current — but making it handle it costs a request, so it is suppressed
      // here where it is free.
      if (!connection.admit(notification.eventId)) continue;

      if (connection.isOverBuffered()) {
        this.log?.warn(
          { connectionId: connection.id, topics: topics.length },
          'realtime: closing slow consumer',
        );
        this.evict(connection, CLOSE.slow_consumer, 'not reading');
        continue;
      }

      connection.send({
        type: 'event',
        topics,
        subject: notification.subject,
        version: notification.version,
        eventId: notification.eventId,
        occurredAt: notification.occurredAt,
      });
      delivered += 1;
    }

    return delivered;
  }

  /** Close a connection and drop it from the registry. */
  evict(connection: Connection, code: CloseCode, reason: string): void {
    for (const topic of connection.subscriptions) {
      this.unindex(topic, connection);
    }
    connection.close(code, reason);
    this.connections.delete(connection.id);
  }

  /**
   * Close sockets whose authority has lapsed or whose session is gone.
   *
   * `loadActor` is the same function the HTTP path uses, so "is this session
   * still good?" has one answer in this system rather than two that can drift.
   * It is called once per distinct identity, not once per socket.
   *
   * Returns the number of sockets closed, so the caller can log a revocation
   * sweep that actually did something.
   */
  async revalidate(
    loadActor: (identityId: string, sessionId: string) => Promise<Actor | null>,
    now: number,
  ): Promise<number> {
    let closed = 0;

    // Grouped by the pair that identifies a session, so two sockets on the same
    // session share one lookup.
    const sessions = new Map<string, Connection[]>();

    for (const connection of this.connections.values()) {
      const actor = connection.actor;
      if (!actor) continue;

      // Expiry is checked without touching the database: the token said when it
      // lapses and no query can make that more true.
      if (connection.authorityExpiresAt <= now) {
        this.evict(connection, CLOSE.session_invalid, 're-authenticate');
        closed += 1;
        continue;
      }

      const key = `${actor.identityId}:${actor.sessionId}`;
      const existing = sessions.get(key);
      if (existing) existing.push(connection);
      else sessions.set(key, [connection]);
    }

    for (const [key, group] of sessions) {
      const separator = key.indexOf(':');
      const identityId = key.slice(0, separator);
      const sessionId = key.slice(separator + 1);

      let actor: Actor | null = null;
      try {
        actor = await loadActor(identityId, sessionId);
      } catch (error) {
        // A database blip must not disconnect everyone. The sockets survive to
        // the next sweep, still bounded by their token expiry above, which is
        // the guarantee that does not depend on the database being reachable.
        this.log?.warn(
          { error: error instanceof Error ? error.message : 'unknown' },
          'realtime: revalidation query failed; sockets kept until their tokens expire',
        );
        return closed;
      }

      if (actor) {
        // Roles and scope may have changed since the socket authenticated — a
        // dispatcher moved between cities, a vendor manager removed from the
        // vendor. Adopting the fresh actor is not enough on its own, because
        // the subscriptions they already hold were authorised against the old
        // one and nothing would ever look at them again.
        for (const connection of group) {
          connection.actor = actor;
          this.dropUnauthorisedSubscriptions(connection, actor);
        }
        continue;
      }

      for (const connection of group) {
        this.evict(connection, CLOSE.session_invalid, 'session ended');
        closed += 1;
      }
    }

    return closed;
  }

  /**
   * Drop subscriptions this actor may no longer hold.
   *
   * Only the part of the decision that is pure is re-run here. `canSubscribe`
   * answers "could this actor ever reach a topic of this kind?" from the actor
   * alone, so a lost role, a lost vendor binding, or a city removed from a
   * dispatcher's scope is caught without a single query — which is what makes
   * it affordable to do on every sweep.
   *
   * What it cannot catch is the other half: an ownership relationship that
   * ended while the subscription stood, such as a rider reassigned off an order
   * they were carrying. Re-deriving that would mean loading every subscribed
   * order on every sweep. Instead it is bounded elsewhere — re-authentication
   * clears subscriptions and makes the client resubscribe, so a stale
   * relationship cannot outlive one access token, and what leaks in the
   * meantime is a version number for an order the actor was legitimately
   * attached to minutes earlier, never any of its data.
   */
  private dropUnauthorisedSubscriptions(connection: Connection, actor: Actor): void {
    for (const topic of [...connection.subscriptions]) {
      let allowed = false;
      try {
        allowed = canSubscribe(actor, parseTopic(topic)).allowed;
      } catch {
        // A subscription that no longer parses cannot have been granted by this
        // version of the server. Dropping it is the safe reading.
        allowed = false;
      }

      if (!allowed) {
        this.unsubscribe(connection, topic);
        this.log?.info(
          { connectionId: connection.id },
          'realtime: dropped a subscription this actor may no longer hold',
        );
      }
    }
  }

  /**
   * Clear every subscription on a connection and tell it to start again.
   *
   * Used when a socket re-authenticates. The new token may carry different
   * authority, and — more importantly — the ownership checks behind the
   * existing subscriptions were run against facts that are now minutes old.
   * Rebuilding them through the ordinary subscribe path re-runs both halves of
   * the check, which is cheaper to reason about than deciding which of them
   * could have changed.
   */
  resetSubscriptions(connection: Connection, reason: 'reauthenticated'): void {
    if (connection.subscriptions.size === 0) return;

    for (const topic of [...connection.subscriptions]) {
      this.unsubscribe(connection, topic);
    }
    connection.send({ type: 'resync', topics: [], reason });
  }

  /** Close every socket. Used on shutdown so clients reconnect elsewhere. */
  closeAll(code: CloseCode = CLOSE.going_away, reason = 'server shutting down'): void {
    for (const connection of [...this.connections.values()]) {
      this.evict(connection, code, reason);
    }
    this.byTopic.clear();
  }
}
