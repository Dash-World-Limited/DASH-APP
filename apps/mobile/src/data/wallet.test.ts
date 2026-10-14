/**
 * The wallet's calls: balance and history, and saved cards. The app never
 * sends a card number — adding a card only asks the server for the provider's
 * page and later asks how it went.
 */

import { describe, expect, it } from 'vitest';

import type { ApiClient, RequestOptions } from '../api/client';
import { confirmCardSetup, getWallet, listCards, makeCardDefault, removeCard, startCardSetup } from './wallet';

function fakeClient(answer: unknown) {
  const calls: { path: string; options: RequestOptions }[] = [];
  const api = {
    configured: true,
    request: async (path: string, options: RequestOptions = {}) => {
      calls.push({ path, options });
      return answer;
    },
  } as unknown as ApiClient;
  return { api, calls };
}

const card = { id: 'pm 1', brand: 'visa', last4: '4081', expMonth: 12, expYear: 2030, bank: null, isDefault: true, createdAt: '2026-10-01T00:00:00.000Z' };

describe('wallet calls', () => {
  it('reads the balance and the cards', async () => {
    const wallet = fakeClient({ currency: 'NGN', balance: 0, transactions: [] });
    await getWallet(wallet.api);
    expect(wallet.calls).toEqual([{ path: '/v1/wallet', options: {} }]);

    const cards = fakeClient({ methods: [card], pendingSetup: null });
    expect(await listCards(cards.api)).toEqual({ methods: [card], pendingSetup: null });
    expect(cards.calls[0]?.path).toBe('/v1/wallet/payment-methods');
  });

  it('starts a setup without sending anything about the card', async () => {
    const { api, calls } = fakeClient({ setup: { reference: 'CARD-ABC', authorizationUrl: 'https://checkout.paystack.com/x', amount: 5000 } });
    expect(await startCardSetup(api)).toEqual({ reference: 'CARD-ABC', authorizationUrl: 'https://checkout.paystack.com/x', amount: 5000 });
    expect(calls).toEqual([{ path: '/v1/wallet/payment-methods/setup', options: { method: 'POST' } }]);
  });

  it('asks how a setup went, and manages cards by id', async () => {
    const confirm = fakeClient({ outcome: { status: 'pending' } });
    expect(await confirmCardSetup(confirm.api, 'CARD-ABC')).toEqual({ status: 'pending' });
    expect(confirm.calls[0]).toEqual({ path: '/v1/wallet/payment-methods/setup/CARD-ABC/confirm', options: { method: 'POST' } });

    const manage = fakeClient({ methods: [card] });
    expect(await makeCardDefault(manage.api, 'pm 1')).toEqual([card]);
    expect(await removeCard(manage.api, 'pm 1')).toEqual([card]);
    expect(manage.calls).toEqual([
      { path: '/v1/wallet/payment-methods/pm%201/default', options: { method: 'POST' } },
      { path: '/v1/wallet/payment-methods/pm%201', options: { method: 'DELETE' } },
    ]);
  });
});
