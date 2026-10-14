/**
 * The Paystack adapter against a simulated Paystack.
 *
 * No network: every call goes to an injected `fetch` that answers the way
 * Paystack's documented API does. Nothing here can reach Paystack, so nothing
 * here can charge a card — which is the point. What these tests pin down is
 * the adapter's beliefs: when it will say "captured", and when it refuses to.
 */

import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { kobo } from '@dash/domain/money';
import { mapPaystackStatus, PaymentProviderError, PaystackPaymentAdapter } from '../adapters/paystack.js';

// Assembled from parts so no scanner mistakes a fixture for a leaked key.
const SECRET = ['sk', 'test', 'fixture'.repeat(6)].join('_');
const OTHER_SECRET = ['sk', 'test', 'someoneelse'.repeat(3)].join('_');
const LIVE_SECRET = ['sk', 'live', 'fixture'.repeat(6)].join('_');

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A fake Paystack: answers by path, records every request. */
function fakePaystack(routes: Record<string, (body: unknown) => { status: number; json: unknown } | 'network'>) {
  const calls: Recorded[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const path = url.replace('https://api.paystack.co', '');
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
    calls.push({ url, method: init?.method ?? 'GET', headers: (init?.headers ?? {}) as Record<string, string>, body });
    const key = Object.keys(routes).find((prefix) => path.startsWith(prefix));
    const answer = key ? routes[key]!(body) : { status: 404, json: { status: false, message: 'Not found' } };
    if (answer === 'network') throw new TypeError('fetch failed');
    return new Response(JSON.stringify(answer.json), { status: answer.status });
  }) as typeof fetch;
  return { impl, calls };
}

const transaction = (overrides: Record<string, unknown> = {}) => ({
  status: 200,
  json: {
    status: true,
    message: 'Verification successful',
    data: { id: 4099, status: 'success', reference: 'DASH-1', amount: 500_000, currency: 'NGN', gateway_response: 'Approved', ...overrides },
  },
});

describe('initialize', () => {
  it('never reports a capture — a checkout URL is not a payment', async () => {
    const paystack = fakePaystack({
      '/transaction/initialize': () => ({
        status: 200,
        json: { status: true, data: { authorization_url: 'https://checkout.paystack.com/abc', reference: 'DASH-1' } },
      }),
    });
    const adapter = new PaystackPaymentAdapter({ secretKey: SECRET, fetch: paystack.impl });

    const intent = await adapter.initialize({
      amount: kobo(500_000),
      currency: 'NGN',
      reference: 'DASH-1',
      customerEmail: 'ada@example.com',
      idempotencyKey: 'order_1',
    });

    expect(intent.status).toBe('pending');
    expect(intent.authorizationUrl).toBe('https://checkout.paystack.com/abc');
  });

  it('sends the amount in kobo, the reference, the currency and the bearer key', async () => {
    const paystack = fakePaystack({
      '/transaction/initialize': () => ({
        status: 200,
        json: { status: true, data: { authorization_url: 'https://checkout.paystack.com/x' } },
      }),
    });
    const adapter = new PaystackPaymentAdapter({ secretKey: SECRET, fetch: paystack.impl, callbackUrl: 'https://dash.test/pay/complete' });
    await adapter.initialize({ amount: kobo(123_456), currency: 'NGN', reference: 'DASH-2', customerEmail: 'a@b.co', idempotencyKey: 'k' });

    const call = paystack.calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.headers['Authorization']).toBe(`Bearer ${SECRET}`);
    expect(call.body).toMatchObject({
      amount: 123_456,
      currency: 'NGN',
      reference: 'DASH-2',
      email: 'a@b.co',
      callback_url: 'https://dash.test/pay/complete',
    });
  });

  it('refuses a zero, negative or fractional amount before calling Paystack', async () => {
    const paystack = fakePaystack({});
    const adapter = new PaystackPaymentAdapter({ secretKey: SECRET, fetch: paystack.impl });
    for (const amount of [0, -100, 10.5]) {
      await expect(
        adapter.initialize({ amount: amount as never, currency: 'NGN', reference: 'r', customerEmail: 'a@b.co', idempotencyKey: 'k' }),
      ).rejects.toBeInstanceOf(PaymentProviderError);
    }
    expect(paystack.calls).toHaveLength(0);
  });

  it('answers a duplicate reference with the existing transaction, never a second one', async () => {
    const paystack = fakePaystack({
      '/transaction/initialize': () => ({ status: 400, json: { status: false, message: 'Duplicate Transaction Reference' } }),
      '/transaction/verify/DASH-1': () => transaction({ status: 'abandoned' }),
    });
    const adapter = new PaystackPaymentAdapter({ secretKey: SECRET, fetch: paystack.impl });
    const intent = await adapter.initialize({ amount: kobo(500_000), currency: 'NGN', reference: 'DASH-1', customerEmail: 'a@b.co', idempotencyKey: 'k' });

    expect(intent.status).toBe('pending');
    expect(paystack.calls.map((c) => c.method)).toEqual(['POST', 'GET']);
  });

  it('throws when Paystack cannot be reached, and never retries the POST', async () => {
    const paystack = fakePaystack({ '/transaction/initialize': () => 'network' });
    const adapter = new PaystackPaymentAdapter({ secretKey: SECRET, fetch: paystack.impl });
    await expect(
      adapter.initialize({ amount: kobo(100), currency: 'NGN', reference: 'r', customerEmail: 'a@b.co', idempotencyKey: 'k' }),
    ).rejects.toBeInstanceOf(PaymentProviderError);
    expect(paystack.calls).toHaveLength(1);
  });

  it('throws on a refusal without echoing the key', async () => {
    const paystack = fakePaystack({ '/transaction/initialize': () => ({ status: 401, json: { status: false, message: 'Invalid key' } }) });
    const adapter = new PaystackPaymentAdapter({ secretKey: SECRET, fetch: paystack.impl });
    const error = await adapter
      .initialize({ amount: kobo(100), currency: 'NGN', reference: 'r', customerEmail: 'a@b.co', idempotencyKey: 'k' })
      .catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(PaymentProviderError);
    expect(String((error as Error).message)).not.toContain(SECRET);
  });
});

