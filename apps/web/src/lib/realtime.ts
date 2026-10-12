'use client';

/**
 * The browser side of realtime.
 *
 * ## What this deliberately does not do
 *
 * It never puts anything from a notification into the UI. A frame says "order
 * abc is now at version 12" and this client's entire response is to tell the
 * screen to re-read through the ordinary authorized route. That is not caution
 * for its own sake — it is what makes the socket incapable of bypassing the
 * field-level projection rules the API enforces per role
 * ([ADR-0013](../../../../docs/DECISIONS.md)). A vendor's queue shows a
 * customer's first name and no phone number *because the vendor route says so*,
 * and that stays true no matter what arrives on a socket.
 *
 * So the callback below receives identifiers and a reason, and nothing else.
 * There is no shape it could pass to a component even by mistake, which is a
 * stronger guarantee than remembering not to.
 *
 * ## Polling is not removed, it is slowed
 *
 * Every screen here polled before this existed, and still does. When the socket
 * is live the interval stretches to a safety net; when it is not, it returns to
 * what it was. That is the whole fallback story, and it works because both
 * paths are the same read — the socket only changes *when* it happens.
 *
 * Keeping a slow poll even while live is deliberate. At-least-once delivery
 * says a notification may arrive twice; nothing promises one always arrives at
 * all. A dropped frame with no poll behind it is a screen that is silently
 * wrong until the user reloads, which is worse than the polling it replaced.
 *
 * ## Testability
 *
 * The socket constructor, the token source, and the clock are injected. The
 * tests drive a fake socket directly, so reconnection, duplicate delivery, and
 * out-of-order arrival are exercised deterministically rather than provoked.
 */

import {
  CLOSE,
  INITIAL_CONNECTION_STATE,
  onConnected,
  onDisconnected,
  parseTopic,
  reconnectDelayMs,
  SeenEvents,
  shouldRefresh,
  type ConnectionState,
} from '@dash/domain/realtime';
import { API_BASE } from './api';
import { getAccessToken } from './session';

/**
 * The parts of a `WebSocket` this client uses.
 *
 * Property-style handlers rather than `addEventListener`, because that is the
 * browser API's own shape and it makes a fake trivial to write.
 */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: (() => void) | null;
}

/** Why a screen is being asked to re-read. */
export type RefreshReason =
  /** A change was announced for something this screen watches. */
  | 'event'
  /**
   * The subscription is new or was re-established. The screen must re-read
   * because this stream has no history and cannot say what was missed.
   */
  | 'resync';

/**
 * What a screen is told when something changes.
 *
 * Identifiers and a reason. Note what is absent: any field from the
 * notification. `subjects` is here so a screen *could* narrow a refetch, and it
 * is safe for that because an id is not domain state — but nothing in this
 * codebase renders it.
 */
export interface RefreshHint {
  readonly reason: RefreshReason;
  readonly subjects: readonly string[];
}

export type RefreshListener = (hint: RefreshHint) => void;

/** What the client is currently doing, for an honest status indicator. */
export type RealtimeStatus =
  /** No socket yet, or reconnecting. Polling is carrying the screen. */
  | 'connecting'
  /** Authenticated and subscribed. Changes arrive as they happen. */
  | 'live'
  /** Given up on the socket for this session. Polling only. */
  | 'polling';

export type StatusListener = (status: RealtimeStatus) => void;

export interface RealtimeClientOptions {
  /** Overridden by tests. Defaults to the API origin with the ws scheme. */
  url?: string;
  /** Overridden by tests. Defaults to the browser's `WebSocket`. */
  createSocket?: (url: string) => WebSocketLike;
  /** Overridden by tests. Defaults to the session's access token. */
  getToken?: () => Promise<string | null>;
  now?: () => number;
  random?: () => number;
}

