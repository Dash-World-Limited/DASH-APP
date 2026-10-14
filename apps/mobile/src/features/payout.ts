/**
 * Rules for the rider's bank account form, kept out of the screen so they are
 * tested without rendering it.
 */

import type { PayoutBank } from '../data/payout';

/** Digits only: people paste numbers with spaces or dashes. */
export function normaliseAccountNumber(raw: string): string {
  return raw.replace(/\D/g, '');
}

/** Why a typed account number cannot be checked yet, or null when it can. */
export function accountNumberProblem(raw: string): string | null {
  const digits = normaliseAccountNumber(raw);
  if (digits.length === 0) return 'Enter your account number.';
  if (digits.length !== 10) return 'Nigerian account numbers have 10 digits.';
  return null;
}

/**
 * Banks matching what the rider typed, by name, initials or code. Matching
 * ignores case and punctuation, so "guaranty" and "gtb" both find Guaranty
 * Trust Bank.
 */
export function filterBanks(banks: readonly PayoutBank[], query: string): PayoutBank[] {
  const squash = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
  const wanted = squash(query);
  if (!wanted) return [...banks];
  const initials = (name: string) =>
    name
      .split(/[\s()&-]+/)
      .filter(Boolean)
      .map((word) => word[0]?.toLowerCase() ?? '')
      .join('');
  return banks.filter((bank) => squash(bank.name).includes(wanted) || bank.code === query.trim() || initials(bank.name).startsWith(wanted));
}
