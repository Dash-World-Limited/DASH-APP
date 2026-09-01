/**
 * Authenticated encryption for secrets held at rest.
 *
 * AES-256-GCM from `node:crypto`. This module writes no cryptography of its
 * own: it composes a standard AEAD construction and adds the envelope format,
 * key-version handling, and context binding around it.
 *
 * Two callers today — the TOTP secret behind administrator MFA, and vendor bank
 * details. Both need the same three properties:
 *
 *   1. **Confidentiality.** A database leak yields ciphertext, not secrets.
 *   2. **Integrity.** GCM's tag means tampering fails loudly rather than
 *      decrypting to something attacker-chosen.
 *   3. **Context binding.** The ciphertext is bound to *what it is and whose it
 *      is* via additional authenticated data, so a row copied from one vendor
 *      to another fails to decrypt instead of silently working.
 *
 * The key never appears here. It is supplied by the caller, which keeps this
 * module pure and keeps key material out of `packages/domain` entirely.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/** AES-256-GCM. 32-byte key, 12-byte nonce, 16-byte tag. */
const ALGORITHM = 'aes-256-gcm';
export const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Envelope format: `v<version>.<keyId>.<nonce>.<ciphertext>.<tag>`
 *
 * Base64url throughout so the whole thing is a safe single-line database value.
 *
 * `keyId` travels with the ciphertext so a key can be rotated without a
 * migration: new writes use the new key, old rows still name the key that
 * encrypted them, and a background re-encryption can proceed at its own pace.
 * Without it, rotation means "decrypt everything during a deploy", which is how
 * rotations get postponed forever.
 */
const ENVELOPE_VERSION = 1;
const ENVELOPE_PATTERN =
  /^v(\d+)\.([A-Za-z0-9_-]{1,64})\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/;

export class EnvelopeError extends Error {
  constructor(
    readonly reason:
      | 'bad_key'
      | 'bad_envelope'
      | 'unknown_key'
      | 'unsupported_version'
      | 'decryption_failed'
      | 'bad_context',
    message: string,
  ) {
    super(message);
    this.name = 'EnvelopeError';
  }
}

/** A key and the identifier recorded alongside anything it encrypts. */
export interface EncryptionKey {
  readonly keyId: string;
  readonly key: Buffer;
}

/**
 * The keyring: one key used for new writes, plus any older keys still needed to
 * read rows that have not been re-encrypted yet.
 */
export interface Keyring {
  readonly active: EncryptionKey;
  readonly retired: readonly EncryptionKey[];
}

/**
 * What the ciphertext is bound to.
 *
 * `purpose` distinguishes field types (a TOTP secret must not be swappable with
 * a bank account number) and `subjectId` distinguishes owners (vendor A's row
 * must not decrypt under vendor B's identity). Both are authenticated but not
 * encrypted — they are not secret, they are what makes the ciphertext
 * non-transferable.
 */
export interface EncryptionContext {
  readonly purpose: string;
  readonly subjectId: string;
}

function encodeContext(context: EncryptionContext): Buffer {
  if (!context.purpose || !context.subjectId) {
    throw new EnvelopeError('bad_context', 'Encryption context requires a purpose and a subject');
  }
  // Length-prefixed rather than delimiter-joined: with a plain separator,
  // ("ab", "c") and ("a", "bc") would produce identical additional data, which
  // would let a ciphertext move between contexts undetected.
  return Buffer.from(
    `${context.purpose.length}:${context.purpose}|${context.subjectId.length}:${context.subjectId}`,
    'utf8',
  );
}

export function assertValidKey(key: Buffer, label = 'key'): void {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    const got = Buffer.isBuffer(key) ? `${key.length} bytes` : typeof key;
    throw new EnvelopeError('bad_key', `${label} must be exactly ${KEY_BYTES} bytes (got ${got})`);
  }
  // An all-zero key is almost certainly an unset environment variable that has
  // been base64-decoded into the right length by accident.
  if (timingSafeEqual(key, Buffer.alloc(KEY_BYTES))) {
    throw new EnvelopeError('bad_key', `${label} is all zero bytes — it has not been configured`);
  }
}

