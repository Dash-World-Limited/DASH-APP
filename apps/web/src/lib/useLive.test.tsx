// @vitest-environment jsdom

/**
 * Realtime, as a screen actually experiences it.
 *
 * `realtime.test.ts` proves the client turns frames into refresh hints. This
 * proves the other half — that a hint becomes a re-read, that the re-read is
 * what reaches the DOM, and that nothing from the wire ever does.
 *
 * That last one is why this suite renders a real component instead of asserting
 * on a mock. "The UI never shows anything from a notification" is a claim about
 * rendering, and the only honest way to make it is to put a hostile frame on
 * the socket and then look at the document.
 *
 * The component below is a faithful miniature of the four real screens: state
 * from an authorized fetch, `useLive` for when to fetch, and nothing else.
 */

import { act } from 'react';
import { useCallback, useState } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RealtimeClient, type WebSocketLike } from './realtime';
import { useLive } from './useLive';

// ---------------------------------------------------------------------------
// A socket the test drives
// ---------------------------------------------------------------------------

class FakeSocket implements WebSocketLike {
  static instances: FakeSocket[] = [];

  readyState = 1;
  readonly sent: Record<string, unknown>[] = [];
  closedWith: number | null = null;

  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor() {
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(code = 1000): void {
    this.closedWith = code;
    this.readyState = 3;
  }

  emit(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  drop(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code, reason: '' });
  }

  static latest(): FakeSocket {
    const socket = FakeSocket.instances.at(-1);
    if (!socket) throw new Error('no socket was opened');
    return socket;
  }
}

// ---------------------------------------------------------------------------
// The server's view of the order, and the authorized read of it
// ---------------------------------------------------------------------------

/**
 * What `GET /v1/orders/:id` would return right now.
 *
 * Mutated by tests to represent the server moving on. The screen can only ever
 * learn about a change by fetching, which is the point.
 */
let serverState = { status: 'preparing', revision: 1 };
let fetchCount = 0;

async function authorizedRead(): Promise<{ status: string }> {
  fetchCount += 1;
  // A real fetch is not instant, and a test that pretends otherwise misses the
  // coalescing behaviour entirely.
  await Promise.resolve();
  return { status: serverState.status };
}

function LiveOrderScreen({
  client,
  pollMs = 1_000,
}: {
  client: RealtimeClient;
  pollMs?: number;
}): React.JSX.Element {
  const [order, setOrder] = useState<{ status: string } | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setOrder(await authorizedRead());
  }, []);

  const { status: transport } = useLive({
    topics: ['order:o1'],
    load,
    pollMs,
    livePollMs: 30_000,
    client,
  });

  return (
    <div>
      <span data-testid="status">{order?.status ?? 'loading'}</span>
      <span data-testid="transport">{transport}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------

function buildClient(overrides: { createSocket?: () => WebSocketLike } = {}): RealtimeClient {
  return new RealtimeClient({
    url: 'ws://test/v1/realtime',
    createSocket: overrides.createSocket ?? (() => new FakeSocket()),
    getToken: async () => 'access-token',
    random: () => 0,
  });
}

/** Let effects, promises, and state updates settle. */
async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  });
}

/** Complete the handshake on the newest socket. */
async function handshake(topics = ['order:o1']): Promise<FakeSocket> {
  const socket = FakeSocket.latest();
  await act(async () => {
    socket.onopen?.();
    socket.emit({ type: 'welcome', protocol: 1 });
  });
  await flush();
  await act(async () => {
    socket.emit({ type: 'authenticated', expiresAt: Date.now() + 900_000 });
  });
  await flush();
  await act(async () => {
    socket.emit({ type: 'subscribed', topics, refused: [], resync: true });
  });
  await flush();
  return socket;
}

const orderEvent = (version: number, extra: Record<string, unknown> = {}): unknown => ({
  type: 'event',
  topics: ['order:o1'],
  subject: 'order:o1',
  version,
  eventId: `order:o1@${version}`,
  occurredAt: 1,
  ...extra,
});

