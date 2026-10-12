import { expect, it } from 'vitest';
import { canApplySubmittedPriceConsent } from './price-consent.js';
const consent = {
  expectedPriceKobo: 1_000_000, submittedPriceConsentKobo: 1_000_000,
  submittedPriceConsentAt: new Date('2026-10-11T09:00:00Z'), submittedPriceConsentBy: 'seller-1',
  sellerIdentityId: 'seller-1', authorizationVersion: 0,
};
it('accepts only an explicitly consented exact submitted price', () => {
  expect(canApplySubmittedPriceConsent(consent, 1_000_000)).toBe(true);
  expect(canApplySubmittedPriceConsent(consent, 1_000_001)).toBe(false);
  expect(canApplySubmittedPriceConsent(consent, 999_999)).toBe(false);
});
it('leaves legacy submissions without consent awaiting a seller answer', () => {
  expect(canApplySubmittedPriceConsent({ ...consent, submittedPriceConsentKobo: null, submittedPriceConsentAt: null, submittedPriceConsentBy: null }, 1_000_000)).toBe(false);
});
it.each([
  { expectedPriceKobo: null }, { expectedPriceKobo: 999_999 },
  { submittedPriceConsentKobo: null }, { submittedPriceConsentAt: null },
  { submittedPriceConsentAt: new Date('invalid') }, { submittedPriceConsentBy: null },
  { submittedPriceConsentBy: 'someone-else' }, { sellerIdentityId: null }, { authorizationVersion: 1 },
])('does not infer consent from incomplete evidence or reuse an older authorisation', patch => {
  expect(canApplySubmittedPriceConsent({ ...consent, ...patch }, 1_000_000)).toBe(false);
});
