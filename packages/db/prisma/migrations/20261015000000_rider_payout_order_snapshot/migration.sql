-- Rider payout accounts, and order details frozen at placement.
--
-- Mirrors the PostgreSQL migration of the same name. Additive only: two
-- nullable columns on Order and one new table. The UPDATEs fill the new
-- columns for orders placed before this migration from the address and vendor
-- they point at today, the best record that exists; nothing is removed.

ALTER TABLE "Order" ADD COLUMN "deliveryAddressSnapshot" TEXT;
ALTER TABLE "Order" ADD COLUMN "vendorNameSnapshot" TEXT;

CREATE TABLE "RiderPayoutAccount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "riderId" TEXT NOT NULL,
    "bankCode" TEXT NOT NULL,
    "bankName" TEXT NOT NULL,
    "accountName" TEXT NOT NULL,
    "accountNumberLast4" TEXT NOT NULL,
    "accountCipher" TEXT NOT NULL,
    "verifiedAt" DATETIME NOT NULL,
    "verifiedBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "RiderPayoutAccount_riderId_fkey" FOREIGN KEY ("riderId") REFERENCES "Rider" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "RiderPayoutAccount_riderId_key" ON "RiderPayoutAccount"("riderId");

UPDATE "Order"
SET "vendorNameSnapshot" = (SELECT "name" FROM "Vendor" WHERE "Vendor"."id" = "Order"."vendorId")
WHERE "vendorNameSnapshot" IS NULL;

UPDATE "Order"
SET "deliveryAddressSnapshot" = (
  SELECT json_object(
    'label', a."label",
    'line1', a."line1",
    'landmark', a."landmark",
    'instructions', a."instructions",
    'contactPhone', a."contactPhone",
    'latitude', a."latitude",
    'longitude', a."longitude"
  )
  FROM "Address" a
  WHERE a."id" = "Order"."addressId"
)
WHERE "addressId" IS NOT NULL AND "deliveryAddressSnapshot" IS NULL;
