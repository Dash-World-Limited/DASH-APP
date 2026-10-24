-- CreateTable
CREATE TABLE "DeclutterConversation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sellerIdentityId" TEXT NOT NULL,
    "submissionId" TEXT,
    "scopeKey" TEXT NOT NULL,
    "assignedIdentityId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "sellerViewedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "DeclutterConversation_sellerIdentityId_fkey" FOREIGN KEY ("sellerIdentityId") REFERENCES "Identity" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "DeclutterConversation_assignedIdentityId_fkey" FOREIGN KEY ("assignedIdentityId") REFERENCES "Identity" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "DeclutterConversation_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "DeclutterSubmission" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DeclutterMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "conversationId" TEXT NOT NULL,
    "senderIdentityId" TEXT NOT NULL,
    "senderType" TEXT NOT NULL,
    "clientMessageId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readAt" DATETIME,
    CONSTRAINT "DeclutterMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "DeclutterConversation" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DeclutterMessage_senderIdentityId_fkey" FOREIGN KEY ("senderIdentityId") REFERENCES "Identity" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DeclutterSubmissionUpdate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "submissionId" TEXT NOT NULL,
    "submittedBy" TEXT NOT NULL,
    "activeKey" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "baseRevision" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "condition" TEXT NOT NULL,
    "sellerMessage" TEXT,
    "submittedAt" DATETIME,
    "reviewedAt" DATETIME,
    "reviewedBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DeclutterSubmissionUpdate_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "DeclutterSubmission" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "DeclutterSubmissionUpdate_submittedBy_fkey" FOREIGN KEY ("submittedBy") REFERENCES "Identity" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DeclutterUpdatePhoto" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "updateId" TEXT NOT NULL,
    "fingerprintId" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'other',
    "caption" TEXT,
    CONSTRAINT "DeclutterUpdatePhoto_updateId_fkey" FOREIGN KEY ("updateId") REFERENCES "DeclutterSubmissionUpdate" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DeclutterUpdatePhoto_fingerprintId_fkey" FOREIGN KEY ("fingerprintId") REFERENCES "DeclutterImageFingerprint" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DeclutterHubNotification" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "eventKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "submissionId" TEXT,
    "messageId" TEXT,
    "recipientIdentityId" TEXT NOT NULL,
    "deliveredAt" DATETIME,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE "DeclutterSubmission" ADD COLUMN "safetyReviewedAt" DATETIME;
ALTER TABLE "DeclutterSubmission" ADD COLUMN "itemReviewedAt" DATETIME;
ALTER TABLE "DeclutterSubmission" ADD COLUMN "fullyApprovedAt" DATETIME;
ALTER TABLE "DeclutterSubmission" ADD COLUMN "fullyApprovedBy" TEXT;
ALTER TABLE "DeclutterSubmission" ADD COLUMN "contentRevision" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE UNIQUE INDEX "DeclutterConversation_scopeKey_key" ON "DeclutterConversation"("scopeKey");

-- CreateIndex
CREATE INDEX "DeclutterConversation_sellerIdentityId_updatedAt_idx" ON "DeclutterConversation"("sellerIdentityId", "updatedAt");

-- CreateIndex
CREATE INDEX "DeclutterConversation_status_updatedAt_idx" ON "DeclutterConversation"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "DeclutterConversation_assignedIdentityId_status_idx" ON "DeclutterConversation"("assignedIdentityId", "status");

-- CreateIndex
CREATE INDEX "DeclutterMessage_conversationId_createdAt_idx" ON "DeclutterMessage"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "DeclutterMessage_conversationId_senderType_readAt_idx" ON "DeclutterMessage"("conversationId", "senderType", "readAt");

-- CreateIndex
CREATE UNIQUE INDEX "DeclutterMessage_conversationId_senderIdentityId_clientMessageId_key" ON "DeclutterMessage"("conversationId", "senderIdentityId", "clientMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "DeclutterSubmissionUpdate_activeKey_key" ON "DeclutterSubmissionUpdate"("activeKey");

-- CreateIndex
CREATE INDEX "DeclutterSubmissionUpdate_submissionId_createdAt_idx" ON "DeclutterSubmissionUpdate"("submissionId", "createdAt");

-- CreateIndex
CREATE INDEX "DeclutterSubmissionUpdate_status_submittedAt_idx" ON "DeclutterSubmissionUpdate"("status", "submittedAt");

-- CreateIndex
CREATE INDEX "DeclutterUpdatePhoto_fingerprintId_idx" ON "DeclutterUpdatePhoto"("fingerprintId");

-- CreateIndex
CREATE UNIQUE INDEX "DeclutterUpdatePhoto_updateId_position_key" ON "DeclutterUpdatePhoto"("updateId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "DeclutterHubNotification_eventKey_key" ON "DeclutterHubNotification"("eventKey");

-- CreateIndex
CREATE INDEX "DeclutterHubNotification_deliveredAt_createdAt_idx" ON "DeclutterHubNotification"("deliveredAt", "createdAt");
