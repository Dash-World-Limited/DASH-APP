/**
 * The V1 default: SMS is off.
 *
 * Sign-in is by emailed code and phone numbers are stored unverified. With
 * SMS_ENABLED=false the deployment has no SMS capability: a phone number
 * cannot request a code (answered identically whether or not it has an
 * account), no SMS is attempted, email codes work, and phone verification
 * cannot be switched on while nothing could send the code.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PHONE_VERIFICATION_FLAG } from '@dash/domain/onboarding';
import { createTestContext, type TestContext } from './harness.js';
import { actAs, buildWorld, type Actor, type World } from './world.js';

let context: TestContext;
let world: World;
let admin: Actor;

beforeAll(async () => {
  vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
  context = await createTestContext({ SMS_ENABLED: 'false' });
  world = await buildWorld(context.prisma);
  admin = await actAs(context, world.admin.email);
}, 180_000);

afterAll(async () => {
  await context?.close();
});

const requestCode = (payload: Record<string, string>) =>
  context.app.inject({ method: 'POST', url: '/v1/auth/otp/request', payload });

describe('with SMS off', () => {
  it('refuses a phone number, identically for known and unknown numbers', async () => {
    const known = await requestCode({ phone: world.customerA.phone });
    const unknown = await requestCode({ phone: '+2348099999999' });
    expect(known.statusCode).toBe(400);
    expect(unknown.statusCode).toBe(400);
    expect(known.json<{ error: { message: string } }>().error.message).toBe(
      unknown.json<{ error: { message: string } }>().error.message,
    );
    // Nothing was issued for the known number.
    expect(await context.prisma.otpChallenge.count({ where: { destination: world.customerA.phone } })).toBe(0);
  });

  it('still sends sign-in codes by email', async () => {
    const response = await requestCode({ email: world.customerA.email });
    expect(response.statusCode).toBe(200);
    expect(await context.prisma.otpChallenge.count({ where: { destination: world.customerA.email, channel: 'email' } })).toBe(1);
  });

  it('will not let phone verification be required while no SMS can be sent', async () => {
    await context.prisma.featureFlag.create({ data: { key: PHONE_VERIFICATION_FLAG, isEnabled: false } });
    const response = await context.app.inject({
      method: 'PATCH',
      url: `/v1/admin/feature-flags/${PHONE_VERIFICATION_FLAG}`,
      headers: admin.headers,
      payload: { isEnabled: true },
    });
    expect(response.statusCode).toBe(409);
    expect((await context.prisma.featureFlag.findUniqueOrThrow({ where: { key: PHONE_VERIFICATION_FLAG } })).isEnabled).toBe(false);
  });

  it('never describes a phone as verified', async () => {
    const customer = await actAs(context, world.customerA.email);
    const me = await context.app.inject({ method: 'GET', url: '/v1/auth/me', headers: customer.headers });
    expect(me.json<{ phone: { verification: string; required: boolean } }>().phone).toMatchObject({
      verification: 'unverified',
      required: false,
    });
  });
});
