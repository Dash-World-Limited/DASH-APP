/**
 * What one identity is allowed to be.
 *
 * DASH has a single consumer identity. A person signs in once, is a Customer,
 * and — only if their rider profile has been approved — may switch that same
 * session into Rider mode. There is no second account and no second login, so
 * the client needs to know two different things about the caller: whether a
 * rider profile exists, and whether it is allowed to work.
 *
 * Those are not the same question, and conflating them is the failure this
 * suite exists to prevent. A pending, suspended or rejected rider still has a
 * `riderId`; treating its presence as permission would offer Rider mode to
 * someone the server will refuse at every turn, which reads to the rider as a
 * broken app rather than as an unapproved account.
 *
 * `riderStatus` is therefore returned so the app can *hide* an option it would
 * not be allowed to use — never so it can grant one. The tests below assert
 * both halves: that the field reports the truth, and that the server enforces
 * the same rule independently of anything the client believes.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './harness.js';
import { actAs, buildWorld, type Actor, type World } from './world.js';
import { useIntegrationTimeouts } from './timeouts.js';

useIntegrationTimeouts();

let context: TestContext;
let world: World;
let customerA: Actor;
let riderA: Actor;

beforeAll(async () => {
  context = await createTestContext();
  world = await buildWorld(context.prisma);
  customerA = await actAs(context, world.customerA.email);
  riderA = await actAs(context, world.riderA.email);
}, 180_000);

afterAll(async () => {
  await context?.close();
});

interface MePayload {
  roles: string[];
  customerId: string | null;
  riderId: string | null;
  riderStatus: 'pending' | 'approved' | 'suspended' | 'rejected' | null;
}

const me = async (actor: Actor): Promise<MePayload> => {
  const response = await context.app.inject({
    method: 'GET',
    url: '/v1/auth/me',
    headers: actor.headers,
  });
  expect(response.statusCode).toBe(200);
  return response.json<MePayload>();
};

const setRiderStatus = async (status: string): Promise<void> => {
  await context.prisma.rider.update({
    where: { id: world.riderA.riderId },
    data: { status },
  });
};

describe('one identity, two capabilities', () => {
  afterAll(async () => {
    await setRiderStatus('approved');
  });

  it('reports an approved rider as both a customer and a rider at once', async () => {
    // The whole architecture in one assertion: a single identity carrying a
    // customer profile, a rider profile, approval to work, and both roles —
    // with no second account and no second session anywhere in sight.
    const payload = await me(riderA);

    expect(payload.customerId).not.toBeNull();
    expect(payload.riderId).not.toBeNull();
    expect(payload.riderStatus).toBe('approved');
    expect(payload.roles).toContain('customer');
    expect(payload.roles).toContain('rider');
  });

  it('reports a customer-only account as having no rider capability', async () => {
    const payload = await me(customerA);

    expect(payload.customerId).not.toBeNull();
    expect(payload.riderId).toBeNull();
    expect(payload.riderStatus).toBeNull();
  });

  it('does not treat the presence of a rider profile as approval', async () => {
    // The reason `riderStatus` exists. `riderId` stays populated through every
    // one of these, so a client gating on it would offer rider mode to an
    // account the server refuses.
    for (const status of ['pending', 'suspended', 'rejected'] as const) {
      await setRiderStatus(status);
      const payload = await me(riderA);

      expect(payload.riderId, status).not.toBeNull();
      expect(payload.riderStatus, status).toBe(status);
    }
  });
});

describe('the server is the authority, whatever the client believes', () => {
  afterAll(async () => {
    await setRiderStatus('approved');
  });

  it('refuses every rider route to a customer-only account', async () => {
    // No client-side mode, however it is stored or forged, can produce a rider
    // session.
    //
    // These refuse with 403 rather than 404, and that is the right answer
    // here: the caller is missing the rider capability itself, which discloses
    // nothing about any particular record. The 404 rule guards *ownership* —
    // one rider probing another rider's delivery by id — and is asserted in
    // dispatch.test.ts, where a record exists to be hidden.
    for (const route of [
      { method: 'GET' as const, url: '/v1/rider/offers' },
      { method: 'GET' as const, url: '/v1/rider/deliveries' },
      { method: 'POST' as const, url: '/v1/rider/availability', payload: { availability: 'idle' } },
      {
        method: 'POST' as const,
        url: '/v1/rider/location',
        payload: { latitude: 6.5, longitude: 3.4 },
      },
    ]) {
      const response = await context.app.inject({
        method: route.method,
        url: route.url,
        headers: customerA.headers,
        ...(route.payload ? { payload: route.payload } : {}),
      });
      expect(response.statusCode, route.url).toBe(403);
      // Whatever the status, the one thing that must never happen is success.
      expect(response.statusCode, route.url).not.toBe(200);
    }
  });

  it('refuses to let a suspended rider go online', async () => {
    // The case a remembered client-side mode cannot survive: an account that
    // was approved when the app last hydrated and is not any more. Whatever
    // the app shows, the server stops the work.
    await setRiderStatus('suspended');

    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/rider/availability',
      headers: riderA.headers,
      payload: { availability: 'idle' },
    });

    expect(response.statusCode).toBeGreaterThanOrEqual(400);
  });
});
