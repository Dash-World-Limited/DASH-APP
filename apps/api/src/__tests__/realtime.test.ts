/**
 * The realtime endpoint, over real WebSockets.
 *
 * This suite listens on an ephemeral port and connects with a real `ws` client
 * rather than using `app.injectWS`. That is deliberate and costs a few hundred
 * milliseconds: an injected upgrade has no underlying socket, so `request.ip`
 * throws inside the rate limiter's key generator and the upgrade never reaches
 * the handler. Testing the path that only exists in the test would prove
 * nothing about the one that runs in production — and close codes, ping/pong,
 * and buffering are all things only a real socket does.
 *
 * What is asserted here, in order of how much it would cost to get wrong:
 *
 *   1. Nobody reaches a topic they are not entitled to, and a refusal never
 *      reveals whether the thing they asked for exists.
 *   2. Frames carry identifiers and a version — never order data.
 *   3. A duplicate delivery becomes one frame; a stale one is ignorable.
 *   4. The socket cannot be used to outlive the session behind it.
 *   5. A client that reconnects is told to resync rather than silently missing
 *      whatever changed while it was away.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { CLOSE, MAX_FRAME_BYTES } from '@dash/domain/realtime';
import { recordOrderChange } from '../realtime/notify.js';
import { createTestContext, type TestContext } from './harness.js';
import { actAs, buildWorld, idempotencyKey, type Actor, type World } from './world.js';
import { useIntegrationTimeouts } from './timeouts.js';

// Real Fastify, real SQLite, real round trips — see timeouts.ts.
useIntegrationTimeouts();

let context: TestContext;
let world: World;
let url = '';

let customerA: Actor;
let customerB: Actor;
let vendorA: Actor;
let vendorB: Actor;
let riderA: Actor;
let dispatcher: Actor;

beforeAll(async () => {
  context = await createTestContext({}, {}, undefined, {
    // Short enough for a test to observe, long enough that an ordinary
    // exchange inside one test is never cut off by it.
    authenticateDeadlineMs: 700,
    // Short, so every socket in this file is pinged repeatedly and every test
    // incidentally proves the heartbeat does not kill a healthy connection —
    // which is the direction that would actually cost users something.
    heartbeatMs: 400,
    // A live sweep, fast enough for a test to observe. Running it for the whole
    // suite also means every other test here is incidentally proving that the
    // sweep does not disturb a healthy socket.
    revalidateIntervalMs: 300,
    maxConnectionsPerIdentity: 4,
  });

  world = await buildWorld(context.prisma);

  customerA = await actAs(context, world.customerA.email);
  customerB = await actAs(context, world.customerB.email);
  vendorA = await actAs(context, world.vendorA.ownerEmail);
  vendorB = await actAs(context, world.vendorB.ownerEmail);
  riderA = await actAs(context, world.riderA.email);
  dispatcher = await actAs(context, world.dispatcher.email);

  await context.app.listen({ port: 0, host: '127.0.0.1' });
  const address = context.app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  url = `ws://127.0.0.1:${port}/v1/realtime`;
}, 240_000);

afterAll(async () => {
  await context?.close();
});

// ---------------------------------------------------------------------------
// A small client
// ---------------------------------------------------------------------------

interface Frame {
  type: string;
  [key: string]: unknown;
}

class Client {
  readonly frames: Frame[] = [];
  closed: { code: number; reason: string } | null = null;

  private readonly waiters: { match: (frame: Frame) => boolean; resolve: (f: Frame) => void }[] = [];
  private readonly closeWaiters: ((info: { code: number; reason: string }) => void)[] = [];

  private constructor(private readonly socket: WebSocket) {}

  static async open(options: { origin?: string } = {}): Promise<Client> {
    const socket = new WebSocket(url, options.origin ? { origin: options.origin } : {});
    const client = new Client(socket);

    // Listeners attached before `open` resolves, so the `welcome` frame — which
    // the server sends immediately — is never missed in a race.
    socket.on('message', (data: Buffer) => client.receive(data));
    socket.on('close', (code: number, reason: Buffer) => {
      client.closed = { code, reason: reason.toString() };
      for (const resolve of client.closeWaiters.splice(0)) resolve(client.closed);
    });

    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });

    return client;
  }

  private receive(data: Buffer): void {
    let frame: Frame;
    try {
      frame = JSON.parse(data.toString()) as Frame;
    } catch {
      throw new Error(`server sent a non-JSON frame: ${data.toString().slice(0, 120)}`);
    }
    this.frames.push(frame);

    for (let i = this.waiters.length - 1; i >= 0; i -= 1) {
      const waiter = this.waiters[i]!;
      if (waiter.match(frame)) {
        this.waiters.splice(i, 1);
        waiter.resolve(frame);
      }
    }
  }

  send(frame: unknown): void {
    this.socket.send(typeof frame === 'string' ? frame : JSON.stringify(frame));
  }

  /** Send a raw string, for the frames a well-behaved client would never send. */
  sendRaw(raw: string): void {
    this.socket.send(raw);
  }

  /**
   * The next frame matching `match`, including one already received.
   *
   * Checking the backlog first is what keeps these tests free of sleeps: a
   * frame that arrived while the test was doing something else still satisfies
   * the wait.
   */
  async next(match: (frame: Frame) => boolean, timeoutMs = 5_000): Promise<Frame> {
    const existing = this.frames.find(match);
    if (existing) return existing;

    return new Promise<Frame>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            `timed out waiting for a frame; saw: ${JSON.stringify(this.frames.map((f) => f.type))}`,
          ),
        );
      }, timeoutMs);
      timer.unref?.();

      this.waiters.push({
        match,
        resolve: (frame) => {
          clearTimeout(timer);
          resolve(frame);
        },
      });
    });
  }

  ofType(type: string): Frame[] {
    return this.frames.filter((frame) => frame.type === type);
  }

  async waitForClose(timeoutMs = 5_000): Promise<{ code: number; reason: string }> {
    if (this.closed) return this.closed;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('socket did not close')), timeoutMs);
      timer.unref?.();
      this.closeWaiters.push((info) => {
        clearTimeout(timer);
        resolve(info);
      });
    });
  }

  /** Connect, authenticate, and return once the server confirms. */
  static async authenticated(actor: Actor): Promise<Client> {
    const client = await Client.open();
    await client.next((frame) => frame.type === 'welcome');
    client.send({ type: 'authenticate', token: actor.accessToken });
    await client.next((frame) => frame.type === 'authenticated');
    return client;
  }

  async subscribe(topics: string[]): Promise<Frame> {
    const before = this.ofType('subscribed').length;
    this.send({ type: 'subscribe', topics });
    return this.next(
      (frame) => frame.type === 'subscribed' && this.ofType('subscribed').length > before,
    );
  }

  dispose(): void {
    this.socket.removeAllListeners();
    this.socket.close();
  }
}

