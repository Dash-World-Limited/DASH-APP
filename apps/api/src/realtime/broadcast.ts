/**
 * `RealtimeBroadcastPort` implementations.
 *
 * Two adapters behind one interface, exactly as the queue and storage ports
 * work. The in-process one is correct on a single instance and silently wrong
 * on more than one, which is why `config.ts` refuses it in production the same
 * way it refuses the in-memory queue.
 */

import type { Redis } from 'ioredis';
import type { RealtimeBroadcastPort } from '@dash/domain/ports';

/**
 * The channel every instance publishes to and listens on.
 *
 * Prefixed, because two deployments sharing one managed Redis — staging and
 * production, the usual arrangement — must not deliver each other's
 * notifications. The queue adapter namespaces its keys for the same reason.
 */
export function channelFor(prefix: string): string {
  return `${prefix}:realtime`;
}

/**
 * Development and test fan-out: hand the notification straight back.
 *
 * Correct whenever there is exactly one process, which is every local run and
 * every test. It is not a stub — a single-instance deployment served by this
 * adapter behaves identically to a clustered one — but it has no way to reach
 * another process, and a second instance would serve half the sockets a stream
 * that never mentions the other half's orders.
 */
export class InProcessBroadcastAdapter implements RealtimeBroadcastPort {
  readonly providerName = 'memory';

  private readonly handlers: ((notification: unknown) => void)[] = [];

  async publish(notification: unknown): Promise<void> {
    for (const handler of this.handlers) handler(notification);
  }

  subscribe(handler: (notification: unknown) => void): void {
    this.handlers.push(handler);
  }

  async close(): Promise<void> {
    this.handlers.length = 0;
  }
}

export interface BroadcastLogger {
  warn(payload: unknown, message: string): void;
}

/**
 * Redis pub/sub fan-out.
 *
 * ## Two connections, not one
 *
 * A Redis client that has issued `SUBSCRIBE` is in subscriber mode and will
 * refuse almost every other command, `PUBLISH` included. Sharing one client
 * between the two halves of this adapter would work in a unit test that only
 * ever subscribes, then fail at the first publish in production. So the
 * subscriber is its own connection and publishing uses another.
 *
 * ## Local delivery does not wait for the round trip
 *
 * `publish` delivers to this instance's own handler *before* it touches Redis.
 * An instance that cannot reach Redis therefore still serves its own sockets
 * correctly, which turns a total realtime outage into a partial one: every
 * client stays live with respect to the instance it is connected to.
 *
 * That means this instance sees each notification twice when Redis is healthy —
 * once locally, once echoed back from its own `PUBLISH`. The duplicate is not a
 * bug to be avoided but the ordinary case the whole pipeline is already built
 * for: `RealtimeHub.publish` admits an event id once per connection and drops
 * the rest. Relying on that here is deliberate, and it is the same at-least-once
 * reasoning the outbox relay uses one layer up.
 *
 * A failed `PUBLISH` is rethrown rather than swallowed. The caller is a queue
 * worker, so throwing means the job is retried and the *other* instances get
 * their copy; swallowing would leave every client on every other instance
 * silently stale.
 */
export class RedisBroadcastAdapter implements RealtimeBroadcastPort {
  readonly providerName = 'redis';

  private readonly channel: string;
  private readonly handlers: ((notification: unknown) => void)[] = [];
  private listening = false;
  private closed = false;

  constructor(
    private readonly publisher: Redis,
    private readonly subscriber: Redis,
    private readonly log?: BroadcastLogger,
    prefix = 'dash',
  ) {
    this.channel = channelFor(prefix);
  }

  async publish(notification: unknown): Promise<void> {
    if (this.closed) return;

    // Local first, and outside the try: a handler that throws is this
    // instance's bug and must not be reported as a broadcast failure that
    // retries the job for everyone.
    for (const handler of this.handlers) handler(notification);

    await this.publisher.publish(this.channel, JSON.stringify(notification));
  }

  subscribe(handler: (notification: unknown) => void): void {
    this.handlers.push(handler);
    if (this.listening) return;
    this.listening = true;

    this.subscriber.on('message', (channel: string, message: string) => {
      if (channel !== this.channel) return;

      let parsed: unknown;
      try {
        parsed = JSON.parse(message);
      } catch {
        // Anything at all can be published to a Redis channel by anything that
        // holds the credentials. Unparseable input is dropped and counted, not
        // trusted — and never logged verbatim, since it is unvalidated bytes
        // from a shared channel.
        this.log?.warn({ channel: this.channel }, 'realtime: unparseable broadcast dropped');
        return;
      }

      for (const registered of this.handlers) registered(parsed);
    });

    void this.subscriber.subscribe(this.channel).catch((error: unknown) => {
      // Realtime is classified degradable: clients fall back to polling and
      // nothing is lost, so this is a warning rather than a boot failure.
      this.log?.warn(
        { error: error instanceof Error ? error.message : 'unknown' },
        'realtime: could not subscribe to the broadcast channel; clients will poll',
      );
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.handlers.length = 0;
    if (this.listening) {
      await this.subscriber.unsubscribe(this.channel).catch(() => undefined);
    }
  }
}
