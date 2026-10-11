-- AlterTable
ALTER TABLE "DeclutterSubmission" ADD COLUMN     "contentRevision" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "fullyApprovedAt" TIMESTAMP(3),
ADD COLUMN     "fullyApprovedBy" TEXT,
ADD COLUMN     "itemReviewedAt" TIMESTAMP(3),
ADD COLUMN     "safetyReviewedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "DeclutterConversation" (
    "id" TEXT NOT NULL,
    "sellerIdentityId" TEXT NOT NULL,
    "submissionId" TEXT,
    "scopeKey" TEXT NOT NULL,
    "assignedIdentityId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "sellerViewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeclutterConversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeclutterMessage" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "senderIdentityId" TEXT NOT NULL,
    "senderType" TEXT NOT NULL,
    "clientMessageId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readAt" TIMESTAMP(3),

    CONSTRAINT "DeclutterMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeclutterSubmissionUpdate" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "submittedBy" TEXT NOT NULL,
    "activeKey" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "baseRevision" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "condition" TEXT NOT NULL,
    "sellerMessage" TEXT,
    "submittedAt" TIMESTAMP(3),
    "reviewedAt" TIMESTAMP(3),
    "reviewedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeclutterSubmissionUpdate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeclutterUpdatePhoto" (
    "id" TEXT NOT NULL,
    "updateId" TEXT NOT NULL,
    "fingerprintId" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'other',
    "caption" TEXT,

    CONSTRAINT "DeclutterUpdatePhoto_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeclutterHubNotification" (
    "id" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "submissionId" TEXT,
    "messageId" TEXT,
    "recipientIdentityId" TEXT NOT NULL,
    "deliveredAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeclutterHubNotification_pkey" PRIMARY KEY ("id")
);

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
CREATE UNIQUE INDEX "DeclutterMessage_conversationId_senderIdentityId_clientMess_key" ON "DeclutterMessage"("conversationId", "senderIdentityId", "clientMessageId");

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

-- AddForeignKey
ALTER TABLE "DeclutterConversation" ADD CONSTRAINT "DeclutterConversation_sellerIdentityId_fkey" FOREIGN KEY ("sellerIdentityId") REFERENCES "Identity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeclutterConversation" ADD CONSTRAINT "DeclutterConversation_assignedIdentityId_fkey" FOREIGN KEY ("assignedIdentityId") REFERENCES "Identity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeclutterConversation" ADD CONSTRAINT "DeclutterConversation_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "DeclutterSubmission"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeclutterMessage" ADD CONSTRAINT "DeclutterMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "DeclutterConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeclutterMessage" ADD CONSTRAINT "DeclutterMessage_senderIdentityId_fkey" FOREIGN KEY ("senderIdentityId") REFERENCES "Identity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeclutterSubmissionUpdate" ADD CONSTRAINT "DeclutterSubmissionUpdate_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "DeclutterSubmission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeclutterSubmissionUpdate" ADD CONSTRAINT "DeclutterSubmissionUpdate_submittedBy_fkey" FOREIGN KEY ("submittedBy") REFERENCES "Identity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeclutterUpdatePhoto" ADD CONSTRAINT "DeclutterUpdatePhoto_updateId_fkey" FOREIGN KEY ("updateId") REFERENCES "DeclutterSubmissionUpdate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeclutterUpdatePhoto" ADD CONSTRAINT "DeclutterUpdatePhoto_fingerprintId_fkey" FOREIGN KEY ("fingerprintId") REFERENCES "DeclutterImageFingerprint"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