// ---------------------------------------------------------------------------
// Order fixtures
// ---------------------------------------------------------------------------

/** Place and pay for an order, which is the transition everything else follows. */
async function placeOrder(as: Actor = customerA): Promise<string> {
  const created = await context.app.inject({
    method: 'POST',
    url: '/v1/orders',
    headers: { ...as.headers, 'idempotency-key': idempotencyKey('rt') },
    payload: {
      branchId: world.vendorA.branchId,
      items: [
        { itemId: world.vendorA.itemId, quantity: 1, modifierIds: [world.vendorA.modifierId] },
      ],
      mode: 'delivery',
      addressId:
        as === customerB ? world.customerB.addressId : world.customerA.addressId,
      paymentMethod: 'card',
    },
  });
  if (created.statusCode !== 200) {
    throw new Error(`order failed: ${created.statusCode} ${created.body}`);
  }
  return created.json<{ order: { id: string } }>().order.id;
}

/** Move an order forward through the vendor, which emits a notification. */
async function acceptOrder(orderId: string): Promise<void> {
  const response = await context.app.inject({
    method: 'POST',
    url: `/v1/vendor/orders/${orderId}/accept`,
    headers: vendorA.headers,
    payload: { prepMinutes: 20 },
  });
  if (response.statusCode !== 200) {
    throw new Error(`accept failed: ${response.statusCode} ${response.body}`);
  }
}

async function progressOrder(orderId: string, to: 'preparing' | 'ready'): Promise<void> {
  const response = await context.app.inject({
    method: 'POST',
    url: `/v1/vendor/orders/${orderId}/progress`,
    headers: vendorA.headers,
    payload: { to },
  });
  if (response.statusCode !== 200) {
    throw new Error(`progress failed: ${response.statusCode} ${response.body}`);
  }
}

// ---------------------------------------------------------------------------

