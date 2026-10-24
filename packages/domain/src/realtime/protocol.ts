/**
 * The realtime wire protocol.
 *
 * Pure: this module parses and builds frames and knows nothing about sockets.
 * Every function here treats its input as hostile, because the client frames
 * genuinely are — a WebSocket is an unauthenticated TCP stream until the
 * handshake below says otherwise, and anything reachable from the internet
 * gets fuzzed eventually.
 *
 * ## Why authentication happens in-band rather than at the upgrade
 *
 * A browser cannot set an `Authorization` header on a WebSocket. That leaves
 * four ways to authenticate one, and three of them are worse:
 *
 *   - **A token in the query string.** It lands in access logs, proxy logs, and
 *     anything that samples URLs. This codebase already refuses to put personal
 *     data in a URL; a 15-minute credential is worse than personal data.
 *   - **A cookie.** WebSocket upgrades are not subject to CORS and browsers
 *     send cookies on them, so a cookie-authenticated socket is cross-site
 *     WebSocket hijacking waiting to happen. The refresh cookie is deliberately
 *     scoped to `/v1/auth` for this family of reasons and must stay there.
 *   - **`Sec-WebSocket-Protocol`.** Works, and keeps the token out of the URL,
 *     but overloads a negotiation header with a credential and is awkward to
 *     rotate on a live socket.
 *
 * So the socket opens unauthenticated and carries no privilege at all until an
 * `authenticate` frame arrives with the ordinary access token — the same
 * credential, over the same TLS, that every HTTP request already uses. The
 * server closes any socket that has not authenticated within
 * `AUTHENTICATE_DEADLINE_MS`.
 *
 * That also solves the problem every long-lived socket has and most ignore: an
 * access token expires in 15 minutes, but a socket lives for hours. Because
 * authentication is a frame rather than a handshake, the client simply sends a
 * new one — the same `authenticate` frame, with a freshly refreshed token —
 * and the socket's authority is renewed without dropping its subscriptions.
 * A socket whose token has expired and has not been renewed is closed, so
 * authority on a socket can never outlive authority on an HTTP request.
 *
 * ## What a frame may carry
 *
 * Server frames carry identifiers and a version, never domain data. See the
 * note at the top of `index.ts` — that rule is what makes it impossible for
 * this transport to bypass the field-level projection rules the HTTP routes
 * enforce.
 */

/** Bumped only for a breaking change. Sent in `welcome` so a client can refuse. */
export const PROTOCOL_VERSION = 1;

/**
 * How long an unauthenticated socket is tolerated.
 *
 * Long enough for a slow phone to send one frame, short enough that opening
 * sockets is not a cheap way to hold server memory.
 */
export const AUTHENTICATE_DEADLINE_MS = 10_000;

/** Server → client heartbeat interval. A client that sees none has a dead link. */
export const HEARTBEAT_INTERVAL_MS = 25_000;

/**
 * A single frame is tiny by construction — the largest legitimate one is a
 * subscribe carrying `MAX_TOPICS_PER_MESSAGE` topics — so anything larger is
 * either a bug or an attempt to make the server allocate.
 */
export const MAX_FRAME_BYTES = 4_096;

/** Topics one `subscribe` may name. */
export const MAX_TOPICS_PER_MESSAGE = 50;

/**
 * Subscriptions one connection may hold.
 *
 * A dispatcher watching a busy city plus every order on their board is the
 * demanding case, and it is well under this. The limit exists so a single
 * socket cannot enrol itself in unbounded fan-out work.
 */
export const MAX_SUBSCRIPTIONS_PER_CONNECTION = 200;

/**
 * Client frames allowed per window, per connection.
 *
 * Separate from the HTTP rate limiter, which only ever sees the upgrade: once a
 * socket is open, every subsequent frame is free as far as `@fastify/rate-limit`
 * is concerned. This is the budget that replaces it.
 */
export const CLIENT_MESSAGE_BUDGET = 60;
export const CLIENT_MESSAGE_WINDOW_MS = 10_000;

// ---------------------------------------------------------------------------
// Close codes
// ---------------------------------------------------------------------------

/**
 * Application close codes, in the 4000–4999 range reserved for private use.
 *
 * A client distinguishes "retry with a fresh token" from "stop retrying" by
 * this code alone, so each one means exactly one thing.
 */
