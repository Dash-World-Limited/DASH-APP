/**
 * What the redaction vocabulary must catch.
 *
 * The suite this replaces asserted that a field literally called `password` was
 * redacted, which it was, and stopped there. That is the failure mode worth
 * naming: a redaction test that only checks the spellings the implementation
 * already handles proves nothing about the ones it does not. Every block below
 * is written to fail against the exact-match matching this replaced.
 */

import { describe, expect, it } from 'vitest';
import {
  isSensitiveKey,
  redactDeep,
  redactSecretsInText,
  redactUrlCredentials,
  REDACTED,
} from './index.js';

describe('key matching', () => {
  it('catches a bare sensitive name', () => {
    for (const key of ['password', 'secret', 'token', 'authorization', 'cookie', 'apiKey']) {
      expect(isSensitiveKey(key), key).toBe(true);
    }
  });

  it('catches the same name inside a longer one', () => {
    // Every one of these passed straight through the previous exact-match list.
    for (const key of [
      'jwtAccessSecret',
      'JWT_REFRESH_SECRET',
      'paystackSecretKey',
      'PAYSTACK_WEBHOOK_SECRET',
      'googleMapsApiKey',
      'mapboxAccessToken',
      'clientSecret',
      'refreshTokenHash',
      'authorizationHeader',
      'stripeApiKey',
      's3SecretAccessKey',
      'servicePassword',
    ]) {
      expect(isSensitiveKey(key), key).toBe(true);
    }
  });

  it('does not care how a name is punctuated or cased', () => {
    for (const key of ['API_KEY', 'api-key', 'api.key', 'apiKey', 'ApiKey', 'api_key']) {
      expect(isSensitiveKey(key), key).toBe(true);
    }
  });

  it('catches connection-string variables by name', () => {
    for (const key of ['DATABASE_URL', 'databaseUrl', 'REDIS_URL', 'redisUrl', 'SMTP_URL']) {
      expect(isSensitiveKey(key), key).toBe(true);
    }
  });

  it('leaves the encryption key id visible while redacting the key itself', () => {
    // The id is not secret — it travels in plaintext inside every envelope it
    // writes — and it is the single field a rotation log is read for. Redacting
    // it would make the rotation runbook unusable to protect nothing.
    expect(isSensitiveKey('ENCRYPTION_KEY')).toBe(true);
    expect(isSensitiveKey('ENCRYPTION_KEYS_RETIRED')).toBe(true);
    expect(isSensitiveKey('ENCRYPTION_KEY_ID')).toBe(false);
    expect(isSensitiveKey('keyId')).toBe(false);
  });

  it('does not redact a duration merely because it names a secret', () => {
    // Fragment matching is broad on purpose, and `ACCESS_TOKEN_TTL_SECONDS`
    // contains `token` while holding a number of seconds. Redacting it would
    // protect nothing and remove a field someone diagnosing a session problem
    // needs.
    expect(isSensitiveKey('ACCESS_TOKEN_TTL_SECONDS')).toBe(false);
    expect(isSensitiveKey('REFRESH_TOKEN_TTL_SECONDS')).toBe(false);
    // The secrets they are named after are still caught.
    expect(isSensitiveKey('JWT_ACCESS_SECRET')).toBe(true);
  });

  it('leaves ordinary fields alone', () => {
    // A redaction pass that swallows the diagnostic fields is a redaction pass
    // people turn off.
    for (const key of ['orderCode', 'status', 'requestId', 'vendorId', 'route', 'statusCode']) {
      expect(isSensitiveKey(key), key).toBe(false);
    }
  });

  it('treats personal data as sensitive only when asked', () => {
    expect(isSensitiveKey('phone')).toBe(false);
    expect(isSensitiveKey('phone', true)).toBe(true);
    expect(isSensitiveKey('email', true)).toBe(true);
    expect(isSensitiveKey('latitude', true)).toBe(true);
  });
});

