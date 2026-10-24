/**
 * Vendor payout details — integration tests.
 *
 * The account number a vendor is paid into redirects every future settlement
 * without touching a ledger entry, so nothing looks wrong until a vendor
 * complains about a missing payment. These tests exist to make that edit hard
 * and the stored value useless to anyone who reaches the database.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { decrypt, parseKey, type Keyring } from '@dash/domain/envelope';
import { createTestContext, type TestContext } from './harness.js';
import { actAs, as, buildWorld, type Actor, type World } from './world.js';
import { decryptPayoutDetailsForSettlement } from '../vendor/payout.js';
import { useIntegrationTimeouts } from './timeouts.js';

// Real Fastify, real SQLite, real round trips — see timeouts.ts.
useIntegrationTimeouts();

let context: TestContext;
let world: World;
let owner: Actor;

const ACCOUNT = { bankName: 'Demo Bank PLC', accountNumber: '0123456789', accountName: 'Test Vendor Ltd' };

beforeAll(async () => {
  context = await createTestContext();
  world = await buildWorld(context.prisma);
  owner = await actAs(context, world.vendorA.ownerEmail);
});

afterAll(async () => {
  await context.close();
});

function keyring(): Keyring {
  return {
    active: {
      keyId: context.config.ENCRYPTION_KEY_ID,
      key: parseKey(context.config.ENCRYPTION_KEY!),
    },
    retired: [],
  };
}

/**
 * Complete a step-up for the vendor owner.
 *
 * Writes `steppedUpAt` on the live session rather than driving an OTP flow.
 * `authenticate()` rebuilds the actor from the database on every request, so
 * the stored value is authoritative and the existing access token picks it up
 * immediately — which is also why revoking a session takes effect at once.
 */
async function stepUpVendorOwner(): Promise<void> {
  const identity = await context.prisma.identity.findFirstOrThrow({
    where: { email: world.vendorA.ownerEmail },
    select: { id: true },
  });
  await context.prisma.session.updateMany({
    where: { identityId: identity.id, revokedAt: null },
    data: { steppedUpAt: new Date() },
  });
}

/** Clear it again, so the next test starts without a step-up. */
async function clearStepUp(): Promise<void> {
  const identity = await context.prisma.identity.findFirstOrThrow({
    where: { email: world.vendorA.ownerEmail },
    select: { id: true },
  });
  await context.prisma.session.updateMany({
    where: { identityId: identity.id },
    data: { steppedUpAt: null },
  });
}

const put = (actor: Actor, body: Record<string, unknown>) =>
  context.app.inject({
    method: 'PUT',
    url: '/v1/vendor/payout-details',
    headers: as(actor),
    payload: body,
  });

function read(actor: Actor) {
  return context.app.inject({
    method: 'GET',
    url: '/v1/vendor/payout-details',
    headers: as(actor),
  });
}

describe('authorization', () => {
  beforeEach(async () => {
    await context.prisma.vendor.update({
      where: { id: world.vendorA.vendorId },
      data: { bankAccountCipher: null, bankAccountLast4: null, bankName: null },
    });
  });

  it('refuses an unauthenticated write', async () => {
    const response = await context.app.inject({
      method: 'PUT',
      url: '/v1/vendor/payout-details',
      payload: ACCOUNT,
    });
    expect(response.statusCode).toBe(401);
  });

  it('refuses a customer', async () => {
    const customer = await actAs(context, world.customerA.email);
    expect((await put(customer, ACCOUNT)).statusCode).toBe(403);
    expect((await read(customer)).statusCode).toBe(403);
  });

  it('refuses a rider', async () => {
    const rider = await actAs(context, world.riderA.email);
    expect((await put(rider, ACCOUNT)).statusCode).toBe(403);
  });

  it('refuses staff — this is the vendor’s own banking, not ops’', async () => {
    for (const email of [world.support.email, world.dispatcher.email, world.admin.email]) {
      const staff = await actAs(context, email);
      const response = await put(staff, ACCOUNT);
      expect([403, 404], `${email} got ${response.statusCode}`).toContain(response.statusCode);
    }
  });

  it('requires a fresh step-up even for the vendor owner', async () => {
    // A borrowed session must not be enough to redirect settlements.
    await clearStepUp();

    const response = await put(owner, ACCOUNT);
    expect(response.statusCode).toBe(403);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('step_up_required');

    const vendor = await context.prisma.vendor.findUniqueOrThrow({
      where: { id: world.vendorA.vendorId },
      select: { bankAccountCipher: true },
    });
    expect(vendor.bankAccountCipher).toBeNull();
  });

  it('accepts the write once step-up is fresh', async () => {
    await stepUpVendorOwner();

    const response = await put(owner, ACCOUNT);
    expect(response.statusCode).toBe(200);
    expect(
      response.json<{ payoutDetails: { configured: boolean } }>().payoutDetails.configured,
    ).toBe(true);

    await clearStepUp();
  });

  it('refuses again once the step-up has aged out', async () => {
    const identity = await context.prisma.identity.findFirstOrThrow({
      where: { email: world.vendorA.ownerEmail },
      select: { id: true },
    });
    // Older than the 15-minute window.
    await context.prisma.session.updateMany({
      where: { identityId: identity.id, revokedAt: null },
      data: { steppedUpAt: new Date(Date.now() - 3_600_000) },
    });

    const response = await put(owner, ACCOUNT);
    expect(response.statusCode).toBe(403);

    await clearStepUp();
  });
});

