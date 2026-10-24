-- Order-scoped customer/rider chat.
--
-- Participants are resolved from Order at request time. The conversation table
-- deliberately stores no duplicate customer/rider ids that could drift when
-- dispatch changes an assignment.

CREATE TABLE "OrderConversation" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OrderConversation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ChatMessage" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "senderIdentityId" TEXT NOT NULL,
    "senderRole" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ChatMessage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OrderConversation_orderId_key"
ON "OrderConversation"("orderId");

CREATE INDEX "ChatMessage_conversationId_createdAt_idx"
ON "ChatMessage"("conversationId", "createdAt");

ALTER TABLE "OrderConversation"
ADD CONSTRAINT "OrderConversation_orderId_fkey"
FOREIGN KEY ("orderId") REFERENCES "Order"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ChatMessage"
ADD CONSTRAINT "ChatMessage_conversationId_fkey"
FOREIGN KEY ("conversationId") REFERENCES "OrderConversation"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
