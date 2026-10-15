-- Push notifications: each phone's Notifications switch as the server sees
-- it, and the last order status a push was considered for.
--
-- Mirrors the SQLite migration of the same name. Additive only: two new
-- columns, and a backfill of the second.

-- AlterTable
ALTER TABLE "Device" ADD COLUMN     "pushEnabled" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "pushNotifiedStatus" TEXT;

-- Orders that already exist have been announced as whatever they are now; the
-- first push any of them earns is for its next change, not a late one for
-- the status it was already in when this shipped.
UPDATE "Order" SET "pushNotifiedStatus" = "status";
