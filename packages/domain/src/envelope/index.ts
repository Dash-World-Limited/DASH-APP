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

/**
 * What a key id may contain.
 *
 * The envelope is dot-separated and base64url throughout, so a key id has to
 * survive being embedded in it and parsed back out. An id containing a dot, a
 * colon, or a plus sign produces ciphertext that this module can write but can
 * never read — the value is encrypted correctly and then lost, which is the
 * worst possible failure mode because nothing complains until a decrypt.
 *
 * Exported so configuration validation rejects such an id at boot rather than
 * at the first write. `config.ts` refers to this constant rather than repeating
 * the character class, so the two cannot drift apart.
 */
export const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const ENVELOPE_PATTERN =
  /^v(\d+)\.([A-Za-z0-9_-]{1,64})\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/;

/**
 * Reject a key id the envelope format could not carry.
 *
 * Throws rather than returning a boolean because every caller wants to stop.
 */
export function assertValidKeyId(keyId: string, label = 'key id'): void {
  if (!KEY_ID_PATTERN.test(keyId)) {
    throw new EnvelopeError(
      'bad_key',
      `${label} must be 1-64 characters of A-Z, a-z, 0-9, underscore, or hyphen — anything else cannot be read back out of an envelope`,
    );
  }
}

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
 * Canonical standard-alphabet base64, correctly padded.
 *
 * The repository's documented way to generate key material is
 * `randomBytes(32).toString('base64')`, which always produces exactly this
 * shape. Anything else is a typo, a truncation, or a paste from somewhere it
 * should not have been.
 */
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Parse a base64 key from configuration.
 *
 * Exported so config validation can reject bad key material at boot rather than
 * at the first write, which might be weeks later and in front of a user.
 *
 * **`Buffer.from(value, 'base64')` cannot be trusted on its own.** It never
 * throws: it silently discards any character outside the base64 alphabet and
 * tolerates missing padding. So a key with a mistyped character decodes to
 * *something*, and if that something happens to be 32 bytes long, a
 * length-only check waves it through — and the process then encrypts real data
 * under a key nobody can reproduce. An unpadded key is the same hazard in a
 * quieter form: it decodes to the right 32 bytes, so it works, while being a
 * different string from the one in the secret store.
 *
 * Three checks, in order, because each catches what the next cannot:
 *
 *   1. The alphabet and padding shape, which rejects mistyped characters
 *      outright rather than letting them be dropped.
 *   2. A re-encode round trip, which rejects any non-canonical spelling of the
 *      same bytes — missing padding, or padding in the wrong place.
 *   3. The decoded length and the all-zero check, in `assertValidKey`.
 */
