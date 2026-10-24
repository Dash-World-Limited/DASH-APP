-- Nullable deliberately: existing prices are not evidence of seller consent.
ALTER TABLE "DeclutterSubmission" ADD COLUMN "submittedPriceConsentKobo" INTEGER;
ALTER TABLE "DeclutterSubmission" ADD COLUMN "submittedPriceConsentAt" TIMESTAMP(3);
ALTER TABLE "DeclutterSubmission" ADD COLUMN "submittedPriceConsentBy" TEXT;