describe('verify', () => {
  it('reports a capture only for success, with the amount Paystack holds', async () => {
    const paystack = fakePaystack({ '/transaction/verify/DASH-1': () => transaction() });
    const adapter = new PaystackPaymentAdapter({ secretKey: SECRET, fetch: paystack.impl });
    const intent = await adapter.verify('DASH-1');
    expect(intent.status).toBe('captured');
    expect(intent.amount).toBe(500_000);
  });

  it.each([
    ['failed', 'failed'],
    ['abandoned', 'pending'],
    ['ongoing', 'pending'],
    ['pending', 'pending'],
    ['processing', 'pending'],
    ['queued', 'pending'],
    ['reversed', 'refunded'],
    ['something-new', 'pending'],
  ])('maps Paystack %s to %s — never to a capture', async (paystackStatus, expected) => {
    const paystack = fakePaystack({ '/transaction/verify/DASH-1': () => transaction({ status: paystackStatus }) });
    const adapter = new PaystackPaymentAdapter({ secretKey: SECRET, fetch: paystack.impl });
    expect((await adapter.verify('DASH-1')).status).toBe(expected);
    expect(mapPaystackStatus(paystackStatus)).toBe(expected);
  });

  it('refuses a success in any currency but NGN', async () => {
    const paystack = fakePaystack({ '/transaction/verify/DASH-1': () => transaction({ currency: 'USD' }) });
    const adapter = new PaystackPaymentAdapter({ secretKey: SECRET, fetch: paystack.impl });
    expect((await adapter.verify('DASH-1')).status).toBe('failed');
  });

  it('throws when Paystack answers for a different reference', async () => {
    const paystack = fakePaystack({ '/transaction/verify/DASH-1': () => transaction({ reference: 'DASH-OTHER' }) });
    const adapter = new PaystackPaymentAdapter({ secretKey: SECRET, fetch: paystack.impl });
    await expect(adapter.verify('DASH-1')).rejects.toBeInstanceOf(PaymentProviderError);
  });

  it('treats a reference Paystack has never seen as unpaid', async () => {
    const paystack = fakePaystack({
      '/transaction/verify/': () => ({ status: 400, json: { status: false, message: 'Transaction reference not found' } }),
    });
    const adapter = new PaystackPaymentAdapter({ secretKey: SECRET, fetch: paystack.impl });
    const intent = await adapter.verify('DASH-GHOST');
    expect(intent.status).toBe('failed');
    expect(intent.amount).toBe(0);
  });

  it('throws — rather than answering "failed" — when Paystack is down', async () => {
    // "Could not ask" must never be mistaken for "was not paid": a customer
    // who paid during an outage would have their order cancelled.
    for (const answer of ['network', { status: 502, json: {} }] as const) {
      const paystack = fakePaystack({ '/transaction/verify/': () => answer });
      const adapter = new PaystackPaymentAdapter({ secretKey: SECRET, fetch: paystack.impl });
      await expect(adapter.verify('DASH-1')).rejects.toBeInstanceOf(PaymentProviderError);
    }
  });

  it('encodes the reference into the path', async () => {
    const paystack = fakePaystack({ '/transaction/verify/': () => transaction({ reference: 'a/b?c' }) });
    const adapter = new PaystackPaymentAdapter({ secretKey: SECRET, fetch: paystack.impl });
    await adapter.verify('a/b?c');
    expect(paystack.calls[0]!.url).toBe('https://api.paystack.co/transaction/verify/a%2Fb%3Fc');
  });
});