export const CLOSE = {
  /** Never authenticated inside the deadline. */
  unauthenticated: 4001,
  /** A frame violated the protocol. The client has a bug; retrying will not help. */
  protocol_violation: 4002,
  /** The session was revoked, expired, or the token aged out. Re-authenticate. */
  session_invalid: 4003,
  /** Client exceeded its frame budget. */
  rate_limited: 4008,
  /** The client stopped reading and its buffer grew past the cap. */
  slow_consumer: 4009,
  /** Realtime is switched off on this deployment. Fall back to polling. */
  disabled: 4013,
  /** The server is shutting down. Reconnect. */
  going_away: 4014,
} as const;

export type CloseCode = (typeof CLOSE)[keyof typeof CLOSE];

// ---------------------------------------------------------------------------
// Client to server
// ---------------------------------------------------------------------------

export interface AuthenticateMessage {
  readonly type: 'authenticate';
  readonly token: string;
}

export interface SubscribeMessage {
  readonly type: 'subscribe';
  readonly topics: readonly string[];
}

export interface UnsubscribeMessage {
  readonly type: 'unsubscribe';
  readonly topics: readonly string[];
}

export interface PingMessage {
  readonly type: 'ping';
}

export type ClientMessage =
  | AuthenticateMessage
  | SubscribeMessage
  | UnsubscribeMessage
  | PingMessage;

export type ClientMessageType = ClientMessage['type'];

/**
 * Why a frame was rejected.
 *
 * `oversized` and `malformed` are deliberately distinct from `unknown_type`:
 * the first two mean the sender is not speaking this protocol at all and the
 * socket is closed, while an unknown type is answered with an error frame and
 * the socket survives — that is what lets a newer client talk to an older
 * server without being disconnected for it.
 */
export type FrameRejection = 'oversized' | 'malformed' | 'unknown_type' | 'invalid_fields';

export class FrameError extends Error {
  constructor(
    readonly rejection: FrameRejection,
    message: string,
  ) {
    super(message);
    this.name = 'FrameError';
  }
}

/** True when a rejection means the socket should be closed rather than answered. */
export function isFatalRejection(rejection: FrameRejection): boolean {
  return rejection === 'oversized' || rejection === 'malformed';
}

function asTopicList(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new FrameError('invalid_fields', 'topics must be a non-empty array');
  }
  if (value.length > MAX_TOPICS_PER_MESSAGE) {
    throw new FrameError('invalid_fields', 'too many topics in one message');
  }
  // Validated as strings only. Whether each *names* something the caller may
  // reach is `parseTopic` plus `canSubscribe`, deliberately not here: shape and
  // authority are separate questions, and conflating them is how one of them
  // ends up skipped.
  for (const entry of value) {
    if (typeof entry !== 'string') {
      throw new FrameError('invalid_fields', 'topics must be strings');
    }
  }
  return value as readonly string[];
}

/**
 * Parse one client frame.
 *
 * Takes the raw bytes rather than a decoded string so the size limit is
 * enforced on what actually arrived, before `JSON.parse` is asked to allocate
 * anything. A 50MB frame is rejected without ever being decoded.
 */
export function parseClientMessage(raw: string | Uint8Array): ClientMessage {
  const byteLength = typeof raw === 'string' ? Buffer.byteLength(raw, 'utf8') : raw.byteLength;

  if (byteLength > MAX_FRAME_BYTES) {
    throw new FrameError('oversized', 'Frame exceeds the maximum size');
  }

  const text = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8');

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new FrameError('malformed', 'Frame is not valid JSON');
  }

  // Arrays and null are objects to `typeof`; neither is a frame.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new FrameError('malformed', 'Frame must be a JSON object');
  }

  const message = parsed as Record<string, unknown>;
  const type = message['type'];

  if (typeof type !== 'string') {
    throw new FrameError('malformed', 'Frame is missing a type');
  }

  switch (type) {
    case 'authenticate': {
      const token = message['token'];
      // Bounded before it is ever handed to a verifier. A JWT this system
      // issues is a few hundred bytes; the cap is generous and still finite.
      if (typeof token !== 'string' || token.length === 0 || token.length > 4_000) {
        throw new FrameError('invalid_fields', 'authenticate requires a token');
      }
      return { type: 'authenticate', token };
    }

    case 'subscribe':
      return { type: 'subscribe', topics: asTopicList(message['topics']) };

    case 'unsubscribe':
      return { type: 'unsubscribe', topics: asTopicList(message['topics']) };

    case 'ping':
      return { type: 'ping' };

    default:
      throw new FrameError('unknown_type', 'Unknown frame type');
  }
}

// ---------------------------------------------------------------------------
// Server to client
// ---------------------------------------------------------------------------

