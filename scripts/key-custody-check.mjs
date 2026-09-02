/**
 * Key custody drill — backup separation, rotation order, and fail-closed reads.
 *
 * **Every key in this run is generated in memory, used once, and discarded.**
 * Nothing is read from a secret store, nothing is written to disk, and no real
 * backup is created or touched. This is a rehearsal of the *procedure* in
 * `docs/KEY_MANAGEMENT.md`, using synthetic material, so the procedure can be
 * checked without anyone handling a production key.
 *
 *   npm run check:keys
 *
 * ## Why this exists alongside the test suite
 *
 * `apps/api/src/__tests__/key-rotation.test.ts` proves the rotation code works
 * against real storage. This proves something different and harder to unit-test:
 * that the **custody rules are the right rules**, by demonstrating the failure
 * each one prevents. Every section below deliberately reaches a broken state and
 * shows what it costs.
 *
 * The one that matters most is section 2. "Back the key up separately from the
 * database" reads like filing advice until you watch a restored database produce
 * nothing but ciphertext.
 */

import { randomBytes } from 'node:crypto';

const {
  assembleKeyring,
  decrypt,
  encrypt,
  envelopeKeyId,
  EnvelopeError,
} = await import('../packages/domain/src/envelope/index.ts');

let passed = 0;
let failed = 0;

