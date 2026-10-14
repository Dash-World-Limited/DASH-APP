-- Saved payment cards (provider tokens, encrypted) and their setup charges,
-- and read receipts for in-app support chat messages.
--
-- Additive only: one nullable column, two new tables, indexes and foreign keys.

-- AlterTable
ALTER TABLE "SupportAction" ADD COLUMN     "readAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "PaymentMethod" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "tokenCipher" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "last4" TEXT NOT NULL,
    "expMonth" INTEGER NOT NULL,
    "expYear" INTEGER NOT NULL,
    "bank" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "removedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentMethod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentMethodSetup" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "paymentMethodId" TEXT,
    "refundReference" TEXT,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentMethodSetup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PaymentMethod_customerId_idx" ON "PaymentMethod"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentMethod_customerId_fingerprint_key" ON "PaymentMethod"("customerId", "fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentMethodSetup_reference_key" ON "PaymentMethodSetup"("reference");

-- CreateIndex
CREATE INDEX "PaymentMethodSetup_customerId_createdAt_idx" ON "PaymentMethodSetup"("customerId", "createdAt");

-- CreateIndex
CREATE INDEX "SupportCase_category_updatedAt_idx" ON "SupportCase"("category", "updatedAt");

-- AddForeignKey
ALTER TABLE "PaymentMethod" ADD CONSTRAINT "PaymentMethod_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentMethodSetup" ADD CONSTRAINT "PaymentMethodSetup_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

