-- AlterTable
ALTER TABLE "Identity" ADD COLUMN "anonymisedAt" DATETIME;

-- CreateTable
CREATE TABLE "AccountDeletionRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "identityId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'scheduled',
    "requestedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "scheduledPurgeAt" DATETIME NOT NULL,
    "cancelledAt" DATETIME,
    "completedAt" DATETIME,
    "heldReason" TEXT,
    "heldAt" DATETIME,
    "reason" TEXT,
    "requestedBy" TEXT NOT NULL,
    "requestedByIp" TEXT,
    "requestedByAgent" TEXT,
    "idempotencyKey" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AccountDeletionRequest_identityId_fkey" FOREIGN KEY ("identityId") REFERENCES "Identity" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DataExportRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "identityId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "requestedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readyAt" DATETIME,
    "deliveredAt" DATETIME,
    "expiresAt" DATETIME,
    "failedAt" DATETIME,
    "failureReason" TEXT,
    "storageKey" TEXT,
    "sizeBytes" INTEGER,
    "format" TEXT NOT NULL DEFAULT 'json',
    "buildClaimId" TEXT,
    "buildClaimUntil" DATETIME,
    "buildAttempts" INTEGER NOT NULL DEFAULT 0,
    "downloadCount" INTEGER NOT NULL DEFAULT 0,
    "downloadLeaseId" TEXT,
    "downloadLeaseUntil" DATETIME,
    "requestedByIp" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "DataExportRequest_identityId_fkey" FOREIGN KEY ("identityId") REFERENCES "Identity" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "AccountDeletionRequest_idempotencyKey_key" ON "AccountDeletionRequest"("idempotencyKey");

-- CreateIndex
CREATE INDEX "AccountDeletionRequest_status_scheduledPurgeAt_idx" ON "AccountDeletionRequest"("status", "scheduledPurgeAt");

-- CreateIndex
CREATE UNIQUE INDEX "AccountDeletionRequest_identityId_key" ON "AccountDeletionRequest"("identityId");

-- CreateIndex
CREATE INDEX "DataExportRequest_identityId_status_idx" ON "DataExportRequest"("identityId", "status");

-- CreateIndex
CREATE INDEX "DataExportRequest_status_expiresAt_idx" ON "DataExportRequest"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "DataExportRequest_status_buildClaimUntil_idx" ON "DataExportRequest"("status", "buildClaimUntil");

-- CreateIndex
CREATE INDEX "Identity_deletionRequestedAt_idx" ON "Identity"("deletionRequestedAt");

