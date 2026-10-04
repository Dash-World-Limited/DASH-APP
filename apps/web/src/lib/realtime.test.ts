/**
 * The browser realtime client.
 *
 * Driven through a fake socket rather than a real one, so redelivery, stale
 * arrival, and a server that goes away mid-session are exercised on purpose
 * instead of waited for. Every assertion here is about one property:
 *
 *   **a notification can only ever cause a re-read.**
 *
 * If that holds, nothing on the wire can put data on a screen, and the
 * authorization the HTTP routes perform is the authorization the user gets.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLOSE } from '@dash/domain/realtime';
import { RealtimeClient, realtimeUrlFor, type WebSocketLike } from './realtime';

/**
 * A socket under the test's control.
 *
 * Nothing here is asynchronous. A test decides exactly when the server speaks,
 * which is what makes "a duplicate arrived" and "an older event arrived after a
 * newer one" ordinary cases rather than races to reproduce.
 */
class FakeSocket implements WebSocketLike {
  static instances: FakeSocket[] = [];

  readyState = 1;
  readonly sent: Record<string, unknown>[] = [];
  closedWith: number | null = null;

  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(code = 1000): void {
    this.closedWith = code;
    this.readyState = 3;
  }

  /**
   * Deliver a frame from the server.
   *
   * Still delivers after `close()`, on purpose. A real socket can hand over a
   * frame that was already in the buffer when the close was requested, so a
   * client that relies on the transport to stop talking to it has a bug this
   * fake is able to find.
   */
  emit(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  /** Deliver a raw string, for the frames a well-behaved server would not send. */
  emitRaw(raw: unknown): void {
    this.onmessage?.({ data: raw });
  }

  /** The server or the network dropped the connection. */
  drop(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code, reason: '' });
  }

  framesOfType(type: string): Record<string, unknown>[] {
    return this.sent.filter((frame) => frame['type'] === type);
  }

  static latest(): FakeSocket {
    const socket = FakeSocket.instances.at(-1);
    if (!socket) throw new Error('no socket was opened');
    return socket;
  }

  static reset(): void {
    FakeSocket.instances = [];
  }
}

/** Let queued promise callbacks run. The client awaits its token source. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
};

function buildClient(
  overrides: Partial<ConstructorParameters<typeof RealtimeClient>[0]> = {},
): RealtimeClient {
  return new RealtimeClient({
    url: 'ws://test/v1/realtime',
    createSocket: (url) => new FakeSocket(url),
    getToken: async () => 'access-token',
    // Zero jitter, so backoff is a value rather than a range.
    random: () => 0,
    ...overrides,
  });
}

/** Connect, authenticate, and subscribe. Returns the socket in play. */
async function connected(
  client: RealtimeClient,
  topics: string[],
  listener: (hint: { reason: string; subjects: readonly string[] }) => void,
): Promise<FakeSocket> {
  client.subscribe(topics, listener);
  const socket = FakeSocket.latest();
  socket.onopen?.();
  socket.emit({ type: 'welcome', protocol: 1 });
  await settle();
  socket.emit({ type: 'authenticated', expiresAt: Date.now() + 900_000 });
  await settle();
  socket.emit({ type: 'subscribed', topics, refused: [], resync: true });
  await settle();
  return socket;
}

beforeEach(() => {
  FakeSocket.reset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the URL', () => {
  it('switches the scheme and keeps the origin', () => {
    expect(realtimeUrlFor('http://127.0.0.1:4000')).toBe('ws://127.0.0.1:4000/v1/realtime');
    expect(realtimeUrlFor('https://api.dashapp.ng')).toBe('wss://api.dashapp.ng/v1/realtime');
    expect(realtimeUrlFor('https://api.dashapp.ng/')).toBe('wss://api.dashapp.ng/v1/realtime');
  });
});

