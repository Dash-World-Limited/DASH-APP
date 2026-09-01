/**
 * Administrator multi-factor authentication.
 *
 * TOTP (RFC 6238) via `otplib`, with the secret held as an AES-256-GCM envelope
 * bound to the identity that owns it.
 *
 * The shape of the login flow is the security-relevant part:
 *
 *   password  →  MfaChallenge (opaque, 5 min, single-use, NOT a session)
 *             →  TOTP or recovery code
 *             →  Session + refresh cookie
 *
 * No session exists until the second factor succeeds. That is deliberate: a
 * stolen intermediate token cannot be refreshed, cannot call a business
 * endpoint, and expires in minutes. Issuing a "partially authenticated" session
 * and upgrading it later would leave a usable credential lying around in
 * exactly the window an attacker is operating in.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { NobleCryptoPlugin, ScureBase32Plugin, TOTP } from 'otplib';
import { hashToken, generateToken } from '@dash/domain/crypto';
import { decrypt, encrypt, type Keyring } from '@dash/domain/envelope';
import {
  MFA_CHALLENGE_TTL_SECONDS,
  MFA_ENROLMENT_TTL_SECONDS,
  MFA_EPOCH_TOLERANCE_SECONDS,
  MFA_MAX_ATTEMPTS,
  RECOVERY_CODE_ALPHABET,
  RECOVERY_CODE_COUNT,
  formatRecoveryCode,
  normaliseRecoveryCode,
  requiresMfa,
} from '@dash/domain/mfa';
import type { Role } from '@dash/domain/permissions';
import type { PrismaClient } from '@dash/db';

/**
 * `sha1` is the RFC 6238 default and the only algorithm every authenticator app
 * supports. It is used here as an HMAC, where the collision weaknesses that
 * retired SHA-1 for signatures do not apply. Changing it would lock out Google
 * Authenticator and most hardware tokens for no real gain.
 */
const totp = new TOTP({
  crypto: new NobleCryptoPlugin(),
  base32: new ScureBase32Plugin(),
  algorithm: 'sha1',
  digits: 6,
  period: 30,
});

export const TOTP_ISSUER = 'DASH APP';

export type MfaPurpose = 'login' | 'step_up' | 'disable' | 'recovery_regenerate';

export class MfaError extends Error {
  constructor(
    readonly reason:
      | 'not_enrolled'
      | 'already_enrolled'
      | 'no_pending_enrolment'
      | 'enrolment_expired'
      | 'invalid_code'
      | 'replayed_code'
      | 'challenge_not_found'
      | 'challenge_expired'
      | 'too_many_attempts'
      | 'not_configured',
    message: string,
  ) {
    super(message);
    this.name = 'MfaError';
  }
}

/** Bind every TOTP envelope to this identity and this field. */
function secretContext(identityId: string) {
  return { purpose: 'mfa_totp_secret', subjectId: identityId };
}

// ---------------------------------------------------------------------------
// Enrolment
// ---------------------------------------------------------------------------

export interface EnrolmentOffer {
  /** Shown once, as a QR code and as text for manual entry. */
  readonly secret: string;
  readonly otpauthUri: string;
}

/**
 * Begin enrolment.
 *
 * The secret is stored in `mfaPendingCipher`, never in `mfaSecretCipher`, so it
 * cannot authenticate anything until possession has been proved. Starting a new
 * enrolment therefore cannot lock anyone out of a working authenticator either.
 */
export async function startEnrolment(
  prisma: PrismaClient,
  keyring: Keyring,
  identity: { id: string; email: string | null; phone: string | null },
): Promise<EnrolmentOffer> {
  const secret = totp.generateSecret();

  await prisma.identity.update({
    where: { id: identity.id },
    data: {
      mfaPendingCipher: encrypt(secret, keyring, secretContext(identity.id)),
      mfaPendingAt: new Date(),
    },
  });

  const label = identity.email ?? identity.phone ?? identity.id;

  return {
    secret,
    otpauthUri: totp.toURI({ secret, label, issuer: TOTP_ISSUER }),
  };
}