describe('parseWebhook', () => {
  const sign = (raw: string, key = SECRET) => createHmac('sha512', key).update(raw).digest('hex');
  const body = JSON.stringify({
    event: 'charge.success',
    data: { id: 4099, reference: 'DASH-1', status: 'success', amount: 500_000, currency: 'NGN' },
  });
  const adapter = new PaystackPaymentAdapter({ secretKey: SECRET, fetch: fakePaystack({}).impl });

  it('accepts an event signed with the secret key', () => {
    const event = adapter.parseWebhook({ rawBody: body, headers: { 'x-paystack-signature': sign(body) } });
    expect(event).toMatchObject({ id: 'charge.success:4099', type: 'charge.success', providerReference: 'DASH-1', status: 'captured' });
  });

  it('refuses a missing, malformed, or wrongly keyed signature', () => {
    for (const signature of [undefined, 'nothex', 'a'.repeat(128), sign(body, OTHER_SECRET)]) {
      expect(adapter.parseWebhook({ rawBody: body, headers: { 'x-paystack-signature': signature } })).toBeNull();
    }
  });

  it('refuses a body changed after signing', () => {
    const tampered = body.replace('500000', '1');
    expect(adapter.parseWebhook({ rawBody: tampered, headers: { 'x-paystack-signature': sign(body) } })).toBeNull();
  });

  it('refuses a signed body with no reference or no object id', () => {
    for (const data of [{ id: 1 }, { reference: 'DASH-1' }]) {
      const raw = JSON.stringify({ event: 'charge.success', data });
      expect(adapter.parseWebhook({ rawBody: raw, headers: { 'x-paystack-signature': sign(raw) } })).toBeNull();
    }
  });

  it('does not accept the mock scheme — the repository-printed secret signs nothing here', () => {
    expect(adapter.parseWebhook({ rawBody: body, headers: { 'x-dash-signature': 'anything' } })).toBeNull();
  });
});

describe('live and test keys', () => {
  it('reports isLive only for a sk_live_ key', () => {
    expect(new PaystackPaymentAdapter({ secretKey: SECRET }).isLive).toBe(false);
    expect(new PaystackPaymentAdapter({ secretKey: LIVE_SECRET }).isLive).toBe(true);
  });
});

