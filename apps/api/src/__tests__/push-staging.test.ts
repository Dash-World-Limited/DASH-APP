/**
 * A staging deployment notifies the staging app build and nothing else, and
 * a tester can ask for a test notification to their own phones.
 *
 * Runs an API configured as staging is: `PUSH_APP_IDS` names only
 * `com.dashworldng.dash.staging`. The push provider is a spy, so these are
 * claims about what DASH would hand to Firebase.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PushReceipt } from '@dash/domain/ports';

import { createTestContext, type TestContext } from './harness.js';
import { actAs, buildWorld, idempotencyKey, type Actor, type World } from './world.js';
import { useIntegrationTimeouts } from './timeouts.js';
import { deliverPushIntent } from '../push/notify.js';

useIntegrationTimeouts();

const STAGING = 'com.dashworldng.dash.staging';
const PRODUCTION = 'com.dashworldng.dash';

interface Sent {
  deviceTokens: readonly string[];
  title: string;
  data?: Readonly<Record<string, string>> | undefined;
}

let context: TestContext;
let world: World;
let customerA: Actor;
let customerB: Actor;
let sent: Sent[] = [];
let nextReceipt: PushReceipt | null = null;

beforeAll(async () => {
  context = await createTestContext({ PUSH_APP_IDS: STAGING });
  world = await buildWorld(context.prisma);
  customerA = await actAs(context, world.customerA.email);
  customerB = await actAs(context, world.customerB.email);
}, 180_000);

afterAll(async () => {
  await context?.close();
});

beforeEach(() => {
  sent = [];
  nextReceipt = null;
  vi.spyOn(context.app.services.push, 'send').mockImplementation(async (input: Sent) => {
    sent.push(input);
    const receipt = nextReceipt ?? { accepted: true, providerMessageId: 'spy' };
    nextReceipt = null;
    return receipt;
  });
});

let counter = 0;
const token = (label: string) => `fcm-${label}-${Date.now()}-${(counter += 1)}-${'s'.repeat(24)}`;

const register = (actor: Actor, body: Record<string, unknown>) =>
  context.app.inject({ method: 'POST', url: '/v1/devices', headers: actor.headers, payload: { platform: 'android', ...body } });

const testPush = (actor: Actor | null, payload: object = {}) =>
  context.app.inject({ method: 'POST', url: '/v1/devices/test', ...(actor ? { headers: actor.headers } : {}), payload });

const to = (deviceToken: string) => sent.filter((push) => push.deviceTokens.includes(deviceToken));

describe('only the staging app build can register', () => {
  it('registers the staging build and records which build it is', async () => {
    const phone = token('staging');
    expect((await register(customerA, { pushToken: phone, appId: STAGING })).statusCode).toBe(200);
    const device = await context.prisma.device.findUniqueOrThrow({ where: { pushToken: phone }, select: { appId: true, identityId: true } });
    expect(device).toEqual({ appId: STAGING, identityId: world.customerA.identityId });
  });

  it('refuses the production build, an unknown build, and a client that does not say', async () => {
    for (const body of [{ appId: PRODUCTION }, { appId: 'ng.dashapp.test' }, {}]) {
      const phone = token('refused');
      const response = await register(customerA, { pushToken: phone, ...body });
      expect(response.statusCode, JSON.stringify(body)).toBe(403);
      expect(response.json<{ error: { message: string } }>().error.message).toMatch(/cannot receive notifications from this DASH service/);
      expect(await context.prisma.device.count({ where: { pushToken: phone } })).toBe(0);
    }
  });

  it('refuses an app id that is not an application id', async () => {
    expect((await register(customerA, { pushToken: token('bad'), appId: 'staging app' })).statusCode).toBe(400);
  });
});

describe('a staging API never sends to another build', () => {
  it('skips a production-build phone even if one is on file, and reaches the staging phone', async () => {
    const stagingPhone = token('reach');
    await register(customerB, { pushToken: stagingPhone, appId: STAGING });
    // A row as an older API, or a mistake, might have left it.
    const productionPhone = token('production');
    await context.prisma.device.create({
      data: { identityId: world.customerB.identityId, platform: 'android', pushToken: productionPhone, appId: PRODUCTION },
    });

    const order = await context.app.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: { ...customerB.headers, 'idempotency-key': idempotencyKey('staging-push') },
      payload: {
        branchId: world.vendorA.branchId,
        items: [{ itemId: world.vendorA.itemId, quantity: 1, modifierIds: [world.vendorA.modifierId] }],
        mode: 'delivery',
        addressId: world.customerB.addressId,
        paymentMethod: 'card',
      },
    });
    const orderId = order.json<{ order: { id: string } }>().order.id;

    await deliverPushIntent(
      context.prisma,
      context.app.services.push,
      { kind: 'payment_update', orderId, outcome: 'refund_completed', refundId: `staging_${orderId}` },
      { appIds: [STAGING] },
    );
    expect(to(stagingPhone)).toHaveLength(1);
    expect(to(productionPhone)).toHaveLength(0);
  });
});

describe('a test notification', () => {
  it('goes only to the caller’s own phones, says which provider sent it, and is audited', async () => {
    const mine = token('test-mine');
    const theirs = token('test-theirs');
    await register(customerA, { pushToken: mine, appId: STAGING });
    await register(customerB, { pushToken: theirs, appId: STAGING });

    const response = await testPush(customerA);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ queued: false, sent: true, provider: 'console', live: false });
    expect(to(mine)).toHaveLength(1);
    expect(to(mine)[0]).toMatchObject({ title: 'DASH test notification', data: { type: 'test' } });
    expect(to(theirs)).toHaveLength(0);
    expect(await context.prisma.auditLog.count({ where: { action: 'push.test_requested', identityId: world.customerA.identityId } })).toBeGreaterThanOrEqual(1);
  });

  it('arrives after the delay asked for, so the app can be closed first', async () => {
    const phone = token('test-delay');
    await register(customerA, { pushToken: phone, appId: STAGING });
    const response = await testPush(customerA, { delaySeconds: 1 });
    expect(response.json()).toMatchObject({ queued: true, delaySeconds: 1, provider: 'console' });
    expect(to(phone)).toHaveLength(0);
    await vi.waitFor(() => expect(to(phone)).toHaveLength(1), { timeout: 5_000 });
  });

  it('reaches a phone whose owner switched notifications off — they asked for it', async () => {
    const phone = token('test-off');
    await register(customerA, { pushToken: phone, appId: STAGING, notifications: 'off' });
    expect((await testPush(customerA)).json()).toMatchObject({ sent: true });
    expect(to(phone)).toHaveLength(1);
  });

  it('reports Firebase’s refusal codes, never a token', async () => {
    await register(customerA, { pushToken: token('test-refused'), appId: STAGING });
    nextReceipt = { accepted: false, providerMessageId: undefined, failureReason: '0 of 1 delivered — messaging/third-party-auth-error ×1', invalidTokens: [] };
    const response = await testPush(customerA);
    expect(response.json()).toMatchObject({ sent: false, reason: '0 of 1 delivered — messaging/third-party-auth-error ×1' });
    expect(response.body).not.toMatch(/fcm-/);
  });

  it('says so when no phone is registered, and is for signed-in people only', async () => {
    const stranger = await actAs(context, world.riderB.email);
    const none = await testPush(stranger);
    expect(none.statusCode).toBe(409);
    expect(none.json<{ error: { message: string } }>().error.message).toMatch(/No phone is registered/);
    expect((await testPush(null)).statusCode).toBe(401);
    expect((await testPush(customerA, { delaySeconds: 600 })).statusCode).toBe(400);
    expect((await testPush(customerA, { delaySeconds: 1, to: world.customerB.identityId })).statusCode).toBe(400);
  });
});
