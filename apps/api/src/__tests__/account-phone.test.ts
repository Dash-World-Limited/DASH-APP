import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './harness.js';
import { actAs, buildWorld, type Actor } from './world.js';
let context: TestContext;
let owner: Actor;
let other: Actor;
let ownerId: string;
let otherId: string;
beforeAll(async () => {
  context = await createTestContext({ DEPLOYMENT_PROFILE: 'declutters' });
  const world = await buildWorld(context.prisma);
  owner = await actAs(context, world.customerA.email);
  other = await actAs(context, world.customerB.email);
  ownerId = (await context.app.inject({ method: 'GET', url: '/v1/auth/me', headers: owner.headers })).json().identity.id;
  otherId = (await context.app.inject({ method: 'GET', url: '/v1/auth/me', headers: other.headers })).json().identity.id;
});
afterAll(async () => { await context?.close(); });
const save = (phone: string, headers = owner.headers, extra = {}) => context.app.inject({ method: 'PATCH', url: '/v1/account/phone', headers, payload: { phone, ...extra } });

it('requires authentication and rejects noncanonical or invalid numbers', async () => {
  expect((await save('+447400123456', {})).statusCode).toBe(401);
  for (const phone of ['07400123456', '+440000000000', '+4474001']) {
    expect((await save(phone)).statusCode).toBe(400);
  }
});

it('updates only the caller’s canonical identity and leaves private KYC evidence unchanged', async () => {
  const seller = await context.prisma.declutterSeller.create({ data: { customerId: (await context.prisma.customer.findUniqueOrThrow({ where: { identityId: ownerId } })).id, displayName: 'Ada', phoneE164: '+2348012345678', kycStatus: 'verified' } });
  const otherBefore = await context.prisma.identity.findUniqueOrThrow({ where: { id: otherId } });
  expect((await save('+447400123456')).statusCode).toBe(200);
  expect((await context.prisma.identity.findUniqueOrThrow({ where: { id: ownerId } })).phone).toBe('+447400123456');
  expect((await context.prisma.identity.findUniqueOrThrow({ where: { id: otherId } })).phone).toBe(otherBefore.phone);
  expect((await context.prisma.declutterSeller.findUniqueOrThrow({ where: { id: seller.id } })).phoneE164).toBe('+2348012345678');
  const me = (await context.app.inject({ method: 'GET', url: '/v1/auth/me', headers: owner.headers })).json();
  expect(me.identity.phone).toBe('+447400123456');
  expect(me.phone.verification).toBe('unverified');
  const audit = await context.prisma.auditLog.findFirstOrThrow({ where: { action: 'account.phone.updated', identityId: ownerId } });
  expect(JSON.stringify(audit)).not.toContain('+447400123456');
});

it('does not permit unproved number changes when SMS sign-in is enabled', async () => {
  const smsContext = await createTestContext({ DEPLOYMENT_PROFILE: 'full' });
  try {
    const world = await buildWorld(smsContext.prisma);
    const actor = await actAs(smsContext, world.customerA.email);
    const response = await smsContext.app.inject({ method: 'PATCH', url: '/v1/account/phone', headers: actor.headers, payload: { phone: '+447400123456' } });
    expect(response.statusCode).toBe(403);
  } finally { await smsContext.close(); }
});

it('prevents duplicate numbers, targeting another identity, and private KYC writes', async () => {
  expect((await save('+447400123456', other.headers)).statusCode).toBe(409);
  expect((await save('+447400123457', other.headers, { identityId: ownerId, phoneVerifiedAt: new Date().toISOString() })).statusCode).toBe(400);
});
