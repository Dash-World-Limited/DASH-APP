/**
 * The SES adapter, without touching AWS.
 *
 * A stub client stands in for `SESv2Client`, so these assert the two things
 * that actually matter about a live email adapter and cannot be checked by
 * sending a real message: that the command carries what SES needs, and that a
 * failure is reported rather than swallowed.
 *
 * The most important test in the file is the one asserting nothing throws a
 * message body around. The body of a verification email *is* the one-time code,
 * so an error or a log line containing it hands every account to anyone who can
 * read the logs.
 */

import { describe, expect, it } from 'vitest';
import { MessageRejected } from '@aws-sdk/client-sesv2';
import type { SendEmailCommand } from '@aws-sdk/client-sesv2';
import { EmailDeliveryError, SesEmailAdapter } from '../adapters/ses.js';

/** Captures the command instead of sending it. */
class StubClient {
  readonly sent: SendEmailCommand[] = [];
  constructor(private readonly behaviour: 'ok' | 'rejected' | 'throttled' = 'ok') {}

  async send(command: SendEmailCommand) {
    this.sent.push(command);
    if (this.behaviour === 'rejected') {
      throw new MessageRejected({ $metadata: {}, message: 'Email address is not verified' });
    }
    if (this.behaviour === 'throttled') {
      const error = new Error('Maximum sending rate exceeded');
      error.name = 'TooManyRequestsException';
      throw error;
    }
    return { MessageId: 'ses-message-1', $metadata: {} };
  }
}

const OPTIONS = {
  region: 'eu-west-1',
  fromAddress: 'no-reply@notify.dashworldng.com',
  fromName: 'DASH World',
  replyTo: 'admin@dashworldng.com',
  configurationSet: 'dash-transactional',
};

function adapterWith(behaviour: 'ok' | 'rejected' | 'throttled' = 'ok') {
  const client = new StubClient(behaviour);
  // The stub satisfies the one method the adapter uses.
  const adapter = new SesEmailAdapter(OPTIONS, client as never);
  return { adapter, client };
}

const MESSAGE = {
  to: 'buyer@example.com',
  subject: '123456 is your DASH verification code',
  text: 'Your DASH verification code is 123456.',
  html: '<p>Your DASH verification code is <strong>123456</strong></p>',
  reference: 'email_verify_cml7x9abc000',
};

// ---------------------------------------------------------------------------

describe('sending', () => {
  it('reports itself as live, unlike the console adapter', () => {
    const { adapter } = adapterWith();
    expect(adapter.isLive).toBe(true);
    expect(adapter.providerName).toBe('ses');
  });

  it('sends both a text and an HTML body', async () => {
    const { adapter, client } = adapterWith();
    await adapter.send(MESSAGE);

    const input = client.sent[0]?.input;
    // Text-only looks like spam to some filters; HTML-only is unreadable in
    // clients that refuse to render it, and a code nobody can read is an
    // account nobody can open.
    expect(input?.Content?.Simple?.Body?.Text?.Data).toBe(MESSAGE.text);
    expect(input?.Content?.Simple?.Body?.Html?.Data).toBe(MESSAGE.html);
  });

  it('sends from the configured identity with a monitored reply-to', async () => {
    const { adapter, client } = adapterWith();
    await adapter.send(MESSAGE);

    const input = client.sent[0]?.input;
    expect(input?.FromEmailAddress).toBe('DASH World <no-reply@notify.dashworldng.com>');
    // The identity-conflict email tells people to reply to this address.
    expect(input?.ReplyToAddresses).toEqual(['admin@dashworldng.com']);
  });

  it('tags the message so bounces can be attributed', async () => {
    const { adapter, client } = adapterWith();
    await adapter.send(MESSAGE);

    const input = client.sent[0]?.input;
    expect(input?.ConfigurationSetName).toBe('dash-transactional');
    // SES allows a narrow alphabet in tag values, and a rejected tag rejects
    // the whole message — so a reference carrying an id must be sanitised.
    expect(input?.EmailTags?.[0]?.Value).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('returns the provider message id', async () => {
    const { adapter } = adapterWith();
    const receipt = await adapter.send(MESSAGE);
    expect(receipt.accepted).toBe(true);
    expect(receipt.providerMessageId).toBe('ses-message-1');
  });

  it('omits the configuration set when none is set', async () => {
    const client = new StubClient();
    const adapter = new SesEmailAdapter(
      { ...OPTIONS, configurationSet: undefined },
      client as never,
    );
    await adapter.send(MESSAGE);
    expect(client.sent[0]?.input.ConfigurationSetName).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

describe('failure', () => {
  it('throws rather than pretending the message went', async () => {
    const { adapter } = adapterWith('rejected');
    // No silent downgrade to a console log. A service that believes it is
    // sending email while writing codes to stdout is worse than one that is
    // plainly broken.
    await expect(adapter.send(MESSAGE)).rejects.toBeInstanceOf(EmailDeliveryError);
  });

  it('says whether retrying could ever help', async () => {
    const rejected = await adapterWith('rejected')
      .adapter.send(MESSAGE)
      .catch((error: EmailDeliveryError) => error);
    const throttled = await adapterWith('throttled')
      .adapter.send(MESSAGE)
      .catch((error: EmailDeliveryError) => error);

    // A rejected message fails identically forever; a throttle does not.
    expect((rejected as EmailDeliveryError).permanent).toBe(true);
    expect((throttled as EmailDeliveryError).permanent).toBe(false);
  });

  it('never puts the message body or the recipient address in the error', async () => {
    const { adapter } = adapterWith('rejected');
    const error = (await adapter.send(MESSAGE).catch((caught) => caught)) as EmailDeliveryError;

    const serialised = `${error.name} ${error.message} ${error.recipientDomain}`;
    // The body of a verification email is the code itself.
    expect(serialised).not.toContain('123456');
    expect(serialised).not.toContain(MESSAGE.text);
    expect(serialised).not.toContain(MESSAGE.html);
    // The local part identifies a person; the domain is what a support agent
    // needs to answer "is their mail provider rejecting us".
    expect(serialised).not.toContain('buyer@example.com');
    expect(error.recipientDomain).toBe('example.com');
  });

  it('keeps the original error as a cause for whoever is debugging', async () => {
    const { adapter } = adapterWith('rejected');
    const error = (await adapter.send(MESSAGE).catch((caught) => caught)) as EmailDeliveryError;
    expect(error.cause).toBeInstanceOf(MessageRejected);
  });
});
