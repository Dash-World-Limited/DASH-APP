-- Which app build registered each push token (its Android application id),
-- so a deployment sends only to its own builds — staging never reaches a
-- production phone.
--
-- Mirrors the PostgreSQL migration of the same name. Additive only: one
-- nullable column.

-- AlterTable
ALTER TABLE "Device" ADD COLUMN "appId" TEXT;
