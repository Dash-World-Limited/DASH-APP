/**
 * How saved cards and card-setup outcomes read in the wallet.
 */

import { describe, expect, it } from 'vitest';

import type { SavedCard } from '../data/wallet';
import { cardExpiry, cardTitle, setupOutcomeMessage } from './wallet';

const card: SavedCard = { id: 'pm_1', brand: 'visa', last4: '4081', expMonth: 12, expYear: 2030, bank: 'TEST BANK', isDefault: true, createdAt: '2026-10-01T00:00:00.000Z' };

describe('a saved card', () => {
  it('shows only its brand and last four', () => {
    expect(cardTitle(card)).toBe('Visa •••• 4081');
    expect(cardTitle({ brand: 'mastercard', last4: '5555' })).toBe('Mastercard •••• 5555');
    expect(cardTitle({ brand: 'verve', last4: '0001' })).toBe('Verve •••• 0001');
    expect(cardTitle({ brand: 'discover', last4: '1117' })).toBe('Discover •••• 1117');
    expect(cardTitle({ brand: '', last4: '1117' })).toBe('Card •••• 1117');
  });

  it('says when it expires, and when it already has', () => {
    const now = new Date(2026, 9, 14);
    expect(cardExpiry(card, now)).toEqual({ label: 'Expires 12/30', expired: false });
    expect(cardExpiry({ expMonth: 10, expYear: 2026 }, now)).toEqual({ label: 'Expires 10/26', expired: false });
    expect(cardExpiry({ expMonth: 9, expYear: 2026 }, now)).toEqual({ label: 'Expired 09/26', expired: true });
    expect(cardExpiry({ expMonth: 3, expYear: 2024 }, now)).toEqual({ label: 'Expired 03/24', expired: true });
  });
});

describe('what the customer is told after adding a card', () => {
  it('confirms a saved card and the refund of the verification charge', () => {
    expect(setupOutcomeMessage({ status: 'saved', method: card, refunded: true })).toEqual({
      text: 'Visa •••• 4081 is saved. The verification charge is being refunded to it.',
      tone: 'success',
    });
    expect(setupOutcomeMessage({ status: 'saved', method: card, refunded: false }).text).toContain('will be refunded shortly');
  });

  it('waits while the payment page is unfinished', () => {
    expect(setupOutcomeMessage({ status: 'pending' }).tone).toBe('waiting');
  });

  it('explains a declined or unsaveable card without blaming anyone', () => {
    expect(setupOutcomeMessage({ status: 'failed', reason: 'declined' })).toEqual({ text: 'Your card wasn’t added. Please try again, or use another card.', tone: 'problem' });
    expect(setupOutcomeMessage({ status: 'failed', reason: 'card_not_reusable' }).text).toContain('refunded');
    expect(setupOutcomeMessage({ status: 'failed', reason: 'superseded' }).text).toContain('newer one');
  });
});