const check = (label, ok, detail) => {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}`);
    if (detail !== undefined) console.log(`        ${detail}`);
  }
};

/**
 * Synthetic key material.
 *
 * Freshly random each run and never printed. If this script ever needs to show
 * a key to explain itself, the explanation is wrong.
 */
const newKey = () => randomBytes(32).toString('base64');

const k1 = newKey();
const k2 = newKey();
const k3 = newKey();

/** Stands in for a database row. Ciphertext only — never the plaintext. */
const context = { purpose: 'vendor_bank_account', subjectId: 'vendor-synthetic-1' };
const PLAINTEXT = JSON.stringify({
  bankName: 'Synthetic Bank',
  accountNumber: '0123456789',
  accountName: 'Synthetic Vendor Ltd',
});

console.log('\nDASH APP — key custody drill');
console.log('='.repeat(60));
console.log('Every key used here is random, generated for this run, and held only');
console.log('in memory. No real key is read, and no key value is ever printed.');

// ---------------------------------------------------------------------------
// 1. A key opens what it wrote, and only that
// ---------------------------------------------------------------------------

console.log('\n1. Baseline — the active key opens its own ciphertext');

const ringK1 = assembleKeyring({ activeKey: k1, activeKeyId: 'k1' });
const rowUnderK1 = encrypt(PLAINTEXT, ringK1, context);

check('the ciphertext names the key that wrote it', envelopeKeyId(rowUnderK1) === 'k1');
check('the active key opens it', decrypt(rowUnderK1, ringK1, context).plaintext === PLAINTEXT);
check(
  'the plaintext is not recoverable from the stored value itself',
  !rowUnderK1.includes('0123456789'),
);

// A different key of the same shape must not open it. This is the property the
// whole custody model rests on: the database is not enough.
const ringK3 = assembleKeyring({ activeKey: k3, activeKeyId: 'k3' });
let wrongKeyRefused = false;
try {
  decrypt(rowUnderK1.replace(/^v1\.k1\./, 'v1.k3.'), ringK3, context);
} catch (error) {
  wrongKeyRefused = error instanceof EnvelopeError;
}
check('a different key of the same shape cannot open it', wrongKeyRefused);

// ---------------------------------------------------------------------------
// 2. Backup separation — the rule this drill exists for
// ---------------------------------------------------------------------------

console.log('\n2. Backup separation — database and key are two halves');

// A restore that brought back the database and no keyring.
let restoredWithoutKey = null;
try {
  decrypt(rowUnderK1, assembleKeyring({ activeKey: k2, activeKeyId: 'k2' }), context);
  restoredWithoutKey = 'decrypted anyway';
} catch (error) {
  restoredWithoutKey = error instanceof EnvelopeError ? error.reason : 'unexpected error';
}
check(
  'a database backup restored WITHOUT its key yields nothing — the rows are unrecoverable',
  restoredWithoutKey === 'unknown_key',
  `expected unknown_key, got ${restoredWithoutKey}`,
);
console.log('        ^ This is why the key is backed up separately AND why losing it is final.');

// The inverse: a key backed up beside the database is one theft, not two.
check(
  'the converse rule holds by construction: one archive containing both halves defeats the encryption',
  true,
);
console.log('        ^ Not testable in code — it is a storage-location rule. See KEY_MANAGEMENT.md.');

// A restore that brought back the database and only the *active* key, having
// dropped the retired one. This is the subtle version, and the one people get
// wrong: the system boots, most rows read, and a minority are silently dead.
const ringK2Only = assembleKeyring({ activeKey: k2, activeKeyId: 'k2' });
const rowUnderK2 = encrypt(PLAINTEXT, ringK2Only, context);

check(
  'a partial keyring restore still opens rows written by the key it kept',
  decrypt(rowUnderK2, ringK2Only, context).plaintext === PLAINTEXT,
);

let partialRestore = null;
try {
  decrypt(rowUnderK1, ringK2Only, context);
  partialRestore = 'decrypted anyway';
} catch (error) {
  partialRestore = error instanceof EnvelopeError ? error.reason : 'unexpected error';
}
check(
  'and silently loses every row written by the retired key it dropped',
  partialRestore === 'unknown_key',
  `expected unknown_key, got ${partialRestore}`,
);
console.log('        ^ The restore procedure must restore ENCRYPTION_KEYS_RETIRED too.');

// ---------------------------------------------------------------------------
// 3. Rotation, in the documented order
// ---------------------------------------------------------------------------

console.log('\n3. Rotation — new key active, old key retained for reads');

const rotated = assembleKeyring({ activeKey: k2, activeKeyId: 'k2', retired: `k1:${k1}` });

const openedOld = decrypt(rowUnderK1, rotated, context);
check('a row written under k1 still opens after k2 becomes active', openedOld.plaintext === PLAINTEXT);
check('and reports that it was not the active key', openedOld.usedActiveKey === false);
check('which is the signal a re-encryption pass looks for', openedOld.keyId === 'k1');

const freshRow = encrypt(PLAINTEXT, rotated, context);
check('new writes use the new key', envelopeKeyId(freshRow) === 'k2');

// Re-encryption, then the retirement gate.
const movedRow = encrypt(decrypt(rowUnderK1, rotated, context).plaintext, rotated, context);
check('after re-encryption the row names k2', envelopeKeyId(movedRow) === 'k2');
check('and the value survived the move', decrypt(movedRow, rotated, context).plaintext === PLAINTEXT);

const afterRetirement = assembleKeyring({ activeKey: k2, activeKeyId: 'k2' });
check(
  'only now can k1 be removed without loss',
  decrypt(movedRow, afterRetirement, context).plaintext === PLAINTEXT,
);

// And the order matters. Removing k1 first is the mistake this gate prevents.
let removedTooEarly = null;
try {
  decrypt(rowUnderK1, afterRetirement, context);
  removedTooEarly = 'decrypted anyway';
} catch (error) {
  removedTooEarly = error instanceof EnvelopeError ? error.reason : 'unexpected error';
}
check(
  'removing k1 BEFORE re-encrypting destroys the rows that still name it',
  removedTooEarly === 'unknown_key',
  `expected unknown_key, got ${removedTooEarly}`,
);

// ---------------------------------------------------------------------------
// 4. Configurations that must not boot
// ---------------------------------------------------------------------------

console.log('\n4. Ambiguous custody is refused at boot');

const refuses = (label, build) => {
  let threw = false;
  let message = '';
  try {
    build();
  } catch (error) {
    threw = true;
    message = error instanceof Error ? error.message : String(error);
  }
  check(label, threw);
  // The refusal must name the problem without carrying the material.
  if (threw) {
    check(
      `  ...and its message carries no key material`,
      !message.includes(k1) && !message.includes(k2) && !message.includes(k3),
    );
  }
};

refuses('one id that is both active and retired', () =>
  assembleKeyring({ activeKey: k2, activeKeyId: 'k1', retired: `k1:${k1}` }),
);
refuses('the same material under two ids', () =>
  assembleKeyring({ activeKey: k1, activeKeyId: 'k2', retired: `k1:${k1}` }),
);
refuses('a duplicate retired id', () =>
  assembleKeyring({ activeKey: k3, activeKeyId: 'k3', retired: `k1:${k1},k1:${k2}` }),
);
refuses('a key id the envelope format cannot carry', () =>
  assembleKeyring({ activeKey: k1, activeKeyId: 'k.1' }),
);
refuses('an all-zero key', () =>
  assembleKeyring({ activeKey: Buffer.alloc(32).toString('base64'), activeKeyId: 'k1' }),
);
refuses('a key of the wrong length', () =>
  assembleKeyring({ activeKey: randomBytes(16).toString('base64'), activeKeyId: 'k1' }),
);

// ---------------------------------------------------------------------------
// 5. Environment separation
// ---------------------------------------------------------------------------

console.log('\n5. Environment separation');

// Staging and production hold different keys, so staging access is not
// production access. Demonstrated rather than asserted: a staging key applied
// to a production row must fail, not merely be discouraged in a document.
const stagingKey = assembleKeyring({ activeKey: newKey(), activeKeyId: 'staging-1' });
const productionRow = encrypt(PLAINTEXT, ringK1, context);

let crossEnvironment = null;
try {
  decrypt(productionRow.replace(/^v1\.k1\./, 'v1.staging-1.'), stagingKey, context);
  crossEnvironment = 'decrypted anyway';
} catch (error) {
  crossEnvironment = error instanceof EnvelopeError ? error.reason : 'unexpected error';
}
check(
  'a staging key cannot read a production row',
  crossEnvironment === 'decryption_failed',
  `expected decryption_failed, got ${crossEnvironment}`,
);

// Context binding, which is the other half of the separation story: one
// vendor's row must not open as another's even under the correct key.
let crossSubject = null;
try {
  decrypt(rowUnderK1, ringK1, { purpose: 'vendor_bank_account', subjectId: 'vendor-synthetic-2' });
  crossSubject = 'decrypted anyway';
} catch (error) {
  crossSubject = error instanceof EnvelopeError ? error.reason : 'unexpected error';
}
check(
  "one subject's row cannot be read as another's, even with the right key",
  crossSubject === 'decryption_failed',
);

let crossPurpose = null;
try {
  decrypt(rowUnderK1, ringK1, { purpose: 'mfa_totp_secret', subjectId: 'vendor-synthetic-1' });
  crossPurpose = 'decrypted anyway';
} catch (error) {
  crossPurpose = error instanceof EnvelopeError ? error.reason : 'unexpected error';
}
check('a payout envelope cannot be read as a TOTP secret', crossPurpose === 'decryption_failed');

// ---------------------------------------------------------------------------

console.log('\n' + '='.repeat(60));
console.log(`${passed} passed, ${failed} failed`);
console.log('No real key was read, and nothing generated here was written to disk.\n');

process.exit(failed === 0 ? 0 : 1);
