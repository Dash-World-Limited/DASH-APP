'use client';

/**
 * The one primitive every live screen uses.
 *
 * Before this, each screen had the same three lines: load on mount, poll on a
 * timer, and hope. This keeps all of that and adds one thing — a notification
 * can bring the next load forward. Nothing is taken away, which is why a screen
 * behaves correctly when the socket never connects at all.
 *
 * ## Why the poll stays on while the socket is live
 *
 * It is tempting to stop polling once a socket is connected, and it is the
 * wrong instinct. Delivery is at-least-once, which promises a notification may
 * arrive twice — it does not promise one always arrives. A dropped frame with
 * nothing behind it leaves a screen silently wrong until someone reloads the
 * page, which is a worse failure than the polling it replaced, and an invisible
 * one. So the interval stretches to a safety net rather than stopping.
 *
 * ## The refresh is always a fetch
 *
 * A notification never carries state, so the only thing this can do with one is
 * call `load()` — the screen's own authorized read. That is the property that
 * makes the socket incapable of showing a user something the API would not have
 * given them.
 */

import { useEffect, useRef, useState } from 'react';
import {
  sharedRealtimeClient,
  type RealtimeClient,
  type RealtimeStatus,
  type RefreshHint,
} from './realtime';

/** How often a live screen re-reads anyway, as a safety net behind the socket. */
export const LIVE_SAFETY_POLL_MS = 30_000;

export interface UseLiveOptions {
  /**
   * Topics to watch. An empty list means "poll only" — used by a screen that is
   * signed out, or has not yet learned which ids it should follow.
   */
  topics: readonly string[];
  /** The screen's own authorized read. Called on mount, on notify, and on poll. */
  load: () => Promise<void> | void;
  /** Poll interval when the socket is not carrying the screen. */
  pollMs: number;
  /** Poll interval when it is. Defaults to `LIVE_SAFETY_POLL_MS`. */
  livePollMs?: number;
  /** False turns everything off — signed out, or the screen is complete. */
  enabled?: boolean;
  /** Tests inject a client; screens use the shared one. */
  client?: RealtimeClient;
}

export interface UseLiveResult {
  status: RealtimeStatus;
  /** True while a notification-driven or polled refresh is in flight. */
  refreshing: boolean;
}

export function useLive(options: UseLiveOptions): UseLiveResult {
  const { pollMs, enabled = true, client: injected } = options;
  const livePollMs = options.livePollMs ?? LIVE_SAFETY_POLL_MS;

  // The screens rebuild `load` on every render via `useCallback`, so holding it
  // in a ref is what stops the subscription being torn down and re-established
  // on each one — which would resubscribe, resync, and refetch in a loop.
  const loadRef = useRef(options.load);
  loadRef.current = options.load;

  const [status, setStatus] = useState<RealtimeStatus>('connecting');
  const [refreshing, setRefreshing] = useState(false);

  // Sorted and joined so a screen passing a fresh array literal each render
  // does not re-subscribe every time.
  const topicKey = [...options.topics].sort().join('|');

  const inFlight = useRef<Promise<void> | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!enabled) return;

    const client = injected ?? sharedRealtimeClient();

    /**
     * Run the screen's read, coalescing concurrent callers.
     *
     * A notification and a poll can land together, and a burst of transitions
     * on a busy order can arrive within one round trip. Without this they would
     * each start a fetch, and the last to resolve would win — which is not
     * necessarily the newest.
     */
    const refresh = (): Promise<void> => {
      if (inFlight.current) return inFlight.current;

      if (mounted.current) setRefreshing(true);
      const run = (async () => {
        try {
          await loadRef.current();
        } finally {
          inFlight.current = null;
          if (mounted.current) setRefreshing(false);
        }
      })();

      inFlight.current = run;
      return run;
    };

    void refresh();

    const unsubscribeStatus = client.onStatusChange((next) => {
      if (mounted.current) setStatus(next);
    });
    if (mounted.current) setStatus(client.getStatus());

    let unsubscribeTopics: (() => void) | null = null;
    const topics = topicKey === '' ? [] : topicKey.split('|');

    if (topics.length > 0) {
      unsubscribeTopics = client.subscribe(topics, (_hint: RefreshHint) => {
        // The hint is deliberately unused. Both reasons — a change was
        // announced, or the subscription was (re-)established and this stream
        // has no history — mean exactly the same thing to a screen: read the
        // current state. Branching on it would only create a path where one of
        // them does not refresh.
        void refresh();
      });
    }

    return () => {
      unsubscribeStatus();
      unsubscribeTopics?.();
    };
  }, [topicKey, enabled, injected]);

  // The poll. Separate from the subscription so a status change re-times it
  // without tearing down the socket.
  useEffect(() => {
    if (!enabled) return;

    const interval = status === 'live' ? livePollMs : pollMs;
    const timer = setInterval(() => {
      if (inFlight.current) return;
      void loadRef.current();
    }, interval);

    return () => clearInterval(timer);
  }, [enabled, status, pollMs, livePollMs]);

  return { status, refreshing };
}

/** A short, honest label for the connection state. */
export function liveLabel(status: RealtimeStatus, pollMs: number): string {
  const seconds = Math.round(pollMs / 1000);
  if (status === 'live') return 'Live';
  if (status === 'connecting') return `Connecting — refreshing every ${seconds}s`;
  return `Refreshing every ${seconds}s`;
}
