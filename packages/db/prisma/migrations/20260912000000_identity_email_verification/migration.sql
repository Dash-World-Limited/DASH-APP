-- Proved control of an email address.
--
-- Null on every existing row, which is correct: no identity in the database has
-- ever been asked to prove its address, and a backfill claiming otherwise would
-- be inventing evidence. Seeded staff and existing customers are unaffected --
-- nothing gates on this column except the new website signup flow.

-- AlterTable
ALTER TABLE "Identity" ADD COLUMN "emailVerifiedAt" DATETIME;

