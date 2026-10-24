/** An explicit seller consent applies only to the first authorisation of this exact submitted price. */
export function canApplySubmittedPriceConsent(input: {
  expectedPriceKobo: number | null;
  submittedPriceConsentKobo: number | null;
  submittedPriceConsentAt: Date | null;
  submittedPriceConsentBy: string | null;
  sellerIdentityId: string | null;
  authorizationVersion: number;
}, authorizedPriceKobo: number): boolean {
  return input.authorizationVersion === 0
    && Number.isSafeInteger(authorizedPriceKobo) && authorizedPriceKobo > 0
    && input.expectedPriceKobo === authorizedPriceKobo
    && input.submittedPriceConsentKobo === authorizedPriceKobo
    && input.submittedPriceConsentAt !== null && Number.isFinite(input.submittedPriceConsentAt.getTime())
    && input.sellerIdentityId !== null
    && input.submittedPriceConsentBy === input.sellerIdentityId;
}