describe('lookupRefund', () => {
  // Shapes from Paystack's Refund API: `GET /refund/:id` names the transaction
  // by its numeric id; the create response nests a transaction object.
  const refund = (overrides: Record<string, unknown> = {}) => ({
    status: 200,
    json: {
      status: true,
      message: 'Refund retrieved',
      data: { id: 3018284, transaction: 4099, amount: 500_000, currency: 'NGN', status: 'processed', ...overrides },
    },
  });
  const ask = (adapter: PaystackPaymentAdapter, refundReference = '3018284') =>
    adapter.lookupRefund({ refundReference, providerReference: 'DASH-1' });

  it('matches a refund to our payment by Paystack transaction id, and reports processed', async () => {
    const paystack = fakePaystack({ '/refund/3018284': () => refund(), '/transaction/verify/': () => transaction() });
    const adapter = new PaystackPaymentAdapter({ secretKey: SECRET, fetch: paystack.impl });

    expect(await ask(adapter)).toEqual({
      refundReference: 'paystack_refund_3018284',
      matchesPayment: true,
      status: 'processed',
      amount: kobo(500_000),
      currency: 'NGN',
      providerStatus: 'processed',
    });
    // The stored form is accepted back, for re-checks.
    expect((await ask(adapter, 'paystack_refund_3018284')).matchesPayment).toBe(true);
  });

  it('does not match a refund made against a different transaction', async () => {
    const paystack = fakePaystack({
      '/refund/3018284': () => refund({ transaction: 5555 }),
      '/transaction/verify/': () => transaction(),
    });
    expect((await ask(new PaystackPaymentAdapter({ secretKey: SECRET, fetch: paystack.impl }))).matchesPayment).toBe(false);
  });

  it('accepts the nested transaction object, but only when its reference agrees too', async () => {
    const nested = (reference: string) =>
      fakePaystack({
        '/refund/3018284': () => refund({ transaction: { id: 4099, reference } }),
        '/transaction/verify/': () => transaction(),
      });
    const good = new PaystackPaymentAdapter({ secretKey: SECRET, fetch: nested('DASH-1').impl });
    expect((await ask(good)).matchesPayment).toBe(true);
    const bad = new PaystackPaymentAdapter({ secretKey: SECRET, fetch: nested('DASH-2').impl });
    expect((await ask(bad)).matchesPayment).toBe(false);
  });

  it('does not match when Paystack answers for a different refund id', async () => {
    const paystack = fakePaystack({ '/refund/3018284': () => refund({ id: 1 }), '/transaction/verify/': () => transaction() });
    expect((await ask(new PaystackPaymentAdapter({ secretKey: SECRET, fetch: paystack.impl }))).matchesPayment).toBe(false);
  });

  it('maps every Paystack refund state, and only processed means done', async () => {
    for (const [paystackStatus, ours] of [
      ['processed', 'processed'],
      ['failed', 'failed'],
      ['pending', 'pending'],
      ['processing', 'pending'],
      ['needs-attention', 'pending'],
      ['something-new', 'pending'],
    ] as const) {
      const paystack = fakePaystack({
        '/refund/3018284': () => refund({ status: paystackStatus }),
        '/transaction/verify/': () => transaction(),
      });
      const found = await ask(new PaystackPaymentAdapter({ secretKey: SECRET, fetch: paystack.impl }));
      expect(found.status, paystackStatus).toBe(ours);
      expect(found.providerStatus).toBe(paystackStatus);
    }
  });

  it('treats a refund id Paystack does not know as not ours', async () => {
    const paystack = fakePaystack({ '/transaction/verify/': () => transaction() });
    const found = await ask(new PaystackPaymentAdapter({ secretKey: SECRET, fetch: paystack.impl }), '42');
    expect(found).toMatchObject({ matchesPayment: false, providerStatus: 'not_found' });
  });

  it('never puts anything but digits into the URL', async () => {
    const paystack = fakePaystack({});
    const adapter = new PaystackPaymentAdapter({ secretKey: SECRET, fetch: paystack.impl });
    for (const hostile of ['../transaction/export', '12/../../customer', 'abc', '1 2', '']) {
      expect((await ask(adapter, hostile)).matchesPayment, hostile).toBe(false);
    }
    expect(paystack.calls).toHaveLength(0);
  });

  it('throws — rather than answering "not found" — when Paystack is down or erroring', async () => {
    const down = fakePaystack({ '/refund/': () => 'network' });
    await expect(ask(new PaystackPaymentAdapter({ secretKey: SECRET, fetch: down.impl }), '1')).rejects.toBeInstanceOf(
      PaymentProviderError,
    );
    const erroring = fakePaystack({ '/refund/': () => ({ status: 500, json: { status: false, message: 'Server error' } }) });
    await expect(ask(new PaystackPaymentAdapter({ secretKey: SECRET, fetch: erroring.impl }), '1')).rejects.toBeInstanceOf(
      PaymentProviderError,
    );
  });

  it('never reports a fractional amount', async () => {
    const paystack = fakePaystack({
      '/refund/3018284': () => refund({ amount: 499_999.5 }),
      '/transaction/verify/': () => transaction(),
    });
    expect((await ask(new PaystackPaymentAdapter({ secretKey: SECRET, fetch: paystack.impl }))).amount).toBe(0);
  });
});

