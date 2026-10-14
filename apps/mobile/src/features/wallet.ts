/**
 * How the wallet describes saved cards and card-setup outcomes. Pure, so the
 * wording is tested without rendering anything.
 */

import type { CardSetupOutcome, SavedCard } from '../data/wallet';

const BRANDS: Record<string, string> = {
  visa: 'Visa',
  mastercard: 'Mastercard',
  verve: 'Verve',
  'american express': 'American Express',
  amex: 'American Express',
};

export function cardTitle(card: Pick<SavedCard, 'brand' | 'last4'>): string {
  const brand = BRANDS[card.brand.trim().toLowerCase()] ?? (card.brand ? card.brand.charAt(0).toUpperCase() + card.brand.slice(1) : 'Card');
  return `${brand} •••• ${card.last4}`;
}

/** "Expires 12/30", or "Expired 03/24" for a card past its month. */
export function cardExpiry(card: Pick<SavedCard, 'expMonth' | 'expYear'>, now: Date = new Date()): { label: string; expired: boolean } {
  const month = String(card.expMonth).padStart(2, '0');
  const year = String(card.expYear % 100).padStart(2, '0');
  const expired = card.expYear < now.getFullYear() || (card.expYear === now.getFullYear() && card.expMonth < now.getMonth() + 1);
  return { label: `${expired ? 'Expired' : 'Expires'} ${month}/${year}`, expired };
}

/** What to tell the customer once the provider has answered about a setup. */
export function setupOutcomeMessage(outcome: CardSetupOutcome): { text: string; tone: 'success' | 'waiting' | 'problem' } {
  switch (outcome.status) {
    case 'saved':
      return {
        text: outcome.refunded
          ? `${cardTitle(outcome.method)} is saved. The verification charge is being refunded to it.`
          : `${cardTitle(outcome.method)} is saved. The verification charge will be refunded shortly.`,
        tone: 'success',
      };
    case 'pending':
      return { text: 'Finish adding your card on the secure payment page, then come back here.', tone: 'waiting' };
    case 'failed':
      return {
        text:
          outcome.reason === 'card_not_reusable'
            ? 'This card can’t be saved for later payments. Any verification charge is being refunded.'
            : outcome.reason === 'superseded'
              ? 'That attempt was replaced by a newer one.'
              : 'Your card wasn’t added. Please try again, or use another card.',
        tone: 'problem',
      };
  }
}