describe('the handshake', () => {
  it('authenticates only after the server speaks first', async () => {
    const client = buildClient();
    client.subscribe(['order:o1'], () => undefined);

    const socket = FakeSocket.latest();
    socket.onopen?.();
    await settle();
    // Nothing is volunteered before `welcome`.
    expect(socket.sent).toEqual([]);

    socket.emit({ type: 'welcome', protocol: 1 });
    await settle();
    expect(socket.framesOfType('authenticate')).toEqual([
      { type: 'authenticate', token: 'access-token' },
    ]);
    client.stop();
  });

  it('subscribes once authenticated, not before', async () => {
    const client = buildClient();
    client.subscribe(['order:o1', 'vendor:v1'], () => undefined);

    const socket = FakeSocket.latest();
    socket.emit({ type: 'welcome', protocol: 1 });
    await settle();
    expect(socket.framesOfType('subscribe')).toEqual([]);

    socket.emit({ type: 'authenticated', expiresAt: Date.now() + 900_000 });
    await settle();
    expect(socket.framesOfType('subscribe')[0]?.['topics']).toEqual(['order:o1', 'vendor:v1']);
    client.stop();
  });

  it('closes rather than looping when there is no session', async () => {
    const client = buildClient({ getToken: async () => null });
    client.subscribe(['order:o1'], () => undefined);

    const socket = FakeSocket.latest();
    socket.emit({ type: 'welcome', protocol: 1 });
    await settle();

    expect(socket.closedWith).toBe(1000);
    expect(socket.framesOfType('authenticate')).toEqual([]);
    client.stop();
  });

  it('refuses a topic name the server would reject', () => {
    const client = buildClient();
    // Caught here so a screen bug is a visible throw rather than a silent
    // subscription that never delivers.
    expect(() => client.subscribe(['order:*'], () => undefined)).toThrow();
    expect(() => client.subscribe(['nonsense'], () => undefined)).toThrow();
    client.stop();
  });
});

describe('a change causes a re-read', () => {
  it('notifies the listener when an event arrives', async () => {
    const hints: { reason: string; subjects: readonly string[] }[] = [];
    const client = buildClient();
    const socket = await connected(client, ['order:o1'], (hint) => hints.push(hint));

    // The subscription itself asks for a read, because the stream has no
    // history and cannot say what was missed.
    expect(hints).toEqual([{ reason: 'resync', subjects: ['order:o1'] }]);

    socket.emit({
      type: 'event',
      topics: ['order:o1'],
      subject: 'order:o1',
      version: 1,
      eventId: 'order:o1@1',
      occurredAt: 1,
    });
    await settle();

    expect(hints).toHaveLength(2);
    expect(hints[1]).toEqual({ reason: 'event', subjects: ['order:o1'] });
    client.stop();
  });

  it('gives a listener one hint even when several of its topics match', async () => {
    const hints: unknown[] = [];
    const client = buildClient();
    const socket = await connected(client, ['order:o1', 'vendor:v1'], (hint) => hints.push(hint));
    hints.length = 0;

    socket.emit({
      type: 'event',
      topics: ['order:o1', 'vendor:v1'],
      subject: 'order:o1',
      version: 1,
      eventId: 'e1',
      occurredAt: 1,
    });
    await settle();

    // One re-read, not one per matched topic.
    expect(hints).toHaveLength(1);
    client.stop();
  });

  it('ignores an event for a topic this client never asked for', async () => {
    const hints: unknown[] = [];
    const client = buildClient();
    const socket = await connected(client, ['order:o1'], (hint) => hints.push(hint));
    hints.length = 0;

    socket.emit({
      type: 'event',
      topics: ['order:somebody-elses'],
      subject: 'order:somebody-elses',
      version: 9,
      eventId: 'e9',
      occurredAt: 1,
    });
    await settle();

    expect(hints).toEqual([]);
    client.stop();
  });
});

