/**
 * The rider's payout bank account. Every read is masked: the app never holds
 * a saved account number, only the one the rider is typing.
 */

import type { ApiClient } from '../api/client';

export interface PayoutBank {
  code: string;
  name: string;
}

export interface PayoutAccount {
  configured: boolean;
  bankCode: string | null;
  bankName: string | null;
  /** As the rider's bank reported it, never as typed. */
  accountName: string | null;
  /** Last four digits only. */
  accountNumberMasked: string | null;
  verifiedAt: string | null;
  updatedAt: string | null;
}

export interface VerifiedPayoutAccount {
  bankCode: string;
  bankName: string;
  accountName: string;
  accountNumberMasked: string;
}

export async function getPayoutAccount(api: ApiClient): Promise<PayoutAccount> {
  return (await api.request<{ payoutAccount: PayoutAccount }>('/v1/rider/payout-account')).payoutAccount;
}

export async function listPayoutBanks(api: ApiClient): Promise<PayoutBank[]> {
  return (await api.request<{ banks: PayoutBank[] }>('/v1/rider/payout-account/banks')).banks;
}

/** Asks the bank whose account it is. Saves nothing. */
export async function verifyPayoutAccount(api: ApiClient, input: { bankCode: string; accountNumber: string }): Promise<VerifiedPayoutAccount> {
  return (
    await api.request<{ account: VerifiedPayoutAccount }>('/v1/rider/payout-account/verify', { method: 'POST', body: input })
  ).account;
}

/**
 * Saves the account. `accountName` is the name the rider was shown and
 * accepted; the server checks with the bank again and refuses if it changed.
 */
export async function savePayoutAccount(
  api: ApiClient,
  input: { bankCode: string; accountNumber: string; accountName: string },
): Promise<PayoutAccount> {
  return (await api.request<{ payoutAccount: PayoutAccount }>('/v1/rider/payout-account', { method: 'PUT', body: input })).payoutAccount;
}
