/**
 * Payments through Paystack.
 *
 * The first live `PaymentPort`. Until this file existed, `PAYMENT_PROVIDER=
 * paystack` passed configuration and then booted the mock, which captures
 * every charge on the spot and accepts webhooks signed with a secret printed
 * in this repository. Nothing about that failure was visible from outside.
 *
 * ## What the adapter believes
 *
 * Only `verify`. `initialize` never reports a capture: Paystack's answer to an
 * initialisation is a checkout URL, and a customer who has been given a URL
 * has paid nothing. A webhook body is parsed only far enough to find the
 * reference — the route then calls `verify` and trusts that answer instead of
 * the body.
 *
 * `verify` reports `captured` only when Paystack says `success` *and* the
 * reference and currency are the ones asked about. The amount is returned for
 * the caller to compare against its own record; this adapter does not know
 * what an order should cost.
 *
 * ## What it never does
 *
 * It never logs or throws the secret key, the Authorization header, or a raw
 * response body. `PaymentProviderError` carries Paystack's short `message`
 * and the HTTP status, nothing else.
 *
 * It never retries a POST. A timed-out initialisation may or may not exist at
 * Paystack; the caller's idempotency key and the unique reference are what
 * make a second attempt safe, and a hidden retry here would defeat both.
 *
 * ## Webhook signatures
 *
 * Paystack signs every event with HMAC-SHA512 over the raw body, keyed by the
 * account's **secret key** — there is no separate webhook secret. Comparison
 * is constant-time.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { kobo, type Kobo } from '@dash/domain/money';
import type {
  PaymentIntent,
  PaymentPort,
  PaymentStatus,
  PaymentWebhookEvent,
} from '@dash/domain/ports';

export interface PaystackOptions {
  /** `sk_test_…` or `sk_live_…`. Validated by config before it gets here. */
  secretKey: string;
  /** Where Paystack sends the customer's browser after checkout. */
  callbackUrl?: string | undefined;
  /** Overridable for tests. Never pointed anywhere but Paystack in a deployment. */
  baseUrl?: string | undefined;
  /** Injected so tests exercise the real code path without a network. */
  fetch?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
}

/** Thrown for anything Paystack refused or could not be reached for. */
export class PaymentProviderError extends Error {
  constructor(
    message: string,
    /** HTTP status, or 0 when the request never got an answer. */
    readonly httpStatus: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'PaymentProviderError';
  }
}

interface PaystackEnvelope<T> {
  status?: boolean;
  message?: string;
  data?: T;
}

interface PaystackTransaction {
  id?: number;
  status?: string;
  reference?: string;
  amount?: number;
  currency?: string;
  gateway_response?: string;
}

/**
 * Paystack's transaction states, mapped onto ours.
 *
 * `abandoned` is not terminal: Paystack uses it for a checkout the customer
 * opened and has not finished, which they can still finish. Treating it as a
 * failure would cancel an order the customer is paying for at that moment, so
 * it stays `pending` and reconciliation decides when it has gone stale.
 *
 * Anything unrecognised is also `pending`. An unknown state must never become
 * a capture, and it must never cancel something that might yet succeed.
 */
export function mapPaystackStatus(status: string | undefined): PaymentStatus {
  switch (status) {
    case 'success':
      return 'captured';
    case 'failed':
      return 'failed';
    case 'reversed':
      return 'refunded';
    default:
      return 'pending';
  }
}

