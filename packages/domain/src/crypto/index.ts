/**
 * Password, OTP, and token hashing.
 *
 * Lives in the domain package because both the API and the seed script need one
 * shared implementation — two hashing implementations is how a "your password
 * is wrong" bug that only affects seeded accounts gets born.
 *
 * Node's built-in crypto only. No native build step, nothing to install.
 */

import {
  createHash,
  randomBytes,
  randomInt,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
) => Promise<Buffer>;

/**
 * scrypt parameters.
 *
 * N=16384, r=8, p=1 is the widely-cited interactive baseline — roughly 100ms
 * and 16MB per hash on commodity hardware. Deliberately slow: the cost is paid
 * once per login and makes an offline dictionary attack on a leaked table
 * expensive rather than trivial.
 *
 * Argon2id would be the stronger modern choice. It needs a native module, which
 * this environment cannot build; scrypt is the best option with zero install
 * cost, and the hash format below carries a version tag so migrating later is a
 * matter of re-hashing on next successful login.
 */
const SCRYPT_KEY_LENGTH = 64;
const SALT_BYTES = 16;
const HASH_VERSION = 's1';

/**
 * Hash a password. Output format: `s1$<salt-hex>$<hash-hex>`.
 *
 * The salt is embedded rather than stored separately so a hash is
 * self-verifying and there is no second column to forget to migrate.
 */
export async function hashPassword(password: string): Promise<string> {
  if (password.length === 0) throw new Error('Cannot hash an empty password');
  const salt = randomBytes(SALT_BYTES);
  const derived = await scrypt(password, salt, SCRYPT_KEY_LENGTH);
  return `${HASH_VERSION}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

/**
 * Verify a password against a stored hash.
 *
 * Uses `timingSafeEqual`, and returns false rather than throwing on a malformed
 * stored hash — a corrupt row must fail closed, not crash the login route.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== HASH_VERSION) return false;

  const [, saltHex, expectedHex] = parts;
  if (!saltHex || !expectedHex) return false;

  try {
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(expectedHex, 'hex');
    if (expected.length !== SCRYPT_KEY_LENGTH) return false;

    const actual = await scrypt(password, salt, SCRYPT_KEY_LENGTH);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/**
 * Generate a numeric OTP.
 *
 * `randomInt` is the CSPRNG-backed generator — `Math.random()` is predictable
 * and must never produce a credential. Leading zeros are preserved by padding,
 * so "004821" stays six digits.
 */
export function generateOtp(digits = 6): string {
  if (digits < 4 || digits > 10) throw new Error(`OTP length ${digits} is out of range`);
  const max = 10 ** digits;
  return String(randomInt(0, max)).padStart(digits, '0');
}

/** Hash an OTP for storage. Same construction as a password — it is one. */
export async function hashOtp(code: string): Promise<string> {
  return hashPassword(code);
}

export async function verifyOtp(code: string, stored: string): Promise<boolean> {
  return verifyPassword(code, stored);
}

/**
 * Generate an opaque, high-entropy token — refresh tokens, pickup codes,
 * idempotency keys. 32 bytes base64url is 256 bits, which is not brute-forcible.
 */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * Hash a token for storage.
 *
 * Plain SHA-256, deliberately — unlike a password, a refresh token already has
 * full entropy, so there is no dictionary to attack and no need for a slow KDF.
 * Using scrypt here would add latency to every token refresh for no security
 * gain. Storing the hash still means a database leak yields nothing usable.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Constant-time comparison of two hex digests. */
export function tokenMatches(token: string, storedHash: string): boolean {
  const actual = Buffer.from(hashToken(token), 'hex');
  let expected: Buffer;
  try {
    expected = Buffer.from(storedHash, 'hex');
  } catch {
    return false;
  }
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/**
 * Short human-readable reference, e.g. `DASH-7F3K2M`.
 *
 * The alphabet excludes I, O, 0, and 1 because these codes are read aloud on
 * support calls and written on packaging. Random, not sequential — a sequential
 * order code leaks daily volume to anyone who places two orders.
 */
const READABLE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generateReference(prefix: string, length = 6): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    // Modulo bias across a 32-character alphabet from 256 values is negligible
    // (256 = 8 × 32 exactly), so no rejection sampling is needed here.
    out += READABLE_ALPHABET[(bytes[i] ?? 0) % READABLE_ALPHABET.length];
  }
  return `${prefix}-${out}`;
}

/**
 * Numeric delivery PIN read aloud by the customer to the rider.
 *
 * Four digits is only 10,000 possibilities, which is fine because it is
 * single-use, tied to one order, and rate-limited to a few attempts — but it is
 * the reason the attempt limit is not optional.
 */
export function generatePin(digits = 4): string {
  return generateOtp(digits);
}