export function parseKey(encoded: string, label = 'key'): Buffer {
  if (typeof encoded !== 'string' || encoded === '') {
    throw new EnvelopeError('bad_key', `${label} is empty`);
  }

  if (!BASE64_PATTERN.test(encoded)) {
    // Deliberately does not echo the offending characters: this message is
    // printed at boot, and the value it describes is key material.
    throw new EnvelopeError(
      'bad_key',
      `${label} is not valid base64 — it contains characters outside the base64 alphabet, or is padded incorrectly`,
    );
  }

  const decoded = Buffer.from(encoded, 'base64');

  if (decoded.toString('base64') !== encoded) {
    throw new EnvelopeError(
      'bad_key',
      `${label} is not canonical base64 — re-encoding the decoded bytes does not reproduce it, which usually means missing or excess padding`,
    );
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
  // Checked at the write, not only at boot. An id the format cannot carry
  // would produce a value that encrypts fine and can never be decrypted, and
  // the loss would be silent until someone tried to read it back.
  assertValidKeyId(keyring.active.keyId, 'active key id');
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

/**
 * Which key wrote this envelope, without decrypting it.
 *
 * The key id travels in the clear as the second field, which is what makes this
 * possible and is the reason the format puts it there. A rotation needs to
 * answer "which rows still name the old key?" over a whole table, and doing
 * that by decrypting every row would mean holding every key, doing real
 * cryptography per row, and touching plaintext that nothing needed to see.
 *
 * Returns null for anything that is not a parseable envelope, so a caller can
 * distinguish "written by a key I do not hold" from "not encrypted at all".
 */
export function envelopeKeyId(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const match = ENVELOPE_PATTERN.exec(value);
  return match ? match[2]! : null;
}

// ---------------------------------------------------------------------------
// Keyring assembly
//
// What makes a set of keys coherent lives here rather than in the API's
// configuration module, because two callers need the same answer and one of
// them cannot reach the other. `apps/api/src/config.ts` builds the runtime
// keyring; `packages/db/src/seed.ts` builds one to enrol development staff, and
// `@dash/db` sits below `apps/api` so it cannot import from it.
//
// Before this existed the seed assembled a keyring by hand and skipped every
// rule below, which meant a key id the envelope format cannot carry would be
// caught at API boot and not caught at all by the seed — a row written by the
// seed and unreadable by the API.
//
// These functions are pure: they take strings and return keys. Nothing here
// reads an environment variable, which is what keeps `@dash/domain` free of I/O.
// ---------------------------------------------------------------------------

/**
 * Parse `id:base64key,id2:base64key2` into retired keys.
 *
 * Every rejection here describes a rotation that has been half-applied, and
 * they all fail the same expensive way: rows that cannot be decrypted,
 * discovered weeks later.
 */
export function parseRetiredKeys(raw: string): EncryptionKey[] {
  const trimmed = raw.trim();
  if (trimmed === '') return [];

  const seenIds = new Set<string>();
  const seenMaterial: Buffer[] = [];

  return trimmed.split(',').map((entry, index) => {
    const separator = entry.indexOf(':');
    if (separator <= 0) {
      throw new EnvelopeError(
        'bad_key',
        `retired key ${index + 1} is not in "id:base64key" form`,
      );
    }

    const keyId = entry.slice(0, separator).trim();
    const encoded = entry.slice(separator + 1).trim();

    // The id has to survive being written into an envelope and parsed back out,
    // exactly as the active id does. A retired id the format cannot carry could
    // never have written a row, so its presence means the list is wrong.
    assertValidKeyId(keyId, `retired key id "${keyId}"`);

    if (seenIds.has(keyId)) {
      throw new EnvelopeError('bad_key', `retired key id "${keyId}" appears more than once`);
    }
    seenIds.add(keyId);

    const key = parseKey(encoded, `retired key "${keyId}"`);

    // Two ids over one key is ambiguous in the other direction: a row naming
    // either id decrypts, so nothing breaks, but the operator's model of which
    // key is where is wrong — and that model is what a retirement decision is
    // made from.
    if (seenMaterial.some((existing) => existing.equals(key))) {
      throw new EnvelopeError(
        'bad_key',
        `retired key "${keyId}" repeats key material already listed under another id`,
      );
    }
    seenMaterial.push(key);

    return { keyId, key };
  });
}

export interface KeyringInput {
  /** Base64 of exactly 32 bytes. */
  readonly activeKey: string;
  readonly activeKeyId: string;
  /** `id:base64key,...`. Empty or omitted when nothing has been rotated yet. */
  readonly retired?: string | undefined;
}

/**
 * Assemble a keyring, refusing anything ambiguous.
 *
 * The rule that matters most: a key id may not be both active and retired. An
 * earlier version dropped the retired entry and carried on, reasoning that the
 * active entry should win. That was wrong. If the two entries hold *different*
 * key material, picking one silently makes every row written under the other
 * unreadable, with no error anywhere. Which of the two rotation steps was
 * skipped is not something this function can know, so it refuses to guess.
 */
export function assembleKeyring(input: KeyringInput): Keyring {
  assertValidKeyId(input.activeKeyId, 'active key id');

  const active: EncryptionKey = {
    keyId: input.activeKeyId,
    key: parseKey(input.activeKey, 'active key'),
  };

  const retired = parseRetiredKeys(input.retired ?? '');

  if (retired.some((entry) => entry.keyId === active.keyId)) {
    throw new EnvelopeError(
      'bad_key',
      `Key id "${active.keyId}" appears as both the active key and a retired key — refusing to guess which one wrote existing rows`,
    );
  }

  if (retired.some((entry) => entry.key.equals(active.key))) {
    throw new EnvelopeError(
      'bad_key',
      'A retired key holds the same material as the active key under a different id — nothing has actually been rotated',
    );
  }

  return { active, retired };
}
