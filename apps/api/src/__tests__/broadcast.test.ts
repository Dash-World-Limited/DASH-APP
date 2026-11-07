/**
 * Broadcast isolation: a notification published by one deployment must not
 * reach another deployment sharing the same Redis.
 *
 * No real Redis is needed to run this file, and that is deliberate: the
 * adapters are driven against a fake in-memory pub/sub bus that behaves the
 * way Redis does for the calls the adapter makes — `publish` delivers to
 * every subscriber of the exact channel, and to no other channel. The
 * healthy path against a real server is `scripts/redis-check.mjs`, which
 * already constructs adapters on different prefixes and asserts the other
 * deployment receives nothing; it is **not** part of this suite and is
 * reported as PENDING until it has been run (see N-2).
 *
 * What is asserted here, with mocks only:
 *   1. The channel is the prefix plus `:realtime`, per profile.
 *   2. An event published on the `full` channel is not received by an
 *      adapter on the `declutters` channel, and vice versa.
 *   3. The same event *does* reach a second adapter on the same channel
 *      (the positive control — isolation must not mean silence).
 *   4. An explicit prefix override wins over the profile default, at both
 *      the config layer and the server wiring.
 */

import { describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import { channelFor, RedisBroadcastAdapter } from '../realtime/broadcast.js';
import { loadConfig, resetConfigCache } from '../config.js';
import { buildServices } from '../server.js';

/** A port in the ephemeral range with nothing bound to it. */
const DEAD_REDIS = 'redis://127.0.0.1:6390';

/**
 * Minimal in-memory pub/sub bus, standing in for one shared Redis.
 * Delivery is by exact channel string, which is the property under test:
 * a subscriber registered under `dash-full:realtime` never sees a message
 * published to `dash-declutters:realtime`.
 */
class FakeBus {
  private readonly channels = new Map<string, Set<FakeRedis>>();

  subscribe(channel: string, client: FakeRedis): void {
    const set = this.channels.get(channel) ?? new Set<FakeRedis>();
    set.add(client);
    this.channels.set(channel, set);
  }

  unsubscribe(channel: string, client: FakeRedis): void {
    this.channels.get(channel)?.delete(client);
  }

  publish(channel: string, message: string): number {
    const subscribers = this.channels.get(channel);
    if (!subscribers) return 0;
    for (const subscriber of [...subscribers]) subscriber.deliver(channel, message);
    return subscribers.size;
  }
}

/** Fake ioredis client, implementing only the surface the adapter uses. */
class FakeRedis {
  private readonly messageHandlers: ((channel: string, message: string) => void)[] = [];

  constructor(private readonly bus: FakeBus) {}

  on(event: string, handler: (channel: string, message: string) => void): void {
    if (event === 'message') this.messageHandlers.push(handler);
  }

  async subscribe(channel: string): Promise<void> {
    this.bus.subscribe(channel, this);
  }

  async unsubscribe(channel: string): Promise<void> {
    this.bus.unsubscribe(channel, this);
  }

  async publish(channel: string, message: string): Promise<number> {
    return this.bus.publish(channel, message);
  }

  deliver(channel: string, message: string): void {
    for (const handler of this.messageHandlers) handler(channel, message);
  }
}

function buildAdapter(bus: FakeBus, prefix?: string): RedisBroadcastAdapter {
  return new RedisBroadcastAdapter(
    new FakeRedis(bus) as unknown as Redis,
    new FakeRedis(bus) as unknown as Redis,
    undefined,
    prefix,
  );
}

const NOTIFICATION = { eventId: 'order:check@1', subject: 'order:check' };

describe('broadcast channel names', () => {
  it('namespaces the channel by prefix', () => {
    expect(channelFor('dash-full')).toBe('dash-full:realtime');
    expect(channelFor('dash-declutters')).toBe('dash-declutters:realtime');
    expect(channelFor('dash-staging')).toBe('dash-staging:realtime');
  });

  it('exposes the prefix the adapter was built with', () => {
    expect(buildAdapter(new FakeBus(), 'dash-declutters').prefix).toBe('dash-declutters');
    // Direct construction with no prefix keeps the adapter's own default,
    // exactly as the queue adapter does; configuration derives it instead.
    expect(buildAdapter(new FakeBus()).prefix).toBe('dash');
  });
});

describe('broadcast isolation over a shared bus', () => {
  it('does not deliver a full-profile event to a declutters adapter', async () => {
    const bus = new FakeBus();
    const full = buildAdapter(bus, 'dash-full');
    const declutters = buildAdapter(bus, 'dash-declutters');
    const fullReceived: unknown[] = [];
    const decluttersReceived: unknown[] = [];
    full.subscribe((raw) => fullReceived.push(raw));
    declutters.subscribe((raw) => decluttersReceived.push(raw));

    await full.publish(NOTIFICATION);

    expect(fullReceived).toContain(NOTIFICATION);
    expect(decluttersReceived).toHaveLength(0);
    await full.close();
    await declutters.close();
  });

  it('does not deliver a declutters-profile event to a full adapter', async () => {
    const bus = new FakeBus();
    const full = buildAdapter(bus, 'dash-full');
    const declutters = buildAdapter(bus, 'dash-declutters');
    const fullReceived: unknown[] = [];
    const decluttersReceived: unknown[] = [];
    full.subscribe((raw) => fullReceived.push(raw));
    declutters.subscribe((raw) => decluttersReceived.push(raw));

    await declutters.publish(NOTIFICATION);

    expect(decluttersReceived).toContain(NOTIFICATION);
    expect(fullReceived).toHaveLength(0);
    await full.close();
    await declutters.close();
  });

  it('does deliver to a second adapter on the same channel', async () => {
    // The positive control: isolation must not mean silence. The second
    // adapter never publishes, so anything it receives arrived over the
    // bus, not through the publisher's local delivery.
    const bus = new FakeBus();
    const publisher = buildAdapter(bus, 'dash-full');
    const listener = buildAdapter(bus, 'dash-full');
    const listenerReceived: unknown[] = [];
    listener.subscribe((raw) => listenerReceived.push(raw));

    await publisher.publish(NOTIFICATION);

    expect(listenerReceived).toHaveLength(1);
    // Deep equality, not identity: the notification crossed the bus as
    // JSON, so the far side holds a parsed copy, not the same object.
    expect(listenerReceived[0]).toStrictEqual(NOTIFICATION);
    await publisher.close();
    await listener.close();
  });

  it('does not deliver an explicitly-prefixed event to the profile channel', async () => {
    const bus = new FakeBus();
    const staging = buildAdapter(bus, 'dash-staging');
    const production = buildAdapter(bus, 'dash-full');
    const productionReceived: unknown[] = [];
    production.subscribe((raw) => productionReceived.push(raw));

    await staging.publish(NOTIFICATION);

    expect(productionReceived).toHaveLength(0);
    await staging.close();
    await production.close();
  });
});

describe('server broadcast wiring', () => {
  function wiringConfig(overrides: Record<string, string>): ReturnType<typeof loadConfig> {
    resetConfigCache();
    return loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'file:./unused.db',
      JWT_ACCESS_SECRET: 'gJ7xQ2mV9wL4pR8sT1uY6zA3bC5dE0fH-access-KnMqPrSt',
      JWT_REFRESH_SECRET: 'Zx4Vn8Bq2Wr6Ty0Ui3Op5As7Df9Gh1Jk-refresh-LmNoPqRs',
      REALTIME_BROADCAST: 'redis',
      REDIS_URL: DEAD_REDIS,
      LOG_LEVEL: 'silent',
      // No encryption key in this minimal config, so MFA must be off with it.
      MFA_ENABLED: 'false',
      ...overrides,
    });
  }

  it('builds the server broadcast on the full prefix', () => {
    try {
      const config = wiringConfig({ DEPLOYMENT_PROFILE: 'full' });
      const services = buildServices(config);
      expect(services.broadcast).toBeInstanceOf(RedisBroadcastAdapter);
      expect((services.broadcast as RedisBroadcastAdapter).prefix).toBe('dash-full');
      expect(channelFor((services.broadcast as RedisBroadcastAdapter).prefix)).toBe(
        'dash-full:realtime',
      );
    } finally {
      resetConfigCache();
    }
  });

  it('builds the server broadcast on the declutters prefix', () => {
    try {
      const config = wiringConfig({ DEPLOYMENT_PROFILE: 'declutters' });
      const services = buildServices(config);
      expect(services.broadcast).toBeInstanceOf(RedisBroadcastAdapter);
      expect((services.broadcast as RedisBroadcastAdapter).prefix).toBe('dash-declutters');
      expect(channelFor((services.broadcast as RedisBroadcastAdapter).prefix)).toBe(
        'dash-declutters:realtime',
      );
    } finally {
      resetConfigCache();
    }
  });

  it('lets an explicit broadcast prefix win over the profile default', () => {
    try {
      const config = wiringConfig({
        DEPLOYMENT_PROFILE: 'full',
        BROADCAST_PREFIX: 'dash-staging',
      });
      const services = buildServices(config);
      expect(services.broadcast).toBeInstanceOf(RedisBroadcastAdapter);
      expect((services.broadcast as RedisBroadcastAdapter).prefix).toBe('dash-staging');
    } finally {
      resetConfigCache();
    }
  });
});