describe('the handshake', () => {
  it('greets a new socket with the timings it will actually enforce', async () => {
    const client = await Client.open();
    const welcome = await client.next((frame) => frame.type === 'welcome');

    expect(welcome['protocol']).toBe(1);
    // Not the default constant — the value this server is running with. A
    // client schedules its authenticate frame from this, so advertising 10s
    // while enforcing 700ms would disconnect a client for obeying the server.
    expect(welcome['authenticateWithinMs']).toBe(700);
    client.dispose();
  });

  it('closes a socket that never authenticates', async () => {
    const client = await Client.open();
    const closed = await client.waitForClose();
    expect(closed.code).toBe(CLOSE.unauthenticated);
  });

  it('refuses an upgrade from another origin', async () => {
    // Cross-site WebSocket hijacking: an upgrade is not subject to CORS, so
    // any page could otherwise open this socket with the victim's browser.
    const client = await Client.open({ origin: 'https://evil.example' });
    const closed = await client.waitForClose();
    expect(closed.code).toBe(CLOSE.protocol_violation);
  });

  it('accepts an upgrade with no Origin at all', async () => {
    // Native apps and server-to-server clients send none, and a browser always
    // does — so absence cannot be forged by a browser into an allowed origin.
    const client = await Client.open();
    await client.next((frame) => frame.type === 'welcome');
    expect(client.closed).toBeNull();
    client.dispose();
  });

  it('refuses a forged token and closes', async () => {
    const client = await Client.open();
    await client.next((frame) => frame.type === 'welcome');
    client.send({ type: 'authenticate', token: 'not.a.real.token' });

    const error = await client.next((frame) => frame.type === 'error');
    expect(error['code']).toBe('invalid_token');
    const closed = await client.waitForClose();
    expect(closed.code).toBe(CLOSE.session_invalid);
  });

  it('refuses a refresh token replayed as an access token', async () => {
    // The audiences are pinned separately precisely so this cannot work.
    const client = await Client.open();
    await client.next((frame) => frame.type === 'welcome');
    client.send({ type: 'authenticate', token: customerA.refreshToken });

    const closed = await client.waitForClose();
    expect(closed.code).toBe(CLOSE.session_invalid);
  });

  it('handles a pipelined authenticate and subscribe in order', async () => {
    // A client that sends both without waiting for `authenticated` is doing
    // nothing wrong. Handling frames concurrently would race the subscribe
    // against the authenticate's database read and refuse it.
    const orderId = await placeOrder(customerA);
    const client = await Client.open();
    await client.next((frame) => frame.type === 'welcome');

    client.send({ type: 'authenticate', token: customerA.accessToken });
    client.send({ type: 'subscribe', topics: [`order:${orderId}`] });

    const subscribed = await client.next((frame) => frame.type === 'subscribed');
    expect(subscribed['topics']).toEqual([`order:${orderId}`]);
    expect(client.ofType('error')).toEqual([]);
    client.dispose();
  });

  it('refuses to subscribe before authentication', async () => {
    const client = await Client.open();
    await client.next((frame) => frame.type === 'welcome');
    client.send({ type: 'subscribe', topics: ['order:anything'] });

    const error = await client.next((frame) => frame.type === 'error');
    expect(error['code']).toBe('not_authenticated');
    client.dispose();
  });
});