describe('duplicates and out-of-order arrival', () => {
  it('re-reads once for a redelivered event', async () => {
    const hints: unknown[] = [];
    const client = buildClient();
    const socket = await connected(client, ['order:o1'], (hint) => hints.push(hint));
    hints.length = 0;

    const event = {
      type: 'event',
      topics: ['order:o1'],
      subject: 'order:o1',
      version: 3,
      eventId: 'order:o1@3',
      occurredAt: 1,
    };
    // At-least-once delivery makes this the ordinary case, not an edge one.
    socket.emit(event);
    socket.emit(event);
    socket.emit(event);
    await settle();

    expect(hints).toHaveLength(1);
    client.stop();
  });

  it('ignores a version older than one already seen', async () => {
    const hints: unknown[] = [];
    const client = buildClient();
    const socket = await connected(client, ['order:o1'], (hint) => hints.push(hint));
    hints.length = 0;

    const at = (version: number) => ({
      type: 'event',
      topics: ['order:o1'],
      subject: 'order:o1',
      version,
      eventId: `order:o1@${version}`,
      occurredAt: 1,
    });

    socket.emit(at(5));
    socket.emit(at(2));
    socket.emit(at(4));
    await settle();

    // Only the first is acted on: the later two describe a past this screen has
    // already moved beyond, and re-reading for them would fetch state that is
    // newer than the notification claimed — harmless, but pointless.
    expect(hints).toHaveLength(1);

    socket.emit(at(6));
    await settle();
    expect(hints).toHaveLength(2);
    client.stop();
  });

  it('tracks versions per subject, not globally', async () => {
    const hints: unknown[] = [];
    const client = buildClient();
    const socket = await connected(client, ['vendor:v1'], (hint) => hints.push(hint));
    hints.length = 0;

    // A vendor queue carries many orders. A high revision on one must not
    // suppress a low one on another — they are unrelated counters.
    socket.emit({
      type: 'event',
      topics: ['vendor:v1'],
      subject: 'order:busy',
      version: 40,
      eventId: 'a',
      occurredAt: 1,
    });
    socket.emit({
      type: 'event',
      topics: ['vendor:v1'],
      subject: 'order:fresh',
      version: 1,
      eventId: 'b',
      occurredAt: 1,
    });
    await settle();

    expect(hints).toHaveLength(2);
    client.stop();
  });

  it('survives frames that are not valid at all', async () => {
    const hints: unknown[] = [];
    const client = buildClient();
    const socket = await connected(client, ['order:o1'], (hint) => hints.push(hint));
    hints.length = 0;

    socket.emitRaw('not json');
    socket.emitRaw(42);
    socket.emit(null);
    socket.emit(['array']);
    socket.emit({ type: 'event' });
    socket.emit({ type: 'event', topics: 'order:o1', subject: 'order:o1', eventId: 'x' });
    socket.emit({ type: 'unheard_of_frame' });
    await settle();

    expect(hints).toEqual([]);
    // And the socket is still usable, not knocked over by any of it.
    expect(socket.closedWith).toBeNull();
    socket.emit({
      type: 'event',
      topics: ['order:o1'],
      subject: 'order:o1',
      version: 1,
      eventId: 'ok',
      occurredAt: 1,
    });
    await settle();
    expect(hints).toHaveLength(1);
    client.stop();
  });
});

describe('reconnection', () => {
  it('reconnects, resubscribes, and resyncs', async () => {
    const hints: { reason: string }[] = [];
    const client = buildClient();
    const first = await connected(client, ['order:o1'], (hint) => hints.push(hint));
    hints.length = 0;

    first.drop(1006);
    expect(client.isLive()).toBe(false);

    // Backoff, then a fresh socket.
    await vi.advanceTimersByTimeAsync(1_000);
    const second = FakeSocket.latest();
    expect(second).not.toBe(first);

    second.emit({ type: 'welcome', protocol: 1 });
    await settle();
    second.emit({ type: 'authenticated', expiresAt: Date.now() + 900_000 });
    await settle();

    // The subscription is re-established without the screen asking.
    expect(second.framesOfType('subscribe')[0]?.['topics']).toEqual(['order:o1']);

    second.emit({ type: 'subscribed', topics: ['order:o1'], refused: [], resync: true });
    await settle();

    // And the screen is told to re-read, which is what closes the gap: whatever
    // changed while the socket was down is picked up by that fetch.
    expect(hints).toEqual([{ reason: 'resync', subjects: ['order:o1'] }]);
    client.stop();
  });

  it('re-reads after a server-driven resync', async () => {
    // The server clears a connection's subscriptions when it re-authenticates,
    // so the ownership checks behind them are re-run.
    const hints: { reason: string }[] = [];
    const client = buildClient();
    const socket = await connected(client, ['order:o1'], (hint) => hints.push(hint));
    hints.length = 0;

    socket.emit({ type: 'resync', topics: [], reason: 'reauthenticated' });
    await settle();
    expect(socket.framesOfType('subscribe')).toHaveLength(2);

    socket.emit({ type: 'subscribed', topics: ['order:o1'], refused: [], resync: true });
    await settle();
    expect(hints).toEqual([{ reason: 'resync', subjects: ['order:o1'] }]);
    client.stop();
  });

  it('does not treat an expired token as a broken transport', async () => {
    const client = buildClient();
    const socket = await connected(client, ['order:o1'], () => undefined);

    // Every fifteen minutes, all day. It must never accumulate into a fallback.
    let current = socket;
    for (let i = 0; i < 8; i += 1) {
      current.drop(CLOSE.session_invalid);
      await vi.advanceTimersByTimeAsync(1_000);
      current = FakeSocket.latest();
    }

    expect(client.getStatus()).not.toBe('polling');
    client.stop();
  });

  it('stops trying once the attempts are spent', async () => {
    const client = buildClient();
    await connected(client, ['order:o1'], () => undefined);

    for (let i = 0; i < 8; i += 1) {
      FakeSocket.latest().drop(1006);
      await vi.advanceTimersByTimeAsync(60_000);
    }

    expect(client.getStatus()).toBe('polling');
    const attempts = FakeSocket.instances.length;

    // And it genuinely stops, rather than slowing down.
    await vi.advanceTimersByTimeAsync(300_000);
    expect(FakeSocket.instances.length).toBe(attempts);
    client.stop();
  });

  it('falls back immediately when the deployment has realtime off', async () => {
    const client = buildClient();
    const statuses: string[] = [];
    client.onStatusChange((status) => statuses.push(status));
    await connected(client, ['order:o1'], () => undefined);

    FakeSocket.latest().drop(CLOSE.disabled);
    await vi.advanceTimersByTimeAsync(120_000);

    expect(client.getStatus()).toBe('polling');
    expect(statuses).toContain('polling');
    // No retry storm against a server that has answered honestly.
    expect(FakeSocket.instances).toHaveLength(1);
    client.stop();
  });

  it('reports the socket never opening as a fallback, not a crash', async () => {
    const client = buildClient({
      createSocket: () => {
        throw new Error('blocked by the network');
      },
    });

    expect(() => client.subscribe(['order:o1'], () => undefined)).not.toThrow();
    for (let i = 0; i < 8; i += 1) await vi.advanceTimersByTimeAsync(60_000);

    expect(client.getStatus()).toBe('polling');
    client.stop();
  });
});

