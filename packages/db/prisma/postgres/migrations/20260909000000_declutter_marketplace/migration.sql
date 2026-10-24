-- DASH World Declutters: the marketplace tables.
--
-- Sixteen new tables. Purely additive — no existing table is altered, no column
-- is dropped, and nothing here touches Order, the dispatch tables, sessions or
-- payments. Applying this to a populated production database creates empty
-- tables and takes no lock on anything that is being read.
--
-- Mirrors the SQLite migration of the same name. Written to match the
-- PostgreSQL dialect the init migration established: TIMESTAMP(3) rather than
-- DATETIME, quoted identifiers throughout, primary keys as named constraints,
-- and foreign keys added after every table exists so ordering does not matter.
--
-- Delete semantics, which are the part worth reading:
--
--   * CASCADE where the child is meaningless without its parent — a photo
--     without its submission, an event without its listing.
--   * RESTRICT where the child is a record we must not lose by deleting
--     something else — a listing referencing its seller, a disclosure
--     referencing the request that authorised it.
--   * SET NULL for optional links whose absence is a legitimate state — a
--     category that was reorganised, a fingerprint that was pruned.
--
-- DeclutterContactDisclosure deliberately has no foreign key to Customer. It
-- records that a real person's contact details were handed to another real
-- person, and that record has to outlive the account it was handed to.
--
-- Verify with `npm run check:postgres` after applying.