describe('storage', () => {
  beforeEach(async () => {
    await context.prisma.vendor.update({
      where: { id: world.vendorA.vendorId },
      data: { bankAccountCipher: null, bankAccountLast4: null, bankName: null },
    });
  });

  /** Write directly through the service, bypassing the step-up gate. */
  async function store(overrides: Partial<typeof ACCOUNT> = {}) {
    const { setPayoutDetails } = await import('../vendor/payout.js');
    return setPayoutDetails(context.prisma, keyring(), {
      vendorId: world.vendorA.vendorId,
      ...ACCOUNT,
      ...overrides,
    });
  }

  it('never stores the account number in clear', async () => {
    await store();

    const vendor = await context.prisma.vendor.findUniqueOrThrow({
      where: { id: world.vendorA.vendorId },
      select: { bankAccountCipher: true, bankAccountLast4: true },
    });

    expect(vendor.bankAccountCipher).not.toBeNull();
    expect(vendor.bankAccountCipher).not.toContain(ACCOUNT.accountNumber);
    expect(vendor.bankAccountCipher).toMatch(/^v1\./);
    // Four digits identifies nothing on its own and lets a vendor recognise
    // their own account.
    expect(vendor.bankAccountLast4).toBe('6789');
  });

  it('encrypts the account name too — it is personal data', async () => {
    await store();
    const vendor = await context.prisma.vendor.findUniqueOrThrow({
      where: { id: world.vendorA.vendorId },
      select: { bankAccountCipher: true },
    });
    expect(vendor.bankAccountCipher).not.toContain(ACCOUNT.accountName);
  });

  it('binds the ciphertext to the vendor that owns it', async () => {
    await store();
    const cipher = (
      await context.prisma.vendor.findUniqueOrThrow({
        where: { id: world.vendorA.vendorId },
        select: { bankAccountCipher: true },
      })
    ).bankAccountCipher!;

    // Right owner opens it.
    expect(
      JSON.parse(
        decrypt(cipher, keyring(), {
          purpose: 'vendor_bank_account',
          subjectId: world.vendorA.vendorId,
        }).plaintext,
      ).accountNumber,
    ).toBe(ACCOUNT.accountNumber);

    // Copied into another vendor's row, it does not — so an attacker with
    // database write access cannot redirect money by moving a row.
    expect(() =>
      decrypt(cipher, keyring(), {
        purpose: 'vendor_bank_account',
        subjectId: world.vendorB.vendorId,
      }),
    ).toThrow();
  });

  it('will not decrypt as a different kind of secret', async () => {
    await store();
    const cipher = (
      await context.prisma.vendor.findUniqueOrThrow({
        where: { id: world.vendorA.vendorId },
        select: { bankAccountCipher: true },
      })
    ).bankAccountCipher!;

    expect(() =>
      decrypt(cipher, keyring(), {
        purpose: 'mfa_totp_secret',
        subjectId: world.vendorA.vendorId,
      }),
    ).toThrow();
  });

  it('will not open under the wrong key', async () => {
    await store();
    const cipher = (
      await context.prisma.vendor.findUniqueOrThrow({
        where: { id: world.vendorA.vendorId },
        select: { bankAccountCipher: true },
      })
    ).bankAccountCipher!;

    const wrong: Keyring = {
      active: { keyId: context.config.ENCRYPTION_KEY_ID, key: Buffer.alloc(32, 9) },
      retired: [],
    };
    expect(() =>
      decrypt(cipher, wrong, {
        purpose: 'vendor_bank_account',
        subjectId: world.vendorA.vendorId,
      }),
    ).toThrow();
  });

  it('detects tampering', async () => {
    await store();
    const cipher = (
      await context.prisma.vendor.findUniqueOrThrow({
        where: { id: world.vendorA.vendorId },
        select: { bankAccountCipher: true },
      })
    ).bankAccountCipher!;

    const parts = cipher.split('.');
    parts[3] = parts[3]!.startsWith('A') ? `B${parts[3]!.slice(1)}` : `A${parts[3]!.slice(1)}`;

    await context.prisma.vendor.update({
      where: { id: world.vendorA.vendorId },
      data: { bankAccountCipher: parts.join('.') },
    });

    await expect(
      decryptPayoutDetailsForSettlement(context.prisma, keyring(), world.vendorA.vendorId),
    ).rejects.toThrow();
  });

  it('rejects an account number that is not 10 digits', async () => {
    for (const accountNumber of ['123', '12345678901234', 'abcdefghij', '']) {
      await expect(store({ accountNumber }), `"${accountNumber}"`).rejects.toThrow();
    }
  });

  it('accepts an account number typed with spaces or dashes', async () => {
    const result = await store({ accountNumber: '012 345-6789' });
    expect(result.accountNumberMasked).toBe('••••••6789');
  });

  it('produces a different ciphertext each time, even for the same account', async () => {
    await store();
    const first = (
      await context.prisma.vendor.findUniqueOrThrow({
        where: { id: world.vendorA.vendorId },
        select: { bankAccountCipher: true },
      })
    ).bankAccountCipher;

    await store();
    const second = (
      await context.prisma.vendor.findUniqueOrThrow({
        where: { id: world.vendorA.vendorId },
        select: { bankAccountCipher: true },
      })
    ).bankAccountCipher;

    // Equal ciphertexts would let anyone with read access tell which vendors
    // share a bank account.
    expect(first).not.toBe(second);
  });

  it('round-trips through the settlement path', async () => {
    await store();
    const opened = await decryptPayoutDetailsForSettlement(
      context.prisma,
      keyring(),
      world.vendorA.vendorId,
    );

    expect(opened.accountNumber).toBe(ACCOUNT.accountNumber);
    expect(opened.accountName).toBe(ACCOUNT.accountName);
    expect(opened.needsReEncryption).toBe(false);
  });

  it('flags a record still under a retired key', async () => {
    const older = { keyId: 'old-key', key: parseKey(Buffer.alloc(32, 4).toString('base64')) };
    const { setPayoutDetails } = await import('../vendor/payout.js');

    await setPayoutDetails(
      context.prisma,
      { active: older, retired: [] },
      { vendorId: world.vendorA.vendorId, ...ACCOUNT },
    );

    const rotated: Keyring = { active: keyring().active, retired: [older] };
    const opened = await decryptPayoutDetailsForSettlement(
      context.prisma,
      rotated,
      world.vendorA.vendorId,
    );

    expect(opened.accountNumber).toBe(ACCOUNT.accountNumber);
    expect(opened.keyId).toBe('old-key');
    // A rotation job uses this to find rows that still need re-encrypting,
    // without forcing a single big migration.
    expect(opened.needsReEncryption).toBe(true);
  });

  it('refuses to store anything when encryption is unavailable', async () => {
    const { setPayoutDetails } = await import('../vendor/payout.js');

    await expect(
      setPayoutDetails(context.prisma, null, { vendorId: world.vendorA.vendorId, ...ACCOUNT }),
    ).rejects.toThrow(/encryption/i);

    const vendor = await context.prisma.vendor.findUniqueOrThrow({
      where: { id: world.vendorA.vendorId },
      select: { bankAccountCipher: true },
    });
    // Storing it in clear because a key is missing would be worse than failing.
    expect(vendor.bankAccountCipher).toBeNull();
  });
});

