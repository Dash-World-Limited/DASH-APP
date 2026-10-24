import { describe, expect, it } from 'vitest';
import {
  assembleKeyring,
  assertValidKey,
  assertValidKeyId,
  decrypt,
  encrypt,
  EnvelopeError,
  envelopeKeyId,
  generateKey,
  isEnvelope,
  KEY_BYTES,
  parseKey,
  parseRetiredKeys,
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

// ---------------------------------------------------------------------------
// Keyring assembly
//
// These rules used to live in `apps/api/src/config.ts`, which meant the
// development seed — which sits below `apps/api` and cannot import it — built
// keyrings by hand under weaker rules. They live here now, so they are tested
// here: a domain module that is only exercised from an application suite is a
// module whose own package cannot tell when it breaks.
// ---------------------------------------------------------------------------

/** Deterministic synthetic material. Fills, not randomness, so failures repeat. */
const KEY_A = Buffer.alloc(KEY_BYTES, 0xa1).toString('base64');
const KEY_B = Buffer.alloc(KEY_BYTES, 0xb2).toString('base64');
const KEY_C = Buffer.alloc(KEY_BYTES, 0xc3).toString('base64');

describe('base64 key parsing is strict', () => {
  // `Buffer.from(value, 'base64')` never throws: it silently discards any
  // character outside the alphabet and tolerates missing padding. A key with a
  // mistyped character therefore decodes to *something*, and a length-only
  // check waves it through if that something is 32 bytes — after which the
  // process encrypts real data under a key nobody can reproduce.

  it('accepts the canonical form the repository documents', () => {
    // node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
    const canonical = generateKey();
    expect(canonical).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(parseKey(canonical)).toHaveLength(KEY_BYTES);
  });

  it('accepts a deterministic canonical key', () => {
    expect(parseKey(Buffer.alloc(KEY_BYTES, 0x2a).toString('base64'))).toHaveLength(KEY_BYTES);
  });

  it('rejects characters outside the base64 alphabet', () => {
    const canonical = Buffer.alloc(KEY_BYTES, 0x2a).toString('base64');

    for (const bad of [
      canonical.replace(/^./, '!'),
      canonical.replace(/^./, ' '),
      canonical.replace(/^./, '@'),
      canonical.replace(/^./, '\n'),
      'not-base64-at-all!!',
    ]) {
      expect(() => parseKey(bad), JSON.stringify(bad.slice(0, 12))).toThrow(EnvelopeError);
    }
  });

  it('rejects base64url, which is a different spelling of the same key', () => {
    // base64url is legitimate elsewhere in the envelope — the nonce, ciphertext,
    // and tag all use it — but a key has one documented spelling. Accepting
    // both would mean the same key material could be configured two ways, and
    // an operator comparing a deployed value against the secret store would see
    // a mismatch that is not one.
    const urlAlphabet = Buffer.from(
      // Chosen so the standard encoding definitely contains both `+` and `/`.
      'fb ff bf fe ef bb 3e 3f fa af ab ba 7e 7f be af cd ef 01 23 45 67 89 ab cd ef fe dc ba 98 76 54'
        .split(' ')
        .map((byte) => Number.parseInt(byte, 16)),
    ).toString('base64');

    expect(urlAlphabet).toMatch(/[+/]/);
    const asUrl = urlAlphabet.replace(/\+/g, '-').replace(/\//g, '_');

    expect(asUrl).not.toBe(urlAlphabet);
    expect(() => parseKey(asUrl)).toThrow(EnvelopeError);
    // The standard spelling of the very same bytes is accepted.
    expect(parseKey(urlAlphabet)).toHaveLength(KEY_BYTES);
  });

  it('rejects an invalid character even when the discarded remainder is 32 bytes', () => {
    // The exact hazard: Node drops the bad characters, the rest happens to
    // decode to a valid length, and a length-only check accepts a key that is
    // not the key anyone stored.
    const canonical = Buffer.alloc(KEY_BYTES, 0x3b).toString('base64');
    const withJunk = canonical.slice(0, 10) + '!!!' + canonical.slice(10);

    expect(Buffer.from(withJunk, 'base64')).toHaveLength(KEY_BYTES);
    expect(() => parseKey(withJunk)).toThrow(EnvelopeError);
  });

  it('rejects missing padding, which decodes to the right bytes anyway', () => {
    const canonical = Buffer.alloc(KEY_BYTES, 0x11).toString('base64');
    const unpadded = canonical.replace(/=+$/, '');

    // Proof the old length-only check would have accepted it.
    expect(Buffer.from(unpadded, 'base64')).toHaveLength(KEY_BYTES);
    expect(() => parseKey(unpadded)).toThrow(/canonical/);
  });

  it('rejects excess padding', () => {
    const canonical = Buffer.alloc(KEY_BYTES, 0x11).toString('base64');
    expect(() => parseKey(canonical + '=')).toThrow(EnvelopeError);
  });

  it('rejects the wrong decoded length', () => {
    expect(() => parseKey(Buffer.alloc(16).fill(9).toString('base64'))).toThrow(/32 bytes/);
    expect(() => parseKey(Buffer.alloc(64).fill(9).toString('base64'))).toThrow(/32 bytes/);
    expect(() => parseKey('c2hvcnQ=')).toThrow(/32 bytes/);
  });

  it('rejects an all-zero key', () => {
    expect(() => parseKey(Buffer.alloc(KEY_BYTES).toString('base64'))).toThrow(/all zero bytes/);
  });

  it('rejects an empty value', () => {
    expect(() => parseKey('')).toThrow(EnvelopeError);
  });

  it('puts no key material in any refusal message', () => {
    const canonical = Buffer.alloc(KEY_BYTES, 0x5d).toString('base64');
    const cases = [
      canonical.replace(/=+$/, ''),
      canonical + '=',
      canonical.slice(0, 10) + '!!!' + canonical.slice(10),
      Buffer.alloc(16, 4).toString('base64'),
    ];

    for (const bad of cases) {
      let message = '';
      try {
        parseKey(bad, 'ENCRYPTION_KEY');
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }

      expect(message).toContain('ENCRYPTION_KEY');
      // Neither the offending value nor the canonical key it was derived from.
      expect(message, `leaked for ${bad.slice(0, 8)}`).not.toContain(bad);
      expect(message).not.toContain(canonical);
    }
  });
});

describe('key ids', () => {
  it('accepts what the envelope format can carry', () => {
    for (const id of ['k1', 'live-1', 'staging_2', 'a'.repeat(64)]) {
      expect(() => assertValidKeyId(id), id).not.toThrow();
    }
  });

  it('refuses what it cannot', () => {
    // The envelope is dot-separated and base64url throughout. An id outside
    // that character set is written into ciphertext that can never be parsed
    // back out — the value encrypts fine and is permanently unreadable, with
    // nothing complaining until a decrypt.
    for (const id of ['has.a.dot', 'has:colon', 'has space', 'plus+sign', '', 'a'.repeat(65)]) {
      expect(() => assertValidKeyId(id), JSON.stringify(id)).toThrow(EnvelopeError);
    }
  });

  it('refuses to encrypt under an id the format cannot carry', () => {
    // Checked at the write as well as at boot, so no path can produce an
    // unreadable row.
    const bad: Keyring = { active: { keyId: 'bad.id', key: parseKey(KEY_A) }, retired: [] };
    expect(() => encrypt('secret', bad, CONTEXT)).toThrow(EnvelopeError);
  });
});

describe('envelopeKeyId', () => {
  it('reads the writing key id without decrypting', () => {
    // This is what lets a rotation survey scan a whole table with no key
    // material and no cryptography per row.
    expect(envelopeKeyId(encrypt('v', keyring('k7'), CONTEXT))).toBe('k7');
  });

  it('returns null for anything that is not an envelope', () => {
    // Distinguishing "written by a key I do not hold" from "not encrypted at
    // all" is the difference between an incident and a no-op.
    expect(envelopeKeyId('plain text')).toBeNull();
    expect(envelopeKeyId(null)).toBeNull();
    expect(envelopeKeyId(undefined)).toBeNull();
  });
});

describe('parseRetiredKeys', () => {
  it('parses an empty list', () => {
    expect(parseRetiredKeys('')).toEqual([]);
    expect(parseRetiredKeys('   ')).toEqual([]);
  });

  it('parses several entries and tolerates surrounding whitespace', () => {
    const parsed = parseRetiredKeys(` k1:${KEY_A} , k2:${KEY_B} `);
    expect(parsed.map((entry) => entry.keyId)).toEqual(['k1', 'k2']);
    expect(parsed[0]!.key).toHaveLength(KEY_BYTES);
  });

  it('refuses an entry that is not in id:key form', () => {
    expect(() => parseRetiredKeys('no-colon-here')).toThrow(/"id:base64key" form/);
    expect(() => parseRetiredKeys(`:${KEY_A}`)).toThrow(/"id:base64key" form/);
  });

  it('refuses a duplicate id', () => {
    expect(() => parseRetiredKeys(`k1:${KEY_A},k1:${KEY_B}`)).toThrow(/more than once/);
  });

  it('refuses the same material under two ids', () => {
    expect(() => parseRetiredKeys(`k1:${KEY_A},k2:${KEY_A}`)).toThrow(/repeats key material/);
  });

  it('refuses an id the envelope format cannot carry', () => {
    expect(() => parseRetiredKeys(`bad.id:${KEY_A}`)).toThrow(EnvelopeError);
  });

  it('refuses malformed key material', () => {
    expect(() => parseRetiredKeys('k1:not-a-32-byte-key')).toThrow(EnvelopeError);
  });
});

describe('assembleKeyring', () => {
  it('builds an active-only keyring', () => {
    const ring = assembleKeyring({ activeKey: KEY_A, activeKeyId: 'k1' });
    expect(ring.active.keyId).toBe('k1');
    expect(ring.retired).toEqual([]);
  });

  it('carries retired keys so rotation needs no migration', () => {
    const ring = assembleKeyring({ activeKey: KEY_B, activeKeyId: 'k2', retired: `k1:${KEY_A}` });
    expect(ring.active.keyId).toBe('k2');
    expect(ring.retired.map((entry) => entry.keyId)).toEqual(['k1']);

    // And the retired key genuinely still opens what it wrote.
    const old = encrypt('v', assembleKeyring({ activeKey: KEY_A, activeKeyId: 'k1' }), CONTEXT);
    expect(decrypt(old, ring, CONTEXT).usedActiveKey).toBe(false);
  });

  it('refuses one id that is both active and retired', () => {
    // Previously this dropped the retired entry and carried on. If the two hold
    // different material — which is what a half-applied rotation looks like —
    // that silently makes every row written under the other unreadable.
    expect(() =>
      assembleKeyring({ activeKey: KEY_B, activeKeyId: 'k1', retired: `k1:${KEY_A}` }),
    ).toThrow(/both the active key and a retired key/);
  });

  it('refuses the active material appearing as a retired key', () => {
    expect(() =>
      assembleKeyring({ activeKey: KEY_A, activeKeyId: 'k2', retired: `k1:${KEY_A}` }),
    ).toThrow(/nothing has actually been rotated/);
  });

  it('refuses an active id the envelope format cannot carry', () => {
    expect(() => assembleKeyring({ activeKey: KEY_A, activeKeyId: 'k.1' })).toThrow(EnvelopeError);
  });

  it('refuses malformed active key material', () => {
    expect(() => assembleKeyring({ activeKey: 'nope', activeKeyId: 'k1' })).toThrow(EnvelopeError);
    expect(() =>
      assembleKeyring({ activeKey: Buffer.alloc(KEY_BYTES).toString('base64'), activeKeyId: 'k1' }),
    ).toThrow(/all zero bytes/);
  });

  it('never puts key material in a refusal message', () => {
    let message = '';
    try {
      assembleKeyring({ activeKey: KEY_C, activeKeyId: 'k1', retired: `k1:${KEY_A}` });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain('k1');
    expect(message).not.toContain(KEY_A);
    expect(message).not.toContain(KEY_C);
  });
});
