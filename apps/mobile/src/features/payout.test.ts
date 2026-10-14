import { describe, expect, it } from 'vitest';

import type { ApiClient, RequestOptions } from '../api/client';
import { getPayoutAccount, listPayoutBanks, savePayoutAccount, verifyPayoutAccount } from '../data/payout';
import { accountNumberProblem, filterBanks, normaliseAccountNumber } from './payout';

const BANKS = [
  { code: '044', name: 'Access Bank' },
  { code: '058', name: 'Guaranty Trust Bank' },
  { code: '999992', name: 'OPay Digital Services Limited (OPay)' },
  { code: '057', name: 'Zenith Bank' },
];

function fakeClient(answer: unknown) {
  const calls: { path: string; options: RequestOptions }[] = [];
  const api: ApiClient = {
    configured: true,
    request: async <T,>(path: string, options: RequestOptions = {}) => {
      calls.push({ path, options });
      return answer as T;
    },
    restore: async () => 'authenticated',
    signOut: async () => undefined,
  };
  return { api, calls };
}

describe('the account number', () => {
  it('accepts exactly ten digits, however it was typed', () => {
    expect(normaliseAccountNumber(' 012-345 6789 ')).toBe('0123456789');
    expect(accountNumberProblem('012 345 6789')).toBeNull();
  });

  it('explains what is wrong', () => {
    expect(accountNumberProblem('')).toMatch(/Enter/);
    expect(accountNumberProblem('12345')).toMatch(/10 digits/);
    expect(accountNumberProblem('012345678901')).toMatch(/10 digits/);
  });
});

describe('finding a bank', () => {
  it('matches by name, initials or code, ignoring case and punctuation', () => {
    expect(filterBanks(BANKS, 'zen').map((bank) => bank.code)).toEqual(['057']);
    expect(filterBanks(BANKS, 'GTB').map((bank) => bank.code)).toEqual(['058']);
    expect(filterBanks(BANKS, 'opay').map((bank) => bank.code)).toEqual(['999992']);
    expect(filterBanks(BANKS, '044').map((bank) => bank.code)).toEqual(['044']);
    expect(filterBanks(BANKS, '')).toHaveLength(BANKS.length);
    expect(filterBanks(BANKS, 'nonexistent')).toEqual([]);
  });
});

describe('the payout account calls', () => {
  it('reads the masked account and the bank list', async () => {
    const account = { configured: false };
    const reading = fakeClient({ payoutAccount: account });
    expect(await getPayoutAccount(reading.api)).toBe(account);
    expect(reading.calls[0]?.path).toBe('/v1/rider/payout-account');

    const banks = fakeClient({ banks: BANKS });
    expect(await listPayoutBanks(banks.api)).toEqual(BANKS);
    expect(banks.calls[0]?.path).toBe('/v1/rider/payout-account/banks');
  });

  it('checks before saving, and saves the name the rider was shown', async () => {
    const verify = fakeClient({ account: { bankCode: '058', bankName: 'Guaranty Trust Bank', accountName: 'ADA OBI', accountNumberMasked: '••••••6789' } });
    await verifyPayoutAccount(verify.api, { bankCode: '058', accountNumber: '0123456789' });
    expect(verify.calls[0]).toEqual({
      path: '/v1/rider/payout-account/verify',
      options: { method: 'POST', body: { bankCode: '058', accountNumber: '0123456789' } },
    });

    const save = fakeClient({ payoutAccount: { configured: true } });
    await savePayoutAccount(save.api, { bankCode: '058', accountNumber: '0123456789', accountName: 'ADA OBI' });
    expect(save.calls[0]).toEqual({
      path: '/v1/rider/payout-account',
      options: { method: 'PUT', body: { bankCode: '058', accountNumber: '0123456789', accountName: 'ADA OBI' } },
    });
  });
});
