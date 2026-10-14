/**
 * Rider payout accounts: the rider sets one, the bank names it, it is stored
 * encrypted and only ever shown masked, and only a stepped-up super admin can
 * see another rider's.
 *
 * Runs on the mock payment provider: every 10-digit number at a listed bank
 * resolves to "DASH TEST ACCOUNT <last four>", 0000000000 is unknown to the
 * bank, and a number ending 9999 makes the bank unreachable.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decrypt, parseKey, type Keyring } from '@dash/domain/envelope';
import { ROLE_PERMISSIONS, STEP_UP_PERMISSIONS } from '@dash/domain/permissions';
import { createTestContext, type TestContext } from './harness.js';
import { actAs, buildWorld, type Actor, type World } from './world.js';

let context: TestContext;
let world: World;
let riderA: Actor;
let riderB: Actor;
let customer: Actor;
let admin: Actor;
let support: Actor;
let finance: Actor;
let dispatcher: Actor;

const ACCOUNT = { bankCode: '058', accountNumber: '0123456789' };
const NAME = 'DASH TEST ACCOUNT 6789';

beforeAll(async () => {
  context = await createTestContext();
  world = await buildWorld(context.prisma);
  riderA = await actAs(context, world.riderA.email);
  riderB = await actAs(context, world.riderB.email);
  customer = await actAs(context, world.customerA.email);
  admin = await actAs(context, world.admin.email);
  support = await actAs(context, world.support.email);
  finance = await actAs(context, world.finance.email);
  dispatcher = await actAs(context, world.dispatcher.email);
}, 180_000);

afterAll(async () => {
  await context?.close();
});

function keyring(): Keyring {
  return { active: { keyId: context.config.ENCRYPTION_KEY_ID, key: parseKey(context.config.ENCRYPTION_KEY!) }, retired: [] };
}

const request = (actor: Actor | null, method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) =>
  context.app.inject({ method, url, ...(actor ? { headers: actor.headers } : {}), ...(payload ? { payload } : {}) });

async function stepUpAdmin(on: boolean): Promise<void> {
  await context.prisma.session.updateMany({
    where: { identityId: world.admin.identityId, ...(on ? { revokedAt: null } : {}) },
    data: { steppedUpAt: on ? new Date() : null },
  });
}

describe('banks', () => {
  it('lists the provider’s banks to a rider', async () => {
    const response = await request(riderA, 'GET', '/v1/rider/payout-account/banks');
    expect(response.statusCode).toBe(200);
    const banks = response.json<{ banks: Array<{ code: string; name: string }> }>().banks;
    expect(banks.length).toBeGreaterThan(3);
    expect(banks).toContainEqual({ code: '058', name: 'Guaranty Trust Bank' });
  });

  it('is for riders only', async () => {
    expect((await request(null, 'GET', '/v1/rider/payout-account/banks')).statusCode).toBe(401);
    expect((await request(customer, 'GET', '/v1/rider/payout-account/banks')).statusCode).toBe(403);
  });
});

describe('verifying an account', () => {
  it('returns the name the bank holds, masked number, and saves nothing', async () => {
    const response = await request(riderA, 'POST', '/v1/rider/payout-account/verify', { bankCode: '058', accountNumber: '012 345 6789' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      account: { bankCode: '058', bankName: 'Guaranty Trust Bank', accountName: NAME, accountNumberMasked: '••••••6789' },
    });
    expect(response.body).not.toContain('0123456789');
    expect(await context.prisma.riderPayoutAccount.count({ where: { riderId: world.riderA.riderId } })).toBe(0);
  });

  it('refuses a malformed number, an unknown bank, and extra fields', async () => {
    for (const payload of [
      { bankCode: '058', accountNumber: '012345678' },
      { bankCode: '058', accountNumber: '01234567890' },
      { bankCode: '058', accountNumber: 'abcdefghij' },
      { bankCode: '999', accountNumber: '0123456789' },
      { bankCode: '058', accountNumber: '0123456789', accountName: 'Anyone' },
      { bankCode: '058' },
    ]) {
      expect((await request(riderA, 'POST', '/v1/rider/payout-account/verify', payload)).statusCode).toBe(400);
    }
  });

  it('says when the bank does not know the account, and when the bank cannot be asked', async () => {
    const unknown = await request(riderA, 'POST', '/v1/rider/payout-account/verify', { bankCode: '058', accountNumber: '0000000000' });
    expect(unknown.statusCode).toBe(422);
    const down = await request(riderA, 'POST', '/v1/rider/payout-account/verify', { bankCode: '058', accountNumber: '0123459999' });
    expect(down.statusCode).toBe(503);
  });
});

describe('saving an account', () => {
  it('starts empty', async () => {
    const response = await request(riderB, 'GET', '/v1/rider/payout-account');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ payoutAccount: { configured: false, accountNumberMasked: null } });
  });

  it('stores the bank’s name, encrypted to this rider, and returns it masked', async () => {
    const response = await request(riderA, 'PUT', '/v1/rider/payout-account', { ...ACCOUNT, accountName: NAME.toLowerCase() });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      payoutAccount: {
        configured: true,
        bankCode: '058',
        bankName: 'Guaranty Trust Bank',
        accountName: NAME,
        accountNumberMasked: '••••••6789',
        verifiedBy: 'mock',
      },
    });
    expect(response.body).not.toContain('0123456789');

    const row = await context.prisma.riderPayoutAccount.findUniqueOrThrow({ where: { riderId: world.riderA.riderId } });
    expect(row.accountCipher).not.toContain('0123456789');
    expect(row.accountNumberLast4).toBe('6789');
    const opened = JSON.parse(
      decrypt(row.accountCipher, keyring(), { purpose: 'rider_bank_account', subjectId: world.riderA.riderId }).plaintext,
    ) as Record<string, string>;
    expect(opened).toEqual({ bankCode: '058', bankName: 'Guaranty Trust Bank', accountNumber: '0123456789', accountName: NAME });
    // Bound to this rider: the same ciphertext does not open as anyone else's.
    expect(() => decrypt(row.accountCipher, keyring(), { purpose: 'rider_bank_account', subjectId: world.riderB.riderId })).toThrow();

    const own = await request(riderA, 'GET', '/v1/rider/payout-account');
    expect(own.json()).toMatchObject({ payoutAccount: { configured: true, accountNumberMasked: '••••••6789', accountName: NAME } });
    expect(own.body).not.toContain('0123456789');
  });

  it('never stores a name the bank did not give', async () => {
    const response = await request(riderB, 'PUT', '/v1/rider/payout-account', { ...ACCOUNT, accountName: 'Someone Else' });
    expect(response.statusCode).toBe(409);
    expect(await context.prisma.riderPayoutAccount.count({ where: { riderId: world.riderB.riderId } })).toBe(0);
  });

  it('replaces the account, and audits both sides masked', async () => {
    const response = await request(riderA, 'PUT', '/v1/rider/payout-account', {
      bankCode: '057',
      accountNumber: '2233445566',
      accountName: 'DASH TEST ACCOUNT 5566',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ payoutAccount: { bankName: 'Zenith Bank', accountNumberMasked: '••••••5566' } });
    expect(await context.prisma.riderPayoutAccount.count({ where: { riderId: world.riderA.riderId } })).toBe(1);

    const audits = await context.prisma.auditLog.findMany({
      where: { resourceId: world.riderA.riderId, action: { startsWith: 'rider.payout_account.' } },
    });
    expect(audits.map((entry) => entry.action).sort()).toEqual(['rider.payout_account.added', 'rider.payout_account.changed']);
    const written = JSON.stringify(audits);
    expect(written).not.toContain('0123456789');
    expect(written).not.toContain('2233445566');
  });

  it('keeps riders out of each other’s accounts', async () => {
    const response = await request(riderB, 'GET', '/v1/rider/payout-account');
    expect(response.json()).toMatchObject({ payoutAccount: { configured: false } });
    expect(response.body).not.toContain('5566');
  });

  it('is for riders only', async () => {
    expect((await request(null, 'PUT', '/v1/rider/payout-account', { ...ACCOUNT, accountName: NAME })).statusCode).toBe(401);
    expect((await request(customer, 'PUT', '/v1/rider/payout-account', { ...ACCOUNT, accountName: NAME })).statusCode).toBe(403);
    expect((await request(customer, 'GET', '/v1/rider/payout-account')).statusCode).toBe(403);
  });
});

describe('the super admin view', () => {
  const url = () => `/v1/admin/riders/${world.riderA.riderId}/payout-account`;

  it('is held by super_admin alone among the roles, behind a step-up', () => {
    const holders = Object.entries(ROLE_PERMISSIONS)
      .filter(([, permissions]) => permissions.includes('admin:rider:payout:read'))
      .map(([role]) => role);
    expect(holders).toEqual(['super_admin']);
    expect(STEP_UP_PERMISSIONS.has('admin:rider:payout:read')).toBe(true);
    // Only a rider may set their own payout account.
    const writers = Object.entries(ROLE_PERMISSIONS)
      .filter(([, permissions]) => permissions.includes('rider:payout:write:own'))
      .map(([role]) => role)
      .sort();
    expect(writers).toEqual(['rider', 'super_admin']);
  });

  it('refuses other staff, riders and customers', async () => {
    for (const actor of [support, finance, dispatcher, riderA, riderB, customer]) {
      const response = await request(actor, 'GET', url());
      expect(response.statusCode).toBe(403);
      expect(response.body).not.toContain('DASH TEST ACCOUNT');
    }
    expect((await request(null, 'GET', url())).statusCode).toBe(401);
  });

  it('needs a recent step-up, then shows the masked account and audits the view', async () => {
    await stepUpAdmin(false);
    expect((await request(admin, 'GET', url())).statusCode).toBe(403);

    await stepUpAdmin(true);
    const response = await request(admin, 'GET', url());
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      rider: { id: world.riderA.riderId },
      payoutAccount: {
        configured: true,
        bankName: 'Zenith Bank',
        accountName: 'DASH TEST ACCOUNT 5566',
        accountNumberMasked: '••••••5566',
      },
    });
    expect(response.body).not.toContain('2233445566');
    expect(response.body).not.toContain('accountCipher');
    expect(
      await context.prisma.auditLog.count({ where: { action: 'rider.payout_account.viewed', resourceId: world.riderA.riderId } }),
    ).toBe(1);

    expect((await request(admin, 'GET', '/v1/admin/riders/no-such-rider/payout-account')).statusCode).toBe(404);
    await stepUpAdmin(false);
  });
});
