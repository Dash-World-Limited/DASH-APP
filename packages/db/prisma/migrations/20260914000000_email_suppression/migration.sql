-- Addresses we must stop sending to.
--
-- Written from SES bounce and complaint notifications. A sender that keeps
-- delivering to an address which hard-bounces, or to somebody who pressed
-- "this is spam", loses its reputation -- and when that happens verification
-- codes stop arriving for everyone, which reads as a broken product rather
-- than a mail problem.
--
-- Keyed on the address, not on an identity: a bounce is a fact about a mailbox,
-- and the mailbox may belong to somebody who never had an account.

-- CreateTable
CREATE TABLE "EmailSuppression" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "address" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "transactionalAllowed" BOOLEAN NOT NULL DEFAULT false,
    "detail" TEXT,
    "lastNotificationId" TEXT,
    "firstSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "clearedAt" DATETIME,
    "clearedBy" TEXT
);

-- CreateIndex
CREATE UNIQUE INDEX "EmailSuppression_address_key" ON "EmailSuppression"("address");

-- CreateIndex
CREATE INDEX "EmailSuppression_reason_lastSeenAt_idx" ON "EmailSuppression"("reason", "lastSeenAt");

