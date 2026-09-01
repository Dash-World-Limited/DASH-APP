import { describe, expect, it } from 'vitest';
import {
  assertValidKey,
  decrypt,
  encrypt,
  EnvelopeError,
  generateKey,
  isEnvelope,
  KEY_BYTES,
  parseKey,
  type EncryptionContext,
  type Keyring,
} from './index.js';

function keyring(activeId = 'k1'): Keyring {
  return { active: { keyId: activeId, key: Buffer.from(parseKey(generateKey())) }, retired: [] };
}

const CONTEXT: EncryptionContext = { purpose: 'mfa_totp_secret', subjectId: 'identity_1' };

describe('key material', () => {
  it('generates a key of exactly the required length', () => {
    expect(parseKey(generateKey())).toHaveLength(KEY_BYTES);
  });

  it('rejects a key of the wrong length', () => {
    expect(() => assertValidKey(Buffer.alloc(16))).toThrow(EnvelopeError);
    expect(() => assertValidKey(Buffer.alloc(64))).toThrow(EnvelopeError);
  });

  it('rejects an all-zero key — that is an unset variable, not a key', () => {
    expect(() => assertValidKey(Buffer.alloc(KEY_BYTES))).toThrow(/all zero/);
  });

  it('rejects base64 that decodes to the wrong length', () => {
    expect(() => parseKey('c2hvcnQ=')).toThrow(EnvelopeError);
  });
});

describe('round trip', () => {
  it('decrypts what it encrypted', () => {
    const ring = keyring();
    const envelope = encrypt('JBSWY3DPEHPK3PXP', ring, CONTEXT);
    expect(decrypt(envelope, ring, CONTEXT).plaintext).toBe('JBSWY3DPEHPK3PXP');
  });

  it('never emits the plaintext inside the envelope', () => {
    const ring = keyring();
    const secret = 'JBSWY3DPEHPK3PXP';
    expect(encrypt(secret, ring, CONTEXT)).not.toContain(secret);
  });

  it('produces a different envelope every time — nonces are never reused', () => {
    const ring = keyring();
    const envelopes = new Set(
      Array.from({ length: 200 }, () => encrypt('same-plaintext', ring, CONTEXT)),
    );
    expect(envelopes.size).toBe(200);
  });

  it('handles unicode and long values', () => {
    const ring = keyring();
    const value = `Ọlá ${'x'.repeat(2000)} ₦`;
    expect(decrypt(encrypt(value, ring, CONTEXT), ring, CONTEXT).plaintext).toBe(value);
  });

  it('refuses to encrypt an empty value', () => {
    expect(() => encrypt('', keyring(), CONTEXT)).toThrow(EnvelopeError);
  });

  it('reports which key opened the value', () => {
    const ring = keyring('active-key');
    const result = decrypt(encrypt('v', ring, CONTEXT), ring, CONTEXT);
    expect(result.keyId).toBe('active-key');
    expect(result.usedActiveKey).toBe(true);
  });
});

describe('integrity', () => {
  it('rejects a tampered ciphertext', () => {
    const ring = keyring();
    const envelope = encrypt('JBSWY3DPEHPK3PXP', ring, CONTEXT);
    const parts = envelope.split('.');
    // Flip a character in the ciphertext segment.
    parts[3] = parts[3]!.startsWith('A') ? `B${parts[3]!.slice(1)}` : `A${parts[3]!.slice(1)}`;
    expect(() => decrypt(parts.join('.'), ring, CONTEXT)).toThrow(/tampered/);
  });

  it('rejects a tampered authentication tag', () => {
    const ring = keyring();
    const parts = encrypt('secret', ring, CONTEXT).split('.');
    parts[4] = parts[4]!.startsWith('A') ? `B${parts[4]!.slice(1)}` : `A${parts[4]!.slice(1)}`;
    expect(() => decrypt(parts.join('.'), ring, CONTEXT)).toThrow(EnvelopeError);
  });

  it('rejects a swapped nonce', () => {
    const ring = keyring();
    const a = encrypt('first', ring, CONTEXT).split('.');
    const b = encrypt('second', ring, CONTEXT).split('.');
    a[2] = b[2]!;
    expect(() => decrypt(a.join('.'), ring, CONTEXT)).toThrow(EnvelopeError);
  });

  it('rejects a malformed envelope', () => {
    const ring = keyring();
    for (const bad of ['', 'nonsense', 'v1.k1.only.three', 'v1.k1.a.b.c.d.e', '....']) {
      expect(() => decrypt(bad, ring, CONTEXT)).toThrow(EnvelopeError);
    }
  });

  it('rejects an unsupported envelope version', () => {
    const ring = keyring();
    const parts = encrypt('secret', ring, CONTEXT).split('.');
    parts[0] = 'v9';
    expect(() => decrypt(parts.join('.'), ring, CONTEXT)).toThrow(/not supported/);
  });
});

