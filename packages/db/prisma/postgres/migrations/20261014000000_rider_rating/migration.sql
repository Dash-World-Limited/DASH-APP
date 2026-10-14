-- A customer's rating of the rider who delivered their order.
--
-- Additive only: one nullable column, two indexes and a foreign key on Review.
-- Existing reviews keep riderId NULL, and PostgreSQL treats NULLs as distinct
-- in a unique index, so no existing row can conflict with it.

ALTER TABLE "Review" ADD COLUMN "riderId" TEXT;

CREATE INDEX "Review_riderId_idx" ON "Review"("riderId");

CREATE UNIQUE INDEX "Review_orderId_subject_riderId_key"
ON "Review"("orderId", "subject", "riderId");

ALTER TABLE "Review"
ADD CONSTRAINT "Review_riderId_fkey"
FOREIGN KEY ("riderId") REFERENCES "Rider"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
