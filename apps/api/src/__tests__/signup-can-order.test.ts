/**
 * A person who signs up through the real form can actually order.
 *
 * Regression: signup created the Customer profile but never the `customer`
 * role, and every consumer permission comes from the role. A real signup
 * could sign in and browse but got 403 saving an address or placing an
 * order. The fixtures create the role directly, so no suite saw it; the
 * end-to-end run against a live API did. These tests go through the signup
 * and sign-in routes only.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestContext, type TestContext } from './harness.js';
import { buildWorld, idempotencyKey, type World } from './world.js';

let context: TestContext;
let world: World;
let counter = 0;

beforeAll(async () => {
  vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
  context = await createTestContext();
  world = await buildWorld(context.prisma);
}, 180_000);

afterAll(async () => {
  await context?.close();
});

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function signUpAndVerify(): Promise<{ token: string; email: string; identityId: string }> {
  counter += 1;
  const email = `new-customer-${counter}-${Date.now()}@dashapp.test`;
  const signup = await context.app.inject({
    method: 'POST',
    url: '/v1/auth/signup',
    payload: {
      name: 'New Customer',
      email,
      phone: `+23480${String(Date.now()).slice(-7)}${counter}`,
      state: 'Lagos',
      cityArea: 'Lekki',
      usageIntent: 'mainly_buying',
      acquisitionSource: 'social_media',
      confirmedAdult: true,
      acceptedTerms: true,
    },
  });
  expect(signup.statusCode, signup.body).toBe(200);
  const code = signup.json<{ devCode: string }>().devCode;
  const verified = await context.app.inject({ method: 'POST', url: '/v1/auth/email/verify', payload: { email, code } });
  expect(verified.statusCode, verified.body).toBe(200);
  const identity = await context.prisma.identity.findUniqueOrThrow({ where: { email }, select: { id: true } });
  return { token: verified.json<{ accessToken: string }>().accessToken, email, identityId: identity.id };
}

async function saveAddress(token: string) {
  return context.app.inject({
    method: 'POST',
    url: '/v1/addresses',
    headers: bearer(token),
    payload: { line1: '1 Test Street', contactPhone: '+2348031234567', latitude: 6.5, longitude: 3.4, isDefault: true },
  });
}

async function signInByCode(email: string): Promise<string> {
  const requested = await context.app.inject({ method: 'POST', url: '/v1/auth/otp/request', payload: { email } });
  const code = requested.json<{ devCode: string }>().devCode;
  const verified = await context.app.inject({ method: 'POST', url: '/v1/auth/otp/verify', payload: { email, code } });
  return verified.json<{ accessToken: string }>().accessToken;
}

describe('a real signup', () => {
  it('can save an address and place an order', async () => {
    const { token } = await signUpAndVerify();
    const address = await saveAddress(token);
    expect(address.statusCode, address.body).toBe(200);

    const order = await context.app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: { ...bearer(token), 'idempotency-key': idempotencyKey('signup-order') },
      payload: {
        branchId: world.vendorA.branchId,
        items: [{ itemId: world.vendorA.itemId, quantity: 1, modifierIds: [world.vendorA.modifierId] }],
        mode: 'delivery',
        addressId: address.json<{ address: { id: string } }>().address.id,
        paymentMethod: 'card',
      },
    });
    expect(order.statusCode, order.body).toBe(200);
  });

  it('holds the customer role exactly once', async () => {
    const { identityId } = await signUpAndVerify();
    expect(await context.prisma.identityRole.count({ where: { identityId, role: 'customer' } })).toBe(1);
  });
});

describe('an account verified before signup granted the role', () => {
  it('receives it at its next code sign-in, and can then order', async () => {
    const { email, identityId } = await signUpAndVerify();
    // Recreate the state such accounts are in: profile, no role.
    await context.prisma.identityRole.deleteMany({ where: { identityId, role: 'customer' } });

    const token = await signInByCode(email);
    expect((await saveAddress(token)).statusCode).toBe(200);
    expect(await context.prisma.identityRole.count({ where: { identityId, role: 'customer' } })).toBe(1);

    // Signing in again does not add a second one.
    await signInByCode(email);
    expect(await context.prisma.identityRole.count({ where: { identityId, role: 'customer' } })).toBe(1);
  });

  it('is never given to an identity without a customer profile', async () => {
    const email = `staff-only-${Date.now()}@dashapp.test`;
    const staff = await context.prisma.identity.create({
      data: { email, emailVerifiedAt: new Date(), displayName: 'Staff Only', roles: { create: { role: 'support_agent' } } },
    });
    await signInByCode(email);
    expect(await context.prisma.identityRole.count({ where: { identityId: staff.id, role: 'customer' } })).toBe(0);
  });
});