beforeEach(() => {
  FakeSocket.instances = [];
  serverState = { status: 'preparing', revision: 1 };
  fetchCount = 0;
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('a realtime event refreshes the screen immediately', () => {
  it('re-reads and re-renders without waiting for the poll', async () => {
    const client = buildClient();
    render(<LiveOrderScreen client={client} pollMs={1_000} />);
    await flush();
    await handshake();

    expect(screen.getByTestId('status').textContent).toBe('preparing');
    expect(screen.getByTestId('transport').textContent).toBe('live');
    const before = fetchCount;

    // The server moves on, and announces it.
    serverState = { status: 'en_route', revision: 2 };
    await act(async () => {
      FakeSocket.latest().emit(orderEvent(2));
    });
    await flush();

    // Updated without a single timer having advanced. This is the whole
    // feature: the screen is current at the moment the order changed, not up to
    // a poll interval later.
    expect(screen.getByTestId('status').textContent).toBe('en_route');
    expect(fetchCount).toBe(before + 1);

    client.stop();
  });

  it('subscribing at all triggers a read, because the stream has no history', async () => {
    const client = buildClient();
    render(<LiveOrderScreen client={client} />);
    await flush();

    const afterMount = fetchCount;
    await handshake();

    // A client that has just subscribed cannot know what changed while it was
    // not listening, and the server cannot tell it. So it reads.
    expect(fetchCount).toBeGreaterThan(afterMount);
    client.stop();
  });
});

describe('duplicates and out-of-order arrival do not corrupt the screen', () => {
  it('re-reads once for a redelivered event', async () => {
    const client = buildClient();
    render(<LiveOrderScreen client={client} />);
    await flush();
    const socket = await handshake();

    serverState = { status: 'en_route', revision: 2 };
    const before = fetchCount;

    await act(async () => {
      socket.emit(orderEvent(2));
      socket.emit(orderEvent(2));
      socket.emit(orderEvent(2));
    });
    await flush();

    expect(fetchCount).toBe(before + 1);
    expect(screen.getByTestId('status').textContent).toBe('en_route');
    client.stop();
  });

  it('does not roll the screen backwards when a stale event arrives late', async () => {
    // The failure this prevents is the visible one: an out-of-order delivery
    // making a delivered order appear to be preparing again.
    const client = buildClient();
    render(<LiveOrderScreen client={client} />);
    await flush();
    const socket = await handshake();

    serverState = { status: 'delivered', revision: 9 };
    await act(async () => {
      socket.emit(orderEvent(9));
    });
    await flush();
    expect(screen.getByTestId('status').textContent).toBe('delivered');

    const before = fetchCount;

    // An older notification turns up afterwards, as unordered delivery allows.
    await act(async () => {
      socket.emit(orderEvent(3));
      socket.emit(orderEvent(7));
    });
    await flush();

    // Neither is acted on, and — the part that matters — the screen still shows
    // what the server actually holds.
    expect(fetchCount).toBe(before);
    expect(screen.getByTestId('status').textContent).toBe('delivered');
    client.stop();
  });

  it('shows the newest state even when events arrive in a burst', async () => {
    const client = buildClient();
    render(<LiveOrderScreen client={client} />);
    await flush();
    const socket = await handshake();

    // Several transitions inside one round trip. The reads coalesce, and
    // whichever wins reads the same server state, so the screen cannot settle
    // on a stale value.
    serverState = { status: 'delivered', revision: 12 };
    await act(async () => {
      socket.emit(orderEvent(10));
      socket.emit(orderEvent(11));
      socket.emit(orderEvent(12));
    });
    await flush();

    expect(screen.getByTestId('status').textContent).toBe('delivered');
    client.stop();
  });
});

describe('reconnecting resyncs', () => {
  it('re-reads after the socket comes back, so a gap cannot leave stale UI', async () => {
    const client = buildClient();
    render(<LiveOrderScreen client={client} pollMs={600_000} />);
    await flush();
    const first = await handshake();

    expect(screen.getByTestId('status').textContent).toBe('preparing');

    // The socket dies, and the order moves while nothing is listening. Nothing
    // will ever replay that change — there is no per-topic log.
    await act(async () => {
      first.drop(1006);
    });
    serverState = { status: 'delivered', revision: 5 };
    await flush();

    // The poll is set to ten minutes here on purpose: if the screen recovers,
    // it is the reconnect that did it and not a timer.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    await flush();
    await handshake();

    expect(screen.getByTestId('status').textContent).toBe('delivered');
    client.stop();
  });
});

describe('polling still works when the socket does not', () => {
  it('keeps the screen current with no WebSocket at all', async () => {
    const client = buildClient({
      createSocket: () => {
        throw new Error('WebSocket blocked');
      },
    });
    render(<LiveOrderScreen client={client} pollMs={1_000} />);
    await flush();

    // The first read happens regardless of the socket.
    expect(screen.getByTestId('status').textContent).toBe('preparing');

    serverState = { status: 'delivered', revision: 4 };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_100);
    });
    await flush();

    // No socket ever existed, and the screen is still correct — which is the
    // entire reason the notification-only design is safe to depend on.
    expect(screen.getByTestId('status').textContent).toBe('delivered');
    client.stop();
  });

  it('reports itself as polling rather than pretending to be live', async () => {
    const client = buildClient({
      createSocket: () => {
        throw new Error('WebSocket blocked');
      },
    });
    render(<LiveOrderScreen client={client} pollMs={1_000} />);
    await flush();

    for (let i = 0; i < 8; i += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      await flush();
    }

    expect(screen.getByTestId('transport').textContent).toBe('polling');
    client.stop();
  });

  it('keeps polling as a safety net while the socket is live', async () => {
    // At-least-once delivery promises a notification may arrive twice. It does
    // not promise one always arrives, so a dropped frame with nothing behind it
    // would leave the screen silently wrong until a reload.
    const client = buildClient();
    render(<LiveOrderScreen client={client} pollMs={1_000} />);
    await flush();
    await handshake();

    const before = fetchCount;
    serverState = { status: 'delivered', revision: 6 };

    // No event is ever sent for this change.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });
    await flush();

    expect(fetchCount).toBeGreaterThan(before);
    expect(screen.getByTestId('status').textContent).toBe('delivered');
    client.stop();
  });
});

