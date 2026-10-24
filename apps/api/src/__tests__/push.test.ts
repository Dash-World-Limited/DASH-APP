/**
 * Who a push token belongs to, and what a notification is allowed to say.
 *
 * A push token is a capability to interrupt someone's phone. Two properties
 * make it safe, and both are adversarial rather than incidental:
 *
 *   1. A token belongs to exactly one identity at a time, and registering it
 *      moves it rather than sharing it. The failure this prevents is a rider
 *      signing out of a borrowed handset and continuing to receive their offers
 *      on it while somebody else uses the phone.
 *   2. A payload carries identifiers and nothing else. It travels through
 *      Google's infrastructure and lands on a lock screen, so a customer's
 *      name, address or order has no business in it.
 *
 * The identity is always taken from the session. There is no request shape in
 * which a client can name a different one, and the tests below try.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertNoPersonalData, riderOfferNotification, PushPayloadError } from '@dash/domain/push';

import { createTestContext, type TestContext } from './harness.js';
import { actAs, buildWorld, type Actor, type World } from './world.js';
import { useIntegrationTimeouts } from './timeouts.js';
import {
  forgetInvalidTokens,
  revokeAllDeviceTokens,
  revokeDeviceToken,
} from '../push/registration.js';
import { sendToRider } from '../push/send.js';

useIntegrationTimeouts();

let context: TestContext;
let world: World;
let riderA: Actor;
let customerA: Actor;

beforeAll(async () => {
  context = await createTestContext();
  world = await buildWorld(context.prisma);
  riderA = await actAs(context, world.riderA.email);
  customerA = await actAs(context, world.customerA.email);
}, 180_000);

afterAll(async () => {
  await context?.close();
});

let counter = 0;
const uniqueToken = (): string => `fcm-token-${Date.now()}-${(counter += 1)}-${'x'.repeat(20)}`;

const register = (actor: Actor, body: Record<string, unknown>) =>
  context.app.inject({
    method: 'POST',
    url: '/v1/devices',
    headers: actor.headers,
    payload: body,
  });

// ---------------------------------------------------------------------------
describe('a push token belongs to one identity at a time', () => {
  it('registers a token to the signed-in identity', async () => {
    const token = uniqueToken();
    const response = await register(riderA, { pushToken: token, platform: 'android' });

    expect(response.statusCode).toBe(200);

    const device = await context.prisma.device.findUnique({
      where: { pushToken: token },
      select: { identityId: true, platform: true },
    });
    expect(device?.identityId).toBe(world.riderA.identityId);
    expect(device?.platform).toBe('android');
  });

  it('is idempotent — re-registering the same token changes no ownership', async () => {
    // Clients register on sign-in, on resume and on every token rotation, so
    // this runs far more often than it changes anything.
    const token = uniqueToken();
    await register(riderA, { pushToken: token, platform: 'android' });
    await register(riderA, { pushToken: token, platform: 'android', appVersion: '1.2.3' });

    const devices = await context.prisma.device.findMany({ where: { pushToken: token } });
    expect(devices).toHaveLength(1);
    expect(devices[0]?.identityId).toBe(world.riderA.identityId);
    expect(devices[0]?.appVersion).toBe('1.2.3');
  });

  it('moves a token to the new owner instead of sharing it', async () => {
    // The borrowed-handset case. The rider signs out, the customer signs in on
    // the same phone, and the phone presents the same token it always had.
    const token = uniqueToken();
    await register(riderA, { pushToken: token, platform: 'android' });
    const takeover = await register(customerA, { pushToken: token, platform: 'android' });

    expect(takeover.statusCode).toBe(200);

    // Exactly one row holds it, and it is the new signer-in. If both identities
    // could hold a claim, the previous rider's offers would keep arriving on a
    // phone they no longer have.
    const devices = await context.prisma.device.findMany({ where: { pushToken: token } });
    expect(devices).toHaveLength(1);
    expect(devices[0]?.identityId).toBe(world.customerA.identityId);

    // And the old owner has no live token left behind under a second row.
    const stillRiders = await context.prisma.device.findMany({
      where: { identityId: world.riderA.identityId, pushToken: token },
    });
    expect(stillRiders).toHaveLength(0);
  });

  it('drops device trust when the token changes hands', async () => {
    const token = uniqueToken();
    await register(riderA, { pushToken: token, platform: 'android' });
    await context.prisma.device.update({
      where: { pushToken: token },
      data: { trustedAt: new Date() },
    });

    await register(customerA, { pushToken: token, platform: 'android' });

    // Trust was earned by the previous signed-in identity, not by the hardware.
    const device = await context.prisma.device.findUnique({ where: { pushToken: token } });
    expect(device?.trustedAt).toBeNull();
  });

  it('ignores an identityId supplied by the client', async () => {
    // The forged-ownership attempt. The field is not in the schema, so it is
    // stripped rather than honoured — the token must land on the caller.
    const token = uniqueToken();
    const response = await register(riderA, {
      pushToken: token,
      platform: 'android',
      identityId: world.customerA.identityId,
    });

    expect(response.statusCode).toBe(200);
    const device = await context.prisma.device.findUnique({ where: { pushToken: token } });
    expect(device?.identityId).toBe(world.riderA.identityId);
    expect(device?.identityId).not.toBe(world.customerA.identityId);
  });

  it('refuses an unauthenticated registration', async () => {
    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/devices',
      payload: { pushToken: uniqueToken(), platform: 'android' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('rejects a malformed token or platform', async () => {
    for (const payload of [
      { pushToken: 'short', platform: 'android' },
      { pushToken: uniqueToken(), platform: 'symbian' },
      { platform: 'android' },
    ]) {
      const response = await register(riderA, payload);
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });
});

// ---------------------------------------------------------------------------
describe('revocation', () => {
  it('will not let one identity silence another identity’s device', async () => {
    const token = uniqueToken();
    await register(riderA, { pushToken: token, platform: 'android' });

    const response = await context.app.inject({
      method: 'DELETE',
      url: '/v1/devices',
      headers: customerA.headers,
      payload: { pushToken: token },
    });

    // Answered without disclosing whether the token exists at all.
    expect(response.json<{ revoked: boolean }>().revoked).toBe(false);
    const device = await context.prisma.device.findUnique({ where: { pushToken: token } });
    expect(device?.pushToken).toBe(token);
  });

  it('clears the token but keeps the device row', async () => {
    // Sessions point at devices. Deleting the row would orphan the audit trail
    // of where a session was used; a row with no token receives nothing, which
    // is the whole requirement.
    const token = uniqueToken();
    await register(riderA, { pushToken: token, platform: 'android' });
    const before = await context.prisma.device.findUnique({ where: { pushToken: token } });

    await revokeDeviceToken(context.prisma, token);

    const after = await context.prisma.device.findUnique({ where: { id: before!.id } });
    expect(after).not.toBeNull();
    expect(after?.pushToken).toBeNull();
  });

  it('silences every handset on logout-everywhere', async () => {
    const tokens = [uniqueToken(), uniqueToken(), uniqueToken()];
    for (const token of tokens) await register(riderA, { pushToken: token, platform: 'android' });

    const silenced = await revokeAllDeviceTokens(context.prisma, world.riderA.identityId);
    expect(silenced).toBeGreaterThanOrEqual(3);

    const live = await context.prisma.device.count({
      where: { identityId: world.riderA.identityId, pushToken: { not: null } },
    });
    expect(live).toBe(0);
  });

  it('permits many revoked devices at once', async () => {
    // The unique index is on a nullable column, so every cleared token holds
    // NULL. If that collided, the second logout on any account would fail.
    const nulls = await context.prisma.device.count({ where: { pushToken: null } });
    expect(nulls).toBeGreaterThan(1);
  });

  it('forgets tokens the provider reports as dead', async () => {
    const alive = uniqueToken();
    const dead = uniqueToken();
    await register(riderA, { pushToken: alive, platform: 'android' });
    await register(riderA, { pushToken: dead, platform: 'android' });

    const cleared = await forgetInvalidTokens(context.prisma, [dead]);
    expect(cleared).toBe(1);

    expect((await context.prisma.device.findUnique({ where: { pushToken: alive } }))?.pushToken).toBe(alive);
    expect(await context.prisma.device.findUnique({ where: { pushToken: dead } })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('eligibility is checked when the push is sent', () => {
  const collectingPort = () => {
    const sent: { tokens: readonly string[]; data?: Record<string, string> }[] = [];
    return {
      port: {
        providerName: 'test',
        isLive: false,
        async send(input: {
          deviceTokens: readonly string[];
          title: string;
          body: string;
          data?: Readonly<Record<string, string>> | undefined;
        }) {
          sent.push({ tokens: input.deviceTokens, data: input.data as Record<string, string> });
          return { accepted: true };
        },
      },
      sent,
    };
  };

  it('does not contact a rider who is no longer approved', async () => {
    // The gap that matters: approved when the token was registered, suspended
    // by the time an offer exists. Checking at registration would have missed
    // it entirely.
    await register(riderA, { pushToken: uniqueToken(), platform: 'android' });
    await context.prisma.rider.update({
      where: { id: world.riderA.riderId },
      data: { status: 'suspended' },
    });

    const { port, sent } = collectingPort();
    const result = await sendToRider(context.prisma, port, {
      riderId: world.riderA.riderId,
      message: riderOfferNotification({ offerId: 'offer_1', expiresAt: new Date() }),
    });

    expect(result.sent).toBe(false);
    expect(result.skipped).toBe('not_approved');
    expect(sent).toHaveLength(0);

    await context.prisma.rider.update({
      where: { id: world.riderA.riderId },
      data: { status: 'approved' },
    });
  });

  it('says so quietly when a rider has no handset registered', async () => {
    // An ordinary state — the rider uses the web client. It must not fail the
    // job that triggered it; realtime still reaches them if their app is open.
    await revokeAllDeviceTokens(context.prisma, world.riderA.identityId);

    const { port, sent } = collectingPort();
    const result = await sendToRider(context.prisma, port, {
      riderId: world.riderA.riderId,
      message: riderOfferNotification({ offerId: 'offer_2', expiresAt: new Date() }),
    });

    expect(result.sent).toBe(false);
    expect(result.skipped).toBe('no_devices');
    expect(sent).toHaveLength(0);
  });

  it('sends identifiers and nothing else to an approved rider', async () => {
    const token = uniqueToken();
    await register(riderA, { pushToken: token, platform: 'android' });

    const { port, sent } = collectingPort();
    await sendToRider(context.prisma, port, {
      riderId: world.riderA.riderId,
      message: riderOfferNotification({
        offerId: 'offer_3',
        expiresAt: new Date('2026-09-07T12:00:30.000Z'),
      }),
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.tokens).toContain(token);
    expect(Object.keys(sent[0]?.data ?? {}).sort()).toEqual(['expiresAt', 'offerId', 'type']);
  });
});

// ---------------------------------------------------------------------------
describe('a notification says nothing it should not', () => {
  it('names no person, address, order or amount', async () => {
    const message = riderOfferNotification({
      offerId: 'offer_4',
      expiresAt: new Date('2026-09-07T12:00:30.000Z'),
    });

    const rendered = `${message.title} ${message.body} ${JSON.stringify(message.data)}`;
    // The lock-screen test: everything in this string is visible to anyone
    // standing near the rider.
    for (const forbidden of ['Customer', 'Road', 'Street', '+234', '₦', 'PIN', 'jollof']) {
      expect(rendered, forbidden).not.toContain(forbidden);
    }
    expect(message.data['offerId']).toBe('offer_4');
  });

  it('refuses a payload key that is not an identifier', async () => {
    // An allowlist, so the default answer to a new key is no. A denylist would
    // have to anticipate every way personal data might be named.
    const hostile: Record<string, string>[] = [
      { type: 'rider_offer', customerName: 'Ada' },
      { type: 'rider_offer', address: '12 Opebi Road' },
      { type: 'rider_offer', pin: '3747' },
    ];
    for (const data of hostile) {
      expect(() => assertNoPersonalData(data)).toThrow(PushPayloadError);
    }
  });

  it('refuses a value long enough to be prose', async () => {
    expect(() => assertNoPersonalData({ orderId: 'x'.repeat(201) })).toThrow(PushPayloadError);
  });

  it('accepts the identifiers it is meant to carry', async () => {
    expect(() =>
      assertNoPersonalData({ type: 'rider_offer', offerId: 'o1', expiresAt: 'now' }),
    ).not.toThrow();
  });
});