export class PaystackPaymentAdapter implements PaymentPort {
  readonly providerName = 'paystack';
  readonly isLive: boolean;

  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: PaystackOptions) {
    this.isLive = options.secretKey.startsWith('sk_live_');
    this.baseUrl = (options.baseUrl ?? 'https://api.paystack.co').replace(/\/+$/, '');
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  async initialize(input: {
    amount: Kobo;
    currency: 'NGN';
    reference: string;
    customerEmail: string;
    paymentMethodToken?: string | undefined;
    idempotencyKey: string;
    metadata?: Readonly<Record<string, string>> | undefined;
  }): Promise<PaymentIntent> {
    if (!Number.isInteger(input.amount) || input.amount <= 0) {
      throw new PaymentProviderError('Refusing to initialise a non-positive or fractional amount', 0);
    }

    const response = await this.request<{ authorization_url?: string; reference?: string }>(
      'POST',
      '/transaction/initialize',
      {
        email: input.customerEmail,
        amount: input.amount,
        currency: input.currency,
        reference: input.reference,
        ...(this.options.callbackUrl ? { callback_url: this.options.callbackUrl } : {}),
        metadata: { ...input.metadata, idempotency_key: input.idempotencyKey },
      },
    );

    if (!response.ok) {
      // Paystack refuses a reference it has already seen. That is the retry of
      // an initialisation whose answer was lost, and the transaction it
      // created is the one to report — never a second one.
      if (/duplicate/i.test(response.message)) {
        return this.verify(input.reference);
      }
      throw new PaymentProviderError(`Paystack refused initialisation: ${response.message}`, response.httpStatus);
    }

    const url = response.data?.authorization_url;
    if (!url || !url.startsWith('https://')) {
      throw new PaymentProviderError('Paystack returned no usable checkout URL', response.httpStatus);
    }

    return {
      providerReference: input.reference,
      status: 'pending',
      amount: input.amount,
      currency: 'NGN',
      authorizationUrl: url,
    };
  }

  async verify(reference: string): Promise<PaymentIntent> {
    const response = await this.request<PaystackTransaction>(
      'GET',
      `/transaction/verify/${encodeURIComponent(reference)}`,
    );

    if (!response.ok) {
      // A reference Paystack has never seen was never paid. Anything else —
      // an outage, a 5xx, a key problem — is thrown so no caller mistakes
      // "could not ask" for "was not paid".
      if (response.httpStatus === 404 || /not found/i.test(response.message)) {
        return {
          providerReference: reference,
          status: 'failed',
          amount: kobo(0),
          currency: 'NGN',
          providerMessage: 'Unknown reference',
        };
      }
      throw new PaymentProviderError(`Paystack verification failed: ${response.message}`, response.httpStatus);
    }

    const data = response.data ?? {};
    if (data.reference !== reference) {
      throw new PaymentProviderError('Paystack answered for a different reference', response.httpStatus);
    }

    const amount = typeof data.amount === 'number' && Number.isInteger(data.amount) ? data.amount : 0;
    let status = mapPaystackStatus(data.status);
    let providerMessage = data.gateway_response;

    // NGN is the only currency this platform prices in. A success in anything
    // else is not a payment for an order of ours, whatever the amount says.
    if (data.currency !== 'NGN' && status === 'captured') {
      status = 'failed';
      providerMessage = `Unexpected currency ${String(data.currency)}`;
    }

    return {
      providerReference: reference,
      status,
      amount: kobo(amount),
      currency: 'NGN',
      ...(providerMessage ? { providerMessage } : {}),
    };
  }

  async refund(input: {
    providerReference: string;
    amount: Kobo;
    reason: string;
    idempotencyKey: string;
  }): Promise<{ refundReference: string; status: PaymentStatus }> {
    const response = await this.request<{ id?: number; status?: string }>('POST', '/refund', {
      transaction: input.providerReference,
      amount: input.amount,
      merchant_note: input.reason.slice(0, 200),
    });
    if (!response.ok) {
      throw new PaymentProviderError(`Paystack refused the refund: ${response.message}`, response.httpStatus);
    }

    // Paystack refunds settle asynchronously; `processed` is the only state
    // that means the money has gone back.
    const refundStatus = response.data?.status;
    return {
      refundReference: `paystack_refund_${String(response.data?.id ?? input.idempotencyKey)}`,
      status: refundStatus === 'processed' ? 'refunded' : 'pending',
    };
  }

  parseWebhook(input: {
    rawBody: string;
    headers: Readonly<Record<string, string | undefined>>;
  }): PaymentWebhookEvent | null {
    const provided = input.headers['x-paystack-signature'];
    if (!provided || !/^[0-9a-f]{128}$/i.test(provided)) return null;

    const expected = createHmac('sha512', this.options.secretKey).update(input.rawBody).digest();
    const given = Buffer.from(provided, 'hex');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

    let parsed: { event?: unknown; data?: Record<string, unknown> };
    try {
      parsed = JSON.parse(input.rawBody) as typeof parsed;
    } catch {
      return null;
    }

    const type = typeof parsed.event === 'string' ? parsed.event : null;
    const data = parsed.data ?? {};
    // Charge events carry `reference`; refund events carry the transaction's
    // reference under a different name.
    const reference =
      typeof data['reference'] === 'string'
        ? data['reference']
        : typeof data['transaction_reference'] === 'string'
          ? data['transaction_reference']
          : null;
    const providerId = typeof data['id'] === 'number' || typeof data['id'] === 'string' ? String(data['id']) : null;
    if (!type || !reference || !providerId) return null;

    return {
      // Paystack sends no event id of its own. The event name and the object
      // it is about identify a delivery uniquely, which is what replay
      // protection needs.
      id: `${type}:${providerId}`,
      type,
      providerReference: reference,
      status: mapPaystackStatus(typeof data['status'] === 'string' ? data['status'] : undefined),
      amount: kobo(typeof data['amount'] === 'number' ? data['amount'] : 0),
      occurredAt: new Date(),
      raw: parsed,
    };
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<{ ok: boolean; httpStatus: number; message: string; data: T | undefined }> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.options.secretKey}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      // The cause is a network error or an abort. Neither carries the key.
      throw new PaymentProviderError('Paystack could not be reached', 0, { cause: error });
    }

    let envelope: PaystackEnvelope<T> = {};
    try {
      envelope = (await response.json()) as PaystackEnvelope<T>;
    } catch {
      // A non-JSON answer (a proxy error page, say) is reported by status only.
    }

    return {
      ok: response.ok && envelope.status === true,
      httpStatus: response.status,
      message: typeof envelope.message === 'string' ? envelope.message.slice(0, 200) : `HTTP ${response.status}`,
      data: envelope.data,
    };
  }
}
