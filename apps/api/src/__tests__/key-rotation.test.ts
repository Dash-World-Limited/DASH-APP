/**
 * Key rotation, end to end, against real storage.
 *
 * Rotation is the operation with the worst failure mode in this system. Nothing
 * about it fails at deploy time: a rotation done in the wrong order encrypts
 * fine, deploys fine, serves traffic fine, and then produces `unknown_key` on
 * one particular vendor's payout row three weeks later — by which point the key
 * that would have opened it has been destroyed per the retention policy.
 *
 * So this suite walks the whole lifecycle from the runbook, in order, against a
 * real database and the real envelope implementation. No crypto is reimplemented
 * here; every step goes through the same `encrypt`/`decrypt`/`assembleKeyring`
 * the API uses, because a rotation test that exercises a copy of the code proves
 * something about the copy.
 *
 * **Every key in this file is synthetic**, generated from a constant byte fill,
 * used only against a temporary per-worker SQLite database, and decrypts nothing
 * that exists anywhere else.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assembleKeyring,
  decrypt,
  encrypt,
  envelopeKeyId,
  EnvelopeError,
  type Keyring,
} from '@dash/domain/envelope';
import { buildKeyring, loadConfig, resetConfigCache } from '../config.js';
import {
  keyringIdentity,
  reEncryptAll,
  reEncryptMfaSecrets,
  reEncryptVendorPayouts,
  surveyKeyUsage,
} from '../secrets/rotation.js';
import { decryptPayoutDetailsForSettlement, setPayoutDetails } from '../vendor/payout.js';
import { createTestContext, type TestContext } from './harness.js';

/** Synthetic key material. A constant fill, so the suite is deterministic. */
const K1 = Buffer.alloc(32, 0x11).toString('base64');
const K2 = Buffer.alloc(32, 0x22).toString('base64');
const K3 = Buffer.alloc(32, 0x33).toString('base64');

const keyringWith = (activeKey: string, activeKeyId: string, retired?: string): Keyring =>
  assembleKeyring({ activeKey, activeKeyId, retired });

let context: TestContext;
let vendorId: string;

/**
 * Bring up a real database and a real server.
 *
 * Called only by the blocks that need storage. The custody blocks at the bottom
 * are pure `assembleKeyring` and `loadConfig` calls, and standing up a Fastify
 * instance and a fresh SQLite file for each of those would triple this file's
 * cost for nothing — the suite already runs close enough to its timeouts on a
 * loaded machine.
 */
function withDatabase(): void {
  beforeEach(async () => {
    resetConfigCache();
    context = await createTestContext({ ENCRYPTION_KEY: K1, ENCRYPTION_KEY_ID: 'k1' });

    const city = await context.prisma.city.create({
      data: { slug: 'rotation-city', name: 'Rotation', centreLatitude: 6.5, centreLongitude: 3.4 },
    });
    const vendor = await context.prisma.vendor.create({
      data: {
        cityId: city.id,
        name: 'Rotation Kitchen',
        slug: 'rotation-kitchen',
        category: 'restaurant',
      },
      select: { id: true },
    });
    vendorId = vendor.id;
  });

  afterEach(async () => {
    await context.close();
    resetConfigCache();
  });
}

// ---------------------------------------------------------------------------
// The lifecycle, in the order the runbook performs it
// ---------------------------------------------------------------------------

