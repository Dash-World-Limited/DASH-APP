/**
 * Transactional email through Brevo's HTTP API.
 *
 * The V1 email provider. It sends what SES would — verification codes,
 * sign-in codes, account notices — so it keeps the same rules as the SES
 * adapter, which it sits beside rather than replaces:
 *
 * - It never falls back. A refusal throws `EmailDeliveryError`, and the caller
 *   (which never tells the requester whether an account exists) decides what
 *   to do. There is no silent downgrade to a log line.
 * - It never logs, throws or returns the message body. The body of a
 *   verification email is the code. Errors carry Brevo's status and its short
 *   error code, and the recipient's domain — never the address, never the key.
 * - Both text and HTML parts are always sent.
 *
 * The sender must be an address (or domain) verified in the Brevo account;
 * Brevo rejects anything else with a 400, which surfaces here at the first
 * send and at boot configuration — not as an invisible failure.
 *
 * API: POST https://api.brevo.com/v3/smtp/email, authenticated by the
 * `api-key` header. 201 with `{ messageId }` on acceptance.
 */

import type { DeliveryReceipt, EmailPort } from '@dash/domain/ports';
import { EmailDeliveryError } from './ses.js';

const DASH_SENDER_NAME = 'DASH';

export interface BrevoEmailOptions {
  /** A Brevo API v3 key (`xkeysib-…`). A secret; never logged. */
  apiKey: string;
  /** Verified in the Brevo account as a sender. */
  fromAddress: string;
  /** Retained for configuration compatibility; DASH owns the visible identity. */
  fromName: string;
  /** A monitored mailbox: the identity-conflict email tells people to reply. */
  replyTo: string;
  /** Overridable for tests only. */
  baseUrl?: string | undefined;
  fetch?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
}

/** The domain only. An address in an error is an address in a log. */
function domainOf(address: string): string {
  const at = address.lastIndexOf('@');
  return at === -1 ? 'unknown' : address.slice(at + 1);
}

/** Brevo tags are free text, but keep them short and free of identifiers' punctuation. */
function tagOf(reference: string): string {
  const cleaned = reference.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
  return cleaned.length > 0 ? cleaned : 'unknown';
}

export class BrevoEmailAdapter implements EmailPort {
  readonly providerName = 'brevo';
  readonly isLive = true;

  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: BrevoEmailOptions) {
    this.baseUrl = (options.baseUrl ?? 'https://api.brevo.com/v3').replace(/\/+$/, '');
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  async send(input: { to: string; subject: string; html: string; text: string; reference: string }): Promise<DeliveryReceipt> {
    const recipientDomain = domainOf(input.to);

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/smtp/email`, {
        method: 'POST',
        headers: {
          'api-key': this.options.apiKey,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          // Every DASH product shares one canonical account. The visible sender
          // follows that identity too: never "DASH WORLD LIMITED" on one code
          // and "DASH APP" on another simply because an old env label survived.
          sender: { name: DASH_SENDER_NAME, email: this.options.fromAddress },
          to: [{ email: input.to }],
          replyTo: { email: this.options.replyTo },
          subject: input.subject,
          textContent: input.text,
          htmlContent: input.html,
          tags: [tagOf(input.reference)],
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      // A network failure or a timeout. Whether Brevo accepted the message is
      // unknown; retrying could help, so it is not permanent.
      throw new EmailDeliveryError('Brevo could not be reached', recipientDomain, false, { cause: error });
    }

    let body: { messageId?: unknown; code?: unknown } = {};
    try {
      body = (await response.json()) as typeof body;
    } catch {
      // Status alone is enough to decide.
    }

    if (response.status === 201 || response.status === 200) {
      return {
        accepted: true,
        providerMessageId: typeof body.messageId === 'string' ? body.messageId : `brevo_${Date.now()}`,
      };
    }

    const code = typeof body.code === 'string' ? body.code.slice(0, 60) : 'unknown';
    throw new EmailDeliveryError(
      `Brevo refused the message (HTTP ${response.status}, ${code})`,
      recipientDomain,
      isPermanent(response.status),
    );
  }
}

/**
 * Whether retrying could ever help.
 *
 * 400 (bad sender, bad recipient), 401 (bad key), 402 (no credits) and 403
 * (sender or IP not authorised) fail identically until a person changes
 * something. 429 and 5xx may succeed later.
 */
function isPermanent(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}