describe('banks and account names', () => {
  /** A fake that answers by full URL, so paging and query strings can be checked. */
  function fakeBanks(answer: (url: URL) => { status: number; json: unknown } | 'network') {
    const urls: URL[] = [];
    const impl = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      urls.push(url);
      const result = answer(url);
      if (result === 'network') throw new TypeError('fetch failed');
      return new Response(JSON.stringify(result.json), { status: result.status });
    }) as typeof fetch;
    return { impl, urls };
  }

  it('follows every page of Paystack’s Nigerian banks, keeping active NUBAN banks once each', async () => {
    const paystack = fakeBanks((url) => {
      if (url.searchParams.get('next') === 'page-2') {
        return {
          status: 200,
          json: { status: true, data: [{ name: 'Zenith Bank', code: '057', type: 'nuban', active: true }], meta: { next: null } },
        };
      }
      return {
        status: 200,
        json: {
          status: true,
          data: [
            { name: 'Guaranty Trust Bank', code: '058', type: 'nuban', active: true },
            { name: 'Access Bank', code: '044', type: 'nuban', active: true },
            { name: 'Access Bank (Duplicate)', code: '044', type: 'nuban', active: true },
            { name: 'Old Bank', code: '999', type: 'nuban', active: false },
            { name: 'Gone Bank', code: '998', type: 'nuban', active: true, is_deleted: true },
            { name: 'Some Wallet', code: 'MPESA', type: 'mobile_money', active: true },
          ],
          meta: { next: 'page-2' },
        },
      };
    });
    const adapter = new PaystackPaymentAdapter({ secretKey: SECRET, fetch: paystack.impl });
    expect(await adapter.listBanks()).toEqual([
      { code: '044', name: 'Access Bank' },
      { code: '058', name: 'Guaranty Trust Bank' },
      { code: '057', name: 'Zenith Bank' },
    ]);
    expect(paystack.urls).toHaveLength(2);
    expect(paystack.urls[0]!.pathname).toBe('/bank');
    expect(paystack.urls[0]!.searchParams.get('country')).toBe('nigeria');
    expect(paystack.urls[0]!.searchParams.get('currency')).toBe('NGN');
  });

  it('throws when the bank list cannot be fetched', async () => {
    const adapter = new PaystackPaymentAdapter({ secretKey: SECRET, fetch: fakeBanks(() => ({ status: 500, json: { status: false } })).impl });
    await expect(adapter.listBanks()).rejects.toBeInstanceOf(PaymentProviderError);
  });

  it('resolves the account name the bank holds', async () => {
    const paystack = fakeBanks(() => ({
      status: 200,
      json: { status: true, data: { account_number: '0123456789', account_name: 'ADA OBI', bank_id: 9 } },
    }));
    const adapter = new PaystackPaymentAdapter({ secretKey: SECRET, fetch: paystack.impl });
    expect(await adapter.resolveBankAccount({ bankCode: '058', accountNumber: '0123456789' })).toEqual({ accountName: 'ADA OBI' });
    expect(paystack.urls[0]!.pathname).toBe('/bank/resolve');
    expect(paystack.urls[0]!.searchParams.get('account_number')).toBe('0123456789');
    expect(paystack.urls[0]!.searchParams.get('bank_code')).toBe('058');
  });

  it('reads Paystack’s 422 as "no such account", and never asks about a malformed one', async () => {
    const paystack = fakeBanks(() => ({ status: 422, json: { status: false, message: 'Could not resolve account name.' } }));
    const adapter = new PaystackPaymentAdapter({ secretKey: SECRET, fetch: paystack.impl });
    expect(await adapter.resolveBankAccount({ bankCode: '058', accountNumber: '0123456789' })).toBeNull();
    expect(await adapter.resolveBankAccount({ bankCode: '058', accountNumber: '12345' })).toBeNull();
    expect(await adapter.resolveBankAccount({ bankCode: '05 8&x=1', accountNumber: '0123456789' })).toBeNull();
    expect(paystack.urls).toHaveLength(1);
  });

  it('throws when Paystack cannot be asked, rather than calling the account unknown', async () => {
    for (const answer of ['network', { status: 500, json: { status: false } }, { status: 429, json: { status: false } }] as const) {
      const adapter = new PaystackPaymentAdapter({ secretKey: SECRET, fetch: fakeBanks(() => answer).impl });
      await expect(adapter.resolveBankAccount({ bankCode: '058', accountNumber: '0123456789' })).rejects.toBeInstanceOf(PaymentProviderError);
    }
  });
});
