-- DASH ValueCheck: comparables, pricing decisions, and the authoritative price.
--
-- The SQLite mirror, for local development. SQLite cannot add a column with a
-- foreign key in place, so Prisma redefines the two changed tables: it builds
-- `new_X`, copies every existing row across, drops the old table and renames.
-- No data is lost — the INSERT ... SELECT below names every prior column.
--
-- Generated with `prisma migrate diff` against the schema at fc97d9a.
-- CreateTable
CREATE TABLE "DeclutterComparable" (
    "id" TEXT NOT NULL PRIMARY KEY,
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
    "observedAt" DATETIME NOT NULL,
    "note" TEXT,
    "createdBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DeclutterComparable_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "DeclutterSubmission" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DeclutterPricingDecision" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "submissionId" TEXT NOT NULL,
    "valuationId" TEXT,
    "actorRole" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "recommendedPriceKobo" INTEGER,
    "proposedPriceKobo" INTEGER,
    "reason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DeclutterPricingDecision_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "DeclutterSubmission" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DeclutterPricingDecision_valuationId_fkey" FOREIGN KEY ("valuationId") REFERENCES "DeclutterValuation" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_DeclutterSubmission" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "intakeChannel" TEXT NOT NULL DEFAULT 'whatsapp',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "title" TEXT,
    "description" TEXT,
    "categoryId" TEXT,
    "condition" TEXT,
    "attributes" TEXT,
    "expectedPriceKobo" INTEGER,
    "locationId" TEXT,
    "finalPriceKobo" INTEGER,
    "sellerAcceptedAt" DATETIME,
    "sellerAcceptanceBy" TEXT,
    "sellerAcceptanceNote" TEXT,
    "rejectionReason" TEXT,
    "adminNotes" TEXT,
    "valueCheckStatus" TEXT NOT NULL DEFAULT 'valuation_pending',
    "escalationReasons" TEXT,
    "authorizedPriceKobo" INTEGER,
    "authorizationVersion" INTEGER NOT NULL DEFAULT 0,
    "authorizedAt" DATETIME,
    "authorizedBy" TEXT,
    "sellerAcceptedPriceKobo" INTEGER,
    "sellerAcceptedVersion" INTEGER,
    "sellerDeclinedAt" DATETIME,
    "sellerDeclineReason" TEXT,
    "partnerApprovalRequired" BOOLEAN NOT NULL DEFAULT false,
    "partnerApprovedAt" DATETIME,
    "partnerApprovedBy" TEXT,
    "partnerApprovalNote" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "DeclutterSubmission_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "DeclutterSeller" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "DeclutterSubmission_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "DeclutterCategory" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_DeclutterSubmission" ("adminNotes", "attributes", "categoryId", "code", "condition", "createdAt", "description", "expectedPriceKobo", "finalPriceKobo", "id", "intakeChannel", "locationId", "rejectionReason", "sellerAcceptanceBy", "sellerAcceptanceNote", "sellerAcceptedAt", "sellerId", "status", "title", "updatedAt") SELECT "adminNotes", "attributes", "categoryId", "code", "condition", "createdAt", "description", "expectedPriceKobo", "finalPriceKobo", "id", "intakeChannel", "locationId", "rejectionReason", "sellerAcceptanceBy", "sellerAcceptanceNote", "sellerAcceptedAt", "sellerId", "status", "title", "updatedAt" FROM "DeclutterSubmission";
DROP TABLE "DeclutterSubmission";
ALTER TABLE "new_DeclutterSubmission" RENAME TO "DeclutterSubmission";
CREATE UNIQUE INDEX "DeclutterSubmission_code_key" ON "DeclutterSubmission"("code");
CREATE INDEX "DeclutterSubmission_status_createdAt_idx" ON "DeclutterSubmission"("status", "createdAt");
CREATE INDEX "DeclutterSubmission_valueCheckStatus_updatedAt_idx" ON "DeclutterSubmission"("valueCheckStatus", "updatedAt");
CREATE INDEX "DeclutterSubmission_sellerId_status_idx" ON "DeclutterSubmission"("sellerId", "status");
CREATE TABLE "new_DeclutterValuation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "submissionId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "requestPayload" TEXT NOT NULL,
    "providerName" TEXT,
    "modelVersion" TEXT,
    "algorithmVersion" TEXT,
    "estimatedMinKobo" INTEGER,
    "estimatedMaxKobo" INTEGER,
    "recommendedPriceKobo" INTEGER,
    "confidenceBasisPoints" INTEGER,
    "factors" TEXT,
    "reasoning" TEXT,
    "warnings" TEXT,
    "evidenceSummary" TEXT,
    "isLive" BOOLEAN NOT NULL DEFAULT false,
    "producedAt" DATETIME,
    "failureReason" TEXT,
    "adminDecision" TEXT,
    "adminPriceKobo" INTEGER,
    "adminReason" TEXT,
    "decidedBy" TEXT,
    "decidedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DeclutterValuation_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "DeclutterSubmission" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_DeclutterValuation" ("adminDecision", "adminPriceKobo", "adminReason", "algorithmVersion", "confidenceBasisPoints", "createdAt", "decidedAt", "decidedBy", "estimatedMaxKobo", "estimatedMinKobo", "factors", "failureReason", "id", "modelVersion", "providerName", "reasoning", "recommendedPriceKobo", "requestPayload", "status", "submissionId") SELECT "adminDecision", "adminPriceKobo", "adminReason", "algorithmVersion", "confidenceBasisPoints", "createdAt", "decidedAt", "decidedBy", "estimatedMaxKobo", "estimatedMinKobo", "factors", "failureReason", "id", "modelVersion", "providerName", "reasoning", "recommendedPriceKobo", "requestPayload", "status", "submissionId" FROM "DeclutterValuation";
DROP TABLE "DeclutterValuation";
ALTER TABLE "new_DeclutterValuation" RENAME TO "DeclutterValuation";
CREATE INDEX "DeclutterValuation_submissionId_createdAt_idx" ON "DeclutterValuation"("submissionId", "createdAt");
CREATE INDEX "DeclutterValuation_status_idx" ON "DeclutterValuation"("status");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "DeclutterComparable_submissionId_observedAt_idx" ON "DeclutterComparable"("submissionId", "observedAt");

-- CreateIndex
CREATE INDEX "DeclutterPricingDecision_submissionId_createdAt_idx" ON "DeclutterPricingDecision"("submissionId", "createdAt");

