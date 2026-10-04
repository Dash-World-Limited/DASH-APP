/**
 * A step-up code elevates only the session of the identity it was sent to.
 *
 * Step-up is what stands between a borrowed session and account deletion,
 * data export and payout changes. The code must therefore prove the person
 * holding the session also holds that account's inbox — not *an* inbox.
 *
 * Regression test: the verify route used to accept any unexpired step-up code
 * for the destination given, then elevate whichever session presented it. A
 * holder of a borrowed session could request a code to their own address and
 * elevate the victim's session with it.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestContext, type TestContext } from './harness.js';
import { actAs, buildWorld, type Actor, type World } from './world.js';

let context: TestContext;
let world: World;
let victim: Actor;
let attacker: Actor;

beforeAll(async () => {
  vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
  context = await createTestContext();
  world = await buildWorld(context.prisma);
  victim = await actAs(context, world.customerA.email);
  attacker = await actAs(context, world.customerB.email);
}, 180_000);

afterAll(async () => {
  await context?.close();
});

/** The harness exposes the code in non-production responses (DEV_EXPOSE_OTP). */
async function stepUpCodeFor(email: string, as: Actor): Promise<string> {
  const response = await context.app.inject({
    method: 'POST',
    url: '/v1/auth/otp/request',
    headers: as.headers,
    payload: { email, purpose: 'step_up' },
  });
  const code = response.json<{ devCode?: string }>().devCode;
  if (!code) throw new Error(`no code issued: ${response.statusCode} ${response.body}`);
  return code;
}

const steppedUp = async (identityId: string) =>
  (await context.prisma.session.findMany({ where: { identityId, revokedAt: null }, select: { steppedUpAt: true } })).some(
    (session) => session.steppedUpAt !== null,
  );

describe('step-up by emailed code', () => {
  it('refuses a code sent to someone else’s address, and leaves the session unelevated', async () => {
    const code = await stepUpCodeFor(world.customerB.email, attacker);

    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/otp/verify',
      headers: victim.headers,
      payload: { email: world.customerB.email, code, purpose: 'step_up' },
    });

    expect(response.statusCode).toBe(400);
    expect(await steppedUp(world.customerA.identityId)).toBe(false);
  });

  it('elevates the session when the code was sent to that account’s own address', async () => {
    const code = await stepUpCodeFor(world.customerA.email, victim);
    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/otp/verify',
      headers: victim.headers,
      payload: { email: world.customerA.email, code, purpose: 'step_up' },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<{ steppedUp: boolean }>().steppedUp).toBe(true);
    expect(await steppedUp(world.customerA.identityId)).toBe(true);
  });

  it('needs a session at all', async () => {
    const code = await stepUpCodeFor(world.customerB.email, attacker);
    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/otp/verify',
      payload: { email: world.customerB.email, code, purpose: 'step_up' },
    });
    expect(response.statusCode).toBe(401);
  });
});
