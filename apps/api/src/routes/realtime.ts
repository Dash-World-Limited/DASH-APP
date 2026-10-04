/**
 * `GET /v1/realtime` — the WebSocket endpoint.
 *
 * A thin adapter. Every decision worth arguing about lives somewhere pure —
 * frame shapes in `@dash/domain/realtime/protocol`, who may watch what in the
 * same package's `canSubscribe` and `canReachOrder`, fan-out and eviction in
 * `realtime/hub.ts`. What is left here is the socket lifecycle and the two
 * database lookups the ownership half of authorization needs.
 *
 * ## The threats this file is written against
 *
 * **Cross-site WebSocket hijacking.** A WebSocket upgrade is not subject to the
 * same-origin policy and carries cookies, so any page on the internet can open
 * a socket to this endpoint with a signed-in user's ambient credentials. Two
 * things make that worthless: the socket authenticates from a frame rather than
 * from anything the browser attaches automatically, so an attacker's page has
 * nothing to send; and the `Origin` header is checked against the same
 * allowlist CORS uses, so the attempt does not get that far.
 *
 * **Unauthenticated sockets as a resource.** Opening connections is cheap and
 * holding them costs the server. An unauthenticated socket is closed after
 * `AUTHENTICATE_DEADLINE_MS`, the upgrade itself is an ordinary HTTP request
 * and therefore rate-limited per IP, and once authenticated a single identity
 * is capped at `MAX_CONNECTIONS_PER_IDENTITY`.
 *
 * **Frames as a way past the HTTP rate limiter.** `@fastify/rate-limit` sees
 * the upgrade and nothing after it, so every frame on an open socket would
 * otherwise be free. Each connection gets its own frame budget.
 *
 * **Probing for resources by subscription.** A refused topic is refused with
 * one code, `not_found`, whether the order does not exist or exists and belongs
 * to somebody else — the same choice `assertScope` makes by returning 404
 * rather than 403.
 */

import { randomUUID } from 'node:crypto';
import websocket from '@fastify/websocket';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  AUTHENTICATE_DEADLINE_MS,
  canReachOrder,
  canReachVendor,
  canSubscribe,
  CLIENT_MESSAGE_BUDGET,
  CLIENT_MESSAGE_WINDOW_MS,
  CLOSE,
  errorFrame,
  FrameError,
  formatTopic,
  HEARTBEAT_INTERVAL_MS,
  isFatalRejection,
  MAX_FRAME_BYTES,
  MAX_SUBSCRIPTIONS_PER_CONNECTION,
  parseClientMessage,
  parseTopic,
  RealtimeError,
  welcomeFrame,
  type ClientMessage,
  type Topic,
  type TopicRefusal,
} from '@dash/domain/realtime';
import type { Actor } from '@dash/domain/permissions';
import { verifyAccessToken } from '../auth/tokens.js';
import { loadActor } from '../auth/sessions.js';
import { Connection, type RealtimeHub, type SocketLike } from '../realtime/hub.js';

export interface RealtimeRouteDeps {
  readonly hub: RealtimeHub;
  /**
   * When false the endpoint accepts the upgrade and immediately closes with
   * `CLOSE.disabled`.
   *
   * Closing with a reason beats refusing the upgrade. A refused upgrade is an
   * opaque connection error that a client cannot tell from a proxy eating the
   * request, so it would retry five times and then fall back; a close code says
   * "this deployment does not do sockets" in one round trip and the client goes
   * straight to polling. See `dispositionFor`.
   */
  readonly enabled: boolean;
  /** Lowered by tests. */
  readonly heartbeatMs?: number;
  readonly authenticateDeadlineMs?: number;
  /**
   * How often sockets are re-checked against their sessions. Zero disables the
   * sweep, which only tests do.
   */
  readonly revalidateIntervalMs?: number;
}

/** A per-connection frame budget, refilled by elapsed time rather than a timer. */
class MessageBudget {
  private windowStartedAt: number;
  private used = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    now: number,
  ) {
    this.windowStartedAt = now;
  }

  /** True when this frame is within budget. */
  admit(now: number): boolean {
    if (now - this.windowStartedAt >= this.windowMs) {
      this.windowStartedAt = now;
      this.used = 0;
    }
    this.used += 1;
    return this.used <= this.limit;
  }
}