describe('subscription authorization', () => {
  it('lets a customer follow their own order', async () => {
    const orderId = await placeOrder(customerA);
    const client = await Client.authenticated(customerA);

    const subscribed = await client.subscribe([`order:${orderId}`]);
    expect(subscribed['topics']).toEqual([`order:${orderId}`]);
    expect(subscribed['refused']).toEqual([]);
    client.dispose();
  });

  it("refuses another customer's order without revealing that it exists", async () => {
    const orderId = await placeOrder(customerA);
    const client = await Client.authenticated(customerB);

    const real = await client.subscribe([`order:${orderId}`]);
    const invented = await client.subscribe(['order:doesnotexistatall']);

    // The two refusals are identical. That is the whole assertion: a refusal
    // that distinguished them would be an oracle for which order ids are real.
    expect(real['refused']).toEqual([{ topic: `order:${orderId}`, code: 'not_found' }]);
    expect(invented['refused']).toEqual([
      { topic: 'order:doesnotexistatall', code: 'not_found' },
    ]);
    expect(real['topics']).toEqual([]);
    client.dispose();
  });

  it("refuses one vendor another vendor's queue and orders", async () => {
    const orderId = await placeOrder(customerA);
    const client = await Client.authenticated(vendorB);

    const refused = await client.subscribe([
      `vendor:${world.vendorA.vendorId}`,
      `order:${orderId}`,
    ]);

    expect(refused['topics']).toEqual([]);
    expect(refused['refused']).toEqual([
      { topic: `vendor:${world.vendorA.vendorId}`, code: 'not_found' },
      { topic: `order:${orderId}`, code: 'not_found' },
    ]);
    client.dispose();
  });

  it('lets a vendor follow their own queue and their own orders', async () => {
    const orderId = await placeOrder(customerA);
    const client = await Client.authenticated(vendorA);

    const subscribed = await client.subscribe([
      `vendor:${world.vendorA.vendorId}`,
      `order:${orderId}`,
    ]);

    expect(subscribed['refused']).toEqual([]);
    expect(subscribed['topics']).toHaveLength(2);
    client.dispose();
  });

  it("refuses a rider another rider's stream", async () => {
    const client = await Client.authenticated(riderA);

    const subscribed = await client.subscribe([
      `rider:${world.riderA.riderId}`,
      `rider:${world.riderB.riderId}`,
    ]);

    expect(subscribed['topics']).toEqual([`rider:${world.riderA.riderId}`]);
    expect(subscribed['refused']).toEqual([
      { topic: `rider:${world.riderB.riderId}`, code: 'not_found' },
    ]);
    client.dispose();
  });

  it('refuses a rider an order they are not carrying', async () => {
    // The rule that stops an unassigned rider learning an order exists at all.
    const orderId = await placeOrder(customerA);
    const client = await Client.authenticated(riderA);

    const subscribed = await client.subscribe([`order:${orderId}`]);
    expect(subscribed['refused']).toEqual([{ topic: `order:${orderId}`, code: 'not_found' }]);
    client.dispose();
  });

  it('binds a dispatcher to the cities they are scoped to', async () => {
    const client = await Client.authenticated(dispatcher);

    const subscribed = await client.subscribe([
      `city:${world.cityId}`,
      'city:someotherplace',
    ]);

    expect(subscribed['topics']).toEqual([`city:${world.cityId}`]);
    expect(subscribed['refused']).toEqual([{ topic: 'city:someotherplace', code: 'not_found' }]);
    client.dispose();
  });

  it('refuses a customer the dispatch board', async () => {
    const client = await Client.authenticated(customerA);
    const subscribed = await client.subscribe([`city:${world.cityId}`]);
    expect(subscribed['refused']).toEqual([{ topic: `city:${world.cityId}`, code: 'not_found' }]);
    client.dispose();
  });

  it.each([
    'order:*',
    'order:',
    'order',
    'order:a:b',
    'order:../../vendor/x',
    '*',
  ])('refuses the crafted topic %s', async (topic) => {
    const client = await Client.authenticated(customerA);
    const subscribed = await client.subscribe([topic]);

    // A malformed name is named as one. It is not an existence oracle: the
    // server refused it without looking anything up.
    expect(subscribed['topics']).toEqual([]);
    expect(subscribed['refused']).toEqual([{ topic, code: 'malformed_topic' }]);
    client.dispose();
  });

  it('always tells a fresh subscription to resync', async () => {
    // There is no history on this stream, so the only correct thing to say to a
    // client that has just subscribed is "read the current state".
    const orderId = await placeOrder(customerA);
    const client = await Client.authenticated(customerA);
    const subscribed = await client.subscribe([`order:${orderId}`]);
    expect(subscribed['resync']).toBe(true);
    client.dispose();
  });
});

