/**
 * The hub, without sockets.
 *
 * Fan-out, deduplication, backpressure, eviction, and the revalidation sweep
 * are all decisions the hub makes about a `SocketLike`, so they can be driven
 * exactly rather than provoked. The cases that matter most here — a client that
 * has stopped reading, an actor who lost a role while connected — are the ones
 * a real socket cannot be made to reproduce reliably.
 */

import { describe, expect, it, vi } from 'vitest';
import { CLOSE, type RealtimeNotification } from '@dash/domain/realtime';
import { buildActor, type Actor, type Role } from '@dash/domain/permissions';
import { Connection, MAX_BUFFERED_BYTES, RealtimeHub } from '../realtime/hub.js';
import type { SocketLike } from '../realtime/hub.js';

class FakeSocket implements SocketLike {
  readonly sent: string[] = [];
  closedWith: { code: number; reason?: string } | null = null;
  bufferedAmount = 0;

  send(data: string): void {
    if (this.closedWith) throw new Error('wrote to a closed socket');
    this.sent.push(data);
  }

  close(code: number, reason?: string): void {
    this.closedWith = { code, ...(reason === undefined ? {} : { reason }) };
  }

  frames(): { type: string; [key: string]: unknown }[] {
    return this.sent.map((raw) => JSON.parse(raw) as { type: string });
  }
}

const actor = (input: {
  identityId?: string;
  sessionId?: string;
  roles: Role[];
  cityIds?: string[];
  riderId?: string;
  customerId?: string;
  vendorId?: string;
}): Actor =>
  buildActor({
    identityId: input.identityId ?? 'identity-1',
    sessionId: input.sessionId ?? 'session-1',
    roles: input.roles,
    ...(input.cityIds ? { cityIds: input.cityIds } : {}),
    ...(input.riderId ? { riderId: input.riderId } : {}),
    ...(input.customerId ? { customerId: input.customerId } : {}),
    ...(input.vendorId ? { vendorId: input.vendorId } : {}),
  });

let counter = 0;
function connect(
  hub: RealtimeHub,
  as: Actor | null = actor({ roles: ['customer'], customerId: 'cust-a' }),
): { connection: Connection; socket: FakeSocket } {
  counter += 1;
  const socket = new FakeSocket();
  const connection = new Connection(`c${counter}`, socket, Date.now());
  if (as) {
    connection.actor = as;
    // An hour out, so nothing here trips the expiry path by accident.
    connection.authorityExpiresAt = Date.now() + 3_600_000;
  }
  hub.add(connection);
  return { connection, socket };
}

const notification = (overrides: Partial<RealtimeNotification> = {}): RealtimeNotification => ({
  eventId: 'order:o1@1',
  subject: 'order:o1',
  topics: ['order:o1'],
  version: 1,
  occurredAt: 1_700_000_000_000,
  ...overrides,
});

describe('fan-out', () => {
  it('delivers only to sockets holding the topic', () => {
    const hub = new RealtimeHub();
    const watching = connect(hub);
    const notWatching = connect(hub);

    hub.subscribe(watching.connection, 'order:o1');
    hub.subscribe(notWatching.connection, 'order:o2');

    expect(hub.publish(notification())).toBe(1);
    expect(watching.socket.frames()).toHaveLength(1);
    expect(notWatching.socket.frames()).toHaveLength(0);
  });

  it('matches by exact equality, never by pattern', () => {
    const hub = new RealtimeHub();
    const { connection, socket } = connect(hub);
    hub.subscribe(connection, 'order:o1');

    // Neither a prefix nor a wildcard reaches a subscription.
    expect(hub.publish(notification({ topics: ['order:o'] }))).toBe(0);
    expect(hub.publish(notification({ eventId: 'e2', topics: ['order:o1x'] }))).toBe(0);
    expect(hub.publish(notification({ eventId: 'e3', topics: ['order:*'] }))).toBe(0);
    expect(socket.sent).toHaveLength(0);
  });

  it('sends one frame naming every topic a connection matched', () => {
    const hub = new RealtimeHub();
    const { connection, socket } = connect(hub);
    hub.subscribe(connection, 'order:o1');
    hub.subscribe(connection, 'vendor:v1');

    hub.publish(notification({ topics: ['order:o1', 'vendor:v1', 'city:c1'] }));

    const frames = socket.frames();
    expect(frames).toHaveLength(1);
    // The city topic is absent because this connection does not hold it.
    expect(frames[0]!['topics']).toEqual(['order:o1', 'vendor:v1']);
  });

  it('suppresses a redelivery of the same event per connection', () => {
    const hub = new RealtimeHub();
    const { connection, socket } = connect(hub);
    hub.subscribe(connection, 'order:o1');

    expect(hub.publish(notification())).toBe(1);
    expect(hub.publish(notification())).toBe(0);
    expect(hub.publish(notification())).toBe(0);
    expect(socket.sent).toHaveLength(1);

    // A genuinely different change still gets through.
    expect(hub.publish(notification({ eventId: 'order:o1@2', version: 2 }))).toBe(1);
  });

  it('carries only identifiers and a version', () => {
    const hub = new RealtimeHub();
    const { connection, socket } = connect(hub);
    hub.subscribe(connection, 'order:o1');
    hub.publish(notification());

    expect(Object.keys(socket.frames()[0]!).sort()).toEqual([
      'eventId',
      'occurredAt',
      'subject',
      'topics',
      'type',
      'version',
    ]);
  });

  it('refuses to subscribe an unauthenticated connection', () => {
    const hub = new RealtimeHub();
    const { connection, socket } = connect(hub, null);

    expect(hub.subscribe(connection, 'order:o1')).toBe(false);
    expect(hub.publish(notification())).toBe(0);
    expect(socket.sent).toHaveLength(0);
  });

  it('stops delivering after an unsubscribe and forgets the topic', () => {
    const hub = new RealtimeHub();
    const { connection } = connect(hub);
    hub.subscribe(connection, 'order:o1');
    hub.unsubscribe(connection, 'order:o1');

    expect(hub.publish(notification())).toBe(0);
    // The index entry is removed rather than left as an empty set, or a
    // long-running instance accumulates one per order it has ever seen.
    expect(hub.subscriberCount('order:o1')).toBe(0);
  });

  it('cleans up the topic index when a connection is removed', () => {
    const hub = new RealtimeHub();
    const { connection } = connect(hub);
    hub.subscribe(connection, 'order:o1');
    expect(hub.subscriberCount('order:o1')).toBe(1);

    hub.remove(connection);
    expect(hub.subscriberCount('order:o1')).toBe(0);
    expect(hub.size).toBe(0);
  });
});