export interface ConfirmedEnrolment {
  readonly recoveryCodes: readonly string[];
}

/**
 * Prove possession and activate.
 *
 * Only here does the pending secret become the live one. The accepted time step
 * is recorded immediately so the confirming code cannot then be replayed as a
 * login.
 */
export async function confirmEnrolment(
  prisma: PrismaClient,
  keyring: Keyring,
  identityId: string,
  code: string,
): Promise<ConfirmedEnrolment> {
  const identity = await prisma.identity.findUnique({
    where: { id: identityId },
    select: { id: true, mfaPendingCipher: true, mfaPendingAt: true, mfaEnrolledAt: true },
  });

  if (!identity?.mfaPendingCipher || !identity.mfaPendingAt) {
    throw new MfaError('no_pending_enrolment', 'There is no enrolment waiting to be confirmed.');
  }

  const ageSeconds = (Date.now() - identity.mfaPendingAt.getTime()) / 1000;
  if (ageSeconds > MFA_ENROLMENT_TTL_SECONDS) {
    // Clear it rather than leaving a stale secret sitting in the row.
    await prisma.identity.update({
      where: { id: identityId },
      data: { mfaPendingCipher: null, mfaPendingAt: null },
    });
    throw new MfaError('enrolment_expired', 'That enrolment has expired. Start again.');
  }

  const secret = decrypt(identity.mfaPendingCipher, keyring, secretContext(identityId)).plaintext;

  const result = await totp.verify(code, {
    secret,
    epochTolerance: MFA_EPOCH_TOLERANCE_SECONDS,
  });

  if (!result.valid) {
    throw new MfaError('invalid_code', 'That code is not correct.');
  }

  const recoveryCodes = generateRecoveryCodes();

  await prisma.$transaction(async (tx) => {
    await tx.identity.update({
      where: { id: identityId },
      data: {
        mfaSecretCipher: identity.mfaPendingCipher,
        mfaEnrolledAt: new Date(),
        mfaPendingCipher: null,
        mfaPendingAt: null,
        // Burn the confirming step so it cannot be reused to sign in.
        mfaLastTimeStep: result.timeStep,
      },
    });

    // Any codes from a previous enrolment are void.
    await tx.mfaRecoveryCode.deleteMany({ where: { identityId } });
    await tx.mfaRecoveryCode.createMany({
      data: recoveryCodes.map((plain) => ({
        identityId,
        codeHash: hashToken(normaliseRecoveryCode(plain)),
        batch: 1,
      })),
    });
  });

  return { recoveryCodes };
}

/** True when this identity has a confirmed, usable second factor. */
export function isMfaActive(identity: {
  mfaSecretCipher: string | null;
  mfaEnrolledAt: Date | null;
}): boolean {
  // Both, not either. A secret without a confirmation is a half-finished
  // enrolment; a confirmation without a secret is a corrupt row. Neither should
  // be treated as protection.
  return identity.mfaSecretCipher !== null && identity.mfaEnrolledAt !== null;
}

