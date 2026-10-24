-- DASH ValueCheck: comparables, pricing decisions, and the authoritative price.
--
-- Additive, and confined to the Declutter tables. Two new tables, plus columns
-- on DeclutterSubmission and DeclutterValuation. Nothing touches Order, the
-- dispatch tables, sessions or payments.
--
-- On PostgreSQL 11 and later, ADD COLUMN with a non-volatile default is a
-- catalogue-only change: no table rewrite, no long lock, safe against a
-- populated table.
--
-- Generated with `prisma migrate diff` against the schema at fc97d9a.
-- AlterTable
ALTER TABLE "DeclutterSubmission" ADD COLUMN     "authorizationVersion" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "authorizedAt" TIMESTAMP(3),
ADD COLUMN     "authorizedBy" TEXT,
ADD COLUMN     "authorizedPriceKobo" INTEGER,
ADD COLUMN     "escalationReasons" TEXT,
ADD COLUMN     "partnerApprovalNote" TEXT,
ADD COLUMN     "partnerApprovalRequired" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "partnerApprovedAt" TIMESTAMP(3),
ADD COLUMN     "partnerApprovedBy" TEXT,
ADD COLUMN     "sellerAcceptedPriceKobo" INTEGER,
ADD COLUMN     "sellerAcceptedVersion" INTEGER,
ADD COLUMN     "sellerDeclineReason" TEXT,
ADD COLUMN     "sellerDeclinedAt" TIMESTAMP(3),
ADD COLUMN     "valueCheckStatus" TEXT NOT NULL DEFAULT 'valuation_pending';

-- AlterTable
ALTER TABLE "DeclutterValuation" ADD COLUMN     "evidenceSummary" TEXT,
ADD COLUMN     "isLive" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "producedAt" TIMESTAMP(3),
ADD COLUMN     "warnings" TEXT;

-- CreateTable
CREATE TABLE "DeclutterComparable" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "provenance" TEXT NOT NULL DEFAULT 'admin',
    "source" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "variant" TEXT,
    "condition" TEXT,
    "market" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "askingPriceKobo" INTEGER,
    "soldPriceKobo" INTEGER,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeclutterComparable_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeclutterPricingDecision" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "valuationId" TEXT,
    "actorRole" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "recommendedPriceKobo" INTEGER,
    "proposedPriceKobo" INTEGER,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeclutterPricingDecision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DeclutterComparable_submissionId_observedAt_idx" ON "DeclutterComparable"("submissionId", "observedAt");

-- CreateIndex
CREATE INDEX "DeclutterPricingDecision_submissionId_createdAt_idx" ON "DeclutterPricingDecision"("submissionId", "createdAt");

-- CreateIndex
CREATE INDEX "DeclutterSubmission_valueCheckStatus_updatedAt_idx" ON "DeclutterSubmission"("valueCheckStatus", "updatedAt");

-- AddForeignKey
ALTER TABLE "DeclutterComparable" ADD CONSTRAINT "DeclutterComparable_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "DeclutterSubmission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeclutterPricingDecision" ADD CONSTRAINT "DeclutterPricingDecision_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "DeclutterSubmission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeclutterPricingDecision" ADD CONSTRAINT "DeclutterPricingDecision_valuationId_fkey" FOREIGN KEY ("valuationId") REFERENCES "DeclutterValuation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

