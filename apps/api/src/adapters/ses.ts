/**
 * Transactional email through Amazon SES v2.
 *
 * The first live `EmailPort`. Everything that reaches it — a verification code,
 * a sign-in code, the "you already have an account" notice, the identity
 * conflict explanation — is mail a real person is waiting for, and in the case
 * of the codes it is the only way into their account. So this adapter is built
 * around the failures rather than the happy path.
 *
 * ## What it refuses to do
 *
 * It never falls back. If SES rejects a message, `send` throws and the caller
 * finds out; there is no silent downgrade to a console log, because the shape
 * of that mistake is exactly what this milestone had to fix elsewhere — a
 * service that believes it is sending email while writing codes to stdout is
 * worse than one that is plainly broken.
 *
 * It never logs the message body. The body of a verification email *is* the
 * one-time code, so a log line containing it hands every account to anyone who
 * can read the logs. Only the recipient, the reference and the provider message
 * id are ever recorded here, and the recipient is what a support agent needs to
 * answer "did it go".
 *
 * ## Reputation
 *
 * `configurationSet` is optional but strongly wanted: it is how bounce and
 * complaint events reach an SNS topic, and a hard bounce retried forever is
 * what gets a sending domain suspended. The adapter does not consume those
 * events — that belongs on the receiving side — but it tags every message so
 * they can be attributed when it does.
 */

import {
  SESv2Client,
  SendEmailCommand,
  AccountSuspendedException,
  MessageRejected,
  SendingPausedException,
} from '@aws-sdk/client-sesv2';
import type { DeliveryReceipt, EmailPort } from '@dash/domain/ports';

const DASH_SENDER_NAME = 'DASH';

export interface SesEmailOptions {
  region: string;
  /** A verified identity in `region`. SES rejects anything else outright. */
  fromAddress: string;
  /** Retained for configuration compatibility; DASH owns the visible identity. */
  fromName: string;
  /**
   * Where replies go, and it must be a monitored mailbox.
   *
   * The identity-conflict email tells a genuine user to reply to it. That is
   * their only route through the one case this system deliberately refuses to
   * resolve automatically, so an unmonitored address here is a person with no
   * way to reach anybody.
   */
  replyTo: string;
  /** Groups messages for bounce and complaint reporting. */
  configurationSet?: string | undefined;
}

/** Thrown for anything SES refused. Never carries the message body. */
export class EmailDeliveryError extends Error {
  constructor(
    message: string,
    readonly recipientDomain: string,
    readonly permanent: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'EmailDeliveryError';
  }
}

/** The domain only. An address in an error is an address in a log. */
function domainOf(address: string): string {
  const at = address.lastIndexOf('@');
  return at === -1 ? 'unknown' : address.slice(at + 1);
}

export class SesEmailAdapter implements EmailPort {
  readonly providerName = 'ses';
  readonly isLive = true;

  private readonly client: SESv2Client;

  constructor(
    private readonly options: SesEmailOptions,
    client?: SESv2Client,
  ) {
    // Credentials are resolved by the SDK's own default chain, so an instance
    // role works and no key has to exist in the environment at all. That is the
    // deployment we want; explicit keys stay possible for anything that cannot
    // assume a role.
    this.client = client ?? new SESv2Client({ region: options.region });
  }

  async send(input: {
    to: string;
    subject: string;
    html: string;
    text: string;
    reference: string;
  }): Promise<DeliveryReceipt> {
    const command = new SendEmailCommand({
      // Match the Brevo identity exactly. Transactional provider changes must
      // never change who a DASH code appears to come from in the inbox.
      FromEmailAddress: `${DASH_SENDER_NAME} <${this.options.fromAddress}>`,
      ReplyToAddresses: [this.options.replyTo],
      Destination: { ToAddresses: [input.to] },
      ...(this.options.configurationSet
        ? { ConfigurationSetName: this.options.configurationSet }
        : {}),
      Content: {
        Simple: {
          Subject: { Data: input.subject, Charset: 'UTF-8' },
          Body: {
            // Both parts, always. A text-only transactional email looks like
            // spam to some filters; an HTML-only one is unreadable in clients
            // that refuse to render it, and a verification code nobody can read
            // is an account nobody can open.
            Text: { Data: input.text, Charset: 'UTF-8' },
            Html: { Data: input.html, Charset: 'UTF-8' },
          },
        },
      },
      EmailTags: [
        // Tags reach bounce and complaint events, so a spike can be attributed
        // to the kind of message causing it rather than to "email".
        { Name: 'reference', Value: sanitiseTag(input.reference) },
      ],
    });

    try {
      const result = await this.client.send(command);
      return {
        accepted: true,
        providerMessageId: result.MessageId ?? `ses_${Date.now()}`,
      };
    } catch (error) {
      throw new EmailDeliveryError(
        describe(error),
        domainOf(input.to),
        isPermanent(error),
        { cause: error },
      );
    }
  }
}

/**
 * SES tag values allow a narrow alphabet, and a rejected tag rejects the whole
 * message. A reference carrying an identity id would otherwise fail on nothing.
 */
function sanitiseTag(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 256);
  return cleaned.length > 0 ? cleaned : 'unknown';
}

/**
 * Whether retrying could ever help.
 *
 * A rejected message, a suspended account or a paused sending identity will
 * fail identically forever; a throttle or a network blip will not. The caller
 * decides what to do, but it cannot decide well without being told which it is.
 */
function isPermanent(error: unknown): boolean {
  return (
    error instanceof MessageRejected ||
    error instanceof AccountSuspendedException ||
    error instanceof SendingPausedException
  );
}

/**
 * A message safe to log.
 *
 * The SES error name and its own text, and nothing from the email. The body of
 * a verification email is the code itself.
 */
function describe(error: unknown): string {
  if (error instanceof MessageRejected) return 'SES rejected the message';
  if (error instanceof AccountSuspendedException) return 'The SES account is suspended';
  if (error instanceof SendingPausedException) return 'SES sending is paused for this identity';
  if (error instanceof Error) return `SES send failed: ${error.name}`;
  return 'SES send failed';
}