/** True when this identity's roles demand MFA that is not yet active. */
export function mfaSetupRequired(
  identity: { mfaSecretCipher: string | null; mfaEnrolledAt: Date | null },
  roles: readonly Role[],
): boolean {
  return requiresMfa(roles) && !isMfaActive(identity);
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/**
 * Verify a TOTP code against the live secret and record the step.
 *
 * Replay protection is the reason this writes: `afterTimeStep` makes otplib
 * reject any step at or below the last accepted one, so the same six digits
 * cannot be used twice even inside the 30-second window they are displayed for.
 * Without it, a code shoulder-surfed or captured in transit stays valid for the
 * remainder of its period.
 */
export async function verifyTotp(
  prisma: PrismaClient,
  keyring: Keyring,
  identityId: string,
  code: string,
): Promise<void> {
  const identity = await prisma.identity.findUnique({
    where: { id: identityId },
    select: { mfaSecretCipher: true, mfaEnrolledAt: true, mfaLastTimeStep: true },
  });

  if (!identity || !isMfaActive(identity)) {
    throw new MfaError('not_enrolled', 'This account does not have an authenticator set up.');
  }

  const secret = decrypt(identity.mfaSecretCipher!, keyring, secretContext(identityId)).plaintext;

  const result = await totp.verify(code, {
    secret,
    epochTolerance: MFA_EPOCH_TOLERANCE_SECONDS,
    ...(identity.mfaLastTimeStep !== null ? { afterTimeStep: identity.mfaLastTimeStep } : {}),
  });

  if (!result.valid) {
    // A correct-but-already-used code and a wrong code are reported the same
    // way. Distinguishing them would tell an attacker replaying a captured code
    // that they had the right digits.
    throw new MfaError('invalid_code', 'That code is not correct.');
  }

  await prisma.identity.update({
    where: { id: identityId },
    data: { mfaLastTimeStep: result.timeStep },
  });
}

// ---------------------------------------------------------------------------
// Recovery codes
// ---------------------------------------------------------------------------

/**
 * Generate a batch of codes.
 *
 * `randomBytes` rather than `Math.random`. The modulo below is over a 30-
 * character alphabet from 256 values, which is very slightly biased; rejection
 * sampling removes it. The bias would be tiny, but "tiny bias in a credential"
 * is not a sentence worth writing.
 */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  const alphabet = RECOVERY_CODE_ALPHABET;

  // 16 characters over a 30-character alphabet is ~78 bits, comfortably above
  // a clean four groups of four to read out.
  const CODE_LENGTH = 16;

  // 240 = floor(256 / 30) * 30. Bytes at or above it are discarded so every
  // character is equally likely; taking the modulo of all 256 would make the
  // first six characters slightly more common.
  const limit = Math.floor(256 / alphabet.length) * alphabet.length;

  const codes: string[] = [];

  while (codes.length < count) {
    let code = '';
    while (code.length < CODE_LENGTH) {
      for (const byte of randomBytes(32)) {
        if (byte >= limit) continue;
        code += alphabet[byte % alphabet.length];
        if (code.length === CODE_LENGTH) break;
      }
    }
    codes.push(formatRecoveryCode(code));
  }

  return codes;
}

/**
 * Redeem a recovery code.
 *
 * Single-use, enforced by an `updateMany` guarded on `usedAt: null` — two
 * simultaneous requests with the same code cannot both succeed, because only
 * one of them matches a row.
 */
export async function consumeRecoveryCode(
  prisma: PrismaClient,
  identityId: string,
  supplied: string,
  ipAddress: string | null,
): Promise<void> {
  const normalised = normaliseRecoveryCode(supplied);
  if (normalised.length === 0) throw new MfaError('invalid_code', 'That code is not correct.');

  const hash = hashToken(normalised);

  const claimed = await prisma.mfaRecoveryCode.updateMany({
    where: { identityId, codeHash: hash, usedAt: null },
    data: { usedAt: new Date(), usedIp: ipAddress },
  });

  if (claimed.count === 0) {
    throw new MfaError('invalid_code', 'That code is not correct.');
  }
}

/**
 * Issue a fresh batch, voiding every unused code from earlier batches.
 *
 * Used codes are kept: "which code was redeemed, and when" must stay
 * answerable during an investigation, and deleting them would erase that.
 */
export async function regenerateRecoveryCodes(
  prisma: PrismaClient,
  identityId: string,
): Promise<string[]> {
  const codes = generateRecoveryCodes();

  const latest = await prisma.mfaRecoveryCode.findFirst({
    where: { identityId },
    orderBy: { batch: 'desc' },
    select: { batch: true },
  });
  const nextBatch = (latest?.batch ?? 0) + 1;

  await prisma.$transaction(async (tx) => {
    await tx.mfaRecoveryCode.deleteMany({ where: { identityId, usedAt: null } });
    await tx.mfaRecoveryCode.createMany({
      data: codes.map((plain) => ({
        identityId,
        codeHash: hashToken(normaliseRecoveryCode(plain)),
        batch: nextBatch,
      })),
    });
  });

  return codes;
}

// ---------------------------------------------------------------------------
// Challenges
// ---------------------------------------------------------------------------

export interface IssuedChallenge {
  readonly challengeToken: string;
  readonly expiresAt: Date;
}

