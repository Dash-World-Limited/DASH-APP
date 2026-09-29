-- Order-scoped customer/rider chat.
--
-- A conversation exists only for a real order. Participants are resolved from
-- the order at request time, so the database never duplicates customer/rider
-- ownership that could drift when an assignment changes.

CREATE TABLE "order_conversations" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "order_conversations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "chat_messages" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "senderIdentityId" TEXT NOT NULL,
    "senderRole" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "chat_messages_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "order_conversations_orderId_key"
ON "order_conversations"("orderId");

CREATE INDEX "chat_messages_conversationId_createdAt_idx"
ON "chat_messages"("conversationId", "createdAt");

ALTER TABLE "order_conversations"
ADD CONSTRAINT "order_conversations_orderId_fkey"
FOREIGN KEY ("orderId") REFERENCES "Order"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "chat_messages"
ADD CONSTRAINT "chat_messages_conversationId_fkey"
FOREIGN KEY ("conversationId") REFERENCES "order_conversations"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
