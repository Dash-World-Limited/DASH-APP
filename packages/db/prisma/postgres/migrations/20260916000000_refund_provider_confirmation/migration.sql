-- Refunds confirmed by the payment provider, not declared by a person.
--
-- Until now a refund owed to a customer was recorded as
-- `refund_pending_manual_review` and stayed that way for ever: the DASH team
-- returns the money in the Paystack dashboard, and nothing connected that
-- Paystack refund back to our record. These columns hold the link and what
-- Paystack last said about it. A refund becomes `refunded` only when Paystack
-- reports it processed, against this payment, for the recorded amount.
--
-- Forward-only and additive. The unique index is on a column no code has
-- written before this migration, so every existing row holds NULL, and NULLs
-- are distinct in both SQLite and PostgreSQL -- it cannot fail on existing
-- data. It exists so one Paystack refund can never settle two refunds of ours.

-- AlterTable
ALTER TABLE "Refund" ADD COLUMN     "providerCheckedAt" TIMESTAMP(3),
ADD COLUMN     "providerStatus" TEXT,
ADD COLUMN     "refundedAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "Refund_providerReference_key" ON "Refund"("providerReference");

