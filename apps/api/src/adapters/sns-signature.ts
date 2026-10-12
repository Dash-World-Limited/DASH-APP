/**
 * Proving an SNS notification actually came from Amazon.
 *
 * The bounce endpoint has to be reachable by AWS, which means it is reachable
 * by everybody. Without this file it would be a public form for adding any
 * address to the suppression list — and suppressing an address is a denial of
 * service against one specific person's account, because it stops their
 * verification codes.
 *
 * SNS signs every message with an RSA private key and publishes the matching
 * certificate. Verification is four steps, and skipping any one of them makes
 * the other three worthless:
 *
 *   1. Rebuild the exact signed string from the message's own fields, in the
 *      order and format AWS specifies. Not the raw body — a signature over
 *      whatever JSON arrived would verify a message with extra fields spliced
 *      in.
 *   2. Refuse a certificate URL that is not an Amazon SNS HTTPS endpoint. This
 *      is the one that matters most: the URL comes from the attacker-controlled
 *      body, so without it a forged message simply points at a certificate the
 *      attacker owns and every signature verifies perfectly.
 *   3. Verify the signature with that certificate's public key.
 *   4. Refuse anything old enough to be a replay.
 *
 * The certificate is fetched over the network and cached, because AWS rotates
 * it rarely and fetching one per notification would make a bounce storm into a
 * self-inflicted outage.
 */

import { createVerify, X509Certificate } from 'node:crypto';

/** What SNS actually posts. Only the fields the signature covers. */
export interface SnsMessage {
  Type: string;
  MessageId: string;
  TopicArn: string;
  Subject?: string;
  Message: string;
  Timestamp: string;
  SignatureVersion: string;
  Signature: string;
  SigningCertURL?: string;
  SigningCertUrl?: string;
  SubscribeURL?: string;
  Token?: string;
}

/**
 * The fields signed, per message type, in the order AWS specifies.
 *
 * The order is part of the algorithm, not a stylistic choice: the signed string
 * is these keys and values concatenated in exactly this sequence.
 */
const SIGNED_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Notification: ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type'],
  SubscriptionConfirmation: [
    'Message',
    'MessageId',
    'SubscribeURL',
    'Timestamp',
    'Token',
    'TopicArn',
    'Type',
  ],
  UnsubscribeConfirmation: [
    'Message',
    'MessageId',
    'SubscribeURL',
    'Timestamp',
    'Token',
    'TopicArn',
    'Type',
  ],
};

/** Older than this is a replay, not a delivery. */
const MAX_AGE_MS = 60 * 60 * 1000;

export type SnsVerificationFailure =
  | 'unknown_type'
  | 'unsupported_signature_version'
  | 'untrusted_certificate_url'
  | 'certificate_unavailable'
  | 'bad_signature'
  | 'stale'
  | 'wrong_topic';

export class SnsVerificationError extends Error {
  constructor(readonly reason: SnsVerificationFailure) {
    super(`SNS message rejected: ${reason}`);
    this.name = 'SnsVerificationError';
  }
}

/**
 * Is this a certificate URL Amazon would actually publish?
 *
 * Parsed rather than pattern-matched. `https://sns.eu-west-1.amazonaws.com.evil
 * .example/cert.pem` contains the right substring and is somebody else's host;
 * only reading the parsed hostname catches it.
 */
export function isTrustedCertificateUrl(candidate: string): boolean {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return false;
  }

  if (url.protocol !== 'https:') return false;
  if (!url.pathname.endsWith('.pem')) return false;

  const host = url.hostname.toLowerCase();
  // `sns.<region>.amazonaws.com`, and nothing that merely ends with it after a
  // different label.
  return /^sns\.[a-z0-9-]+\.amazonaws\.com$/.test(host);
}

/** The exact string AWS signed. */
export function signedStringFor(message: SnsMessage): string {
  const fields = SIGNED_FIELDS[message.Type];
  if (!fields) throw new SnsVerificationError('unknown_type');

  let signed = '';
  for (const field of fields) {
    const value = (message as unknown as Record<string, unknown>)[field];
    // Absent optional fields are omitted entirely, key included. Emitting an
    // empty value instead produces a different string and never verifies.
    if (value === undefined || value === null) continue;
    signed += `${field}\n${String(value)}\n`;
  }
  return signed;
}

/** Certificates, kept so a bounce storm is not also a fetch storm. */
const certificateCache = new Map<string, { pem: string; fetchedAt: number }>();
const CERTIFICATE_TTL_MS = 24 * 60 * 60 * 1000;

export type CertificateFetcher = (url: string) => Promise<string>;

const fetchCertificate: CertificateFetcher = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new SnsVerificationError('certificate_unavailable');
  return await response.text();
};

export interface VerifyOptions {
  /** Only messages from this topic are accepted, when set. */
  expectedTopicArn?: string | undefined;
  /** Substituted in tests. Nothing else should pass one. */
  fetcher?: CertificateFetcher | undefined;
  now?: (() => Date) | undefined;
}

/**
 * Verify a message, or throw.
 *
 * Returns nothing on success: the caller's next step is to act on the message,
 * and a boolean return would be one `if` away from being ignored.
 */
export async function verifySnsMessage(
  message: SnsMessage,
  options: VerifyOptions = {},
): Promise<void> {
  const now = options.now?.() ?? new Date();

  if (!SIGNED_FIELDS[message.Type]) throw new SnsVerificationError('unknown_type');

  // SignatureVersion 1 is SHA1, 2 is SHA256. AWS still emits 1 by default and
  // both are accepted; anything else is a message this code does not
  // understand, and guessing is how a verification bypass happens.
  if (message.SignatureVersion !== '1' && message.SignatureVersion !== '2') {
    throw new SnsVerificationError('unsupported_signature_version');
  }

  if (options.expectedTopicArn && message.TopicArn !== options.expectedTopicArn) {
    // A valid signature from a topic we never subscribed to is still somebody
    // else's traffic.
    throw new SnsVerificationError('wrong_topic');
  }

  const timestamp = Date.parse(message.Timestamp);
  if (!Number.isFinite(timestamp) || now.getTime() - timestamp > MAX_AGE_MS) {
    throw new SnsVerificationError('stale');
  }

  const certificateUrl = message.SigningCertURL ?? message.SigningCertUrl;
  if (!certificateUrl || !isTrustedCertificateUrl(certificateUrl)) {
    throw new SnsVerificationError('untrusted_certificate_url');
  }

  const cached = certificateCache.get(certificateUrl);
  let pem: string;
  if (cached && now.getTime() - cached.fetchedAt < CERTIFICATE_TTL_MS) {
    pem = cached.pem;
  } else {
    pem = await (options.fetcher ?? fetchCertificate)(certificateUrl);
    certificateCache.set(certificateUrl, { pem, fetchedAt: now.getTime() });
  }

  let publicKey;
  try {
    publicKey = new X509Certificate(pem).publicKey;
  } catch {
    throw new SnsVerificationError('certificate_unavailable');
  }

  const verifier = createVerify(message.SignatureVersion === '2' ? 'RSA-SHA256' : 'RSA-SHA1');
  verifier.update(signedStringFor(message), 'utf8');

  if (!verifier.verify(publicKey, message.Signature, 'base64')) {
    throw new SnsVerificationError('bad_signature');
  }
}

/** Test seam. Never called in production. */
export function resetCertificateCache(): void {
  certificateCache.clear();
}
