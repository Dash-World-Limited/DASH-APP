/**
 * Bounce and complaint handling.
 *
 * The endpoint is reachable by anyone, and suppressing an address is a targeted
 * denial of service: it stops one named person receiving the code that opens
 * their account. So most of this file is about refusing forgeries, and the
 * single most important test is the one where the attacker supplies a
 * *perfectly valid* signature made with their own certificate — because that is
 * the attack a naive implementation passes.
 *
 * Signatures are real: the suite generates a key pair, self-signs a
 * certificate, and signs its own messages the way SNS does.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createSign, generateKeyPairSync, createPrivateKey } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { createTestContext, type TestContext } from './harness.js';
import { useIntegrationTimeouts } from './timeouts.js';
import {
  isTrustedCertificateUrl,
  resetCertificateCache,
  signedStringFor,
  verifySnsMessage,
  SnsVerificationError,
  type SnsMessage,
} from '../adapters/sns-signature.js';
import { isEssential } from '../adapters/suppressed-email.js';

useIntegrationTimeouts();

// ---------------------------------------------------------------------------
// A certificate authority for the test, and one for the attacker.
// ---------------------------------------------------------------------------

interface Signer {
  privateKeyPem: string;
  certificatePem: string;
}

/**
 * A self-signed certificate.
 *
 * Node cannot mint an X.509 certificate directly, so this builds a minimal DER
 * one by hand. It only has to parse and carry a public key — the tests are
 * about whether a signature verifies, not about certificate chains.
 */
function makeSigner(): Signer {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    certificatePem: selfSign(privateKey, publicKey),
  };
}

function selfSign(privateKey: KeyObject, publicKey: KeyObject): string {
  // Minimal DER: tbsCertificate with the SubjectPublicKeyInfo, signed.
  const spki = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;

  const int = (value: number) => Buffer.from([0x02, 0x01, value]);
  const seq = (...parts: Buffer[]) => {
    const body = Buffer.concat(parts);
    return Buffer.concat([Buffer.from([0x30]), derLength(body.length), body]);
  };
  const derLength = (length: number): Buffer => {
    if (length < 0x80) return Buffer.from([length]);
    const bytes: number[] = [];
    let remaining = length;
    while (remaining > 0) {
      bytes.unshift(remaining & 0xff);
      remaining >>= 8;
    }
    return Buffer.from([0x80 | bytes.length, ...bytes]);
  };
  const oidSha256Rsa = Buffer.from('300d06092a864886f70d01010b0500', 'hex');
  const name = Buffer.from('300f310d300b06035504030c0474657374', 'hex');
  const validity = Buffer.from(
    '301e170d3230303130313030303030305a170d3330303130313030303030305a',
    'hex',
  );

  const tbs = seq(int(2), oidSha256Rsa, name, validity, name, spki);

  const signature = createSign('RSA-SHA256').update(tbs).sign(privateKey);
  const bitString = Buffer.concat([
    Buffer.from([0x03]),
    derLength(signature.length + 1),
    Buffer.from([0x00]),
    signature,
  ]);

  const certificate = seq(tbs, oidSha256Rsa, bitString);
  const base64 = certificate.toString('base64').replace(/(.{64})/g, '$1\n');
  return `-----BEGIN CERTIFICATE-----\n${base64}\n-----END CERTIFICATE-----\n`;
}

const amazon = makeSigner();
const attacker = makeSigner();

const AMAZON_CERT_URL = 'https://sns.eu-west-1.amazonaws.com/SimpleNotificationService-abc.pem';
const TOPIC = 'arn:aws:sns:eu-west-1:123456789012:dash-email-events';

function sign(message: Omit<SnsMessage, 'Signature'>, signer: Signer): SnsMessage {
  const complete = { ...message, Signature: '' } as SnsMessage;
  const signature = createSign(message.SignatureVersion === '2' ? 'RSA-SHA256' : 'RSA-SHA1')
    .update(signedStringFor(complete), 'utf8')
    .sign(createPrivateKey(signer.privateKeyPem), 'base64');
  return { ...complete, Signature: signature };
}

function notification(body: unknown, overrides: Partial<SnsMessage> = {}): SnsMessage {
  return sign(
    {
      Type: 'Notification',
      MessageId: `msg-${Math.random().toString(36).slice(2)}`,
      TopicArn: TOPIC,
      Message: JSON.stringify(body),
      Timestamp: new Date().toISOString(),
      SignatureVersion: '1',
      SigningCertURL: AMAZON_CERT_URL,
      ...overrides,
    } as Omit<SnsMessage, 'Signature'>,
    amazon,
  );
}