/**
 * Why a topic was refused.
 *
 * There is exactly one refusal code for "you may not have this", and it is
 * named `not_found`. A separate `forbidden` would confirm that the resource
 * exists, which is the same disclosure `assertScope` refuses to make over HTTP
 * by returning 404 rather than 403. The socket must not be a way around that.
 */
export type RefusalCode = 'not_found' | 'malformed_topic' | 'too_many_subscriptions';

export interface TopicRefusal {
  readonly topic: string;
  readonly code: RefusalCode;
}

export interface WelcomeFrame {
  readonly type: 'welcome';
  readonly protocol: number;
  readonly heartbeatMs: number;
  readonly authenticateWithinMs: number;
}

export interface AuthenticatedFrame {
  readonly type: 'authenticated';
  /**
   * When this socket's authority lapses, as epoch milliseconds.
   *
   * The client renews by sending another `authenticate` before it passes. This
   * is the socket equivalent of an access token expiring mid-session, and it is
   * surfaced rather than left implicit so a client can schedule the renewal
   * instead of discovering it as a disconnect.
   */
  readonly expiresAt: number;
}

export interface SubscribedFrame {
  readonly type: 'subscribed';
  readonly topics: readonly string[];
  readonly refused: readonly TopicRefusal[];
  /**
   * Always true, and it is not redundant.
   *
   * This stream carries no history. A client that has just subscribed — first
   * connection, or reconnection after a gap — cannot know whether anything
   * changed while it was not listening, and the server cannot tell it, because
   * nothing here stores a per-topic log. So every subscription begins by
   * telling the client to read the current state over HTTP.
   *
   * That is the whole reconnect story, and it is only this simple because the
   * stream is notifications rather than data: there is no gap to replay, only a
   * screen to refresh.
   */
  readonly resync: true;
}

export interface UnsubscribedFrame {
  readonly type: 'unsubscribed';
  readonly topics: readonly string[];
}

export interface EventFrame {
  readonly type: 'event';
  /**
   * The subscriptions this delivery answers — every topic the connection holds
   * that this event reached.
   *
   * Plural, and that is what keeps one change to one frame. A vendor watching
   * both `order:abc` and their own queue matches twice; sending two frames
   * would make that client re-read twice for a single change, and deduplicating
   * by event id on the client would then throw away the second topic name it
   * needed in order to know which of its two views to refresh. Naming every
   * matched topic once says the same thing without either problem.
   */
  readonly topics: readonly string[];
  /** What changed, as `kind:id`. One subject reaches several topics. */
  readonly subject: string;
  /**
   * Monotonic per subject. Compared only against another version for the *same*
   * subject — see `shouldRefresh`.
   */
  readonly version: number;
  /** Stable across redeliveries of the same event. The dedupe key. */
  readonly eventId: string;
  /**
   * When the change was recorded, epoch milliseconds.
   *
   * Informational only. It is never used to order events, because it is a wall
   * clock read on whichever instance handled the write, and two instances do
   * not agree closely enough to order anything by. `version` is the ordering.
   */
  readonly occurredAt: number;
}

export interface ResyncFrame {
  readonly type: 'resync';
  readonly topics: readonly string[];
  readonly reason: 'backpressure' | 'reauthenticated' | 'server_restart';
}

export interface ErrorFrame {
  readonly type: 'error';
  readonly code: string;
  readonly message: string;
}

export interface PongFrame {
  readonly type: 'pong';
}

export type ServerFrame =
  | WelcomeFrame
  | AuthenticatedFrame
  | SubscribedFrame
  | UnsubscribedFrame
  | EventFrame
  | ResyncFrame
  | ErrorFrame
  | PongFrame;

/**
 * The first frame on every socket.
 *
 * Takes the timings the server is actually running with rather than reading the
 * constants. A client schedules its heartbeat and its authenticate frame from
 * what this says, so a welcome that advertises the default while the server
 * enforces something shorter is a client that gets disconnected for obeying the
 * server.
 */
export function welcomeFrame(
  timings: { heartbeatMs?: number; authenticateWithinMs?: number } = {},
): WelcomeFrame {
  return {
    type: 'welcome',
    protocol: PROTOCOL_VERSION,
    heartbeatMs: timings.heartbeatMs ?? HEARTBEAT_INTERVAL_MS,
    authenticateWithinMs: timings.authenticateWithinMs ?? AUTHENTICATE_DEADLINE_MS,
  };
}

export function errorFrame(code: string, message: string): ErrorFrame {
  return { type: 'error', code, message };
}

export function encodeFrame(frame: ServerFrame): string {
  return JSON.stringify(frame);
}
