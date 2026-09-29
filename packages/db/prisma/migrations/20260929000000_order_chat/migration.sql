-- Order-scoped customer/rider chat.
--
-- Mirrors the PostgreSQL migration of the same name. Participant ownership is
-- resolved from Order at request time rather than duplicated into this table.

CREATE TABLE "OrderConversation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orderId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "OrderConversation_orderId_fkey"
      FOREIGN KEY ("orderId") REFERENCES "Order" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "ChatMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "conversationId" TEXT NOT NULL,
    "senderIdentityId" TEXT NOT NULL,
    "senderRole" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "readAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ChatMessage_conversationId_fkey"
      FOREIGN KEY ("conversationId") REFERENCES "OrderConversation" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "OrderConversation_orderId_key"
ON "OrderConversation"("orderId");

CREATE INDEX "ChatMessage_conversationId_createdAt_idx"
ON "ChatMessage"("conversationId", "createdAt");
