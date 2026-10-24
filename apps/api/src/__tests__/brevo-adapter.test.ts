/**
 * The Brevo email adapter against a simulated Brevo.
 *
 * No network: `fetch` is injected. What is pinned down is the adapter's
 * contract with the rest of the system — what it sends, when it throws, and
 * that nothing it throws ever carries the message body (a verification code)
 * or the API key.
 */

import { describe, expect, it } from 'vitest';
import { BrevoEmailAdapter } from '../adapters/brevo.js';
import { EmailDeliveryError } from '../adapters/ses.js';
import { loadConfig, resetConfigCache } from '../config.js';
import { buildServices } from '../server.js';

// Assembled from parts so no scanner mistakes a fixture for a leaked key.
const KEY = ['xkeysib', 'fixture'.repeat(8)].join('-');
const CODE = '482913';

function fakeBrevo(answer: { status: number; json?: unknown } | 'network') {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    if (answer === 'network') throw new TypeError('fetch failed');
    return new Response(answer.json === undefined ? '' : JSON.stringify(answer.json), { status: answer.status });
  }) as typeof fetch;
  return { impl, calls };
}

const adapterWith = (answer: Parameters<typeof fakeBrevo>[0]) => {
  const brevo = fakeBrevo(answer);
  const adapter = new BrevoEmailAdapter({
    apiKey: KEY,
    fromAddress: 'no-reply@dashworldng.com',
    fromName: 'DASH World',
    replyTo: 'hello@dashworldng.com',
    fetch: brevo.impl,
  });
  return { adapter, calls: brevo.calls };
};

const message = {
  to: 'ada@example.com',
  subject: `${CODE} is your DASH verification code`,
  text: `Your DASH verification code is ${CODE}.`,
  html: `<p>Your DASH verification code is <strong>${CODE}</strong></p>`,
  reference: 'email_verify_ckabc123',
};

describe('sending', () => {
  it('posts one message with both parts, the verified sender and a reply-to', async () => {
    const { adapter, calls } = adapterWith({ status: 201, json: { messageId: '<20260928.abc@smtp-relay.mailin.fr>' } });
    const receipt = await adapter.send(message);

    expect(receipt).toEqual({ accepted: true, providerMessageId: '<20260928.abc@smtp-relay.mailin.fr>' });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe('https://api.brevo.com/v3/smtp/email');
    expect(call.init.method).toBe('POST');
    expect((call.init.headers as Record<string, string>)['api-key']).toBe(KEY);

    const body = JSON.parse(String(call.init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      sender: { name: 'DASH World', email: 'no-reply@dashworldng.com' },
      to: [{ email: 'ada@example.com' }],
      replyTo: { email: 'hello@dashworldng.com' },
      subject: message.subject,
      textContent: message.text,
      htmlContent: message.html,
    });
    // A tag, stripped of punctuation, so bounces can be attributed by kind.
    expect(body['tags']).toEqual(['email_verify_ckabc123']);
  });

  it('reports itself as a live provider named brevo', () => {
    const { adapter } = adapterWith({ status: 201 });
    expect(adapter.providerName).toBe('brevo');
    expect(adapter.isLive).toBe(true);
  });
});

describe('wiring', () => {
  it('is the adapter the server builds for EMAIL_PROVIDER=brevo', () => {
    resetConfigCache();
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'file:./unused.db',
      JWT_ACCESS_SECRET: 'gJ7xQ2mV9wL4pR8sT1uY6zA3bC5dE0fH-access-KnMqPrSt',
      JWT_REFRESH_SECRET: 'Zx4Vn8Bq2Wr6Ty0Ui3Op5As7Df9Gh1Jk-refresh-LmNoPqRs',
      EMAIL_PROVIDER: 'brevo',
      BREVO_API_KEY: KEY,
      EMAIL_FROM_ADDRESS: 'no-reply@dashworldng.com',
      EMAIL_REPLY_TO: 'hello@dashworldng.com',
      LOG_LEVEL: 'silent',
      // No encryption key in this minimal config, so MFA must be off with it.
      MFA_ENABLED: 'false',
    });
    const services = buildServices(config);
    expect(services.email.providerName).toBe('brevo');
    expect(services.email.isLive).toBe(true);
    resetConfigCache();
  });
});

describe('refusals', () => {
  it.each([
    [400, 'invalid_parameter', true],
    [401, 'unauthorized', true],
    [402, 'not_enough_credits', true],
    [403, 'permission_denied', true],
    [429, 'too_many_requests', false],
    [500, 'internal_error', false],
    [503, 'unavailable', false],
  ])('throws on HTTP %i, permanent=%s where retrying cannot help', async (status, code, permanent) => {
    const { adapter } = adapterWith({ status, json: { code, message: `Something about ${CODE}` } });
    const error = await adapter.send(message).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EmailDeliveryError);
    expect((error as EmailDeliveryError).permanent).toBe(permanent);
    expect((error as EmailDeliveryError).recipientDomain).toBe('example.com');
  });

  it('throws a retryable error when Brevo cannot be reached', async () => {
    const { adapter } = adapterWith('network');
    const error = await adapter.send(message).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EmailDeliveryError);
    expect((error as EmailDeliveryError).permanent).toBe(false);
  });

  it('never puts the code, the recipient or the key into an error', async () => {
    for (const answer of [{ status: 400, json: { code: 'invalid_parameter', message: `bad ${CODE}` } }, 'network'] as const) {
      const { adapter } = adapterWith(answer);
      const error = (await adapter.send(message).catch((e: unknown) => e)) as Error;
      const serialised = `${error.message} ${JSON.stringify(error)}`;
      expect(serialised).not.toContain(CODE);
      expect(serialised).not.toContain('ada@example.com');
      expect(serialised).not.toContain(KEY);
    }
  });
});