describe('context binding', () => {
  it('refuses to decrypt under a different subject', () => {
    // The point of the whole mechanism: a row copied from one vendor to
    // another must not decrypt, even though the key is identical.
    const ring = keyring();
    const envelope = encrypt('0123456789', ring, { purpose: 'bank', subjectId: 'vendor_a' });
    expect(() => decrypt(envelope, ring, { purpose: 'bank', subjectId: 'vendor_b' })).toThrow(
      EnvelopeError,
    );
  });

  it('refuses to decrypt under a different purpose', () => {
    // A TOTP secret must not be readable as if it were a bank account number.
    const ring = keyring();
    const envelope = encrypt('JBSWY3DPEHPK3PXP', ring, {
      purpose: 'mfa_totp_secret',
      subjectId: 'identity_1',
    });
    expect(() => decrypt(envelope, ring, { purpose: 'bank', subjectId: 'identity_1' })).toThrow(
      EnvelopeError,
    );
  });

  it('is not fooled by a context whose parts concatenate the same way', () => {
    // Without length-prefixing, ("ab","c") and ("a","bc") would authenticate
    // identically and a ciphertext could move between them undetected.
    const ring = keyring();
    const envelope = encrypt('v', ring, { purpose: 'ab', subjectId: 'c' });
    expect(() => decrypt(envelope, ring, { purpose: 'a', subjectId: 'bc' })).toThrow(EnvelopeError);
  });

  it('requires both a purpose and a subject', () => {
    const ring = keyring();
    expect(() => encrypt('v', ring, { purpose: '', subjectId: 's' })).toThrow(EnvelopeError);
    expect(() => encrypt('v', ring, { purpose: 'p', subjectId: '' })).toThrow(EnvelopeError);
  });
});

describe('key rotation', () => {
  it('reads a value written by a retired key', () => {
    const oldKey = { keyId: 'k1', key: parseKey(generateKey()) };
    const newKey = { keyId: 'k2', key: parseKey(generateKey()) };

    const before: Keyring = { active: oldKey, retired: [] };
    const envelope = encrypt('JBSWY3DPEHPK3PXP', before, CONTEXT);

    const after: Keyring = { active: newKey, retired: [oldKey] };
    const result = decrypt(envelope, after, CONTEXT);

    expect(result.plaintext).toBe('JBSWY3DPEHPK3PXP');
    expect(result.keyId).toBe('k1');
    // Flags the row as due for re-encryption without forcing it now.
    expect(result.usedActiveKey).toBe(false);
  });

  it('writes new values under the active key only', () => {
    const oldKey = { keyId: 'k1', key: parseKey(generateKey()) };
    const newKey = { keyId: 'k2', key: parseKey(generateKey()) };
    const after: Keyring = { active: newKey, retired: [oldKey] };

    expect(decrypt(encrypt('v', after, CONTEXT), after, CONTEXT).usedActiveKey).toBe(true);
  });

  it('fails loudly when the naming key is not held', () => {
    const written = encrypt('v', { active: { keyId: 'gone', key: parseKey(generateKey()) }, retired: [] }, CONTEXT);
    const other: Keyring = { active: { keyId: 'k2', key: parseKey(generateKey()) }, retired: [] };
    expect(() => decrypt(written, other, CONTEXT)).toThrow(/No key available/);
  });

  it('refuses a value encrypted under a different key of the same id', () => {
    // Same key id, different bytes — a rotation done wrong.
    const written = encrypt('v', { active: { keyId: 'k1', key: parseKey(generateKey()) }, retired: [] }, CONTEXT);
    const impostor: Keyring = { active: { keyId: 'k1', key: parseKey(generateKey()) }, retired: [] };
    expect(() => decrypt(written, impostor, CONTEXT)).toThrow(/tampered|decrypted/);
  });
});

describe('isEnvelope', () => {
  it('recognises a real envelope', () => {
    expect(isEnvelope(encrypt('v', keyring(), CONTEXT))).toBe(true);
  });

  it('rejects plaintext, null, and undefined', () => {
    expect(isEnvelope('0123456789')).toBe(false);
    expect(isEnvelope(null)).toBe(false);
    expect(isEnvelope(undefined)).toBe(false);
  });
});