describe('what is exposed', () => {
  beforeEach(async () => {
    const { setPayoutDetails } = await import('../vendor/payout.js');
    await setPayoutDetails(context.prisma, keyring(), {
      vendorId: world.vendorA.vendorId,
      ...ACCOUNT,
    });
  });

  it('returns only the mask to the owner', async () => {
    const response = await read(owner);
    expect(response.statusCode).toBe(200);

    expect(response.body).not.toContain(ACCOUNT.accountNumber);
    expect(response.body).not.toContain(ACCOUNT.accountName);
    expect(response.body).not.toContain('Cipher');
    expect(response.json<{ payoutDetails: { accountNumberMasked: string } }>().payoutDetails
      .accountNumberMasked).toBe('••••••6789');
  });

  it('never appears in the public vendor catalogue', async () => {
    const list = await context.app.inject({ method: 'GET', url: '/v1/vendors' });
    const detail = await context.app.inject({
      method: 'GET',
      url: `/v1/vendors/${world.vendorA.slug}`,
    });

    for (const body of [list.body, detail.body]) {
      expect(body).not.toContain(ACCOUNT.accountNumber);
      expect(body).not.toContain(ACCOUNT.accountName);
      expect(body).not.toContain('bankAccountCipher');
      expect(body).not.toContain('bankAccountLast4');
    }
  });

  it('never appears in the vendor order queue', async () => {
    const response = await context.app.inject({
      method: 'GET',
      url: '/v1/vendor/orders',
      headers: as(owner),
    });
    expect(response.body).not.toContain(ACCOUNT.accountNumber);
  });

  it('is masked on both sides of the audit trail', async () => {
    const entries = await context.prisma.auditLog.findMany({
      where: { action: 'vendor.payout_details.changed' },
    });

    for (const entry of entries) {
      const serialised = JSON.stringify(entry);
      expect(serialised).not.toContain(ACCOUNT.accountNumber);
      expect(serialised).not.toContain(ACCOUNT.accountName);
    }
  });

  it('reports "not configured" rather than erroring when unset', async () => {
    await context.prisma.vendor.update({
      where: { id: world.vendorA.vendorId },
      data: { bankAccountCipher: null, bankAccountLast4: null },
    });

    const response = await read(owner);
    expect(response.statusCode).toBe(200);
    expect(response.json<{ payoutDetails: { configured: boolean } }>().payoutDetails.configured).toBe(
      false,
    );
  });
});