export async function createChallenge(
  prisma: PrismaClient,
  identityId: string,
  purpose: MfaPurpose,
  context: { ipAddress?: string | null; userAgent?: string | null } = {},
): Promise<IssuedChallenge> {
  const challengeToken = generateToken(32);
  const expiresAt = new Date(Date.now() + MFA_CHALLENGE_TTL_SECONDS * 1000);

  // Starting a new challenge retires any outstanding one for the same purpose,
  // so a user cannot accumulate parallel challenges and multiply their attempts.
  await prisma.mfaChallenge.updateMany({
    where: { identityId, purpose, consumedAt: null },
    data: { consumedAt: new Date() },
  });

  await prisma.mfaChallenge.create({
    data: {
      identityId,
      tokenHash: hashToken(challengeToken),
      purpose,
      maxAttempts: MFA_MAX_ATTEMPTS,
      ipAddress: context.ipAddress ?? null,
      userAgent: context.userAgent ?? null,
      expiresAt,
    },
  });

  return { challengeToken, expiresAt };
}

export interface OpenChallenge {
  readonly id: string;
  readonly identityId: string;
  readonly purpose: string;
}

/**
 * Look up a live challenge and burn one attempt.
 *
 * The attempt is spent *before* the code is checked, so a crash or a dropped
 * connection mid-verify cannot be used to get unlimited tries.
 */
export async function claimChallengeAttempt(
  prisma: PrismaClient,
  challengeToken: string,
  purpose: MfaPurpose,
): Promise<OpenChallenge> {
  const challenge = await prisma.mfaChallenge.findUnique({
    where: { tokenHash: hashToken(challengeToken) },
    select: {
      id: true,
      identityId: true,
      purpose: true,
      attempts: true,
      maxAttempts: true,
      consumedAt: true,
      expiresAt: true,
    },
  });

  if (!challenge || challenge.consumedAt || challenge.purpose !== purpose) {
    throw new MfaError('challenge_not_found', 'That sign-in attempt is no longer valid.');
  }

  if (challenge.expiresAt.getTime() < Date.now()) {
    throw new MfaError('challenge_expired', 'That sign-in attempt has expired. Start again.');
  }

  if (challenge.attempts >= challenge.maxAttempts) {
    await prisma.mfaChallenge.update({
      where: { id: challenge.id },
      data: { consumedAt: new Date() },
    });
    throw new MfaError('too_many_attempts', 'Too many incorrect codes. Start again.');
  }

  await prisma.mfaChallenge.update({
    where: { id: challenge.id },
    data: { attempts: { increment: 1 } },
  });

  return { id: challenge.id, identityId: challenge.identityId, purpose: challenge.purpose };
}

/**
 * Mark a challenge used.
 *
 * Guarded on `consumedAt: null` so two requests racing with the same token
 * cannot both succeed — only one `updateMany` matches a row.
 */
export async function consumeChallenge(prisma: PrismaClient, challengeId: string): Promise<void> {
  const consumed = await prisma.mfaChallenge.updateMany({
    where: { id: challengeId, consumedAt: null },
    data: { consumedAt: new Date() },
  });

  if (consumed.count === 0) {
    throw new MfaError('challenge_not_found', 'That sign-in attempt is no longer valid.');
  }
}

/**
 * Turn MFA off and wipe every artefact of it.
 *
 * Callers must have completed a fresh step-up first; this function does not
 * check that, because the route is where authorization belongs.
 */
export async function disableMfa(prisma: PrismaClient, identityId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.identity.update({
      where: { id: identityId },
      data: {
        mfaSecretCipher: null,
        mfaPendingCipher: null,
        mfaPendingAt: null,
        mfaEnrolledAt: null,
        mfaLastTimeStep: null,
      },
    });
    await tx.mfaRecoveryCode.deleteMany({ where: { identityId } });
    await tx.mfaChallenge.updateMany({
      where: { identityId, consumedAt: null },
      data: { consumedAt: new Date() },
    });
  });
}

/** Constant-time comparison for opaque tokens supplied by a client. */
export function tokensMatch(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