describe('delivery', () => {
  it('notifies the customer when the vendor accepts', async () => {
    const orderId = await placeOrder(customerA);
    const client = await Client.authenticated(customerA);
    await client.subscribe([`order:${orderId}`]);

    await acceptOrder(orderId);

    const event = await client.next((frame) => frame.type === 'event');
    expect(event['subject']).toBe(`order:${orderId}`);
    expect(event['topics']).toEqual([`order:${orderId}`]);
    expect(typeof event['version']).toBe('number');
    client.dispose();
  });

  it('carries identifiers and a version — never order data', async () => {
    // The invariant the whole design rests on. If a frame ever carried the
    // order itself, it would bypass every field-level projection rule the HTTP
    // routes enforce — the customer's phone number, the exact drop-off address,
    // the delivery PIN — for every subscriber at once.
    const orderId = await placeOrder(customerA);
    const client = await Client.authenticated(customerA);
    await client.subscribe([`order:${orderId}`]);

    await acceptOrder(orderId);
    const event = await client.next((frame) => frame.type === 'event');

    expect(Object.keys(event).sort()).toEqual([
      'eventId',
      'occurredAt',
      'subject',
      'topics',
      'type',
      'version',
    ]);

    const serialised = JSON.stringify(event);
    for (const leak of ['status', 'total', 'phone', 'address', 'pin', 'customer', 'displayName']) {
      expect(serialised.toLowerCase()).not.toContain(leak.toLowerCase());
    }
    client.dispose();
  });

  it('reaches the vendor queue and the dispatch board from one change', async () => {
    const vendorClient = await Client.authenticated(vendorA);
    const boardClient = await Client.authenticated(dispatcher);
    await vendorClient.subscribe([`vendor:${world.vendorA.vendorId}`]);
    await boardClient.subscribe([`city:${world.cityId}`]);

    const orderId = await placeOrder(customerA);

    // Matched on subject, not "the next event". A vendor queue and a city board
    // legitimately carry every order for that vendor and city, so an order from
    // an earlier test in this file can still be in flight — the relay publishes
    // after the request returns. Taking the first frame would make this test
    // depend on what ran before it.
    const forThisOrder = (frame: Frame): boolean =>
      frame.type === 'event' && frame['subject'] === `order:${orderId}`;

    const vendorEvent = await vendorClient.next(forThisOrder);
    const boardEvent = await boardClient.next(forThisOrder);

    expect(vendorEvent['subject']).toBe(`order:${orderId}`);
    expect(vendorEvent['topics']).toEqual([`vendor:${world.vendorA.vendorId}`]);
    expect(boardEvent['subject']).toBe(`order:${orderId}`);
    expect(boardEvent['topics']).toEqual([`city:${world.cityId}`]);

    vendorClient.dispose();
    boardClient.dispose();
  });

  it('sends one frame naming both topics when a client holds both', async () => {
    // A vendor watching their queue and one order matches twice. Two frames
    // would make the client re-read twice for a single change.
    const orderId = await placeOrder(customerA);
    const client = await Client.authenticated(vendorA);
    await client.subscribe([`vendor:${world.vendorA.vendorId}`, `order:${orderId}`]);

    await acceptOrder(orderId);
    // On subject again: the vendor topic carries other orders too, and one from
    // an earlier test may still be in flight.
    const event = await client.next(
      (frame) => frame.type === 'event' && frame['subject'] === `order:${orderId}`,
    );

    expect(event['topics']).toEqual(
      expect.arrayContaining([`order:${orderId}`, `vendor:${world.vendorA.vendorId}`]),
    );
    expect((event['topics'] as string[]).length).toBe(2);

    // And exactly one frame for that change.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const forThisVersion = client
      .ofType('event')
      .filter((frame) => frame['eventId'] === event['eventId']);
    expect(forThisVersion).toHaveLength(1);
    client.dispose();
  });

  it('does not deliver an order to a client that never subscribed to it', async () => {
    const other = await placeOrder(customerA);
    const client = await Client.authenticated(customerA);
    await client.subscribe([`order:${other}`]);

    // A second order, which this client is not watching.
    const unwatched = await placeOrder(customerA);
    await acceptOrder(unwatched);
    await new Promise((resolve) => setTimeout(resolve, 300));

    for (const event of client.ofType('event')) {
      expect(event['subject']).not.toBe(`order:${unwatched}`);
    }
    client.dispose();
  });

  it('stops delivering after an unsubscribe', async () => {
    const orderId = await placeOrder(customerA);
    const client = await Client.authenticated(customerA);
    await client.subscribe([`order:${orderId}`]);

    client.send({ type: 'unsubscribe', topics: [`order:${orderId}`] });
    await client.next((frame) => frame.type === 'unsubscribed');

    await acceptOrder(orderId);
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(client.ofType('event')).toHaveLength(0);
    client.dispose();
  });

  it('advances the version on every change, so a stale one is recognisable', async () => {
    const orderId = await placeOrder(customerA);
    const client = await Client.authenticated(customerA);
    await client.subscribe([`order:${orderId}`]);

    await acceptOrder(orderId);
    const first = await client.next((frame) => frame.type === 'event');

    await progressOrder(orderId, 'preparing');
    const second = await client.next(
      (frame) => frame.type === 'event' && frame['eventId'] !== first['eventId'],
    );

    // Monotonic, which is what makes `shouldRefresh` able to drop a
    // redelivered older notification without dropping a real newer one.
    expect(second['version'] as number).toBeGreaterThan(first['version'] as number);
    // And the event id is derived from subject and version, so it is stable
    // across redeliveries and unique across changes.
    expect(second['eventId']).toBe(`order:${orderId}@${second['version'] as number}`);
    client.dispose();
  });

  it('delivers one change to many sockets exactly once each', async () => {
    const orderId = await placeOrder(customerA);
    const clients = await Promise.all(
      Array.from({ length: 4 }, () => Client.authenticated(customerA)),
    );
    await Promise.all(clients.map((client) => client.subscribe([`order:${orderId}`])));

    await acceptOrder(orderId);
    await Promise.all(clients.map((client) => client.next((frame) => frame.type === 'event')));
    await new Promise((resolve) => setTimeout(resolve, 200));

    for (const client of clients) {
      expect(client.ofType('event')).toHaveLength(1);
    }
    for (const client of clients) client.dispose();
  });
});

