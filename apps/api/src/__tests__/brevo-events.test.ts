/**
 * Brevo bounce and complaint events.
 *
 * Brevo is the V1 email provider, so this is the feed that actually keeps a
 * dead mailbox or a spam complaint from being mailed again in production. The
 * endpoint is public, and suppressing an address stops one named person
 * receiving the code that opens their account — so, as for SES, most of this
 * is about refusing what did not come from Brevo.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './harness.js';
import { useIntegrationTimeouts } from './timeouts.js';

useIntegrationTimeouts();

// A made-up, high-entropy value; it unlocks nothing.
const TOKEN = ['brevo', 'hook', 'Qm7Zt2Lp9Xw4Rk8Vn3Bc6Hy1Js5Gd0Fa'].join('-');

let context: TestContext;
let unconfigured: TestContext;

beforeAll(async () => {
  context = await createTestContext({ BREVO_WEBHOOK_TOKEN: TOKEN });
  unconfigured = await createTestContext();
}, 180_000);

afterAll(async () => {
  await context?.close();
  await unconfigured?.close();
});

let counter = 0;
const address = (kind: string) => `${kind}.${Date.now()}.${(counter += 1)}@example.com`;

const event = (name: string, email: string, messageId = `<${Date.now()}.${(counter += 1)}@smtp-relay.brevo.com>`) => ({
  event: name,
  email,
  id: 4242,
  date: '2026-09-28 22:00:00',
  ts_event: 1_790_000_000,
  'message-id': messageId,
  subject: 'Your DASH code',
  tag: 'otp_login',
});

const bearer = { authorization: `Bearer ${TOKEN}` };
const basic = (password: string) => ({ authorization: `Basic ${Buffer.from(`brevo:${password}`).toString('base64')}` });

const post = (body: unknown, headers: Record<string, string> = bearer, ctx: TestContext = context) =>
  ctx.app.inject({ method: 'POST', url: '/v1/webhooks/brevo-events', headers, payload: body as object });

const suppression = (email: string, ctx: TestContext = context) =>
  ctx.prisma.emailSuppression.findUnique({ where: { address: email.toLowerCase() } });

describe('who may report an event', () => {
  it('refuses everything while no token is configured', async () => {
    const email = address('unconfigured');
    const response = await post(event('hard_bounce', email), bearer, unconfigured);
    expect(response.statusCode).toBe(401);
    expect(await suppression(email, unconfigured)).toBeNull();
  });

  it('refuses a missing token, a wrong one, and a wrong Basic password — and says nothing about which', async () => {
    const email = address('forged');
    const answers = [
      await post(event('hard_bounce', email), {}),
      await post(event('hard_bounce', email), { authorization: `Bearer ${TOKEN}x` }),
      await post(event('hard_bounce', email), { authorization: 'Bearer ' }),
      await post(event('hard_bounce', email), basic('not-the-token')),
      await post(event('hard_bounce', email), { authorization: TOKEN }),
    ];
    for (const response of answers) {
      expect(response.statusCode).toBe(401);
      expect(response.body).toBe(JSON.stringify({ received: false }));
    }
    expect(await suppression(email)).toBeNull();
  });

  it('accepts the token as a bearer token or as the Basic auth password', async () => {
    const one = address('bearer');
    const two = address('basic');
    expect((await post(event('hard_bounce', one))).statusCode).toBe(200);
    expect((await post(event('hard_bounce', two), basic(TOKEN))).statusCode).toBe(200);
    expect(await suppression(one)).not.toBeNull();
    expect(await suppression(two)).not.toBeNull();
  });
});

describe('what each event does', () => {
  it('suppresses everything after a hard bounce or an invalid address', async () => {
    for (const name of ['hard_bounce', 'invalid_email']) {
      const email = address(name);
      await post(event(name, email.toUpperCase()));
      expect(await suppression(email), name).toMatchObject({
        reason: 'hard_bounce',
        transactionalAllowed: false,
        detail: `brevo:${name}`,
      });
    }
  });

  it('stops only non-essential mail after a spam complaint, and never loosens a hard bounce', async () => {
    const complained = address('spam');
    await post(event('spam', complained));
    expect(await suppression(complained)).toMatchObject({ reason: 'complaint', transactionalAllowed: true });

    const both = address('bounced-then-spam');
    await post(event('hard_bounce', both));
    await post(event('spam', both));
    expect(await suppression(both)).toMatchObject({ transactionalAllowed: false });
  });

  it('changes nothing for a soft bounce, a Brevo block, a delivery or an open', async () => {
    for (const name of ['soft_bounce', 'blocked', 'delivered', 'opened', 'deferred', 'unsubscribed']) {
      const email = address(name);
      const response = await post(event(name, email));
      expect(response.statusCode, name).toBe(200);
      expect(await suppression(email), name).toBeNull();
    }
  });

  it('handles a batch, and applies a repeated event once', async () => {
    const a = address('batch-a');
    const b = address('batch-b');
    const repeated = event('hard_bounce', a, '<same-message@smtp-relay.brevo.com>');
    expect((await post([repeated, event('spam', b), repeated])).statusCode).toBe(200);
    expect(await suppression(a)).toMatchObject({ reason: 'hard_bounce' });
    expect(await suppression(b)).toMatchObject({ reason: 'complaint' });
    await post(repeated);
    expect(
      await context.prisma.auditLog.count({ where: { action: 'email.suppressed.hard_bounce', resourceId: a } }),
    ).toBe(1);
  });

  it('accepts, and ignores, an authenticated body it does not understand', async () => {
    expect((await post({ hello: 'world' })).statusCode).toBe(200);
    expect((await post({ event: 'hard_bounce' })).statusCode).toBe(200);
  });
});

describe('end to end', () => {
  it('sends no verification code to an address Brevo reported as bounced', async () => {
    const email = address('dead-mailbox');
    await post(event('hard_bounce', email));

    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: {
        name: 'Bounced Person',
        email,
        phone: `+23482${String(Date.now()).slice(-8)}`,
        state: 'Lagos',
        cityArea: 'Yaba',
        usageIntent: 'mainly_buying',
        acquisitionSource: 'search',
        confirmedAdult: true,
        acceptedTerms: true,
      },
    });
    // The caller learns nothing, and their request does not fail…
    expect(response.statusCode).toBe(200);
    // …but the code was never delivered, so the address stays unverified.
    const identity = await context.prisma.identity.findUnique({ where: { email } });
    expect(identity?.emailVerifiedAt ?? null).toBeNull();
  });
});