-- CreateTable
CREATE TABLE "DeclutterLocation" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "parentId" TEXT,
    "cityId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeclutterLocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeclutterCategory" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "parentId" TEXT,
    "attributeSchema" TEXT,
    "requiresOwnershipEvidence" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeclutterCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeclutterSeller" (
    "id" TEXT NOT NULL,
    "customerId" TEXT,
    "displayName" TEXT NOT NULL,
    "sellerType" TEXT NOT NULL DEFAULT 'individual',
    "publicArea" TEXT,
    "kycStatus" TEXT NOT NULL DEFAULT 'unverified',
    "legalName" TEXT,
    "nationalIdCipher" TEXT,
    "nationalIdLast4" TEXT,
    "phoneE164" TEXT,
    "phoneVerifiedAt" TIMESTAMP(3),
    "addressLine" TEXT,
    "bankName" TEXT,
    "bankAccountLast4" TEXT,
    "bankAccountCipher" TEXT,
    "bankAccountName" TEXT,
    "nameMatchScore" INTEGER,
    "nameMatchVerdict" TEXT,
    "nameMatchDetail" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "verifiedBy" TEXT,
    "rejectionReason" TEXT,
    "adminNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeclutterSeller_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeclutterSellerDocument" (
    "id" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "note" TEXT,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeclutterSellerDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeclutterSubmission" (
    "id" TEXT NOT NULL,
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
    "sellerAcceptedAt" TIMESTAMP(3),
    "sellerAcceptanceBy" TEXT,
    "sellerAcceptanceNote" TEXT,
    "rejectionReason" TEXT,
    "adminNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeclutterSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeclutterSubmissionEvent" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT,
    "reasonCode" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeclutterSubmissionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeclutterSubmissionPhoto" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "fingerprintId" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "bytes" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeclutterSubmissionPhoto_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeclutterValuation" (
    "id" TEXT NOT NULL,
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
    "failureReason" TEXT,
    "adminDecision" TEXT,
    "adminPriceKobo" INTEGER,
    "adminReason" TEXT,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeclutterValuation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeclutterListing" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "submissionId" TEXT,
    "sellerId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "condition" TEXT NOT NULL,
    "priceKobo" INTEGER NOT NULL,
    "attributes" TEXT,
    "moderationStatus" TEXT NOT NULL DEFAULT 'draft',
    "availability" TEXT NOT NULL DEFAULT 'available',
    "publishedAt" TIMESTAMP(3),
    "soldAt" TIMESTAMP(3),
    "suspendedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "suspensionReason" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeclutterListing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeclutterListingPhoto" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "fingerprintId" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeclutterListingPhoto_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeclutterListingEvent" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "axis" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT,
    "reasonCode" TEXT,
    "note" TEXT,
    "changedFields" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeclutterListingEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeclutterContactRequest" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "buyerCustomerId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "message" TEXT,
    "grantedMethod" TEXT,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "rejectionReason" TEXT,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedBy" TEXT,
    "revocationReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeclutterContactRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
--
-- Append-only. There is no "revokedAt" column here on purpose: once a buyer has
-- seen a seller's number, no database write can make them unsee it, and a
-- revoked flag would let the product claim otherwise.
CREATE TABLE "DeclutterContactDisclosure" (
    "id" TEXT NOT NULL,
    "contactRequestId" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "buyerCustomerId" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "disclosedFields" TEXT NOT NULL,
    "approvedBy" TEXT NOT NULL,
    "approvalReason" TEXT,
    "sellerConsentAt" TIMESTAMP(3),
    "sellerConsentEvidence" TEXT,
    "disclosedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeclutterContactDisclosure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeclutterImageFingerprint" (
    "id" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "perceptualHash" TEXT,
    "firstSellerId" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeclutterImageFingerprint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeclutterImageUsage" (
    "id" TEXT NOT NULL,
    "fingerprintId" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "submissionId" TEXT,
    "outcome" TEXT NOT NULL,
    "overrideBy" TEXT,
    "overrideReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeclutterImageUsage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeclutterFraudFlag" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'medium',
    "sellerId" TEXT,
    "submissionId" TEXT,
    "listingId" TEXT,
    "fingerprintId" TEXT,
    "detail" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "resolvedBy" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolutionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeclutterFraudFlag_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DeclutterLocation_slug_key" ON "DeclutterLocation"("slug");

-- CreateIndex
CREATE INDEX "DeclutterLocation_kind_isActive_idx" ON "DeclutterLocation"("kind", "isActive");

-- CreateIndex
CREATE INDEX "DeclutterLocation_parentId_idx" ON "DeclutterLocation"("parentId");

-- CreateIndex
CREATE UNIQUE INDEX "DeclutterCategory_key_key" ON "DeclutterCategory"("key");

-- CreateIndex
CREATE UNIQUE INDEX "DeclutterCategory_slug_key" ON "DeclutterCategory"("slug");

-- CreateIndex
CREATE INDEX "DeclutterCategory_isActive_sortOrder_idx" ON "DeclutterCategory"("isActive", "sortOrder");

-- CreateIndex
CREATE INDEX "DeclutterCategory_parentId_idx" ON "DeclutterCategory"("parentId");

-- CreateIndex
CREATE UNIQUE INDEX "DeclutterSeller_customerId_key" ON "DeclutterSeller"("customerId");

-- CreateIndex
CREATE INDEX "DeclutterSeller_kycStatus_idx" ON "DeclutterSeller"("kycStatus");

-- CreateIndex
CREATE INDEX "DeclutterSeller_sellerType_idx" ON "DeclutterSeller"("sellerType");

-- CreateIndex
CREATE INDEX "DeclutterSellerDocument_sellerId_status_idx" ON "DeclutterSellerDocument"("sellerId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "DeclutterSubmission_code_key" ON "DeclutterSubmission"("code");

-- CreateIndex
CREATE INDEX "DeclutterSubmission_status_createdAt_idx" ON "DeclutterSubmission"("status", "createdAt");

-- CreateIndex
CREATE INDEX "DeclutterSubmission_sellerId_status_idx" ON "DeclutterSubmission"("sellerId", "status");

-- CreateIndex
CREATE INDEX "DeclutterSubmissionEvent_submissionId_createdAt_idx" ON "DeclutterSubmissionEvent"("submissionId", "createdAt");

-- CreateIndex
CREATE INDEX "DeclutterSubmissionPhoto_fingerprintId_idx" ON "DeclutterSubmissionPhoto"("fingerprintId");

-- CreateIndex
CREATE UNIQUE INDEX "DeclutterSubmissionPhoto_submissionId_position_key" ON "DeclutterSubmissionPhoto"("submissionId", "position");

-- CreateIndex
CREATE INDEX "DeclutterValuation_submissionId_createdAt_idx" ON "DeclutterValuation"("submissionId", "createdAt");

-- CreateIndex
CREATE INDEX "DeclutterValuation_status_idx" ON "DeclutterValuation"("status");

-- CreateIndex
CREATE UNIQUE INDEX "DeclutterListing_slug_key" ON "DeclutterListing"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "DeclutterListing_submissionId_key" ON "DeclutterListing"("submissionId");

-- CreateIndex
CREATE INDEX "DeclutterListing_moderationStatus_availability_publishedAt_idx" ON "DeclutterListing"("moderationStatus", "availability", "publishedAt");

-- CreateIndex
CREATE INDEX "DeclutterListing_categoryId_availability_idx" ON "DeclutterListing"("categoryId", "availability");

-- CreateIndex
CREATE INDEX "DeclutterListing_locationId_availability_idx" ON "DeclutterListing"("locationId", "availability");

-- CreateIndex
CREATE INDEX "DeclutterListing_sellerId_idx" ON "DeclutterListing"("sellerId");

-- CreateIndex
CREATE INDEX "DeclutterListing_priceKobo_idx" ON "DeclutterListing"("priceKobo");

-- CreateIndex
CREATE INDEX "DeclutterListingPhoto_fingerprintId_idx" ON "DeclutterListingPhoto"("fingerprintId");

-- CreateIndex
CREATE UNIQUE INDEX "DeclutterListingPhoto_listingId_position_key" ON "DeclutterListingPhoto"("listingId", "position");

-- CreateIndex
CREATE INDEX "DeclutterListingEvent_listingId_createdAt_idx" ON "DeclutterListingEvent"("listingId", "createdAt");

-- CreateIndex
CREATE INDEX "DeclutterContactRequest_status_createdAt_idx" ON "DeclutterContactRequest"("status", "createdAt");

-- CreateIndex
CREATE INDEX "DeclutterContactRequest_listingId_status_idx" ON "DeclutterContactRequest"("listingId", "status");

-- CreateIndex
CREATE INDEX "DeclutterContactRequest_buyerCustomerId_createdAt_idx" ON "DeclutterContactRequest"("buyerCustomerId", "createdAt");

-- CreateIndex
CREATE INDEX "DeclutterContactDisclosure_listingId_disclosedAt_idx" ON "DeclutterContactDisclosure"("listingId", "disclosedAt");

-- CreateIndex
CREATE INDEX "DeclutterContactDisclosure_buyerCustomerId_disclosedAt_idx" ON "DeclutterContactDisclosure"("buyerCustomerId", "disclosedAt");

-- CreateIndex
CREATE INDEX "DeclutterContactDisclosure_sellerId_disclosedAt_idx" ON "DeclutterContactDisclosure"("sellerId", "disclosedAt");

-- CreateIndex
CREATE UNIQUE INDEX "DeclutterImageFingerprint_sha256_key" ON "DeclutterImageFingerprint"("sha256");

-- CreateIndex
CREATE INDEX "DeclutterImageFingerprint_perceptualHash_idx" ON "DeclutterImageFingerprint"("perceptualHash");

-- CreateIndex
CREATE INDEX "DeclutterImageUsage_fingerprintId_createdAt_idx" ON "DeclutterImageUsage"("fingerprintId", "createdAt");

-- CreateIndex
CREATE INDEX "DeclutterImageUsage_sellerId_createdAt_idx" ON "DeclutterImageUsage"("sellerId", "createdAt");

-- CreateIndex
CREATE INDEX "DeclutterFraudFlag_status_severity_createdAt_idx" ON "DeclutterFraudFlag"("status", "severity", "createdAt");

-- CreateIndex
CREATE INDEX "DeclutterFraudFlag_sellerId_status_idx" ON "DeclutterFraudFlag"("sellerId", "status");

-- AddForeignKey
ALTER TABLE "DeclutterLocation" ADD CONSTRAINT "DeclutterLocation_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "DeclutterLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeclutterCategory" ADD CONSTRAINT "DeclutterCategory_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "DeclutterCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeclutterSeller" ADD CONSTRAINT "DeclutterSeller_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeclutterSellerDocument" ADD CONSTRAINT "DeclutterSellerDocument_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "DeclutterSeller"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeclutterSubmission" ADD CONSTRAINT "DeclutterSubmission_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "DeclutterSeller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeclutterSubmission" ADD CONSTRAINT "DeclutterSubmission_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "DeclutterCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeclutterSubmissionEvent" ADD CONSTRAINT "DeclutterSubmissionEvent_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "DeclutterSubmission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeclutterSubmissionPhoto" ADD CONSTRAINT "DeclutterSubmissionPhoto_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "DeclutterSubmission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeclutterSubmissionPhoto" ADD CONSTRAINT "DeclutterSubmissionPhoto_fingerprintId_fkey" FOREIGN KEY ("fingerprintId") REFERENCES "DeclutterImageFingerprint"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeclutterValuation" ADD CONSTRAINT "DeclutterValuation_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "DeclutterSubmission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeclutterListing" ADD CONSTRAINT "DeclutterListing_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "DeclutterSeller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeclutterListing" ADD CONSTRAINT "DeclutterListing_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "DeclutterSubmission"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeclutterListing" ADD CONSTRAINT "DeclutterListing_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "DeclutterCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeclutterListing" ADD CONSTRAINT "DeclutterListing_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "DeclutterLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeclutterListingPhoto" ADD CONSTRAINT "DeclutterListingPhoto_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "DeclutterListing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeclutterListingPhoto" ADD CONSTRAINT "DeclutterListingPhoto_fingerprintId_fkey" FOREIGN KEY ("fingerprintId") REFERENCES "DeclutterImageFingerprint"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeclutterListingEvent" ADD CONSTRAINT "DeclutterListingEvent_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "DeclutterListing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeclutterContactRequest" ADD CONSTRAINT "DeclutterContactRequest_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "DeclutterListing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeclutterContactRequest" ADD CONSTRAINT "DeclutterContactRequest_buyerCustomerId_fkey" FOREIGN KEY ("buyerCustomerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeclutterContactDisclosure" ADD CONSTRAINT "DeclutterContactDisclosure_contactRequestId_fkey" FOREIGN KEY ("contactRequestId") REFERENCES "DeclutterContactRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeclutterContactDisclosure" ADD CONSTRAINT "DeclutterContactDisclosure_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "DeclutterListing"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeclutterImageUsage" ADD CONSTRAINT "DeclutterImageUsage_fingerprintId_fkey" FOREIGN KEY ("fingerprintId") REFERENCES "DeclutterImageFingerprint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeclutterImageUsage" ADD CONSTRAINT "DeclutterImageUsage_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "DeclutterSeller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeclutterFraudFlag" ADD CONSTRAINT "DeclutterFraudFlag_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "DeclutterSeller"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeclutterFraudFlag" ADD CONSTRAINT "DeclutterFraudFlag_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "DeclutterSubmission"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeclutterFraudFlag" ADD CONSTRAINT "DeclutterFraudFlag_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "DeclutterListing"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeclutterFraudFlag" ADD CONSTRAINT "DeclutterFraudFlag_fingerprintId_fkey" FOREIGN KEY ("fingerprintId") REFERENCES "DeclutterImageFingerprint"("id") ON DELETE SET NULL ON UPDATE CASCADE;