describe('duplicates and redelivery', () => {
  it('collapses a redelivered notification into one frame', async () => {
    const orderId = await placeOrder(customerA);
    const client = await Client.authenticated(customerA);
    await client.subscribe([`order:${orderId}`]);

    await acceptOrder(orderId);
    const event = await client.next((frame) => frame.type === 'event');

    // Republish the identical notification the way an at-least-once relay
    // would after crashing between publishing and marking the row published.
    const replay = {
      eventId: event['eventId'],
      subject: event['subject'],
      topics: event['topics'],
      version: event['version'],
      occurredAt: event['occurredAt'],
    };
    await context.app.services.broadcast.publish(replay);
    await context.app.services.broadcast.publish(replay);
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(client.ofType('event')).toHaveLength(1);
    client.dispose();
  });

  it('discards a broadcast that is not a valid notification', async () => {
    // The broadcast channel is shared infrastructure. Anything that can write
    // to it must not be able to put a frame on somebody's socket.
    const orderId = await placeOrder(customerA);
    const client = await Client.authenticated(customerA);
    await client.subscribe([`order:${orderId}`]);

    for (const rubbish of [
      null,
      'a string',
      { subject: `order:${orderId}` },
      { eventId: 'e', subject: `order:${orderId}`, topics: ['order:*'], version: 1, occurredAt: 1 },
      {
        eventId: 'e',
        subject: `order:${orderId}`,
        topics: [`order:${orderId}`],
        version: -5,
        occurredAt: 1,
      },
    ]) {
      await context.app.services.broadcast.publish(rubbish);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(client.ofType('event')).toHaveLength(0);
    expect(client.closed).toBeNull();
    client.dispose();
  });

  it('does not let a crafted wildcard topic reach a subscriber', async () => {
    const orderId = await placeOrder(customerA);
    const client = await Client.authenticated(customerA);
    await client.subscribe([`order:${orderId}`]);

    // Matching is exact string equality, and the notification is re-parsed on
    // arrival, so neither layer would honour a pattern even if one arrived.
    await context.app.services.broadcast.publish({
      eventId: 'crafted-1',
      subject: 'order:aaaa',
      topics: ['order:*'],
      version: 1,
      occurredAt: Date.now(),
    });
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(client.ofType('event')).toHaveLength(0);
    client.dispose();
  });
});

describe('protocol abuse', () => {
  it('answers an unknown frame type without dropping the socket', async () => {
    // A newer client talking to an older server must survive.
    const client = await Client.authenticated(customerA);
    client.send({ type: 'telepathy' });

    const error = await client.next((frame) => frame.type === 'error');
    expect(error['code']).toBe('unknown_type');
    expect(client.closed).toBeNull();

    // Still usable afterwards.
    client.send({ type: 'ping' });
    await client.next((frame) => frame.type === 'pong');
    client.dispose();
  });

  it('closes a socket sending frames that are not JSON', async () => {
    const client = await Client.authenticated(customerA);
    client.sendRaw('this is not json');
    const closed = await client.waitForClose();
    expect(closed.code).toBe(CLOSE.protocol_violation);
  });

  it('drops an oversized frame without letting it through', async () => {
    const client = await Client.authenticated(customerA);
    client.sendRaw(JSON.stringify({ type: 'ping', pad: 'a'.repeat(MAX_FRAME_BYTES * 2) }));

    // `ws` enforces maxPayload below the application check, so the socket goes
    // either way. What matters is that it closes rather than allocating.
    const closed = await client.waitForClose();
    expect(closed.code).toBeGreaterThanOrEqual(1000);
  });

  it('enforces a frame budget the HTTP rate limiter cannot see', async () => {
    // The upgrade is rate-limited; every frame after it would otherwise be free.
    const client = await Client.authenticated(customerA);
    for (let i = 0; i < 200; i += 1) client.send({ type: 'ping' });

    const closed = await client.waitForClose();
    expect(closed.code).toBe(CLOSE.rate_limited);
  });

  it('caps how many sockets one identity may hold', async () => {
    const clients: Client[] = [];
    try {
      // The harness caps this identity at four.
      for (let i = 0; i < 4; i += 1) clients.push(await Client.authenticated(customerB));

      const extra = await Client.open();
      await extra.next((frame) => frame.type === 'welcome');
      extra.send({ type: 'authenticate', token: customerB.accessToken });

      const closed = await extra.waitForClose();
      expect(closed.code).toBe(CLOSE.rate_limited);
    } finally {
      for (const client of clients) client.dispose();
    }
  });

  it('ignores an unsubscribe for something never held', async () => {
    const client = await Client.authenticated(customerA);
    client.send({ type: 'unsubscribe', topics: ['order:neverheld', 'garbage'] });

    const frame = await client.next((f) => f.type === 'unsubscribed');
    expect(frame['topics']).toEqual([]);
    expect(client.closed).toBeNull();
    client.dispose();
  });
});

describe('reconnect and resume', () => {
  it('tells a reconnecting client to resync rather than replaying a gap', async () => {
    const orderId = await placeOrder(customerA);

    const first = await Client.authenticated(customerA);
    await first.subscribe([`order:${orderId}`]);
    first.dispose();

    // The change happens while nothing is listening. Nothing replays it, and
    // nothing needs to: the state is in the database either way.
    await acceptOrder(orderId);
    await new Promise((resolve) => setTimeout(resolve, 150));

    const second = await Client.authenticated(customerA);
    const subscribed = await second.subscribe([`order:${orderId}`]);

    // The whole resume story: read the current state, then keep listening.
    expect(subscribed['resync']).toBe(true);
    expect(subscribed['topics']).toEqual([`order:${orderId}`]);

    // And it is live again.
    await progressOrder(orderId, 'preparing');
    const event = await second.next((frame) => frame.type === 'event');
    expect(event['subject']).toBe(`order:${orderId}`);
    second.dispose();
  });

  it('clears subscriptions when a socket re-authenticates', async () => {
    // A renewed token may carry different authority, and the ownership checks
    // behind the existing subscriptions are up to an access-token lifetime old.
    const orderId = await placeOrder(customerA);
    const client = await Client.authenticated(customerA);
    await client.subscribe([`order:${orderId}`]);

    client.send({ type: 'authenticate', token: customerA.accessToken });
    const resync = await client.next((frame) => frame.type === 'resync');
    expect(resync['reason']).toBe('reauthenticated');

    // The subscription is genuinely gone, not merely announced as gone.
    await acceptOrder(orderId);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(client.ofType('event')).toHaveLength(0);

    // Resubscribing restores it.
    await client.subscribe([`order:${orderId}`]);
    await progressOrder(orderId, 'preparing');
    await client.next((frame) => frame.type === 'event');
    client.dispose();
  });

  it('frees the subscription when a socket goes away', async () => {
    const orderId = await placeOrder(customerA);
    const client = await Client.authenticated(customerA);
    await client.subscribe([`order:${orderId}`]);
    client.dispose();

    // A change with nobody listening must not throw or leak the connection.
    await new Promise((resolve) => setTimeout(resolve, 150));
    await expect(acceptOrder(orderId)).resolves.toBeUndefined();
  });
});

describe('liveness', () => {
  it('keeps a responsive socket open across many heartbeats', async () => {
    // The server pings every 400ms here and closes a socket that misses a pong.
    // `ws` answers automatically, exactly as a browser does, so a socket that
    // closed during this window would mean the heartbeat is evicting healthy
    // clients — worse than not having one at all.
    const client = await Client.authenticated(customerA);
    await new Promise((resolve) => setTimeout(resolve, 1_600));
    expect(client.closed).toBeNull();

    // And still usable, not merely still open.
    client.send({ type: 'ping' });
    await client.next((frame) => frame.type === 'pong');
    client.dispose();
  });
});

describe('when realtime is switched off', () => {
  // One context for both tests. Building a Fastify instance and copying a
  // database is not free, and doing it per test is what tips a loaded run into
  // starving other suites' workers.
  let disabled: TestContext;
  let disabledUrl = '';

  beforeAll(async () => {
    disabled = await createTestContext({ REALTIME_ENABLED: 'false' }, {}, undefined, {
      revalidateIntervalMs: 0,
    });
    await disabled.app.listen({ port: 0, host: '127.0.0.1' });
    const address = disabled.app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    disabledUrl = `ws://127.0.0.1:${port}/v1/realtime`;
  }, 180_000);

  afterAll(async () => {
    await disabled?.close();
  });

  it('says so in one round trip instead of failing opaquely', async () => {
    // The fallback path. A refused upgrade is indistinguishable from a proxy
    // eating the request, so a client would retry five times before polling; a
    // close code says "this deployment does not do sockets" immediately.
    const socket = new WebSocket(disabledUrl);
    const closed = await new Promise<number>((resolve, reject) => {
      socket.on('close', (code: number) => resolve(code));
      socket.once('error', reject);
    });

    expect(closed).toBe(CLOSE.disabled);
  });

  it('still records notifications, so nothing is lost while it is off', async () => {
    // Turning the endpoint off must not turn the *recording* off: the rows are
    // what a client reads from either way, and a deployment that flips realtime
    // back on should not have a hole in its history.
    const disabledWorld = await buildWorld(disabled.prisma);
    const order = await disabled.prisma.order.create({
      data: {
        code: `OFF-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        customerId: disabledWorld.customerA.customerId,
        vendorId: disabledWorld.vendorA.vendorId,
        branchId: disabledWorld.vendorA.branchId,
        status: 'placed',
        itemsSubtotal: 1_000,
        total: 1_000,
        quoteBreakdown: '{}',
        pricingRuleVersion: 'test.1',
      },
      select: { id: true },
    });

    await disabled.prisma.$transaction((tx) => recordOrderChange(tx, order.id));
    const rows = await disabled.prisma.outboxEvent.count({ where: { name: 'realtime.notify' } });
    expect(rows).toBe(1);
  }, 60_000);
});

describe('session lifetime', () => {
  it('closes a live socket once its session is revoked', async () => {
    // The property that matters: over HTTP, revocation takes effect on the next
    // request, because every request re-reads the session. A socket has no next
    // request. Without the sweep, holding one open would be a way to keep using
    // a session that has been ended — which is exactly the bypass a revocation
    // is meant to close.
    //
    // riderB is used by no other test here, so revoking their session cannot
    // disturb anything running alongside this.
    const victim = await actAs(context, world.riderB.email);
    const client = await Client.authenticated(victim);
    await client.subscribe([`rider:${world.riderB.riderId}`]);

    // Revoked directly, the way an administrator ending a session or the
    // retention sweep expiring one does.
    await context.prisma.session.updateMany({
      where: { identityId: world.riderB.identityId, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    const closed = await client.waitForClose(5_000);
    expect(closed.code).toBe(CLOSE.session_invalid);
  });

  it('refuses a socket authenticating with an already-revoked session', async () => {
    const victim = await actAs(context, world.support.email);
    await context.prisma.session.updateMany({
      where: { identityId: world.support.identityId, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    const client = await Client.open();
    await client.next((frame) => frame.type === 'welcome');
    client.send({ type: 'authenticate', token: victim.accessToken });

    const closed = await client.waitForClose();
    expect(closed.code).toBe(CLOSE.session_invalid);
  });

  it('leaves a healthy socket alone across many sweeps', async () => {
    const orderId = await placeOrder(customerA);
    const client = await Client.authenticated(customerA);
    await client.subscribe([`order:${orderId}`]);

    // Several sweep intervals. A sweep that closed or unsubscribed a valid
    // session would be a far worse bug than one that never ran.
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(client.closed).toBeNull();

    await acceptOrder(orderId);
    await client.next((frame) => frame.type === 'event');
    client.dispose();
  });
});
