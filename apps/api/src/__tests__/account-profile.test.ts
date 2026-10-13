/**
 * Personal details: read and edit the caller's own name, state and city/area,
 * through the same columns sign-up writes. Email is never editable here, and
 * nothing outside the caller's own identity and customer rows can be touched.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './harness.js';
import { actAs, buildWorld, type Actor, type World } from './world.js';

let context: TestContext;
let world: World;
let customer: Actor;
let otherCustomer: Actor;
let rider: Actor;

beforeAll(async () => {
  // Email-only sign-in, as V1 runs: the phone route accepts changes.
  context = await createTestContext({ SMS_ENABLED: 'false' });
  world = await buildWorld(context.prisma);
  customer = await actAs(context, world.customerA.email);
  otherCustomer = await actAs(context, world.customerB.email);
  rider = await actAs(context, world.riderA.email);
}, 180_000);

afterAll(async () => {
  await context?.close();
});

const read = (headers: Record<string, string>) => context.app.inject({ method: 'GET', url: '/v1/account/profile', headers });
const save = (payload: unknown, headers: Record<string, string> = customer.headers) =>
  context.app.inject({ method: 'PATCH', url: '/v1/account/profile', headers, payload: payload as Record<string, unknown> });

describe('GET /v1/account/profile', () => {
  it('requires a session', async () => {
    expect((await read({})).statusCode).toBe(401);
  });

  it('returns the caller’s own details and says what may be edited', async () => {
    const response = await read(customer.headers);
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const body = response.json();
    expect(body.profile.email).toBe(world.customerA.email);
    expect(body.profile.phone).toBe(world.customerA.phone);
    expect(body.editable).toEqual({ name: true, phone: true, location: true });
    // Nothing internal leaks: no ids, hashes, roles or flags.
    expect(Object.keys(body.profile).sort()).toEqual(['cityArea', 'email', 'name', 'phone', 'phoneNotice', 'state']);
  });

  it('gives a rider the same details: signing in gave them a customer account', async () => {
    const body = (await read(rider.headers)).json();
    expect(body.profile.email).toBe(world.riderA.email);
    expect(body.editable).toEqual({ name: true, phone: true, location: true });
  });

  it('does not offer a phone edit when SMS sign-in is on, because the phone route would refuse it', async () => {
    const smsContext = await createTestContext();
    try {
      const smsWorld = await buildWorld(smsContext.prisma);
      const actor = await actAs(smsContext, smsWorld.customerA.email);
      const body = (await smsContext.app.inject({ method: 'GET', url: '/v1/account/profile', headers: actor.headers })).json();
      expect(body.editable).toEqual({ name: true, phone: false, location: true });
    } finally {
      await smsContext.close();
    }
  }, 180_000);
});

describe('PATCH /v1/account/profile', () => {
  it('requires a session', async () => {
    expect((await save({ name: 'Nobody' }, {})).statusCode).toBe(401);
  });

  it('updates the caller’s name, state and city/area, and only theirs', async () => {
    const before = await context.prisma.identity.findUniqueOrThrow({ where: { id: world.customerB.identityId } });
    const response = await save({ name: '  Adaeze Okonkwo ', state: 'Delta', cityArea: 'Asaba' });
    expect(response.statusCode).toBe(200);

    const identity = await context.prisma.identity.findUniqueOrThrow({ where: { id: world.customerA.identityId } });
    const row = await context.prisma.customer.findUniqueOrThrow({ where: { id: world.customerA.customerId } });
    expect(identity.displayName).toBe('Adaeze Okonkwo');
    expect(row.state).toBe('Delta');
    expect(row.cityArea).toBe('Asaba');
    expect((await context.prisma.identity.findUniqueOrThrow({ where: { id: world.customerB.identityId } })).displayName).toBe(before.displayName);

    // /v1/auth/me reads the same column, so the app's header updates too.
    const me = (await context.app.inject({ method: 'GET', url: '/v1/auth/me', headers: customer.headers })).json();
    expect(me.identity.displayName).toBe('Adaeze Okonkwo');
    const profile = (await read(customer.headers)).json().profile;
    expect(profile).toMatchObject({ name: 'Adaeze Okonkwo', state: 'Delta', cityArea: 'Asaba' });
  });

  it('records which fields changed, never their values', async () => {
    await save({ cityArea: 'Okpanam' });
    const audit = await context.prisma.auditLog.findFirstOrThrow({
      where: { action: 'account.profile.updated', identityId: world.customerA.identityId },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit.after).toContain('cityArea');
    expect(audit.after).not.toContain('Okpanam');
  });

  it('applies sign-up’s validation', async () => {
    for (const payload of [{ name: 'A' }, { name: 'x'.repeat(81) }, { state: 'Atlantis' }, { cityArea: ' ' }, {}]) {
      expect((await save(payload)).statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  it('refuses fields it does not own: email, phone, ids, roles', async () => {
    for (const payload of [
      { email: 'new@dashapp.test' },
      { phone: '+2348000000000' },
      { identityId: world.customerB.identityId, name: 'Hijack' },
      { roles: ['admin'] },
    ]) {
      expect((await save(payload)).statusCode, JSON.stringify(payload)).toBe(400);
    }
    const identity = await context.prisma.identity.findUniqueOrThrow({ where: { id: world.customerA.identityId } });
    expect(identity.email).toBe(world.customerA.email);
    expect((await context.prisma.identity.findUniqueOrThrow({ where: { id: world.customerB.identityId } })).displayName).not.toBe('Hijack');
  });

  it('lets a rider edit their own details', async () => {
    expect((await save({ name: 'Rider Renamed', state: 'Lagos', cityArea: 'Yaba' }, rider.headers)).statusCode).toBe(200);
    expect((await context.prisma.identity.findUniqueOrThrow({ where: { id: world.riderA.identityId } })).displayName).toBe('Rider Renamed');
    expect((await read(rider.headers)).json().profile).toMatchObject({ name: 'Rider Renamed', state: 'Lagos', cityArea: 'Yaba' });
  });

  it('keeps another customer’s session working on their own row', async () => {
    expect((await save({ name: 'Customer Bee' }, otherCustomer.headers)).statusCode).toBe(200);
    expect((await context.prisma.identity.findUniqueOrThrow({ where: { id: world.customerA.identityId } })).displayName).toBe('Adaeze Okonkwo');
  });
});