/** `http(s)://host` → `ws(s)://host/v1/realtime`. */
export function realtimeUrlFor(apiBase: string): string {
  const base = apiBase.replace(/^http/i, (match) => (match === 'HTTP' ? 'WS' : 'ws'));
  return `${base.replace(/\/$/, '')}/v1/realtime`;
}

interface Subscription {
  readonly topic: string;
  readonly listeners: Set<RefreshListener>;
}

export class RealtimeClient {
  private socket: WebSocketLike | null = null;
  private connection: ConnectionState = INITIAL_CONNECTION_STATE;
  private status: RealtimeStatus = 'connecting';

  private readonly subscriptions = new Map<string, Subscription>();
  private readonly statusListeners = new Set<StatusListener>();

  /** Topics confirmed by the server. Cleared whenever the socket is not live. */
  private confirmed = new Set<string>();

  /**
   * The highest version seen per subject.
   *
   * Per *subject*, not per topic: a vendor queue carries notifications about
   * many orders, and comparing one order's revision with another's would be
   * meaningless. See ADR-0013.
   */
  private readonly versions = new Map<string, number>();

  /** Suppresses a redelivery of the same change. */
  private readonly seen = new SeenEvents();

  private authenticated = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reauthTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  private readonly url: string;
  private readonly createSocket: (url: string) => WebSocketLike;
  private readonly getToken: () => Promise<string | null>;
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(options: RealtimeClientOptions = {}) {
    this.url = options.url ?? realtimeUrlFor(API_BASE);
    this.createSocket =
      options.createSocket ??
      ((url) => new WebSocket(url) as unknown as WebSocketLike);
    this.getToken = options.getToken ?? getAccessToken;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  getStatus(): RealtimeStatus {
    return this.status;
  }

  onStatusChange(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  private setStatus(next: RealtimeStatus): void {
    if (this.status === next) return;
    this.status = next;
    for (const listener of this.statusListeners) listener(next);
  }

  /**
   * Watch some topics.
   *
   * Returns an unsubscribe. Several screens may watch the same topic; the
   * socket subscription lasts as long as the last of them.
   */
  subscribe(topics: readonly string[], listener: RefreshListener): () => void {
    const added: string[] = [];

    for (const topic of topics) {
      // Validated here so a screen bug becomes a visible throw rather than a
      // subscription the server silently refuses.
      parseTopic(topic);

      let entry = this.subscriptions.get(topic);
      if (!entry) {
        entry = { topic, listeners: new Set() };
        this.subscriptions.set(topic, entry);
        added.push(topic);
      }
      entry.listeners.add(listener);
    }

    this.start();
    if (added.length > 0 && this.authenticated) this.sendSubscribe(added);

    return () => {
      for (const topic of topics) {
        const entry = this.subscriptions.get(topic);
        if (!entry) continue;
        entry.listeners.delete(listener);
        if (entry.listeners.size > 0) continue;

        this.subscriptions.delete(topic);
        this.confirmed.delete(topic);
        if (this.authenticated) {
          this.send({ type: 'unsubscribe', topics: [topic] });
        }
      }
      if (this.subscriptions.size === 0) this.stop();
    };
  }

  /** Open a socket, unless one is already open or the client has fallen back. */
  private start(): void {
    if (this.stopped) {
      this.stopped = false;
      this.connection = INITIAL_CONNECTION_STATE;
    }
    if (this.socket || this.reconnectTimer) return;
    if (this.connection.fellBack) return;
    this.open();
  }

  private open(): void {
    this.setStatus('connecting');

    let socket: WebSocketLike;
    try {
      socket = this.createSocket(this.url);
    } catch {
      // A constructor that throws — a blocked URL, a hostile environment — is
      // the same situation as a socket that never opens.
      this.handleClose(1006);
      return;
    }

    this.socket = socket;

    socket.onopen = (): void => {
      // Nothing is sent here. The server speaks first with `welcome`, and the
      // token is fetched lazily so a refresh does not delay the upgrade.
    };

    socket.onmessage = (event): void => {
      void this.handleFrame(event.data);
    };

    socket.onerror = (): void => {
      // `onclose` always follows; handling both would double-count the failure
      // against the connection budget and fall back twice as fast as intended.
    };

    socket.onclose = (event): void => {
      this.handleClose(event?.code ?? 1006);
    };
  }

  private async handleFrame(raw: unknown): Promise<void> {
    // A closed socket can still deliver a frame that was already buffered, and
    // `stop()` returns before the close completes. Without this guard a screen
    // that has been torn down could still be told to refetch.
    if (this.stopped) return;
    if (typeof raw !== 'string') return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    // `null` and an array are both objects to `typeof`, and neither is a frame.
    // Reading `.type` off the first of them throws, which on a socket handler
    // means an unhandled rejection rather than an ignored message.
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return;

    const frame = parsed as { type?: unknown; [key: string]: unknown };
    if (typeof frame.type !== 'string') return;

    switch (frame.type) {
      case 'welcome': {
        const token = await this.getToken();
        if (!token) {
          // Nothing to authenticate with. Falling back rather than reconnecting
          // in a loop: a signed-out client has no business holding a socket.
          this.socket?.close(1000, 'no session');
          return;
        }
        this.send({ type: 'authenticate', token });
        return;
      }

      case 'authenticated': {
        this.authenticated = true;
        this.connection = onConnected(this.connection);
        this.setStatus('live');
        this.scheduleReauthentication(frame['expiresAt']);

        // Subscribe to everything currently wanted. On a reconnect this is what
        // re-establishes the subscriptions, and the `subscribed` frame that
        // answers it carries `resync: true` — which is what stops a gap in the
        // stream leaving a stale screen.
        const topics = [...this.subscriptions.keys()];
        if (topics.length > 0) this.sendSubscribe(topics);
        return;
      }

      case 'subscribed': {
        const accepted = Array.isArray(frame['topics']) ? (frame['topics'] as string[]) : [];
        for (const topic of accepted) this.confirmed.add(topic);

        // A refused topic is never retried. The server said `not_found`, which
        // means "not yours or not there" and will not change by asking again.
        // The screen keeps polling and its own fetch reports the real error.
        if (accepted.length > 0) {
          this.notify(accepted, 'resync', accepted);
        }
        return;
      }

      case 'resync': {
        // The server cleared this connection's subscriptions — it does that on
        // re-authentication so the ownership checks behind them are re-run.
        this.confirmed.clear();
        const topics = [...this.subscriptions.keys()];
        if (topics.length > 0) this.sendSubscribe(topics);
        return;
      }

      case 'event':
        this.handleEvent(frame);
        return;

      default:
        // `pong`, `unsubscribed`, `error`, and anything a newer server adds.
        // Ignored rather than treated as a failure: an unknown frame must not
        // be able to knock a working client off its socket.
        return;
    }
  }

  /**
   * Decide whether a notification is worth a re-read, then say so.
   *
   * Two independent filters, and they catch different things. The event id
   * catches a redelivery of the *same* change — at-least-once delivery makes
   * that ordinary. The version catches a *stale* change arriving after a newer
   * one, which unordered delivery makes ordinary too. Neither is an
   * optimisation that can go wrong: acting on either would cause one extra
   * fetch of state that is already correct.
   */
  private handleEvent(frame: Record<string, unknown>): void {
    const subject = frame['subject'];
    const eventId = frame['eventId'];
    const version = frame['version'];
    const topics = frame['topics'];

    if (typeof subject !== 'string' || typeof eventId !== 'string') return;
    if (!Array.isArray(topics)) return;

    // Only topics this client actually asked for. A server that named one it
    // did not — or a frame injected by anything else — refreshes nothing.
    const matched = (topics as unknown[]).filter(
      (topic): topic is string => typeof topic === 'string' && this.subscriptions.has(topic),
    );
    if (matched.length === 0) return;

    if (!this.seen.admit(eventId)) return;

    const incoming = typeof version === 'number' && Number.isFinite(version) ? version : undefined;
    if (!shouldRefresh(this.versions.get(subject), incoming)) return;
    if (incoming !== undefined) this.versions.set(subject, incoming);

    this.notify(matched, 'event', [subject]);
  }

  private notify(topics: readonly string[], reason: RefreshReason, subjects: string[]): void {
    // One call per listener, even when several of its topics matched.
    const listeners = new Set<RefreshListener>();
    for (const topic of topics) {
      const entry = this.subscriptions.get(topic);
      if (entry) for (const listener of entry.listeners) listeners.add(listener);
    }

    const hint: RefreshHint = { reason, subjects };
    for (const listener of listeners) listener(hint);
  }

  /**
   * Renew the token before the server closes the socket for holding a stale one.
   *
   * The server closes a socket whose access token has expired, so a client that
   * waits to be disconnected takes a reconnect it did not need. Renewing a
   * minute early turns that into a single frame.
   */
  private scheduleReauthentication(expiresAt: unknown): void {
    if (this.reauthTimer) clearTimeout(this.reauthTimer);
    if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return;

    const delay = Math.max(1_000, expiresAt - this.now() - 60_000);
    this.reauthTimer = setTimeout(() => {
      void (async () => {
        const token = await this.getToken();
        if (token && this.authenticated) this.send({ type: 'authenticate', token });
      })();
    }, delay);
    this.reauthTimer.unref?.();
  }

  private sendSubscribe(topics: readonly string[]): void {
    if (topics.length === 0) return;
    this.send({ type: 'subscribe', topics: [...topics] });
  }

  private send(frame: unknown): void {
    try {
      this.socket?.send(JSON.stringify(frame));
    } catch {
      // A send on a closing socket. `onclose` handles the recovery.
    }
  }

  private handleClose(code: number): void {
    this.socket = null;
    this.authenticated = false;
    this.confirmed.clear();
    if (this.reauthTimer) {
      clearTimeout(this.reauthTimer);
      this.reauthTimer = null;
    }

    if (this.stopped) return;

    this.connection = onDisconnected(this.connection, code);

    if (this.connection.fellBack) {
      // The deployment has realtime off, or the attempts are spent. Polling is
      // already running and is now the only thing this screen relies on.
      this.setStatus('polling');
      return;
    }

    this.setStatus('connecting');

    if (this.subscriptions.size === 0) return;

    const delay = reconnectDelayMs(Math.max(1, this.connection.failures), this.random);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped && this.subscriptions.size > 0) this.open();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  /** Close the socket and stop reconnecting. */
  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.reauthTimer) {
      clearTimeout(this.reauthTimer);
      this.reauthTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    this.authenticated = false;
    this.confirmed.clear();
    socket?.close(1000, 'done');
  }

  /** Test and diagnostic use only. */
  isLive(): boolean {
    return this.authenticated;
  }

  confirmedTopics(): readonly string[] {
    return [...this.confirmed];
  }
}

// ---------------------------------------------------------------------------
// The shared client
// ---------------------------------------------------------------------------

let shared: RealtimeClient | null = null;

/**
 * One socket for the whole tab.
 *
 * Four screens each opening their own would be four upgrades, four
 * authentications, and four counts against the server's per-identity connection
 * cap — for a page that shows at most one of them at a time.
 */
export function sharedRealtimeClient(): RealtimeClient {
  shared ??= new RealtimeClient();
  return shared;
}

/** Tests replace the shared client; nothing else should. */
export function setSharedRealtimeClient(client: RealtimeClient | null): void {
  shared = client;
}

/** The close code a deployment with realtime switched off sends. */
export const REALTIME_DISABLED_CODE = CLOSE.disabled;
