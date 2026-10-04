/**
 * What a client does when the socket is not available.
 *
 * ## Why the fallback is polling, and why that is not a compromise
 *
 * Every screen this milestone touches already worked by polling, and still
 * does. The socket does not deliver state — it delivers the *sentence* "order
 * abc is now at version 12", and the client answers it by calling the same
 * authorized HTTP route it would have called on a timer anyway.
 *
 * So there is no second code path to keep correct. Degrading from realtime to
 * polling changes one number: how often the existing fetch runs. A client with
 * no socket is a client with a slower refresh, not a client missing a feature,
 * and nothing can be permanently lost by the socket being down because the
 * socket was never the source of anything.
 *
 * That is the entire reason the notification-only design was chosen. This
 * module is where the benefit is collected.
 *
 * Pure, and randomness is injected rather than read from `Math.random`, so a
 * test can assert the exact backoff curve instead of a range.
 */

import { CLOSE, type CloseCode } from './protocol.js';

export type Transport = 'websocket' | 'polling';

/**
 * How a socket ended, reduced to the only three things a client does about it.
 */
export type CloseDisposition =
  /** Try again after a backoff. A network blip, a deploy, a slow consumer. */
  | 'retry'
  /** Get a fresh access token first, then reconnect. Not a transport failure. */
  | 'reauthenticate'
  /** Stop trying. This deployment will not serve a socket. */
  | 'fall_back';

/**
 * What a close code means for the client.
 *
 * `session_invalid` is deliberately not a transport failure: the socket worked
 * perfectly and said so. Counting it as one would make an expired access token
 * — a thing that happens to every client every fifteen minutes — look like a
 * broken server and eventually push a healthy client onto polling for ever.
 */
export function dispositionFor(code: number): CloseDisposition {
  switch (code) {
    case CLOSE.session_invalid:
      return 'reauthenticate';

    // The deployment has realtime switched off. No amount of retrying changes
    // that, and hammering an endpoint that is answering honestly is rude.
    case CLOSE.disabled:
      return 'fall_back';

    // The client sent something this server will not accept. Retrying sends it
    // again. Polling keeps the product working while the bug is fixed, which is
    // better than a reconnect loop nobody notices.
    case CLOSE.protocol_violation:
      return 'fall_back';

    default:
      return 'retry';
  }
}

/**
 * Consecutive failed connection attempts before a client stops trying.
 *
 * Five, with the backoff below, is roughly half a minute of trying — long
 * enough to ride out a deploy, short enough that a user behind a proxy that
 * strips upgrades is not staring at a stale screen while the client keeps
 * hoping.
 */
export const MAX_CONNECT_ATTEMPTS = 5;

/** Backoff bounds. Capped so a long outage does not push the retry into next week. */
export const RECONNECT_BASE_MS = 500;
export const RECONNECT_CEILING_MS = 30_000;

/**
 * Backoff before connection attempt `attempt` (1-based), with full jitter.
 *
 * Full jitter rather than a fixed curve because every client of a deployment
 * that just restarted is reconnecting at once, and a deterministic backoff
 * synchronises them into a thundering herd that knocks the server over again
 * on each retry. Spreading each client uniformly across its own window is the
 * cheapest fix and the standard one.
 */
export function reconnectDelayMs(attempt: number, random: () => number = Math.random): number {
  const bounded = Math.max(1, Math.floor(attempt));
  const ceiling = Math.min(RECONNECT_BASE_MS * 2 ** (bounded - 1), RECONNECT_CEILING_MS);
  // `random()` is in [0, 1); the floor keeps a delay of zero off the table so a
  // failing client cannot spin.
  return Math.max(RECONNECT_BASE_MS, Math.floor(ceiling * random()));
}

/**
 * How often to re-read when there is no socket.
 *
 * Two intervals, not one. A customer watching a rider approach needs a fresh
 * answer every few seconds; the same client with the tab in the background
 * needs one occasionally and should not be spending the user's battery or the
 * server's capacity in the meantime. `visible` is the caller's own judgement —
 * page visibility, app foreground state — passed in rather than detected here,
 * because this module has no window to ask.
 */
export const POLL_INTERVAL_ACTIVE_MS = 5_000;
export const POLL_INTERVAL_BACKGROUND_MS = 60_000;

export function pollIntervalMs(visible: boolean): number {
  return visible ? POLL_INTERVAL_ACTIVE_MS : POLL_INTERVAL_BACKGROUND_MS;
}

/**
 * The client's connection state, as a value.
 *
 * Held as a plain object and advanced by the pure function below so the
 * decision "should I still be trying a socket?" is testable without a socket, a
 * timer, or a browser.
 */
export interface ConnectionState {
  readonly transport: Transport;
  /** Failed attempts since the last success. Reset by `onConnected`. */
  readonly failures: number;
  /**
   * True once the client has given up on sockets for this session.
   *
   * Sticky on purpose. A client that fell back because the deployment has
   * realtime disabled must not rediscover that every thirty seconds.
   */
  readonly fellBack: boolean;
}

export const INITIAL_CONNECTION_STATE: ConnectionState = {
  transport: 'websocket',
  failures: 0,
  fellBack: false,
};

/** A socket opened and authenticated. Clears the failure history. */
export function onConnected(state: ConnectionState): ConnectionState {
  return state.fellBack ? state : { transport: 'websocket', failures: 0, fellBack: false };
}

/**
 * A socket closed or failed to open.
 *
 * Returns the state the client should now be in — including, once the attempts
 * are spent or the server has said "not here", the decision to stop trying and
 * poll instead.
 */
export function onDisconnected(state: ConnectionState, code: number): ConnectionState {
  if (state.fellBack) return state;

  const disposition = dispositionFor(code);

  if (disposition === 'fall_back') {
    return { transport: 'polling', failures: state.failures, fellBack: true };
  }

  // Re-authentication is not a failure of the transport, so it does not consume
  // an attempt. Treating it as one is how a working client talks itself into
  // polling over the course of an afternoon.
  if (disposition === 'reauthenticate') return state;

  const failures = state.failures + 1;
  if (failures >= MAX_CONNECT_ATTEMPTS) {
    return { transport: 'polling', failures, fellBack: true };
  }

  return { transport: 'websocket', failures, fellBack: false };
}

/**
 * Every close code the server can send, so a test can assert that each one has
 * a deliberate disposition rather than falling through to the default.
 */
export const KNOWN_CLOSE_CODES: readonly CloseCode[] = Object.values(CLOSE);
