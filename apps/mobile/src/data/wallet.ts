/**
 * The DASH Wallet: the ledger balance and history, and cards saved through
 * the payment provider. Cards come back masked — brand, last four, expiry —
 * and the app never handles a card number: adding a card happens on the
 * provider's own page.
 */

import type { ApiClient } from '../api/client';

export interface WalletTransaction {
  id: string;
  amount: number;
  memo: string;
  kind: string;
  referenceType: string;
  referenceId: string;
  occurredAt: string;
  createdAt: string;
}

export interface WalletSummary {
  currency: 'NGN';
  balance: number;
  transactions: WalletTransaction[];
}

export interface SavedCard {
  id: string;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  bank: string | null;
  isDefault: boolean;
  createdAt: string;
}

export interface CardSetup {
  reference: string;
  authorizationUrl: string;
  amount: number;
}

export type CardSetupOutcome =
  | { status: 'saved'; method: SavedCard; refunded: boolean }
  | { status: 'pending' }
  | { status: 'failed'; reason: string };

export function getWallet(api: ApiClient): Promise<WalletSummary> {
  return api.request<WalletSummary>('/v1/wallet');
}

export function listCards(api: ApiClient): Promise<{ methods: SavedCard[]; pendingSetup: { reference: string; amount: number } | null }> {
  return api.request('/v1/wallet/payment-methods');
}

export async function startCardSetup(api: ApiClient): Promise<CardSetup> {
  return (await api.request<{ setup: CardSetup }>('/v1/wallet/payment-methods/setup', { method: 'POST' })).setup;
}

export async function confirmCardSetup(api: ApiClient, reference: string): Promise<CardSetupOutcome> {
  return (
    await api.request<{ outcome: CardSetupOutcome }>(`/v1/wallet/payment-methods/setup/${encodeURIComponent(reference)}/confirm`, { method: 'POST' })
  ).outcome;
}

export async function makeCardDefault(api: ApiClient, id: string): Promise<SavedCard[]> {
  return (await api.request<{ methods: SavedCard[] }>(`/v1/wallet/payment-methods/${encodeURIComponent(id)}/default`, { method: 'POST' })).methods;
}

export async function removeCard(api: ApiClient, id: string): Promise<SavedCard[]> {
  return (await api.request<{ methods: SavedCard[] }>(`/v1/wallet/payment-methods/${encodeURIComponent(id)}`, { method: 'DELETE' })).methods;
}
