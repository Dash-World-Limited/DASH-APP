-- Nullable deliberately: existing prices are not evidence of seller consent.
ALTER TABLE "DeclutterSubmission" ADD COLUMN "submittedPriceConsentKobo" INTEGER;
ALTER TABLE "DeclutterSubmission" ADD COLUMN "submittedPriceConsentAt" DATETIME;
ALTER TABLE "DeclutterSubmission" ADD COLUMN "submittedPriceConsentBy" TEXT;