describe('rotating a key without downtime or a migration', () => {
  withDatabase();

  it('walks the full lifecycle and only then reports it is safe to destroy k1', async () => {
    // --- Step 0: data written under k1 -------------------------------------
    const k1Only = keyringWith(K1, 'k1');
    await setPayoutDetails(context.prisma, k1Only, {
      vendorId,
      bankName: 'Synthetic Bank',
      accountNumber: '0123456789',
      accountName: 'Rotation Kitchen Ltd',
    });

    const written = await context.prisma.vendor.findUniqueOrThrow({
      where: { id: vendorId },
      select: { bankAccountCipher: true },
    });
    expect(envelopeKeyId(written.bankAccountCipher)).toBe('k1');

    // Readable with k1 active, and reported as needing nothing.
    const underK1 = await decryptPayoutDetailsForSettlement(context.prisma, k1Only, vendorId);
    expect(underK1.accountNumber).toBe('0123456789');
    expect(underK1.keyId).toBe('k1');
    expect(underK1.needsReEncryption).toBe(false);

    // --- Step 1-3: k2 becomes active, k1 becomes decrypt-only ---------------
    const rotated = keyringWith(K2, 'k2', `k1:${K1}`);

    // The old row still decrypts, because the retired key is still held. This
    // is the property that makes rotation possible without a migration window.
    const afterRotation = await decryptPayoutDetailsForSettlement(
      context.prisma,
      rotated,
      vendorId,
    );
    expect(afterRotation.accountNumber).toBe('0123456789');
    expect(afterRotation.keyId).toBe('k1');
    // And it says so — this is the signal the re-encryption pass hunts for.
    expect(afterRotation.needsReEncryption).toBe(true);

    // A survey agrees, and can say so without decrypting anything.
    const before = await surveyKeyUsage(context.prisma, keyringIdentity(rotated));
    expect(before.activeKeyId).toBe('k2');
    expect(before.rowsNeedingReEncryption).toBeGreaterThan(0);
    expect(before.unknownKeyIds).toEqual([]);
    // The gate the runbook reads. It must be closed here.
    expect(before.safeToRetireOtherKeys).toBe(false);

    // --- New writes use k2 --------------------------------------------------
    const secondVendor = await context.prisma.vendor.create({
      data: {
        cityId: (await context.prisma.city.findFirstOrThrow()).id,
        name: 'Post Rotation',
        slug: 'post-rotation',
        category: 'grocery',
      },
      select: { id: true },
    });
    await setPayoutDetails(context.prisma, rotated, {
      vendorId: secondVendor.id,
      bankName: 'Synthetic Bank',
      accountNumber: '9876543210',
      accountName: 'Post Rotation Ltd',
    });

    const fresh = await context.prisma.vendor.findUniqueOrThrow({
      where: { id: secondVendor.id },
      select: { bankAccountCipher: true },
    });
    expect(envelopeKeyId(fresh.bankAccountCipher)).toBe('k2');

    // --- Step 4: re-encrypt in the background -------------------------------
    const pass = await reEncryptVendorPayouts(context.prisma, rotated);
    expect(pass.reEncrypted).toBe(1);

    const moved = await context.prisma.vendor.findUniqueOrThrow({
      where: { id: vendorId },
      select: { bankAccountCipher: true },
    });
    expect(envelopeKeyId(moved.bankAccountCipher)).toBe('k2');

    // The value survived the move. A rotation that silently corrupted the
    // plaintext would pass every key-id assertion above.
    const reopened = await decryptPayoutDetailsForSettlement(context.prisma, rotated, vendorId);
    expect(reopened.accountNumber).toBe('0123456789');
    expect(reopened.accountName).toBe('Rotation Kitchen Ltd');
    expect(reopened.needsReEncryption).toBe(false);

    // --- Step 5: only now is it safe to destroy k1 --------------------------
    const after = await surveyKeyUsage(context.prisma, keyringIdentity(rotated));
    expect(after.rowsNeedingReEncryption).toBe(0);
    expect(after.safeToRetireOtherKeys).toBe(true);

    // And having dropped k1, everything still reads.
    const k2Only = keyringWith(K2, 'k2');
    const withoutK1 = await decryptPayoutDetailsForSettlement(context.prisma, k2Only, vendorId);
    expect(withoutK1.accountNumber).toBe('0123456789');
  });

  it('re-encryption is idempotent', async () => {
    const k1Only = keyringWith(K1, 'k1');
    await setPayoutDetails(context.prisma, k1Only, {
      vendorId,
      bankName: 'Synthetic Bank',
      accountNumber: '0123456789',
      accountName: 'Rotation Kitchen Ltd',
    });

    const rotated = keyringWith(K2, 'k2', `k1:${K1}`);
    expect((await reEncryptVendorPayouts(context.prisma, rotated)).reEncrypted).toBe(1);
    // A second pass must find nothing to do rather than rewriting every row on
    // every run — this is a job something will eventually run on a schedule.
    expect((await reEncryptVendorPayouts(context.prisma, rotated)).reEncrypted).toBe(0);
  });

  it('covers the TOTP secret, not only payout details', async () => {
    // The failure this guards: a rotation that surveys and moves payout details,
    // signs itself off as complete, and destroys the old key while every
    // administrator's second factor still sits under it.
    const k1Only = keyringWith(K1, 'k1');
    await context.prisma.identity.update({
      where: { id: context.identityId },
      data: {
        mfaSecretCipher: encrypt('JBSWY3DPEHPK3PXP', k1Only, {
          purpose: 'mfa_totp_secret',
          subjectId: context.identityId,
        }),
      },
    });

    const rotated = keyringWith(K2, 'k2', `k1:${K1}`);

    const survey = await surveyKeyUsage(context.prisma, keyringIdentity(rotated));
    expect(survey.rowsNeedingReEncryption).toBeGreaterThan(0);
    expect(survey.safeToRetireOtherKeys).toBe(false);

    const pass = await reEncryptMfaSecrets(context.prisma, rotated);
    expect(pass.reEncrypted).toBe(1);

    const identity = await context.prisma.identity.findUniqueOrThrow({
      where: { id: context.identityId },
      select: { mfaSecretCipher: true },
    });
    expect(envelopeKeyId(identity.mfaSecretCipher)).toBe('k2');
    expect(
      decrypt(identity.mfaSecretCipher!, rotated, {
        purpose: 'mfa_totp_secret',
        subjectId: context.identityId,
      }).plaintext,
    ).toBe('JBSWY3DPEHPK3PXP');

    expect((await surveyKeyUsage(context.prisma, keyringIdentity(rotated))).safeToRetireOtherKeys).toBe(true);
  });

  it('moves every encrypted field in one pass', async () => {
    const k1Only = keyringWith(K1, 'k1');
    await setPayoutDetails(context.prisma, k1Only, {
      vendorId,
      bankName: 'Synthetic Bank',
      accountNumber: '0123456789',
      accountName: 'Rotation Kitchen Ltd',
    });
    await context.prisma.identity.update({
      where: { id: context.identityId },
      data: {
        mfaPendingCipher: encrypt('JBSWY3DPEHPK3PXP', k1Only, {
          purpose: 'mfa_totp_secret',
          subjectId: context.identityId,
        }),
      },
    });

    const rotated = keyringWith(K2, 'k2', `k1:${K1}`);
    const result = await reEncryptAll(context.prisma, rotated);

    expect(result.payouts.reEncrypted).toBe(1);
    expect(result.mfa.reEncrypted).toBe(1);
    expect(result.survey.safeToRetireOtherKeys).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Review finding 1 — forward progress
//
// The defect: batches took the first `limit` rows with a non-null ciphertext,
// regardless of which key wrote them. On a table whose first page was already
// re-encrypted, every pass re-scanned those same rows, reported zero work, and
// never reached the old-key rows behind them. The rotation could not finish and
// nothing said so — `safeToRetireOtherKeys` simply stayed false for ever.
// ---------------------------------------------------------------------------

describe('batching reaches rows behind an already-migrated page', () => {
  withDatabase();

  /** More rows than the batch size, with the stale ones deliberately last. */
  async function seedVendors(activeCount: number, staleCount: number): Promise<string[]> {
    const cityId = (await context.prisma.city.findFirstOrThrow()).id;
    const k1Only = keyringWith(K1, 'k1');
    const k2Active = keyringWith(K2, 'k2', `k1:${K1}`);
    const stale: string[] = [];

    for (let index = 0; index < activeCount + staleCount; index += 1) {
      const vendor = await context.prisma.vendor.create({
        data: {
          cityId,
          name: `Batch ${index}`,
          slug: `batch-${index}`,
          category: 'restaurant',
        },
        select: { id: true },
      });

      // The first `activeCount` are written under the NEW key, so a naive
      // "first N non-null rows" batch would consume the whole budget on them.
      const onActive = index < activeCount;
      await setPayoutDetails(context.prisma, onActive ? k2Active : k1Only, {
        vendorId: vendor.id,
        bankName: 'Synthetic Bank',
        accountNumber: '0123456789',
        accountName: `Batch ${index} Ltd`,
      });

      if (!onActive) stale.push(vendor.id);
    }

    return stale;
  }

  it('re-encrypts a row that sits behind a full batch of already-active rows', async () => {
    // The seeded vendor from withDatabase() has no payout details, so every row
    // here is one this test created.
    const staleIds = await seedVendors(4, 2);
    const rotated = keyringWith(K2, 'k2', `k1:${K1}`);

    // A batch smaller than the number of already-active rows in front. Under
    // the old behaviour this pass would select four active rows and move none.
    const pass = await reEncryptVendorPayouts(context.prisma, rotated, { limit: 2 });

    expect(pass.scanned).toBeGreaterThan(0);
    expect(pass.reEncrypted).toBeGreaterThan(0);
    // Every row examined is accounted for by exactly one outcome. The walk no
    // longer excludes already-active rows in SQL — that exclusion used a LIKE
    // pattern and was unsafe — so `alreadyActive` is part of the sum.
    expect(pass.scanned).toBe(
      pass.reEncrypted +
        pass.skippedConcurrentWrite +
        pass.alreadyActive +
        pass.malformed +
        pass.unreadable,
    );

    for (const id of staleIds) {
      const row = await context.prisma.vendor.findUniqueOrThrow({
        where: { id },
        select: { bankAccountCipher: true },
      });
      expect(envelopeKeyId(row.bankAccountCipher)).toBe('k2');
    }
  });

  it('a single supervised run with a small limit finishes the whole table', async () => {
    await seedVendors(5, 3);
    const rotated = keyringWith(K2, 'k2', `k1:${K1}`);

    const result = await reEncryptAll(context.prisma, rotated, { limit: 2 });

    expect(result.survey.rowsNeedingReEncryption).toBe(0);
    expect(result.survey.safeToRetireOtherKeys).toBe(true);
    // It took more than one pass, which is the point of the bounded batch.
    expect(result.passes).toBeGreaterThan(1);
  });

  it('repeated manual passes converge and then stop finding work', async () => {
    await seedVendors(4, 3);
    const rotated = keyringWith(K2, 'k2', `k1:${K1}`);

    let moved = 0;
    for (let pass = 0; pass < 10; pass += 1) {
      const result = await reEncryptVendorPayouts(context.prisma, rotated, { limit: 2 });
      moved += result.reEncrypted;
      if (result.reEncrypted === 0) break;
    }

    expect(moved).toBe(3);

    const survey = await surveyKeyUsage(context.prisma, keyringIdentity(rotated));
    expect(survey.rowsNeedingReEncryption).toBe(0);
    expect(survey.safeToRetireOtherKeys).toBe(true);

    // A further pass still *reads* the rows — the walk no longer filters
    // already-active ones out in SQL — but it moves none and says so.
    const settled = await reEncryptVendorPayouts(context.prisma, rotated, { limit: 2 });
    expect(settled.reEncrypted).toBe(0);
    expect(settled.alreadyActive).toBe(settled.scanned);
  });

  it('does not confuse a key id that is a prefix of another', async () => {
    // Active `k1` must not match rows written by `k10`. Without the trailing
    // dot in the selection prefix, those rows would be reported as needing
    // nothing and silently left under a key about to be destroyed.
    const cityId = (await context.prisma.city.findFirstOrThrow()).id;
    const vendor = await context.prisma.vendor.create({
      data: { cityId, name: 'Prefix', slug: 'prefix-vendor', category: 'retail' },
      select: { id: true },
    });

    const k10 = Buffer.alloc(32, 0x44).toString('base64');
    await setPayoutDetails(context.prisma, keyringWith(k10, 'k10'), {
      vendorId: vendor.id,
      bankName: 'Synthetic Bank',
      accountNumber: '0123456789',
      accountName: 'Prefix Ltd',
    });

    const activeK1 = keyringWith(K1, 'k1', `k10:${k10}`);
    const pass = await reEncryptVendorPayouts(context.prisma, activeK1, { limit: 10 });

    expect(pass.reEncrypted).toBe(1);
    const row = await context.prisma.vendor.findUniqueOrThrow({
      where: { id: vendor.id },
      select: { bankAccountCipher: true },
    });
    expect(envelopeKeyId(row.bankAccountCipher)).toBe('k1');
  });

  it('reaches MFA rows behind already-active ones too', async () => {
    const k1Only = keyringWith(K1, 'k1');
    const k2Active = keyringWith(K2, 'k2', `k1:${K1}`);

    // Two identities already on k2, then one still on k1.
    const staleIds: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const identity = await context.prisma.identity.create({
        data: { displayName: `Batch MFA ${index}`, email: `batch-mfa-${index}@dashapp.test` },
        select: { id: true },
      });
      const onActive = index < 2;
      await context.prisma.identity.update({
        where: { id: identity.id },
        data: {
          mfaSecretCipher: encrypt('JBSWY3DPEHPK3PXP', onActive ? k2Active : k1Only, {
            purpose: 'mfa_totp_secret',
            subjectId: identity.id,
          }),
        },
      });
      if (!onActive) staleIds.push(identity.id);
    }

    const pass = await reEncryptMfaSecrets(context.prisma, k2Active, { limit: 1 });
    expect(pass.reEncrypted).toBe(1);

    const row = await context.prisma.identity.findUniqueOrThrow({
      where: { id: staleIds[0]! },
      select: { mfaSecretCipher: true },
    });
    expect(envelopeKeyId(row.mfaSecretCipher)).toBe('k2');
  });
});

// ---------------------------------------------------------------------------
// Review finding 2 — never revert a concurrent write
//
// Rotation is read-then-write. Between those two steps a vendor can change
// their bank details or an administrator can re-enrol. Writing back by id alone
// would put the stale plaintext this pass is holding over the top of that — a
// silent data loss that looks exactly like a successful rotation.
// ---------------------------------------------------------------------------

describe('a concurrent write is never reverted by rotation', () => {
  withDatabase();

  it('leaves a payout row that changed under the active key alone', async () => {
    const k1Only = keyringWith(K1, 'k1');
    await setPayoutDetails(context.prisma, k1Only, {
      vendorId,
      bankName: 'Old Bank',
      accountNumber: '0123456789',
      accountName: 'Rotation Kitchen Ltd',
    });

    const rotated = keyringWith(K2, 'k2', `k1:${K1}`);

    // What the vendor does while the rotation pass is in flight: a real write,
    // through the real code path, already on the active key.
    await setPayoutDetails(context.prisma, rotated, {
      vendorId,
      bankName: 'New Bank',
      accountNumber: '9999999999',
      accountName: 'Rotation Kitchen Ltd',
    });

    // A rotation pass built from the pre-change read. `updateMany` guards on
    // the exact ciphertext that was read, so this must decline to write.
    const stale = encrypt(
      JSON.stringify({
        bankName: 'Old Bank',
        accountNumber: '0123456789',
        accountName: 'Rotation Kitchen Ltd',
      }),
      rotated,
      { purpose: 'vendor_bank_account', subjectId: vendorId },
    );
    const written = await context.prisma.vendor.updateMany({
      where: {
        id: vendorId,
        // The value the pass read before the vendor's change.
        bankAccountCipher: encrypt('never-matches', k1Only, {
          purpose: 'vendor_bank_account',
          subjectId: vendorId,
        }),
      },
      data: { bankAccountCipher: stale },
    });
    expect(written.count).toBe(0);

    // The vendor's change survives, in full.
    const current = await decryptPayoutDetailsForSettlement(context.prisma, rotated, vendorId);
    expect(current.accountNumber).toBe('9999999999');
    expect(current.bankName).toBe('New Bank');
  });

  it('counts the skip and reports it rather than failing', async () => {
    const k1Only = keyringWith(K1, 'k1');
    await setPayoutDetails(context.prisma, k1Only, {
      vendorId,
      bankName: 'Old Bank',
      accountNumber: '0123456789',
      accountName: 'Rotation Kitchen Ltd',
    });

    const rotated = keyringWith(K2, 'k2', `k1:${K1}`);

    // Simulate the interleaving precisely: the pass selects the k1 row, and
    // before it writes, the vendor's own update lands. A prisma middleware is
    // the cleanest way to land a write between the select and the update.
    let fired = false;
    const original = context.prisma.vendor.updateMany.bind(context.prisma.vendor);
    const spy = async (args: Parameters<typeof original>[0]) => {
      if (!fired) {
        fired = true;
        await setPayoutDetails(context.prisma, rotated, {
          vendorId,
          bankName: 'New Bank',
          accountNumber: '9999999999',
          accountName: 'Rotation Kitchen Ltd',
        });
      }
      return original(args);
    };
    (context.prisma.vendor as any).updateMany = spy;

    try {
      const pass = await reEncryptVendorPayouts(context.prisma, rotated, { limit: 10 });
      expect(pass.skippedConcurrentWrite).toBe(1);
      expect(pass.reEncrypted).toBe(0);
    } finally {
      (context.prisma.vendor as any).updateMany = original;
    }

    // The concurrent write is intact, and the row is already on the active key,
    // so the next pass correctly finds nothing to do.
    const current = await decryptPayoutDetailsForSettlement(context.prisma, rotated, vendorId);
    expect(current.accountNumber).toBe('9999999999');
    const settled = await reEncryptVendorPayouts(context.prisma, rotated, { limit: 10 });
    expect(settled.reEncrypted).toBe(0);
    expect(settled.skippedConcurrentWrite).toBe(0);
  });

  it('leaves an MFA secret that changed under the active key alone', async () => {
    const k1Only = keyringWith(K1, 'k1');
    const context_ = { purpose: 'mfa_totp_secret', subjectId: context.identityId };

    await context.prisma.identity.update({
      where: { id: context.identityId },
      data: { mfaSecretCipher: encrypt('OLDSECRETOLDSECRE', k1Only, context_) },
    });

    const rotated = keyringWith(K2, 'k2', `k1:${K1}`);

    // A re-enrolment lands under the active key.
    await context.prisma.identity.update({
      where: { id: context.identityId },
      data: { mfaSecretCipher: encrypt('NEWSECRETNEWSECRE', rotated, context_) },
    });

    // A CAS guarded on the value the pass would have read writes nothing.
    const written = await context.prisma.identity.updateMany({
      where: {
        id: context.identityId,
        mfaSecretCipher: encrypt('OLDSECRETOLDSECRE', k1Only, context_),
      },
      data: { mfaSecretCipher: encrypt('OLDSECRETOLDSECRE', rotated, context_) },
    });
    expect(written.count).toBe(0);

    const row = await context.prisma.identity.findUniqueOrThrow({
      where: { id: context.identityId },
      select: { mfaSecretCipher: true },
    });
    expect(decrypt(row.mfaSecretCipher!, rotated, context_).plaintext).toBe('NEWSECRETNEWSECRE');
  });

  it('rotates the pending column even when the confirmed one changed concurrently', async () => {
    // The two columns are swapped independently, so a concurrent re-enrolment
    // must not block the pending secret from being moved.
    const k1Only = keyringWith(K1, 'k1');
    const rotated = keyringWith(K2, 'k2', `k1:${K1}`);
    const ctx = { purpose: 'mfa_totp_secret', subjectId: context.identityId };

    await context.prisma.identity.update({
      where: { id: context.identityId },
      data: {
        mfaSecretCipher: encrypt('CONFIRMEDSECRETXX', k1Only, ctx),
        mfaPendingCipher: encrypt('PENDINGSECRETXXXX', k1Only, ctx),
      },
    });

    const pass = await reEncryptMfaSecrets(context.prisma, rotated, { limit: 10 });
    expect(pass.reEncrypted).toBe(1);

    const row = await context.prisma.identity.findUniqueOrThrow({
      where: { id: context.identityId },
      select: { mfaSecretCipher: true, mfaPendingCipher: true },
    });
    expect(envelopeKeyId(row.mfaSecretCipher)).toBe('k2');
    expect(envelopeKeyId(row.mfaPendingCipher)).toBe('k2');
    expect(decrypt(row.mfaPendingCipher!, rotated, ctx).plaintext).toBe('PENDINGSECRETXXXX');
  });
});

// ---------------------------------------------------------------------------
// Review finding 3 — a value that is not an envelope must not be ignored
//
// The survey used to skip anything `envelopeKeyId` could not parse. A corrupt,
// truncated, or foreign-format value was therefore invisible, and
// `safeToRetireOtherKeys` could report true while unreadable data sat in the
// table — after which the keys that were its last hope get destroyed.
// ---------------------------------------------------------------------------

describe('malformed encrypted values block retirement', () => {
  withDatabase();

  const MALFORMED = 'not-an-envelope-at-all';

  it('reports a malformed vendor payout cipher and refuses to call retirement safe', async () => {
    await context.prisma.vendor.update({
      where: { id: vendorId },
      data: { bankAccountCipher: MALFORMED },
    });

    const survey = await surveyKeyUsage(context.prisma, keyringIdentity(keyringWith(K1, 'k1')));

    expect(survey.malformedValues).toBe(1);
    expect(survey.safeToRetireOtherKeys).toBe(false);

    const field = survey.usage.find((entry) => entry.column === 'bankAccountCipher');
    expect(field?.malformed).toBe(1);
  });

  it('reports a malformed confirmed MFA secret', async () => {
    await context.prisma.identity.update({
      where: { id: context.identityId },
      data: { mfaSecretCipher: MALFORMED },
    });

    const survey = await surveyKeyUsage(context.prisma, keyringIdentity(keyringWith(K1, 'k1')));

    expect(survey.malformedValues).toBe(1);
    expect(survey.safeToRetireOtherKeys).toBe(false);
    expect(survey.usage.find((entry) => entry.column === 'mfaSecretCipher')?.malformed).toBe(1);
  });

  it('reports a malformed pending MFA secret', async () => {
    await context.prisma.identity.update({
      where: { id: context.identityId },
      data: { mfaPendingCipher: MALFORMED },
    });

    const survey = await surveyKeyUsage(context.prisma, keyringIdentity(keyringWith(K1, 'k1')));

    expect(survey.malformedValues).toBe(1);
    expect(survey.safeToRetireOtherKeys).toBe(false);
    expect(survey.usage.find((entry) => entry.column === 'mfaPendingCipher')?.malformed).toBe(1);
  });

  it('counts malformed values across every encrypted field at once', async () => {
    await context.prisma.vendor.update({
      where: { id: vendorId },
      data: { bankAccountCipher: MALFORMED },
    });
    await context.prisma.identity.update({
      where: { id: context.identityId },
      data: { mfaSecretCipher: MALFORMED, mfaPendingCipher: MALFORMED },
    });

    const survey = await surveyKeyUsage(context.prisma, keyringIdentity(keyringWith(K1, 'k1')));

    expect(survey.malformedValues).toBe(3);
    expect(survey.safeToRetireOtherKeys).toBe(false);
  });

  it('keeps retirement closed even when every parseable row is on the active key', async () => {
    // The dangerous shape: everything that *can* be read is already migrated,
    // so every other signal says "done", and one unreadable row is the only
    // thing standing between the operator and destroying the old key.
    const rotated = keyringWith(K2, 'k2', `k1:${K1}`);
    await setPayoutDetails(context.prisma, rotated, {
      vendorId,
      bankName: 'Synthetic Bank',
      accountNumber: '0123456789',
      accountName: 'Rotation Kitchen Ltd',
    });
    await context.prisma.identity.update({
      where: { id: context.identityId },
      data: { mfaSecretCipher: MALFORMED },
    });

    const survey = await surveyKeyUsage(context.prisma, keyringIdentity(rotated));

    expect(survey.rowsNeedingReEncryption).toBe(0);
    expect(survey.unknownKeyIds).toEqual([]);
    expect(survey.malformedValues).toBe(1);
    expect(survey.safeToRetireOtherKeys).toBe(false);
  });

  it('never puts the offending value in the survey', async () => {
    // A column that failed to parse is the one place this module could print
    // something that might be plaintext. It reports a count and a field name.
    const secretish = 'PLAINTEXT-LEAKED-0123456789';
    await context.prisma.vendor.update({
      where: { id: vendorId },
      data: { bankAccountCipher: secretish },
    });

    const survey = await surveyKeyUsage(context.prisma, keyringIdentity(keyringWith(K1, 'k1')));

    expect(JSON.stringify(survey)).not.toContain(secretish);
    expect(JSON.stringify(survey)).not.toContain('PLAINTEXT');
  });

  it('leaves a malformed value untouched during re-encryption instead of failing the pass', async () => {
    // One unreadable row must not abort a pass over thousands of good ones.
    const cityId = (await context.prisma.city.findFirstOrThrow()).id;
    const good = await context.prisma.vendor.create({
      data: { cityId, name: 'Good', slug: 'good-vendor', category: 'retail' },
      select: { id: true },
    });
    await setPayoutDetails(context.prisma, keyringWith(K1, 'k1'), {
      vendorId: good.id,
      bankName: 'Synthetic Bank',
      accountNumber: '0123456789',
      accountName: 'Good Ltd',
    });
    await context.prisma.vendor.update({
      where: { id: vendorId },
      data: { bankAccountCipher: MALFORMED },
    });

    const rotated = keyringWith(K2, 'k2', `k1:${K1}`);
    const pass = await reEncryptVendorPayouts(context.prisma, rotated, { limit: 10 });

    expect(pass.malformed).toBe(1);
    expect(pass.reEncrypted).toBe(1);

    // The good row moved; the malformed one is exactly as it was.
    const untouched = await context.prisma.vendor.findUniqueOrThrow({
      where: { id: vendorId },
      select: { bankAccountCipher: true },
    });
    expect(untouched.bankAccountCipher).toBe(MALFORMED);
  });

  it('reEncryptAll terminates rather than spinning on a value it cannot move', async () => {
    await context.prisma.vendor.update({
      where: { id: vendorId },
      data: { bankAccountCipher: MALFORMED },
    });

    const result = await reEncryptAll(context.prisma, keyringWith(K2, 'k2', `k1:${K1}`), { limit: 10 });

    expect(result.passes).toBeLessThanOrEqual(2);
    expect(result.survey.malformedValues).toBe(1);
    expect(result.survey.safeToRetireOtherKeys).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The survey needs no key material
// ---------------------------------------------------------------------------

describe('surveying without holding a key', () => {
  withDatabase();

  it('accepts key ids alone, so an operator with no key can run it', async () => {
    await setPayoutDetails(context.prisma, keyringWith(K1, 'k1'), {
      vendorId,
      bankName: 'Synthetic Bank',
      accountNumber: '0123456789',
      accountName: 'Rotation Kitchen Ltd',
    });

    // No Keyring anywhere in this call — just two ids, of the kind an operator
    // reads off a deployment manifest.
    const survey = await surveyKeyUsage(context.prisma, {
      activeKeyId: 'k2',
      heldKeyIds: ['k2', 'k1'],
    });

    expect(survey.activeKeyId).toBe('k2');
    expect(survey.rowsNeedingReEncryption).toBe(1);
    expect(survey.unknownKeyIds).toEqual([]);
    expect(survey.safeToRetireOtherKeys).toBe(false);
  });

  it('keyringIdentity discards the key bytes', () => {
    const identity = keyringIdentity(keyringWith(K2, 'k2', `k1:${K1}`));

    expect(identity).toEqual({ activeKeyId: 'k2', heldKeyIds: ['k2', 'k1'] });
    expect(JSON.stringify(identity)).not.toContain(K1);
    expect(JSON.stringify(identity)).not.toContain(K2);
  });
});


// ---------------------------------------------------------------------------
// Second review finding — unmovable rows starve the batch, and an unknown key
// aborts the pass entirely.
//
// The first forward-progress fix excluded rows already on the active key from
// the selection, which fixed starvation behind *migrated* rows. It did not fix
// starvation behind rows that can never be migrated:
//
//   - a **malformed** value is not an envelope, so it can never be rotated and
//     never stops matching `NOT startsWith(activePrefix)`;
//   - a value written by a key the deployment no longer holds cannot be
//     decrypted, so it is equally permanent.
//
// Both stay in the selection set for ever. With `limit` or more of them ahead
// of the good rows, every pass selects the same unmovable rows, moves nothing,
// and the good rows behind them are never reached — the original starvation
// bug, arrived at through a different door.
//
// The unknown-key case was worse than starvation: `decrypt` throws, and nothing
// caught it, so a single row under a destroyed key aborted the whole rotation.
// ---------------------------------------------------------------------------

describe('rows that can never be moved do not starve the ones that can', () => {
  withDatabase();

  const MALFORMED = 'not-an-envelope-at-all';

  /** A vendor whose payout cipher is set directly, bypassing validation. */
  async function vendorWithCipher(slug: string, cipher: string): Promise<string> {
    const cityId = (await context.prisma.city.findFirstOrThrow()).id;
    const vendor = await context.prisma.vendor.create({
      data: { cityId, name: slug, slug, category: 'restaurant' },
      select: { id: true },
    });
    await context.prisma.vendor.update({
      where: { id: vendor.id },
      data: { bankAccountCipher: cipher },
    });
    return vendor.id;
  }

  it('reaches a good row sitting behind a full batch of malformed ones', async () => {
    // Three malformed rows created first, so they sort ahead of the good one,
    // then one genuinely rotatable row.
    await vendorWithCipher('malformed-a', MALFORMED);
    await vendorWithCipher('malformed-b', MALFORMED);
    await vendorWithCipher('malformed-c', MALFORMED);

    const good = await vendorWithCipher(
      'good-behind-malformed',
      encrypt('{"bankName":"B","accountNumber":"0123456789","accountName":"N"}', keyringWith(K1, 'k1'), {
        purpose: 'vendor_bank_account',
        subjectId: 'placeholder',
      }),
    );
    // Re-encrypt bound to the real vendor id so it decrypts during rotation.
    await context.prisma.vendor.update({
      where: { id: good },
      data: {
        bankAccountCipher: encrypt(
          '{"bankName":"B","accountNumber":"0123456789","accountName":"N"}',
          keyringWith(K1, 'k1'),
          { purpose: 'vendor_bank_account', subjectId: good },
        ),
      },
    });

    const rotated = keyringWith(K2, 'k2', `k1:${K1}`);

    // limit 2, **page size 2** — smaller than the three malformed rows in
    // front, so reaching the good row genuinely requires the cursor to advance
    // across a page boundary. Without an explicit page size the default of 200
    // would swallow the whole table in one read and the test would pass whether
    // or not the cursor advanced at all.
    const pass = await reEncryptVendorPayouts(context.prisma, rotated, { limit: 2, pageSize: 2 });

    expect(pass.reEncrypted).toBe(1);

    const row = await context.prisma.vendor.findUniqueOrThrow({
      where: { id: good },
      select: { bankAccountCipher: true },
    });
    expect(envelopeKeyId(row.bankAccountCipher)).toBe('k2');
  });

  it('does not abort the pass when a row names a key the deployment no longer holds', async () => {
    // k3 is never given to the rotation keyring, so this row cannot be
    // decrypted. Unfixed, `decrypt` throws straight out of the pass.
    const lost = await vendorWithCipher('unknown-key-row', 'placeholder');
    await context.prisma.vendor.update({
      where: { id: lost },
      data: {
        bankAccountCipher: encrypt(
          '{"bankName":"B","accountNumber":"0123456789","accountName":"N"}',
          keyringWith(K3, 'k3'),
          { purpose: 'vendor_bank_account', subjectId: lost },
        ),
      },
    });

    const good = await vendorWithCipher('good-behind-unknown', 'placeholder');
    await context.prisma.vendor.update({
      where: { id: good },
      data: {
        bankAccountCipher: encrypt(
          '{"bankName":"B","accountNumber":"0123456789","accountName":"N"}',
          keyringWith(K1, 'k1'),
          { purpose: 'vendor_bank_account', subjectId: good },
        ),
      },
    });

    const rotated = keyringWith(K2, 'k2', `k1:${K1}`);

    const pass = await reEncryptVendorPayouts(context.prisma, rotated, { limit: 10 });

    // The unreadable row is counted, not thrown.
    expect(pass.unreadable).toBe(1);
    // And the good row behind it still moved.
    expect(pass.reEncrypted).toBe(1);

    const row = await context.prisma.vendor.findUniqueOrThrow({
      where: { id: good },
      select: { bankAccountCipher: true },
    });
    expect(envelopeKeyId(row.bankAccountCipher)).toBe('k2');
  });

  it('reEncryptAll finishes the movable rows despite unmovable ones', async () => {
    await vendorWithCipher('mal-1', MALFORMED);
    await vendorWithCipher('mal-2', MALFORMED);

    const good = await vendorWithCipher('good-final', 'placeholder');
    await context.prisma.vendor.update({
      where: { id: good },
      data: {
        bankAccountCipher: encrypt(
          '{"bankName":"B","accountNumber":"0123456789","accountName":"N"}',
          keyringWith(K1, 'k1'),
          { purpose: 'vendor_bank_account', subjectId: good },
        ),
      },
    });

    const rotated = keyringWith(K2, 'k2', `k1:${K1}`);
    const result = await reEncryptAll(context.prisma, rotated, { limit: 1 });

    expect(result.payouts.reEncrypted).toBe(1);
    // The malformed rows are reported, and they keep retirement closed.
    expect(result.survey.malformedValues).toBe(2);
    expect(result.survey.safeToRetireOtherKeys).toBe(false);
    // Everything that could move, moved.
    expect(result.survey.rowsNeedingReEncryption).toBe(0);
  });

  it('reaches an MFA row behind unmovable ones', async () => {
    const stale: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const identity = await context.prisma.identity.create({
        data: { displayName: `Mal ${index}`, email: `mal-${index}@dashapp.test` },
        select: { id: true },
      });
      await context.prisma.identity.update({
        where: { id: identity.id },
        data: { mfaSecretCipher: MALFORMED },
      });
    }

    const good = await context.prisma.identity.create({
      data: { displayName: 'Good MFA', email: 'good-mfa@dashapp.test' },
      select: { id: true },
    });
    await context.prisma.identity.update({
      where: { id: good.id },
      data: {
        mfaSecretCipher: encrypt('JBSWY3DPEHPK3PXP', keyringWith(K1, 'k1'), {
          purpose: 'mfa_totp_secret',
          subjectId: good.id,
        }),
      },
    });
    stale.push(good.id);

    const rotated = keyringWith(K2, 'k2', `k1:${K1}`);
    // Page size 2 against three unmovable identities, so the walk must paginate.
    const pass = await reEncryptMfaSecrets(context.prisma, rotated, { limit: 2, pageSize: 2 });

    expect(pass.reEncrypted).toBe(1);

    const row = await context.prisma.identity.findUniqueOrThrow({
      where: { id: good.id },
      select: { mfaSecretCipher: true },
    });
    expect(envelopeKeyId(row.mfaSecretCipher)).toBe('k2');
  });

  it('an unknown key id is reported by the survey and blocks retirement', async () => {
    const lost = await vendorWithCipher('unknown-survey', 'placeholder');
    await context.prisma.vendor.update({
      where: { id: lost },
      data: {
        bankAccountCipher: encrypt(
          '{"bankName":"B","accountNumber":"0123456789","accountName":"N"}',
          keyringWith(K3, 'k3'),
          { purpose: 'vendor_bank_account', subjectId: lost },
        ),
      },
    });

    const rotated = keyringWith(K2, 'k2', `k1:${K1}`);
    await reEncryptVendorPayouts(context.prisma, rotated, { limit: 10 });

    const survey = await surveyKeyUsage(context.prisma, keyringIdentity(rotated));
    expect(survey.unknownKeyIds).toEqual(['k3']);
    expect(survey.safeToRetireOtherKeys).toBe(false);
  });

  it('reports no ciphertext or plaintext for a row it could not move', async () => {
    const secretish = 'PLAINTEXT-SHOULD-NOT-APPEAR-0123456789';
    await vendorWithCipher('leaky-malformed', secretish);

    const rotated = keyringWith(K2, 'k2', `k1:${K1}`);
    const pass = await reEncryptVendorPayouts(context.prisma, rotated, { limit: 10 });

    expect(JSON.stringify(pass)).not.toContain(secretish);
    expect(JSON.stringify(pass)).not.toContain('PLAINTEXT');
  });
});


// ---------------------------------------------------------------------------
// Review finding 1 — the scan budget was a wall, not a budget
//
// A pass stops when it has spent its scan budget, and used to report only
// `exhausted: false` with no cursor. `reEncryptAll` stopped when both passes
// moved nothing. So on a table whose first `scanBudget` rows cannot be moved,
// every invocation restarted at the beginning, re-scanned the same unmovable
// rows, and the movable row behind them was never reached — bounded work that
// could never finish, and nothing said so.
//
// The fix is a continuation cursor: a pass reports the last id it examined, and
// the orchestrator resumes *after* it.
// ---------------------------------------------------------------------------

describe('bounded work makes progress across scan-budget boundaries', () => {
  withDatabase();

  const MALFORMED = 'not-an-envelope-at-all';
  const PAYLOAD = '{"bankName":"B","accountNumber":"0123456789","accountName":"N"}';

  async function vendorWithRawCipher(slug: string, cipher: string): Promise<string> {
    const cityId = (await context.prisma.city.findFirstOrThrow()).id;
    const vendor = await context.prisma.vendor.create({
      data: { cityId, name: slug, slug, category: 'restaurant' },
      select: { id: true },
    });
    await context.prisma.vendor.update({
      where: { id: vendor.id },
      data: { bankAccountCipher: cipher },
    });
    return vendor.id;
  }

  /**
   * Five unmovable rows, then one genuinely rotatable row behind them.
   *
   * The walk orders by `id`, and these tests depend on the good row sorting
   * *after* the five malformed ones — otherwise the budget never traps anything
   * and the test would pass for the wrong reason. Prisma's `cuid()` is
   * timestamp-prefixed so creation order and id order agree in practice, but
   * "in practice" is not an assertion. The premise is therefore checked here
   * rather than assumed, so a change in id generation fails loudly instead of
   * quietly turning these into tests of nothing.
   */
  async function seedBudgetTrap(): Promise<string> {
    for (let index = 0; index < 5; index += 1) {
      await vendorWithRawCipher(`budget-mal-${index}`, MALFORMED);
    }
    const good = await vendorWithRawCipher('budget-good', 'placeholder');
    await context.prisma.vendor.update({
      where: { id: good },
      data: {
        bankAccountCipher: encrypt(PAYLOAD, keyringWith(K1, 'k1'), {
          purpose: 'vendor_bank_account',
          subjectId: good,
        }),
      },
    });

    const ordered = await context.prisma.vendor.findMany({
      where: { bankAccountCipher: { not: null } },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    expect(
      ordered.findIndex((row) => row.id === good),
      'the rotatable row must sort behind the five unmovable ones for this trap to mean anything',
    ).toBe(5);

    return good;
  }

  it('a single budget-limited pass stops early and reports where to resume', async () => {
    await seedBudgetTrap();
    const rotated = keyringWith(K2, 'k2', `k1:${K1}`);

    const first = await reEncryptVendorPayouts(context.prisma, rotated, {
      limit: 10,
      pageSize: 2,
      scanBudget: 5,
    });

    // It spent the whole budget on rows it could not move.
    expect(first.scanned).toBe(5);
    expect(first.reEncrypted).toBe(0);
    expect(first.exhausted).toBe(false);
    // The continuation cursor is the whole point: without it the next call has
    // no way to start anywhere but the beginning.
    expect(first.nextCursor).not.toBeNull();
  });

  it('resuming after the cursor reaches the row the budget could not', async () => {
    const good = await seedBudgetTrap();
    const rotated = keyringWith(K2, 'k2', `k1:${K1}`);

    const first = await reEncryptVendorPayouts(context.prisma, rotated, {
      limit: 10,
      pageSize: 2,
      scanBudget: 5,
    });
    expect(first.reEncrypted).toBe(0);

    const second = await reEncryptVendorPayouts(context.prisma, rotated, {
      limit: 10,
      pageSize: 2,
      scanBudget: 5,
      startAfterId: first.nextCursor,
    });

    expect(second.reEncrypted).toBe(1);

    const row = await context.prisma.vendor.findUniqueOrThrow({
      where: { id: good },
      select: { bankAccountCipher: true },
    });
    expect(envelopeKeyId(row.bankAccountCipher)).toBe('k2');
  });

  it('restarting from the beginning would never reach it — which is the bug', async () => {
    await seedBudgetTrap();
    const rotated = keyringWith(K2, 'k2', `k1:${K1}`);

    // Two passes that both start at the beginning, exactly as the orchestrator
    // used to do. Neither moves anything, for ever.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const pass = await reEncryptVendorPayouts(context.prisma, rotated, {
        limit: 10,
        pageSize: 2,
        scanBudget: 5,
        startAfterId: null,
      });
      expect(pass.reEncrypted).toBe(0);
      expect(pass.exhausted).toBe(false);
    }

    // Nothing moved, so the good row is still under the retired key. This is
    // the state the continuation cursor exists to escape.
    const survey = await surveyKeyUsage(context.prisma, keyringIdentity(rotated));
    expect(survey.rowsNeedingReEncryption).toBe(1);
  });

  it('reEncryptAll converges despite a budget smaller than the unmovable prefix', async () => {
    const good = await seedBudgetTrap();
    const rotated = keyringWith(K2, 'k2', `k1:${K1}`);

    const result = await reEncryptAll(context.prisma, rotated, {
      limit: 10,
      pageSize: 2,
      scanBudget: 5,
      maxPasses: 20,
    });

    // It took more than one pass, because one pass could not span the trap.
    expect(result.passes).toBeGreaterThan(1);
    // And it finished: the walk reached the end of the stale set.
    expect(result.payouts.exhausted).toBe(true);
    expect(result.payouts.reEncrypted).toBe(1);

    const row = await context.prisma.vendor.findUniqueOrThrow({
      where: { id: good },
      select: { bankAccountCipher: true },
    });
    expect(envelopeKeyId(row.bankAccountCipher)).toBe('k2');

    // Everything movable moved.
    expect(result.survey.rowsNeedingReEncryption).toBe(0);
  });

  it('the unmovable rows are untouched and still block retirement', async () => {
    await seedBudgetTrap();
    const rotated = keyringWith(K2, 'k2', `k1:${K1}`);

    await reEncryptAll(context.prisma, rotated, {
      limit: 10,
      pageSize: 2,
      scanBudget: 5,
      maxPasses: 20,
    });

    const untouched = await context.prisma.vendor.findMany({
      where: { slug: { startsWith: 'budget-mal-' } },
      select: { bankAccountCipher: true },
    });
    expect(untouched).toHaveLength(5);
    for (const row of untouched) {
      expect(row.bankAccountCipher).toBe(MALFORMED);
    }

    const survey = await surveyKeyUsage(context.prisma, keyringIdentity(rotated));
    expect(survey.malformedValues).toBe(5);
    expect(survey.safeToRetireOtherKeys).toBe(false);
  });

  it('terminates rather than looping for ever', async () => {
    await seedBudgetTrap();
    const rotated = keyringWith(K2, 'k2', `k1:${K1}`);

    // maxPasses is deliberately low. Even if convergence were broken, this
    // returns rather than hanging the suite.
    const result = await reEncryptAll(context.prisma, rotated, {
      limit: 1,
      pageSize: 1,
      scanBudget: 2,
      maxPasses: 25,
    });

    expect(result.passes).toBeLessThanOrEqual(25);
    expect(result.survey.rowsNeedingReEncryption).toBe(0);
  });

  it('applies to the MFA walk as well as the payout walk', async () => {
    // The two call sites share a walker, but each supplies its own fetch page,
    // so each needs its own proof that the cursor is threaded through.
    for (let index = 0; index < 5; index += 1) {
      const identity = await context.prisma.identity.create({
        data: { displayName: `Budget ${index}`, email: `budget-${index}@dashapp.test` },
        select: { id: true },
      });
      await context.prisma.identity.update({
        where: { id: identity.id },
        data: { mfaSecretCipher: MALFORMED },
      });
    }

    const good = await context.prisma.identity.create({
      data: { displayName: 'Budget good', email: 'budget-good@dashapp.test' },
      select: { id: true },
    });
    await context.prisma.identity.update({
      where: { id: good.id },
      data: {
        mfaSecretCipher: encrypt('JBSWY3DPEHPK3PXP', keyringWith(K1, 'k1'), {
          purpose: 'mfa_totp_secret',
          subjectId: good.id,
        }),
      },
    });

    const rotated = keyringWith(K2, 'k2', `k1:${K1}`);

    const first = await reEncryptMfaSecrets(context.prisma, rotated, {
      limit: 10,
      pageSize: 2,
      scanBudget: 3,
    });
    expect(first.reEncrypted).toBe(0);
    expect(first.nextCursor).not.toBeNull();

    const result = await reEncryptAll(context.prisma, rotated, {
      limit: 10,
      pageSize: 2,
      scanBudget: 3,
      maxPasses: 20,
    });
    expect(result.mfa.reEncrypted).toBe(1);

    const row = await context.prisma.identity.findUniqueOrThrow({
      where: { id: good.id },
      select: { mfaSecretCipher: true },
    });
    expect(envelopeKeyId(row.mfaSecretCipher)).toBe('k2');
  });

  it('reports no ciphertext or plaintext in any pass result', async () => {
    await seedBudgetTrap();
    const rotated = keyringWith(K2, 'k2', `k1:${K1}`);

    const result = await reEncryptAll(context.prisma, rotated, {
      limit: 10,
      pageSize: 2,
      scanBudget: 5,
      maxPasses: 20,
    });

    const rendered = JSON.stringify(result);
    expect(rendered).not.toContain('0123456789');
    expect(rendered).not.toContain(MALFORMED);
    expect(rendered).not.toContain(K1);
    expect(rendered).not.toContain(K2);
  });
});

// ---------------------------------------------------------------------------
// Review finding 5 — an empty string is malformed, not absent
// ---------------------------------------------------------------------------

describe('an empty encrypted column is malformed, not absent', () => {
  withDatabase();

  it('counts an empty payout cipher as malformed and blocks retirement', async () => {
    await context.prisma.vendor.update({
      where: { id: vendorId },
      data: { bankAccountCipher: '' },
    });

    const survey = await surveyKeyUsage(context.prisma, keyringIdentity(keyringWith(K1, 'k1')));

    expect(survey.malformedValues).toBe(1);
    expect(survey.safeToRetireOtherKeys).toBe(false);
    expect(survey.usage.find((entry) => entry.column === 'bankAccountCipher')?.malformed).toBe(1);
  });

  it('counts empty MFA columns as malformed', async () => {
    await context.prisma.identity.update({
      where: { id: context.identityId },
      data: { mfaSecretCipher: '', mfaPendingCipher: '' },
    });

    const survey = await surveyKeyUsage(context.prisma, keyringIdentity(keyringWith(K1, 'k1')));

    expect(survey.malformedValues).toBe(2);
    expect(survey.safeToRetireOtherKeys).toBe(false);
  });

  it('still treats null as absent, not malformed', async () => {
    // The distinction that matters: nothing was ever written to these columns,
    // which is the normal state for most rows and must stay silent.
    const survey = await surveyKeyUsage(context.prisma, keyringIdentity(keyringWith(K1, 'k1')));

    expect(survey.malformedValues).toBe(0);
    expect(survey.safeToRetireOtherKeys).toBe(true);
  });

  it('agrees with the rotation pass, which already treated it as malformed', async () => {
    await context.prisma.vendor.update({
      where: { id: vendorId },
      data: { bankAccountCipher: '' },
    });

    const rotated = keyringWith(K2, 'k2', `k1:${K1}`);
    const pass = await reEncryptVendorPayouts(context.prisma, rotated, { limit: 10 });
    const survey = await surveyKeyUsage(context.prisma, keyringIdentity(rotated));

    // Both halves of the system now say the same thing about the same row.
    expect(pass.malformed).toBe(1);
    expect(survey.malformedValues).toBe(1);
  });

  it('does not report the offending value', async () => {
    await context.prisma.vendor.update({
      where: { id: vendorId },
      data: { bankAccountCipher: '' },
    });

    const survey = await surveyKeyUsage(context.prisma, keyringIdentity(keyringWith(K1, 'k1')));
    expect(JSON.stringify(survey)).not.toContain('bankAccountCipher":""');
  });
});


// ---------------------------------------------------------------------------
// Review finding — a LIKE wildcard in the active-key prefix filter
//
// `KEY_ID_PATTERN` permits `_`, and Prisma compiles `startsWith` to SQL `LIKE`,
// where `_` matches any single character. An active key id of `k_1` therefore
// produced the pattern `v1.k_1.%`, which also matches `v1.ka1.%` — so a row
// written by a genuinely different, still-retired key was excluded from the
// stale set before `envelopeKeyId` ever saw it. Invisible to rotation,
// impossible to migrate, and the pass reported `exhausted` while it happened.
//
// Verified against this repository's SQLite path before the fix: with active
// `k_1` the stale set came back **empty** even though a `ka1` row was present.
//
// The fix removes the SQL narrowing entirely and compares key ids in
// application code, so no LIKE semantics are involved on either supported
// database. These tests pin that behaviour.
// ---------------------------------------------------------------------------

describe('an underscore in the active key id is not a wildcard', () => {
  withDatabase();

  /** Two 32-byte keys distinct from K1/K2/K3, for the underscore scenario. */
  const KU = Buffer.alloc(32, 0x55).toString('base64');
  const KA = Buffer.alloc(32, 0x66).toString('base64');

  const PAYLOAD = '{"bankName":"B","accountNumber":"0123456789","accountName":"N"}';

  async function newVendor(slug: string): Promise<string> {
    const cityId = (await context.prisma.city.findFirstOrThrow()).id;
    const vendor = await context.prisma.vendor.create({
      data: { cityId, name: slug, slug, category: 'restaurant' },
      select: { id: true },
    });
    return vendor.id;
  }

  it('accepts an underscore as a legal key id, as the envelope format claims', () => {
    // The format documents `_` as valid, so the fix must not quietly outlaw it
    // — that would strand any envelope or retired key already using one.
    expect(() => assembleKeyring({ activeKey: KU, activeKeyId: 'k_1' })).not.toThrow();
  });

  it('does not treat a ka1 row as already active when k_1 is the active key', async () => {
    // The exact collision: `ka1` differs from `k_1` in one character, which is
    // precisely what LIKE's `_` matches.
    const vendorOld = await newVendor('underscore-old');
    await context.prisma.vendor.update({
      where: { id: vendorOld },
      data: {
        bankAccountCipher: encrypt(PAYLOAD, keyringWith(KA, 'ka1'), {
          purpose: 'vendor_bank_account',
          subjectId: vendorOld,
        }),
      },
    });

    const rotated = keyringWith(KU, 'k_1', `ka1:${KA}`);

    // Before the fix this pass saw an empty stale set and moved nothing.
    const pass = await reEncryptVendorPayouts(context.prisma, rotated, { limit: 10 });
    expect(pass.reEncrypted).toBe(1);

    const row = await context.prisma.vendor.findUniqueOrThrow({
      where: { id: vendorOld },
      select: { bankAccountCipher: true },
    });
    expect(envelopeKeyId(row.bankAccountCipher)).toBe('k_1');

    // And the value survived the move.
    const reopened = await decryptPayoutDetailsForSettlement(context.prisma, rotated, vendorOld);
    expect(reopened.accountNumber).toBe('0123456789');
  });

  it('re-encrypts an old-key MFA secret under an underscored active key', async () => {
    await context.prisma.identity.update({
      where: { id: context.identityId },
      data: {
        mfaSecretCipher: encrypt('JBSWY3DPEHPK3PXP', keyringWith(KA, 'ka1'), {
          purpose: 'mfa_totp_secret',
          subjectId: context.identityId,
        }),
      },
    });

    const rotated = keyringWith(KU, 'k_1', `ka1:${KA}`);
    const pass = await reEncryptMfaSecrets(context.prisma, rotated, { limit: 10 });
    expect(pass.reEncrypted).toBe(1);

    const row = await context.prisma.identity.findUniqueOrThrow({
      where: { id: context.identityId },
      select: { mfaSecretCipher: true },
    });
    expect(envelopeKeyId(row.mfaSecretCipher)).toBe('k_1');
    expect(
      decrypt(row.mfaSecretCipher!, rotated, {
        purpose: 'mfa_totp_secret',
        subjectId: context.identityId,
      }).plaintext,
    ).toBe('JBSWY3DPEHPK3PXP');
  });

  it('leaves a genuinely active k_1 row untouched and readable', async () => {
    const vendorActive = await newVendor('underscore-active');
    const rotated = keyringWith(KU, 'k_1', `ka1:${KA}`);

    await setPayoutDetails(context.prisma, rotated, {
      vendorId: vendorActive,
      bankName: 'Synthetic Bank',
      accountNumber: '5555555555',
      accountName: 'Active Ltd',
    });

    const before = await context.prisma.vendor.findUniqueOrThrow({
      where: { id: vendorActive },
      select: { bankAccountCipher: true },
    });

    const pass = await reEncryptVendorPayouts(context.prisma, rotated, { limit: 10 });
    expect(pass.reEncrypted).toBe(0);
    expect(pass.alreadyActive).toBeGreaterThan(0);

    const after = await context.prisma.vendor.findUniqueOrThrow({
      where: { id: vendorActive },
      select: { bankAccountCipher: true },
    });
    // Byte-for-byte identical: an already-active row is not rewritten, so its
    // nonce does not churn and nothing about it changes.
    expect(after.bankAccountCipher).toBe(before.bankAccountCipher);

    const reopened = await decryptPayoutDetailsForSettlement(context.prisma, rotated, vendorActive);
    expect(reopened.accountNumber).toBe('5555555555');
    expect(reopened.needsReEncryption).toBe(false);
  });

  it('survives other one-character collisions too', async () => {
    // `kX1` is another string LIKE would have matched against `v1.k_1.%`.
    const KX = Buffer.alloc(32, 0x77).toString('base64');
    const vendorOld = await newVendor('underscore-kx');
    await context.prisma.vendor.update({
      where: { id: vendorOld },
      data: {
        bankAccountCipher: encrypt(PAYLOAD, keyringWith(KX, 'kX1'), {
          purpose: 'vendor_bank_account',
          subjectId: vendorOld,
        }),
      },
    });

    const rotated = keyringWith(KU, 'k_1', `kX1:${KX}`);
    expect((await reEncryptVendorPayouts(context.prisma, rotated, { limit: 10 })).reEncrypted).toBe(1);

    const row = await context.prisma.vendor.findUniqueOrThrow({
      where: { id: vendorOld },
      select: { bankAccountCipher: true },
    });
    expect(envelopeKeyId(row.bankAccountCipher)).toBe('k_1');
  });

  it('reaches retirement safety once the old-key rows are migrated', async () => {
    const vendorOld = await newVendor('underscore-retire');
    await context.prisma.vendor.update({
      where: { id: vendorOld },
      data: {
        bankAccountCipher: encrypt(PAYLOAD, keyringWith(KA, 'ka1'), {
          purpose: 'vendor_bank_account',
          subjectId: vendorOld,
        }),
      },
    });
    await context.prisma.identity.update({
      where: { id: context.identityId },
      data: {
        mfaSecretCipher: encrypt('JBSWY3DPEHPK3PXP', keyringWith(KA, 'ka1'), {
          purpose: 'mfa_totp_secret',
          subjectId: context.identityId,
        }),
      },
    });

    const rotated = keyringWith(KU, 'k_1', `ka1:${KA}`);

    const before = await surveyKeyUsage(context.prisma, keyringIdentity(rotated));
    expect(before.rowsNeedingReEncryption).toBe(2);
    expect(before.safeToRetireOtherKeys).toBe(false);

    const result = await reEncryptAll(context.prisma, rotated, { limit: 100 });

    expect(result.survey.rowsNeedingReEncryption).toBe(0);
    expect(result.survey.malformedValues).toBe(0);
    expect(result.survey.unknownKeyIds).toEqual([]);
    expect(result.survey.safeToRetireOtherKeys).toBe(true);
  });

  it('still distinguishes k1 from k10, which share a literal prefix', async () => {
    // The original prefix hazard, re-checked now that the comparison moved out
    // of SQL: `k1` must not swallow rows written by `k10`.
    const K10 = Buffer.alloc(32, 0x44).toString('base64');
    const vendorOld = await newVendor('prefix-k10');
    await context.prisma.vendor.update({
      where: { id: vendorOld },
      data: {
        bankAccountCipher: encrypt(PAYLOAD, keyringWith(K10, 'k10'), {
          purpose: 'vendor_bank_account',
          subjectId: vendorOld,
        }),
      },
    });

    const activeK1 = keyringWith(K1, 'k1', `k10:${K10}`);
    expect((await reEncryptVendorPayouts(context.prisma, activeK1, { limit: 10 })).reEncrypted).toBe(1);

    const row = await context.prisma.vendor.findUniqueOrThrow({
      where: { id: vendorOld },
      select: { bankAccountCipher: true },
    });
    expect(envelopeKeyId(row.bankAccountCipher)).toBe('k1');
  });

  it('a percent sign in a key id is not a wildcard either', async () => {
    // `%` is LIKE's multi-character wildcard. It is not in KEY_ID_PATTERN, so
    // it cannot reach the database — asserted here so that widening the pattern
    // later cannot quietly reintroduce a wildcard.
    expect(() => assembleKeyring({ activeKey: KU, activeKeyId: 'k%1' })).toThrow(EnvelopeError);
  });
});

// ---------------------------------------------------------------------------
// Failing closed
// ---------------------------------------------------------------------------

describe('a key that is not held', () => {
  withDatabase();

  it('refuses to decrypt rather than returning something', async () => {
    const k1Only = keyringWith(K1, 'k1');
    await setPayoutDetails(context.prisma, k1Only, {
      vendorId,
      bankName: 'Synthetic Bank',
      accountNumber: '0123456789',
      accountName: 'Rotation Kitchen Ltd',
    });

    // k1 destroyed too early: the row still names it, and nothing holds it.
    const k3Only = keyringWith(K3, 'k3');

    await expect(
      decryptPayoutDetailsForSettlement(context.prisma, k3Only, vendorId),
    ).rejects.toThrow(EnvelopeError);
  });

  it('is visible in a survey as an incident, not a rotation step', async () => {
    const k1Only = keyringWith(K1, 'k1');
    await setPayoutDetails(context.prisma, k1Only, {
      vendorId,
      bankName: 'Synthetic Bank',
      accountNumber: '0123456789',
      accountName: 'Rotation Kitchen Ltd',
    });

    const survey = await surveyKeyUsage(context.prisma, keyringIdentity(keyringWith(K3, 'k3')));

    // Naming the unreadable key ids is the whole point: it tells whoever is
    // paged exactly which key needs restoring.
    expect(survey.unknownKeyIds).toEqual(['k1']);
    expect(survey.safeToRetireOtherKeys).toBe(false);
  });

  it('reports no key value in the failure', async () => {
    const k1Only = keyringWith(K1, 'k1');
    await setPayoutDetails(context.prisma, k1Only, {
      vendorId,
      bankName: 'Synthetic Bank',
      accountNumber: '0123456789',
      accountName: 'Rotation Kitchen Ltd',
    });

    let message = '';
    try {
      await decryptPayoutDetailsForSettlement(context.prisma, keyringWith(K3, 'k3'), vendorId);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain('k1');
    expect(message).not.toContain(K1);
    expect(message).not.toContain(K3);
    expect(message).not.toContain('0123456789');
  });
});

// ---------------------------------------------------------------------------
// Custody: configurations that must not boot
// ---------------------------------------------------------------------------

describe('an ambiguous keyring is refused', () => {
  it('refuses one key id that is both active and retired', () => {
    // This used to be silently resolved in favour of the active entry. If the
    // two entries hold different material — which is exactly what a half-applied
    // rotation produces — that quietly makes every row written under the other
    // unreadable, with no error anywhere.
    expect(() => assembleKeyring({ activeKey: K2, activeKeyId: 'k1', retired: `k1:${K1}` })).toThrow(
      /both the active key and a retired key/,
    );
  });

  it('refuses the same material under two ids', () => {
    expect(() => assembleKeyring({ activeKey: K1, activeKeyId: 'k2', retired: `k1:${K1}` })).toThrow(
      /nothing has actually been rotated/,
    );
  });

  it('refuses a duplicate retired id', () => {
    expect(() =>
      assembleKeyring({ activeKey: K3, activeKeyId: 'k3', retired: `k1:${K1},k1:${K2}` }),
    ).toThrow(/appears more than once/);
  });

  it('refuses duplicate retired material under different ids', () => {
    expect(() =>
      assembleKeyring({ activeKey: K3, activeKeyId: 'k3', retired: `k1:${K1},k9:${K1}` }),
    ).toThrow(/repeats key material/);
  });

  it('refuses a malformed retired entry', () => {
    expect(() => assembleKeyring({ activeKey: K1, activeKeyId: 'k1', retired: 'no-colon' })).toThrow(
      /"id:base64key" form/,
    );
  });

  it('refuses a key id the envelope format could not carry', () => {
    // The dangerous one: without this, `encrypt` writes a value whose key id
    // cannot be parsed back out, so the row is correctly encrypted and
    // permanently unreadable.
    for (const badId of ['has.a.dot', 'has:a:colon', 'has a space', 'plus+sign', '']) {
      expect(() => assembleKeyring({ activeKey: K1, activeKeyId: badId }), badId).toThrow();
    }
  });

  it('refuses a retired key id the envelope format could not carry', () => {
    expect(() =>
      assembleKeyring({ activeKey: K2, activeKeyId: 'k2', retired: `bad.id:${K1}` }),
    ).toThrow();
  });

  it('never puts key material in the refusal', () => {
    let message = '';
    try {
      assembleKeyring({ activeKey: K2, activeKeyId: 'k1', retired: `k1:${K1}` });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).not.toContain(K1);
    expect(message).not.toContain(K2);
  });
});

describe('the boot-time keyring', () => {
  beforeEach(() => {
    resetConfigCache();
  });

  function env(overrides: Record<string, string>): NodeJS.ProcessEnv {
    return {
      NODE_ENV: 'test',
      DATABASE_URL: 'file:./rotation.db',
      JWT_ACCESS_SECRET: 'gJ7xQ2mV9wL4pR8sT1uY6zA3bC5dE0fH-access-KnMqPrSt',
      JWT_REFRESH_SECRET: 'Zx4Vn8Bq2Wr6Ty0Ui3Op5As7Df9Gh1Jk-refresh-LmNoPqRs',
      ENCRYPTION_KEY: K1,
      ENCRYPTION_KEY_ID: 'k1',
      ...overrides,
    };
  }

  function refusal(overrides: Record<string, string>): string {
    resetConfigCache();
    try {
      loadConfig(env(overrides));
      return '';
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  it('refuses a key id the envelope format could not carry', () => {
    expect(refusal({ ENCRYPTION_KEY_ID: 'k.1' })).toContain('ENCRYPTION_KEY_ID');
  });

  it('refuses an id that is both active and retired', () => {
    expect(refusal({ ENCRYPTION_KEYS_RETIRED: `k1:${K2}` })).toContain('ENCRYPTION_KEYS_RETIRED');
  });

  it('refuses retired keys with no active key', () => {
    // Not a decrypt-only mode: it can read old rows and write none, so it fails
    // at the first write rather than at boot.
    const message = refusal({
      ENCRYPTION_KEY: '',
      MFA_ENABLED: 'false',
      ENCRYPTION_KEYS_RETIRED: `k1:${K1}`,
    });
    expect(message).toContain('ENCRYPTION_KEYS_RETIRED');
  });

  it('builds a usable keyring from a valid rotation', () => {
    resetConfigCache();
    const config = loadConfig(env({ ENCRYPTION_KEY: K2, ENCRYPTION_KEY_ID: 'k2', ENCRYPTION_KEYS_RETIRED: `k1:${K1}` }));
    const keyring = buildKeyring(config);

    expect(keyring.active.keyId).toBe('k2');
    expect(keyring.retired.map((entry) => entry.keyId)).toEqual(['k1']);
  });
});