/**
 * Is this upgrade coming from a page we serve?
 *
 * Mirrors the CORS allowlist in `server.ts`, including its treatment of a
 * missing `Origin` as acceptable — native apps and server-to-server clients
 * send none, and a browser always does, so absence cannot be forged *by* a
 * browser into an origin that would otherwise be refused.
 */
export function isAllowedOrigin(origin: string | undefined, publicWebUrl: string): boolean {
  if (!origin) return true;
  return (
    origin === publicWebUrl ||
    origin === 'http://localhost:3000' ||
    origin === 'http://127.0.0.1:3000'
  );
}

export async function registerRealtimeRoutes(
  app: FastifyInstance,
  deps: RealtimeRouteDeps,
): Promise<void> {
  const { hub } = deps;
  const heartbeatMs = deps.heartbeatMs ?? HEARTBEAT_INTERVAL_MS;
  const authenticateDeadlineMs = deps.authenticateDeadlineMs ?? AUTHENTICATE_DEADLINE_MS;
  const revalidateIntervalMs = deps.revalidateIntervalMs ?? 60_000;

  await app.register(websocket, {
    options: {
      // Enforced by the library, below the application's own check in
      // `parseClientMessage`. Belt and braces on purpose: this one drops the
      // frame before Node has assembled it, which is the only place a genuinely
      // enormous frame can be stopped cheaply.
      maxPayload: MAX_FRAME_BYTES,
      // No compression. `permessage-deflate` on a stream that mixes
      // attacker-influenced identifiers with server data is the shape of CRIME
      // and BREACH, and these frames are far too small for it to pay anyway.
      perMessageDeflate: false,
    },
    // Close every socket before the HTTP server stops accepting, so clients see
    // a clean going-away and reconnect elsewhere rather than a reset.
    preClose: () => {
      hub.closeAll(CLOSE.going_away, 'server shutting down');
    },
  });

  // --- Session revalidation --------------------------------------------------
  // The sweep that stops a socket from outliving the session behind it. One
  // timer for the instance, not one per connection.
  if (revalidateIntervalMs > 0) {
    const timer = setInterval(() => {
      void hub
        .revalidate(
          (identityId, sessionId) => loadActor(app.services.prisma, identityId, sessionId),
          Date.now(),
        )
        .then((closed) => {
          if (closed > 0) app.log.info({ closed }, 'realtime: closed sockets with dead sessions');
        })
        .catch((error: unknown) => {
          app.log.warn(
            { error: error instanceof Error ? error.message : 'unknown' },
            'realtime: revalidation sweep failed',
          );
        });
    }, revalidateIntervalMs);
    // Never hold the process open for a housekeeping timer.
    timer.unref?.();
    app.addHook('onClose', async () => {
      clearInterval(timer);
    });
  }

  app.get('/v1/realtime', { websocket: true }, (socket, request) => {
    const connection = new Connection(randomUUID(), socket as unknown as SocketLike, Date.now());

    if (!deps.enabled) {
      // The client is told which of the two "no realtime here" cases this is,
      // so it can stop trying rather than retrying into a wall.
      connection.close(CLOSE.disabled, 'realtime is disabled');
      return;
    }

    if (!isAllowedOrigin(request.headers.origin, app.services.config.PUBLIC_WEB_URL)) {
      request.log.warn({ requestId: request.id }, 'realtime: refused a cross-origin upgrade');
      connection.close(CLOSE.protocol_violation, 'origin not allowed');
      return;
    }

    hub.add(connection);
    connection.send(welcomeFrame({ heartbeatMs, authenticateWithinMs: authenticateDeadlineMs }));

    const budget = new MessageBudget(
      CLIENT_MESSAGE_BUDGET,
      CLIENT_MESSAGE_WINDOW_MS,
      connection.openedAt,
    );

    // --- The unauthenticated deadline ---------------------------------------
    const handshakeTimer = setTimeout(() => {
      if (!connection.isAuthenticated) {
        hub.evict(connection, CLOSE.unauthenticated, 'no credentials');
      }
    }, authenticateDeadlineMs);
    handshakeTimer.unref?.();

    // --- Liveness ------------------------------------------------------------
    // A TCP connection can be gone for hours without either end noticing. The
    // ping/pong pair is what turns that into a closed socket and a freed slot
    // instead of a subscription that will never be read again.
    let awaitingPong = false;
    const heartbeat = setInterval(() => {
      if (connection.isClosed) return;
      if (awaitingPong) {
        hub.evict(connection, CLOSE.going_away, 'no response to heartbeat');
        return;
      }
      awaitingPong = true;
      try {
        socket.ping();
      } catch {
        hub.evict(connection, CLOSE.going_away, 'heartbeat failed');
      }
    }, heartbeatMs);
    heartbeat.unref?.();

    socket.on('pong', () => {
      awaitingPong = false;
    });

    const teardown = (): void => {
      clearTimeout(handshakeTimer);
      clearInterval(heartbeat);
      hub.remove(connection);
    };

    socket.on('close', teardown);
    socket.on('error', teardown);

    // Frames are handled strictly in order, one at a time.
    //
    // Handling them concurrently would be a race with a visible symptom: a
    // client that pipelines `authenticate` immediately followed by `subscribe`
    // — a perfectly reasonable thing to do — would have the subscribe reach
    // `connection.actor` while the authenticate was still awaiting its database
    // read, and be told it is not authenticated. Chaining also makes the
    // subscription cap and the frame budget mean what they say, rather than
    // being checked against state two in-flight handlers are both mutating.
    let inFlight: Promise<void> = Promise.resolve();

    socket.on('message', (raw: Buffer) => {
      inFlight = inFlight.then(
        () => handleMessage(raw),
        // Swallowed: a failure of the *previous* frame has already been dealt
        // with by the catch below, and letting it reject here would silently
        // stop the chain and freeze the socket.
        () => undefined,
      );

      void inFlight.catch((error: unknown) => {
        // Any escape from the handler is this server's bug, not the client's.
        // The socket is closed rather than left in an unknown state, and the
        // error is logged where it can be seen.
        request.log.error(
          { error: error instanceof Error ? error.message : 'unknown' },
          'realtime: message handler failed',
        );
        hub.evict(connection, CLOSE.protocol_violation, 'internal error');
      });
    });

    async function handleMessage(raw: Buffer): Promise<void> {
      if (connection.isClosed) return;

      if (!budget.admit(Date.now())) {
        hub.evict(connection, CLOSE.rate_limited, 'too many messages');
        return;
      }

      let message: ClientMessage;
      try {
        message = parseClientMessage(raw);
      } catch (error) {
        if (!(error instanceof FrameError)) throw error;

        // A frame that is not JSON, or is enormous, means the peer is not
        // speaking this protocol; there is nothing to answer and the socket
        // goes. An unknown *type* is different — that is a newer client talking
        // to an older server, and disconnecting it would make every future
        // protocol addition a breaking change.
        if (isFatalRejection(error.rejection)) {
          hub.evict(connection, CLOSE.protocol_violation, error.rejection);
          return;
        }
        connection.send(errorFrame(error.rejection, error.message));
        return;
      }

      switch (message.type) {
        case 'authenticate':
          await authenticateConnection(message.token);
          return;

        case 'subscribe':
          await subscribeTo(message.topics);
          return;

        case 'unsubscribe': {
          const removed: string[] = [];
          for (const raw of message.topics) {
            // Unsubscribing needs no authorization: it can only ever remove
            // something this connection already holds. Unparseable names are
            // simply not held, so they fall out here without an error.
            if (connection.subscriptions.has(raw)) {
              hub.unsubscribe(connection, raw);
              removed.push(raw);
            }
          }
          connection.send({ type: 'unsubscribed', topics: removed });
          return;
        }

        case 'ping':
          connection.send({ type: 'pong' });
          return;
      }
    }

    async function authenticateConnection(token: string): Promise<void> {
      const { prisma, config } = app.services;

      let actor: Actor | null = null;
      let expiresAt = 0;

      try {
        const claims = await verifyAccessToken(token, config.JWT_ACCESS_SECRET);
        actor = await loadActor(prisma, claims.sub, claims.sid);
        // A verified access token always carries `exp`; the fallback exists so
        // a token minted without one cannot become a socket that never expires.
        expiresAt = claims.exp ? claims.exp * 1_000 : Date.now();
      } catch {
        // Expired, forged, wrong audience, or a refresh token replayed here —
        // all the same answer. Distinguishing them tells an attacker which part
        // of their token was wrong.
        actor = null;
      }

      if (!actor) {
        connection.send(errorFrame('invalid_token', 'Your session is no longer valid.'));
        hub.evict(connection, CLOSE.session_invalid, 'authentication failed');
        return;
      }

      const renewal = connection.isAuthenticated;

      if (!renewal && hub.isAtConnectionLimit(actor.identityId)) {
        connection.send(errorFrame('too_many_connections', 'Too many open connections.'));
        hub.evict(connection, CLOSE.rate_limited, 'connection limit');
        return;
      }

      connection.actor = actor;
      connection.authorityExpiresAt = expiresAt;

      // Renewal clears the subscriptions on purpose. The new token may carry
      // different authority, and — more to the point — the ownership checks
      // behind the existing subscriptions were made against facts that are now
      // up to an access-token lifetime old. Re-running them through the
      // ordinary subscribe path is cheaper to be sure of than deciding which of
      // them could have gone stale.
      if (renewal) hub.resetSubscriptions(connection, 'reauthenticated');

      connection.send({ type: 'authenticated', expiresAt });
    }

    async function subscribeTo(requested: readonly string[]): Promise<void> {
      const actor = connection.actor;
      if (!actor) {
        connection.send(errorFrame('not_authenticated', 'Authenticate before subscribing.'));
        return;
      }

      const accepted: string[] = [];
      const refused: TopicRefusal[] = [];

      for (const raw of requested) {
        let topic: Topic;
        try {
          topic = parseTopic(raw);
        } catch (error) {
          if (!(error instanceof RealtimeError)) throw error;
          // A malformed name is a client bug and is named as one. It discloses
          // nothing: the server has not looked anything up to say it.
          refused.push({ topic: raw, code: 'malformed_topic' });
          continue;
        }

        // Re-formatted rather than echoed, so the name held in the index is
        // exactly the name fan-out will compute for it. Two spellings of one
        // topic would silently never match.
        const name = formatTopic(topic);

        if (connection.subscriptions.has(name)) {
          accepted.push(name);
          continue;
        }
        if (connection.subscriptions.size >= MAX_SUBSCRIPTIONS_PER_CONNECTION) {
          refused.push({ topic: name, code: 'too_many_subscriptions' });
          continue;
        }

        const decision = canSubscribe(actor, topic);
        if (!decision.allowed) {
          refused.push({ topic: name, code: 'not_found' });
          continue;
        }

        if (decision.requiresOwnershipCheck && !(await ownsSubject(actor, topic))) {
          refused.push({ topic: name, code: 'not_found' });
          continue;
        }

        if (hub.subscribe(connection, name)) accepted.push(name);
        else refused.push({ topic: name, code: 'too_many_subscriptions' });
      }

      // `resync` is always true: this stream has no history, so a client that
      // has just subscribed must read the current state over HTTP to know it.
      // That single fact is the entire reconnect-and-resume story.
      connection.send({ type: 'subscribed', topics: accepted, refused, resync: true });
    }

    /**
     * The ownership half of the check, against the database.
     *
     * Reached only when `canSubscribe` has already said this actor could hold a
     * topic of this kind and left the specific subject to be confirmed. The
     * selects are deliberately narrow — the identifiers the decision needs and
     * not one field more, so this can never become a way to read an order.
     */
    async function ownsSubject(actor: Actor, topic: Topic): Promise<boolean> {
      const { prisma } = app.services;

      if (topic.kind === 'order') {
        const order = await prisma.order.findUnique({
          where: { id: topic.id },
          select: {
            customerId: true,
            vendorId: true,
            branchId: true,
            riderId: true,
            vendor: { select: { cityId: true } },
          },
        });
        // A missing order and an order belonging to somebody else return the
        // same `false`, and the caller turns both into `not_found`.
        if (!order) return false;

        return canReachOrder(actor, {
          customerId: order.customerId,
          vendorId: order.vendorId,
          branchId: order.branchId,
          riderId: order.riderId,
          cityId: order.vendor.cityId,
        });
      }

      if (topic.kind === 'vendor') {
        const vendor = await prisma.vendor.findUnique({
          where: { id: topic.id },
          select: { cityId: true },
        });
        if (!vendor) return false;
        return canReachVendor(actor, { cityId: vendor.cityId });
      }

      // `rider` and `city` are settled by `canSubscribe` from the actor's own
      // scope and never reach here. Refusing rather than allowing means a new
      // topic kind that forgets to add its check fails closed.
      return false;
    }
  });
}

/** Exported for the tests, which assert the upgrade is refused cross-origin. */
export type { FastifyRequest };