/**
 * Parse a base64 key from configuration.
 *
 * Exported so config validation can reject bad key material at boot rather than
 * at the first write, which might be weeks later and in front of a user.
 */
export function parseKey(encoded: string, label = 'key'): Buffer {
  let decoded: Buffer;
  try {
    decoded = Buffer.from(encoded, 'base64');
  } catch {
    throw new EnvelopeError('bad_key', `${label} is not valid base64`);
  }
  assertValidKey(decoded, label);
  return decoded;
}

/** Generate key material. Used by tooling and tests, never at runtime. */
export function generateKey(): string {
  return randomBytes(KEY_BYTES).toString('base64');
}

export function encrypt(
  plaintext: string,
  keyring: Keyring,
  context: EncryptionContext,
): string {
  assertValidKey(keyring.active.key, 'active key');
  if (plaintext.length === 0) {
    throw new EnvelopeError('bad_envelope', 'Refusing to encrypt an empty value');
  }

  // A fresh random nonce per encryption. Reuse under GCM is catastrophic — it
  // leaks the XOR of two plaintexts and enables tag forgery — so it is
  // generated here and never derived from anything caller-supplied.
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, keyring.active.key, nonce);
  cipher.setAAD(encodeContext(context));

  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    `v${ENVELOPE_VERSION}`,
    keyring.active.keyId,
    nonce.toString('base64url'),
    ciphertext.toString('base64url'),
    tag.toString('base64url'),
  ].join('.');
}

export interface DecryptedEnvelope {
  readonly plaintext: string;
  /** Which key opened it — non-active means the row is due for re-encryption. */
  readonly keyId: string;
  readonly usedActiveKey: boolean;
}

export function decrypt(
  envelope: string,
  keyring: Keyring,
  context: EncryptionContext,
): DecryptedEnvelope {
  const match = ENVELOPE_PATTERN.exec(envelope);
  if (!match) throw new EnvelopeError('bad_envelope', 'Value is not a valid encryption envelope');

  const versionRaw = match[1]!;
  const keyId = match[2]!;
  const nonceRaw = match[3]!;
  const ciphertextRaw = match[4]!;
  const tagRaw = match[5]!;

  if (Number(versionRaw) !== ENVELOPE_VERSION) {
    throw new EnvelopeError(
      'unsupported_version',
      `Envelope version ${versionRaw} is not supported by this build`,
    );
  }

  const candidate =
    keyring.active.keyId === keyId
      ? keyring.active
      : keyring.retired.find((entry) => entry.keyId === keyId);

  if (!candidate) {
    // Named a key we do not hold. Usually a partially rolled-back rotation.
    throw new EnvelopeError('unknown_key', `No key available for key id "${keyId}"`);
  }

  const nonce = Buffer.from(nonceRaw, 'base64url');
  const ciphertext = Buffer.from(ciphertextRaw, 'base64url');
  const tag = Buffer.from(tagRaw, 'base64url');

  if (nonce.length !== NONCE_BYTES || tag.length !== TAG_BYTES) {
    throw new EnvelopeError('bad_envelope', 'Envelope nonce or tag is the wrong length');
  }

  try {
    const decipher = createDecipheriv(ALGORITHM, candidate.key, nonce);
    decipher.setAAD(encodeContext(context));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
      'utf8',
    );

    return { plaintext, keyId, usedActiveKey: keyId === keyring.active.keyId };
  } catch {
    // Deliberately one reason for every failure mode below this line: wrong
    // key, tampered ciphertext, tampered tag, or mismatched context. Telling a
    // caller *which* would help an attacker work out what they got wrong.
    throw new EnvelopeError(
      'decryption_failed',
      'Value could not be decrypted — wrong key, wrong context, or it has been tampered with',
    );
  }
}

/** True when a stored value looks like an envelope this build can parse. */
export function isEnvelope(value: string | null | undefined): boolean {
  return typeof value === 'string' && ENVELOPE_PATTERN.test(value);
}