describe('credentials inside free text', () => {
  it('strips the password from a connection string', () => {
    const scrubbed = redactUrlCredentials('postgresql://dash_runtime:s3cr3t-pw@db.internal:5432/dash');

    expect(scrubbed).not.toContain('s3cr3t-pw');
    // The host and user survive: they are what make the error diagnosable, and
    // neither is the secret.
    expect(scrubbed).toContain('db.internal:5432');
    expect(scrubbed).toContain('dash_runtime');
  });

  it('strips it when the URL is buried in a sentence', () => {
    // This is the exact shape a Prisma connection failure takes, and the shape
    // no path-based log redaction can reach.
    const message =
      "Can't reach database server at postgresql://dash:hunter2@db.internal:5432/dash?schema=public";

    expect(redactUrlCredentials(message)).not.toContain('hunter2');
  });

  it('handles a Redis URL with no username', () => {
    const scrubbed = redactUrlCredentials('redis://:swordfish@cache.internal:6379');

    expect(scrubbed).not.toContain('swordfish');
    expect(scrubbed).toContain('cache.internal:6379');
  });

  it('strips more than one in the same string', () => {
    const scrubbed = redactUrlCredentials(
      'primary postgresql://a:pw-one@one:5432 replica postgresql://b:pw-two@two:5432',
    );

    expect(scrubbed).not.toContain('pw-one');
    expect(scrubbed).not.toContain('pw-two');
  });

  it('leaves a URL without credentials untouched', () => {
    const url = 'https://dashapp.ng/orders/DASH-ABC123';
    expect(redactUrlCredentials(url)).toBe(url);
  });

  it('strips a known secret value wherever it appears', () => {
    const secret = 'gJ7xQ2mV9wL4pR8sT1uY6zA3bC5dE0fH';
    const scrubbed = redactSecretsInText(`signing failed with ${secret} supplied`, [secret]);

    expect(scrubbed).not.toContain(secret);
    expect(scrubbed).toContain(REDACTED);
  });

  it('ignores a known secret too short to replace safely', () => {
    // Replacing every occurrence of a two-character value would corrupt the
    // message without protecting anything.
    expect(redactSecretsInText('the code is ok', ['ok'])).toBe('the code is ok');
  });
});

describe('walking a structure', () => {
  it('redacts by key at depth', () => {
    const scrubbed = redactDeep({
      request: { body: { nested: { paystackSecretKey: 'sk_live_whatever' } } },
    }) as Record<string, Record<string, Record<string, Record<string, unknown>>>>;

    expect(scrubbed['request']!['body']!['nested']!['paystackSecretKey']).toBe(REDACTED);
  });

  it('scrubs a credential that is inside a string rather than under a key', () => {
    // No key name reaches inside a sentence, so key matching alone would miss
    // this entirely. Both passes are needed.
    const scrubbed = redactDeep({
      message: 'connect ECONNREFUSED redis://:letmein@cache:6379',
    }) as Record<string, string>;

    expect(scrubbed['message']).not.toContain('letmein');
  });

  it('reaches the message and stack of an Error', () => {
    // An Error's message and stack are non-enumerable, so a plain
    // `Object.entries` walk returns {} and the interesting part passes through
    // untouched. This asserts the special case actually exists.
    const error = new Error('failed against postgresql://dash:leaky@db:5432/dash');
    const scrubbed = redactDeep({ err: error }) as Record<string, Record<string, string>>;

    expect(scrubbed['err']!['message']).not.toContain('leaky');
    expect(scrubbed['err']!['name']).toBe('Error');
  });

  it('redacts inside arrays', () => {
    const scrubbed = redactDeep([{ apiKey: 'abc' }, { orderCode: 'DASH-1' }]) as Record<
      string,
      unknown
    >[];

    expect(scrubbed[0]!['apiKey']).toBe(REDACTED);
    expect(scrubbed[1]!['orderCode']).toBe('DASH-1');
  });

  it('stops at the depth cap rather than recursing forever', () => {
    let deep: Record<string, unknown> = { password: 'hunter2' };
    for (let index = 0; index < 40; index += 1) deep = { level: deep };

    expect(() => redactDeep(deep)).not.toThrow();
  });

  it('redacts rather than exposing anything past the depth cap', () => {
    // Truncating to `undefined` would be a quiet way to lose a redaction: the
    // cap must fail closed, not open.
    const scrubbed = redactDeep({ a: { b: { c: 'x' } } }, { maxDepth: 1 }) as Record<
      string,
      Record<string, unknown>
    >;

    expect(scrubbed['a']!['b']).toBe(REDACTED);
  });

  it('leaves primitives and null alone', () => {
    expect(redactDeep(null)).toBeNull();
    expect(redactDeep(42)).toBe(42);
    expect(redactDeep(true)).toBe(true);
  });
});