describe('the client never trusts the event payload', () => {
  it('renders what the authorized read returned, not what the frame claimed', async () => {
    const client = buildClient();
    render(<LiveOrderScreen client={client} pollMs={600_000} />);
    await flush();
    const socket = await handshake();

    // The server's actual answer for this actor.
    serverState = { status: 'preparing', revision: 2 };

    // A frame claiming something else entirely, plus fields a projection rule
    // would never have released to this actor. If any of it could reach the
    // DOM, the socket would be a way around the per-role field rules the API
    // enforces.
    await act(async () => {
      socket.emit(
        orderEvent(2, {
          status: 'delivered',
          statusLabel: 'Delivered',
          total: 999_999,
          customerPhone: '+2348000000000',
          deliveryPin: '4321',
          rider: { latitude: 6.5, longitude: 3.4 },
        }),
      );
    });
    await flush();

    // The screen shows the server's answer.
    expect(screen.getByTestId('status').textContent).toBe('preparing');

    // And nothing from the frame is anywhere in the document.
    const html = document.body.innerHTML;
    for (const leak of ['Delivered', '999999', '2348000000000', '4321', '6.5']) {
      expect(html).not.toContain(leak);
    }
    client.stop();
  });

  it('ignores a frame naming a topic the screen never subscribed to', async () => {
    // Authorization is the server's, but a client that acted on unrequested
    // topics would still be doing work on behalf of something it did not ask
    // for. Exact-match only, here as well as on the server.
    const client = buildClient();
    render(<LiveOrderScreen client={client} pollMs={600_000} />);
    await flush();
    const socket = await handshake();

    const before = fetchCount;
    serverState = { status: 'delivered', revision: 3 };

    await act(async () => {
      socket.emit({
        type: 'event',
        topics: ['order:someone-elses'],
        subject: 'order:someone-elses',
        version: 3,
        eventId: 'x',
        occurredAt: 1,
      });
    });
    await flush();

    expect(fetchCount).toBe(before);
    expect(screen.getByTestId('status').textContent).toBe('preparing');
    client.stop();
  });
});
