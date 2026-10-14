-- A customer's rating of the rider who delivered their order.
--
-- Mirrors the PostgreSQL migration of the same name. Additive only: one
-- nullable column and two indexes on Review. Existing reviews keep riderId
-- empty, and the unique index never matches an empty riderId, so no existing
-- row can conflict with it.

ALTER TABLE "Review" ADD COLUMN "riderId" TEXT
  REFERENCES "Rider" ("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Review_riderId_idx" ON "Review"("riderId");

CREATE UNIQUE INDEX "Review_orderId_subject_riderId_key"
ON "Review"("orderId", "subject", "riderId");
