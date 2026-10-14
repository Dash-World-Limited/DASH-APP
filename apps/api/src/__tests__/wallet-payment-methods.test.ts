/**
 * Saving a card to the DASH Wallet, through the payment provider.
 *
 * The customer pays a small verification charge on the provider's own page;
 * DASH keeps only the provider's token for the card, encrypted, and shows only
 * brand, last four and expiry. The charge is refunded once, however many
 * times the app asks. Runs on the mock provider.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { decrypt, parseKey, type Keyring } from '@dash/domain/envelope';
import { kobo } from '@dash/domain/money';
import type { MockPaymentAdapter } from '../adapters/index.js';
import { createTestContext, type TestContext } from './harness.js';
import { actAs, buildWorld, type Actor, type World } from './world.js';

let context: TestContext;
let world: World;
let customerA: Actor;
let customerB: Actor;
let rider: Actor;

beforeAll(async () => {
  context = await createTestContext();
  world = await buildWorld(context.prisma);
  customerA = await actAs(context, world.customerA.email);
  customerB = await actAs(context, world.customerB.email);
  rider = await actAs(context, world.riderA.email);
}, 180_000);

afterAll(async () => {
  await context?.close();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const payments = () => context.app.services.payments as MockPaymentAdapter;

function keyring(): Keyring {
  return { active: { keyId: context.config.ENCRYPTION_KEY_ID, key: parseKey(context.config.ENCRYPTION_KEY!) }, retired: [] };
}

const call = (actor: Actor | null, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object) =>
  context.app.inject({ method, url, ...(actor ? { headers: actor.headers } : {}), ...(payload ? { payload } : {}) });

async function startSetup(actor: Actor = customerA) {
  const response = await call(actor, 'POST', '/v1/wallet/payment-methods/setup');
  expect(response.statusCode).toBe(200);
  return response.json<{ setup: { reference: string; authorizationUrl: string; amount: number } }>().setup;
}

async function confirm(reference: string, actor: Actor = customerA) {
  return call(actor, 'POST', `/v1/wallet/payment-methods/setup/${reference}/confirm`);
}

interface Method {
  id: string;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  isDefault: boolean;
}

async function methods(actor: Actor = customerA): Promise<Method[]> {
  return (await call(actor, 'GET', '/v1/wallet/payment-methods')).json<{ methods: Method[] }>().methods;
}

describe('adding a card', () => {
  it('starts on the provider’s page with a small verification charge', async () => {
    expect(await methods()).toEqual([]);
    const setup = await startSetup();
    expect(setup.authorizationUrl).toMatch(/^https:\/\//);
    expect(setup.amount).toBe(5_000);
    const listed = (await call(customerA, 'GET', '/v1/wallet/payment-methods')).json<{ pendingSetup: { reference: string } | null }>();
    expect(listed.pendingSetup?.reference).toBe(setup.reference);
  });

  it('saves the tokenised card masked, keeps the token encrypted, and refunds the charge', async () => {
    const setup = await startSetup();
    const response = await confirm(setup.reference);
    expect(response.statusCode).toBe(200);
    const outcome = response.json<{ outcome: { status: string; method: Method; refunded: boolean } }>().outcome;
    expect(outcome).toMatchObject({ status: 'saved', refunded: true, method: { brand: 'visa', last4: '4081', expMonth: 12, expYear: 2030, isDefault: true } });
    expect(response.body).not.toMatch(/mock_auth_|tokenCipher|fingerprint|mock_sig_/);

    const row = await context.prisma.paymentMethod.findUniqueOrThrow({ where: { id: outcome.method.id } });
    expect(row.tokenCipher).not.toContain('mock_auth_');
    const token = decrypt(row.tokenCipher, keyring(), { purpose: 'customer_payment_method', subjectId: world.customerA.customerId }).plaintext;
    expect(token).toMatch(/^mock_auth_/);
    expect(() => decrypt(row.tokenCipher, keyring(), { purpose: 'customer_payment_method', subjectId: world.customerB.customerId })).toThrow();

    const record = await context.prisma.paymentMethodSetup.findUniqueOrThrow({ where: { reference: setup.reference } });
    expect(record).toMatchObject({ status: 'saved', paymentMethodId: outcome.method.id });
    expect(record.refundReference).toMatch(/^mock_refund_/);

    const listed = await call(customerA, 'GET', '/v1/wallet/payment-methods');
    expect(listed.body).not.toMatch(/mock_auth_|tokenCipher/);
    expect(listed.json<{ pendingSetup: unknown }>().pendingSetup).toBeNull();
  });

  it('is idempotent: asking again neither saves nor refunds twice', async () => {
    const setup = await startSetup();
    const refund = vi.spyOn(payments(), 'refund');
    await confirm(setup.reference);
    await confirm(setup.reference);
    const again = (await confirm(setup.reference)).json<{ outcome: { status: string } }>().outcome;
    expect(again.status).toBe('saved');
    expect(refund).toHaveBeenCalledTimes(1);
  });

  it('recognises the same card added twice', async () => {
    expect(await context.prisma.paymentMethod.count({ where: { customerId: world.customerA.customerId } })).toBe(1);
  });

  it('reports a declined, unfinished or unsaveable card without saving it', async () => {
    const verify = vi.spyOn(payments(), 'verifyCardSetup');

    verify.mockResolvedValue({ status: 'failed', amount: kobo(0), card: null });
    const declined = await startSetup(customerB);
    expect((await confirm(declined.reference, customerB)).json()).toMatchObject({ outcome: { status: 'failed', reason: 'declined' } });

    verify.mockResolvedValue({ status: 'pending', amount: kobo(0), card: null });
    const unfinished = await startSetup(customerB);
    expect((await confirm(unfinished.reference, customerB)).json()).toMatchObject({ outcome: { status: 'pending' } });

    // Starting again settles the one left behind: still unpaid, so set aside,
    // and only the newest setup is offered to resume.
    const unsaveable = await startSetup(customerB);
    expect(await context.prisma.paymentMethodSetup.findUniqueOrThrow({ where: { reference: unfinished.reference } })).toMatchObject({
      status: 'failed',
      failureReason: 'superseded',
    });
    const listed = (await call(customerB, 'GET', '/v1/wallet/payment-methods')).json<{ pendingSetup: { reference: string } | null }>();
    expect(listed.pendingSetup?.reference).toBe(unsaveable.reference);

    const refund = vi.spyOn(payments(), 'refund');
    verify.mockResolvedValue({ status: 'captured', amount: kobo(5_000), card: null });
    expect((await confirm(unsaveable.reference, customerB)).json()).toMatchObject({ outcome: { status: 'failed', reason: 'card_not_reusable' } });
    // Charged but not saveable: the charge still goes back.
    expect(refund).toHaveBeenCalledTimes(1);

    expect(await methods(customerB)).toEqual([]);
  });

  it('saves and refunds a setup the customer paid for but never came back from', async () => {
    const abandoned = await startSetup();
    // No confirmation: the customer closed the app after paying. Starting
    // another setup finds it paid, saves the card and refunds the charge.
    await startSetup();
    const record = await context.prisma.paymentMethodSetup.findUniqueOrThrow({ where: { reference: abandoned.reference } });
    expect(record.status).toBe('saved');
    expect(record.refundReference).toMatch(/^mock_refund_/);
  });

  it('says so when the provider cannot be asked', async () => {
    vi.spyOn(payments(), 'verifyCardSetup').mockRejectedValue(new Error('down'));
    const setup = await startSetup(customerB);
    expect((await confirm(setup.reference, customerB)).statusCode).toBe(503);
  });

  it('needs an email address, which the provider requires', async () => {
    await context.prisma.identity.update({ where: { id: world.customerB.identityId }, data: { email: null } });
    try {
      expect((await call(customerB, 'POST', '/v1/wallet/payment-methods/setup')).statusCode).toBe(422);
    } finally {
      await context.prisma.identity.update({ where: { id: world.customerB.identityId }, data: { email: world.customerB.email } });
    }
  });
});

describe('managing cards', () => {
  it('makes another card the default, and removes a card at the provider too', async () => {
    const second = await startSetup();
    vi.spyOn(payments(), 'verifyCardSetup').mockResolvedValueOnce({
      status: 'captured',
      amount: kobo(5_000),
      card: { token: 'mock_auth_second', fingerprint: 'mock_sig_second', brand: 'mastercard', last4: '5555', expMonth: 3, expYear: 2031, bank: null },
    });
    const added = (await confirm(second.reference)).json<{ outcome: { method: Method } }>().outcome.method;
    expect(added.isDefault).toBe(false);

    const switched = await call(customerA, 'POST', `/v1/wallet/payment-methods/${added.id}/default`);
    expect(switched.statusCode).toBe(200);
    expect((await methods()).find((method) => method.id === added.id)?.isDefault).toBe(true);

    const removed = await call(customerA, 'DELETE', `/v1/wallet/payment-methods/${added.id}`);
    expect(removed.statusCode).toBe(200);
    expect(payments().deactivatedCards.has('mock_auth_second')).toBe(true);
    const left = await methods();
    expect(left.map((method) => method.last4)).toEqual(['4081']);
    expect(left[0]?.isDefault).toBe(true);

    expect(
      await context.prisma.auditLog.count({ where: { action: { in: ['customer.payment_method.saved', 'customer.payment_method.removed'] }, identityId: world.customerA.identityId } }),
    ).toBeGreaterThanOrEqual(2);
  });

  it('keeps every customer to their own cards', async () => {
    const mine = (await methods())[0]!;
    expect((await call(customerB, 'DELETE', `/v1/wallet/payment-methods/${mine.id}`)).statusCode).toBe(404);
    expect((await call(customerB, 'POST', `/v1/wallet/payment-methods/${mine.id}/default`)).statusCode).toBe(404);
    const setup = await startSetup();
    expect((await confirm(setup.reference, customerB)).statusCode).toBe(404);
    expect(await methods(customerB)).toEqual([]);
  });

  it('makes a card the default again when it is re-added after being removed', async () => {
    const first = (await confirm((await startSetup(customerB)).reference, customerB)).json<{ outcome: { method: Method } }>().outcome.method;
    expect(first.isDefault).toBe(true);
    expect((await call(customerB, 'DELETE', `/v1/wallet/payment-methods/${first.id}`)).statusCode).toBe(200);
    expect(await methods(customerB)).toEqual([]);

    const again = (await confirm((await startSetup(customerB)).reference, customerB)).json<{ outcome: { method: Method } }>().outcome.method;
    expect(again).toMatchObject({ id: first.id, isDefault: true });
    expect((await methods(customerB)).map((method) => method.id)).toEqual([first.id]);
  });

  it('is for signed-in customers only', async () => {
    const support = await actAs(context, world.support.email);
    expect((await call(null, 'GET', '/v1/wallet/payment-methods')).statusCode).toBe(401);
    expect((await call(support, 'GET', '/v1/wallet/payment-methods')).statusCode).toBe(403);
    expect((await call(support, 'POST', '/v1/wallet/payment-methods/setup')).statusCode).toBe(403);
    expect((await confirm('not a reference!')).statusCode).toBe(404);
    // A rider's cards are their customer profile's own; none of A's appear.
    expect((await call(rider, 'GET', '/v1/wallet/payment-methods')).body).not.toContain('4081');
  });
});