describe('backpressure', () => {
  it('closes a client that has stopped reading', () => {
    const hub = new RealtimeHub();
    const { connection, socket } = connect(hub);
    hub.subscribe(connection, 'order:o1');

    socket.bufferedAmount = MAX_BUFFERED_BYTES + 1;
    expect(hub.publish(notification())).toBe(0);

    // Closed rather than skipped: dropping frames would leave the client
    // silently behind with no way to notice, while closing makes it reconnect —
    // and reconnecting resubscribes, which resyncs.
    expect(socket.closedWith?.code).toBe(CLOSE.slow_consumer);
    expect(hub.size).toBe(0);
  });

  it('keeps serving a client that is merely a little behind', () => {
    const hub = new RealtimeHub();
    const { connection, socket } = connect(hub);
    hub.subscribe(connection, 'order:o1');

    socket.bufferedAmount = MAX_BUFFERED_BYTES - 1;
    expect(hub.publish(notification())).toBe(1);
    expect(socket.closedWith).toBeNull();
  });

  it('does not let one dead socket stop delivery to the others', () => {
    const hub = new RealtimeHub();
    const healthy = connect(hub);
    const stalled = connect(hub);
    hub.subscribe(healthy.connection, 'order:o1');
    hub.subscribe(stalled.connection, 'order:o1');
    stalled.socket.bufferedAmount = MAX_BUFFERED_BYTES * 2;

    expect(hub.publish(notification())).toBe(1);
    expect(healthy.socket.sent).toHaveLength(1);
    expect(stalled.socket.closedWith?.code).toBe(CLOSE.slow_consumer);
  });
});

describe('connection limits', () => {
  it('counts sockets per identity', () => {
    const hub = new RealtimeHub({ maxConnectionsPerIdentity: 2 });
    const one = actor({ identityId: 'a', roles: ['customer'], customerId: 'c' });
    const two = actor({ identityId: 'b', roles: ['customer'], customerId: 'd' });

    connect(hub, one);
    expect(hub.isAtConnectionLimit('a')).toBe(false);
    connect(hub, one);
    expect(hub.isAtConnectionLimit('a')).toBe(true);
    // One identity filling its own budget must not affect anybody else's.
    connect(hub, two);
    expect(hub.isAtConnectionLimit('b')).toBe(false);
  });
});