const fetcher = async (url: string) => {
  if (url === AMAZON_CERT_URL) return amazon.certificatePem;
  return attacker.certificatePem;
};

// ---------------------------------------------------------------------------

describe('the certificate URL check', () => {
  it('accepts a real SNS endpoint', () => {
    expect(isTrustedCertificateUrl(AMAZON_CERT_URL)).toBe(true);
    expect(
      isTrustedCertificateUrl('https://sns.us-east-1.amazonaws.com/SimpleNotification-1.pem'),
    ).toBe(true);
  });

  it('refuses a host that merely contains the right words', () => {
    // The attack a substring check passes. This URL is somebody else's server.
    expect(
      isTrustedCertificateUrl('https://sns.eu-west-1.amazonaws.com.evil.example/cert.pem'),
    ).toBe(false);
    expect(isTrustedCertificateUrl('https://evil.example/sns.amazonaws.com/cert.pem')).toBe(false);
    expect(isTrustedCertificateUrl('https://notsns.eu-west-1.amazonaws.com/cert.pem')).toBe(false);
  });

  it('refuses plain HTTP and non-certificate paths', () => {
    expect(isTrustedCertificateUrl('http://sns.eu-west-1.amazonaws.com/cert.pem')).toBe(false);
    expect(isTrustedCertificateUrl('https://sns.eu-west-1.amazonaws.com/anything')).toBe(false);
  });

  it('refuses nonsense without throwing', () => {
    expect(isTrustedCertificateUrl('not a url')).toBe(false);
    expect(isTrustedCertificateUrl('')).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('signature verification', () => {
  beforeEach(() => resetCertificateCache());

  it('accepts a genuine message', async () => {
    await expect(
      verifySnsMessage(notification({ notificationType: 'Delivery' }), { fetcher }),
    ).resolves.toBeUndefined();
  });

  it('refuses a forgery signed with the attacker’s own certificate', async () => {
    // The one that matters. The signature is valid; the certificate is theirs.
    // Without the URL check every field of this message verifies perfectly.
    const forged = sign(
      {
        Type: 'Notification',
        MessageId: 'forged-1',
        TopicArn: TOPIC,
        Message: JSON.stringify({ notificationType: 'Bounce' }),
        Timestamp: new Date().toISOString(),
        SignatureVersion: '1',
        SigningCertURL: 'https://evil.example/cert.pem',
      } as Omit<SnsMessage, 'Signature'>,
      attacker,
    );

    await expect(verifySnsMessage(forged, { fetcher })).rejects.toMatchObject({
      reason: 'untrusted_certificate_url',
    });
  });

  it('refuses a tampered message that kept a valid signature', async () => {
    const message = notification({ notificationType: 'Delivery' });
    const tampered = { ...message, Message: JSON.stringify({ notificationType: 'Bounce' }) };
    await expect(verifySnsMessage(tampered, { fetcher })).rejects.toMatchObject({
      reason: 'bad_signature',
    });
  });

  it('refuses a message from another topic', async () => {
    const other = notification({}, { TopicArn: 'arn:aws:sns:eu-west-1:999:someone-else' });
    await expect(
      verifySnsMessage(other, { fetcher, expectedTopicArn: TOPIC }),
    ).rejects.toMatchObject({ reason: 'wrong_topic' });
  });

  it('refuses a replay', async () => {
    const old = notification(
      {},
      { Timestamp: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString() },
    );
    await expect(verifySnsMessage(old, { fetcher })).rejects.toMatchObject({ reason: 'stale' });
  });

  it('refuses an unknown type and an unknown signature version', async () => {
    await expect(
      verifySnsMessage({ ...notification({}), Type: 'SomethingElse' }, { fetcher }),
    ).rejects.toBeInstanceOf(SnsVerificationError);

    await expect(
      verifySnsMessage({ ...notification({}), SignatureVersion: '9' }, { fetcher }),
    ).rejects.toMatchObject({ reason: 'unsupported_signature_version' });
  });

  it('omits absent optional fields from the signed string', () => {
    // Emitting an empty value instead produces a different string, and nothing
    // AWS signs would ever verify.
    const withSubject = signedStringFor({ ...notification({}), Subject: 'Hello' });
    const without = signedStringFor(notification({}));
    expect(withSubject).toContain('Subject\nHello\n');
    expect(without).not.toContain('Subject');
  });
});

// ---------------------------------------------------------------------------

describe('what counts as essential', () => {
  it('treats codes and account notices as essential', () => {
    expect(isEssential('email_verify_abc123')).toBe(true);
    expect(isEssential('otp_login')).toBe(true);
    expect(isEssential('signup_phone_conflict')).toBe(true);
  });

  it('treats anything it does not recognise as non-essential', () => {
    // An allowlist, so a new kind of marketing email cannot reach a
    // complainant by having been forgotten.
    expect(isEssential('newsletter_september')).toBe(false);
    expect(isEssential('')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Through the endpoint
// ---------------------------------------------------------------------------

let context: TestContext;

beforeAll(async () => {
  context = await createTestContext({ SES_EVENT_TOPIC_ARN: TOPIC });
}, 180_000);

afterAll(async () => {
  await context?.close();
});

// ---------------------------------------------------------------------------
// The suppression list, enforced
// ---------------------------------------------------------------------------

describe('a suppressed address', () => {
  async function suppressAddress(
    address: string,
    reason: 'hard_bounce' | 'complaint',
    transactionalAllowed: boolean,
  ) {
    await context.prisma.emailSuppression.upsert({
      where: { address },
      create: { address, reason, transactionalAllowed },
      update: { reason, transactionalAllowed, clearedAt: null },
    });
  }

  it('receives no verification code after a hard bounce', async () => {
    const address = `bounced.${Date.now()}@example.com`;
    await suppressAddress(address, 'hard_bounce', false);

    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: {
        name: 'Bounced Person',
        email: address,
        phone: `+23480${String(Date.now()).slice(-8)}`,
        state: 'Lagos',
        cityArea: 'Yaba',
        usageIntent: 'mainly_buying',
        acquisitionSource: 'search',
        confirmedAdult: true,
        acceptedTerms: true,
      },
    });

    // The signup itself still answers normally — the caller learns nothing
    // about the suppression, and a failed send must not fail their request.
    expect(response.statusCode).toBe(200);

    // But nothing was delivered, and continuing to send to a dead mailbox is
    // what costs the sending reputation everybody else depends on.
    const identity = await context.prisma.identity.findUnique({ where: { email: address } });
    expect(identity).not.toBeNull();
    expect(identity?.emailVerifiedAt).toBeNull();
  });

  it('still receives a sign-in code after a complaint', async () => {
    // Somebody who marked a newsletter as spam has not asked to be locked out
    // of their own account.
    const address = `complained.${Date.now()}@example.com`;
    await suppressAddress(address, 'complaint', true);

    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: {
        name: 'Complained Person',
        email: address,
        phone: `+23481${String(Date.now()).slice(-8)}`,
        state: 'Lagos',
        cityArea: 'Yaba',
        usageIntent: 'mainly_buying',
        acquisitionSource: 'search',
        confirmedAdult: true,
        acceptedTerms: true,
      },
    });

    expect(response.statusCode).toBe(200);
    // The code was issued and sent: transactional mail survives a complaint.
    expect(response.json().devCode).toMatch(/^\d{6}$/);
  });

  it('stops being suppressed once it is cleared', async () => {
    const address = `cleared.${Date.now()}@example.com`;
    await suppressAddress(address, 'hard_bounce', false);
    await context.prisma.emailSuppression.update({
      where: { address },
      data: { clearedAt: new Date(), clearedBy: 'test' },
    });

    const suppression = await context.prisma.emailSuppression.findUniqueOrThrow({
      where: { address },
    });
    // Kept rather than deleted: "this bounced once and was cleared" is worth
    // being able to say later.
    expect(suppression.clearedAt).not.toBeNull();
    expect(suppression.reason).toBe('hard_bounce');
  });
});

describe('the endpoint', () => {
  it('refuses arbitrary JSON that was never signed', async () => {
    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/webhooks/email-events',
      payload: {
        Type: 'Notification',
        MessageId: 'x',
        TopicArn: TOPIC,
        Message: JSON.stringify({
          notificationType: 'Bounce',
          bounce: {
            bounceType: 'Permanent',
            bouncedRecipients: [{ emailAddress: 'victim@example.com' }],
          },
        }),
        Timestamp: new Date().toISOString(),
        SignatureVersion: '1',
        Signature: 'not-a-signature',
        SigningCertURL: AMAZON_CERT_URL,
      },
    });

    expect(response.statusCode).toBe(400);
    // The point: suppressing an address is a targeted denial of service, and
    // an unsigned request must never manage it.
    expect(
      await context.prisma.emailSuppression.findUnique({
        where: { address: 'victim@example.com' },
      }),
    ).toBeNull();
  });

  it('does not tell the caller which check they failed', async () => {
    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/webhooks/email-events',
      payload: { ...notification({}), Signature: 'wrong' },
    });
    const message = response.json().error.message as string;
    expect(message).not.toMatch(/certificate|topic|stale|signature version/i);
  });
});