describe('renewal', () => {
  it('sends a fresh token before the server would close the socket', async () => {
    let issued = 0;
    const client = buildClient({
      getToken: async () => {
        issued += 1;
        return `token-${issued}`;
      },
    });
    const socket = await connected(client, ['order:o1'], () => undefined);

    // The server said this socket's authority lapses in fifteen minutes.
    socket.emit({ type: 'authenticated', expiresAt: Date.now() + 900_000 });
    await settle();

    await vi.advanceTimersByTimeAsync(840_001);
    await settle();

    const authFrames = socket.framesOfType('authenticate');
    expect(authFrames.length).toBeGreaterThan(1);
    // A *fresh* token, not the one it opened with.
    expect(authFrames.at(-1)?.['token']).not.toBe('token-1');
    client.stop();
  });
});

describe('subscription lifecycle', () => {
  it('keeps one socket for several screens', async () => {
    const client = buildClient();
    await connected(client, ['order:o1'], () => undefined);
    client.subscribe(['vendor:v1'], () => undefined);
    await settle();

    expect(FakeSocket.instances).toHaveLength(1);
    client.stop();
  });

  it('unsubscribes only when the last listener goes', async () => {
    const client = buildClient();
    const socket = await connected(client, ['order:o1'], () => undefined);
    const release = client.subscribe(['order:o1'], () => undefined);

    release();
    expect(socket.framesOfType('unsubscribe')).toEqual([]);
    client.stop();
  });

  it('stops delivering to a listener that has gone', async () => {
    const hints: unknown[] = [];
    const client = buildClient();
    const socket = await connected(client, ['order:o1'], (hint) => hints.push(hint));
    hints.length = 0;

    client.stop();
    socket.emit({
      type: 'event',
      topics: ['order:o1'],
      subject: 'order:o1',
      version: 1,
      eventId: 'e1',
      occurredAt: 1,
    });
    await settle();

    expect(hints).toEqual([]);
  });
});

describe('what a notification can carry into the client', () => {
  it('passes on identifiers and a reason, and nothing else', async () => {
    const hints: Record<string, unknown>[] = [];
    const client = buildClient();
    const socket = await connected(client, ['order:o1'], (hint) =>
      hints.push(hint as unknown as Record<string, unknown>),
    );
    hints.length = 0;

    // A frame stuffed with things that look like order state. If any of it
    // could reach a screen, the socket would be a way around the projection
    // rules the API applies per role.
    socket.emit({
      type: 'event',
      topics: ['order:o1'],
      subject: 'order:o1',
      version: 1,
      eventId: 'e1',
      occurredAt: 1,
      status: 'delivered',
      total: 1,
      customerPhone: '+2348000000000',
      deliveryPin: '1234',
      rider: { latitude: 6.5, longitude: 3.4 },
    });
    await settle();

    expect(hints).toHaveLength(1);
    // The hint's shape is the guarantee: there is no field a component could
    // render even by mistake.
    expect(Object.keys(hints[0]!).sort()).toEqual(['reason', 'subjects']);

    const serialised = JSON.stringify(hints[0]);
    for (const leak of ['delivered', '2348000000000', '1234', 'latitude']) {
      expect(serialised).not.toContain(leak);
    }
    client.stop();
  });
});