describe('revalidation', () => {
  const dispatcher = actor({
    identityId: 'ops-1',
    sessionId: 'session-ops',
    roles: ['dispatcher'],
    cityIds: ['lagos'],
  });

  it('closes sockets whose session has gone', async () => {
    const hub = new RealtimeHub();
    const { connection, socket } = connect(hub, dispatcher);
    hub.subscribe(connection, 'city:lagos');

    const closed = await hub.revalidate(async () => null, Date.now());

    expect(closed).toBe(1);
    expect(socket.closedWith?.code).toBe(CLOSE.session_invalid);
    expect(hub.size).toBe(0);
  });

  it('closes a socket whose token has expired, without a query', async () => {
    const hub = new RealtimeHub();
    const { connection, socket } = connect(hub, dispatcher);
    connection.authorityExpiresAt = Date.now() - 1;

    const load = vi.fn(async () => dispatcher);
    const closed = await hub.revalidate(load, Date.now());

    expect(closed).toBe(1);
    expect(socket.closedWith?.code).toBe(CLOSE.session_invalid);
    // The token said when it lapsed; no query can make that more true.
    expect(load).not.toHaveBeenCalled();
  });

  it('asks once per session, not once per socket', async () => {
    const hub = new RealtimeHub();
    for (let i = 0; i < 5; i += 1) connect(hub, dispatcher);

    const load = vi.fn(async () => dispatcher);
    await hub.revalidate(load, Date.now());

    // Five sockets on one session cost one lookup, which is what makes it
    // affordable to run this on a timer at all.
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('keeps a healthy socket and its subscriptions', async () => {
    const hub = new RealtimeHub();
    const { connection, socket } = connect(hub, dispatcher);
    hub.subscribe(connection, 'city:lagos');

    await hub.revalidate(async () => dispatcher, Date.now());

    expect(socket.closedWith).toBeNull();
    expect(connection.subscriptions.has('city:lagos')).toBe(true);
  });

  it('drops a subscription the actor may no longer hold', async () => {
    const hub = new RealtimeHub();
    const { connection, socket } = connect(hub, dispatcher);
    hub.subscribe(connection, 'city:lagos');

    // The dispatcher is moved to another city while connected. The socket
    // stays — the session is fine — but the subscription must not.
    const moved = actor({
      identityId: 'ops-1',
      sessionId: 'session-ops',
      roles: ['dispatcher'],
      cityIds: ['abuja'],
    });
    await hub.revalidate(async () => moved, Date.now());

    expect(socket.closedWith).toBeNull();
    expect(connection.subscriptions.has('city:lagos')).toBe(false);
    expect(hub.publish(notification({ topics: ['city:lagos'] }))).toBe(0);
  });

  it('drops every subscription when the role itself is gone', async () => {
    const hub = new RealtimeHub();
    const { connection } = connect(hub, dispatcher);
    hub.subscribe(connection, 'city:lagos');

    const demoted = actor({
      identityId: 'ops-1',
      sessionId: 'session-ops',
      roles: ['customer'],
      customerId: 'cust-x',
    });
    await hub.revalidate(async () => demoted, Date.now());

    expect(connection.subscriptions.size).toBe(0);
  });

  it('keeps sockets when the lookup itself fails', async () => {
    // A database blip must not disconnect everyone. Expiry still bounds them,
    // and that bound needs no database.
    const hub = new RealtimeHub();
    const { socket } = connect(hub, dispatcher);

    const closed = await hub.revalidate(async () => {
      throw new Error('database unreachable');
    }, Date.now());

    expect(closed).toBe(0);
    expect(socket.closedWith).toBeNull();
    expect(hub.size).toBe(1);
  });

  it('ignores connections that never authenticated', async () => {
    const hub = new RealtimeHub();
    connect(hub, null);
    const load = vi.fn(async () => dispatcher);

    await hub.revalidate(load, Date.now());
    expect(load).not.toHaveBeenCalled();
  });
});

describe('re-authentication', () => {
  it('clears subscriptions and asks the client to resync', () => {
    const hub = new RealtimeHub();
    const { connection, socket } = connect(hub);
    hub.subscribe(connection, 'order:o1');

    hub.resetSubscriptions(connection, 'reauthenticated');

    expect(connection.subscriptions.size).toBe(0);
    expect(hub.publish(notification())).toBe(0);
    const frames = socket.frames();
    expect(frames.at(-1)).toEqual({ type: 'resync', topics: [], reason: 'reauthenticated' });
  });

  it('says nothing when there was nothing to clear', () => {
    const hub = new RealtimeHub();
    const { connection, socket } = connect(hub);
    hub.resetSubscriptions(connection, 'reauthenticated');
    expect(socket.sent).toHaveLength(0);
  });
});

describe('shutdown', () => {
  it('closes every socket with a code that means "reconnect"', () => {
    const hub = new RealtimeHub();
    const first = connect(hub);
    const second = connect(hub);
    hub.subscribe(first.connection, 'order:o1');

    hub.closeAll();

    expect(first.socket.closedWith?.code).toBe(CLOSE.going_away);
    expect(second.socket.closedWith?.code).toBe(CLOSE.going_away);
    expect(hub.size).toBe(0);
    expect(hub.subscriberCount('order:o1')).toBe(0);
  });

  it('never writes to a socket after closing it', () => {
    // FakeSocket throws on a write after close, so this would fail loudly.
    const hub = new RealtimeHub();
    const { connection, socket } = connect(hub);
    hub.subscribe(connection, 'order:o1');

    hub.closeAll();
    expect(() => hub.publish(notification())).not.toThrow();
    expect(socket.frames().some((frame) => frame.type === 'event')).toBe(false);
  });
});
