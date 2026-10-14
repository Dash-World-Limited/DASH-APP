-- Rider payout accounts, and order details frozen at placement.
--
-- Additive only: two nullable columns on Order and one new table. The UPDATEs
-- fill the new columns for orders placed before this migration from the
-- address and vendor they point at today, the best record that exists;
-- nothing is removed.

ALTER TABLE "Order" ADD COLUMN "deliveryAddressSnapshot" TEXT;
ALTER TABLE "Order" ADD COLUMN "vendorNameSnapshot" TEXT;

CREATE TABLE "RiderPayoutAccount" (
    "id" TEXT NOT NULL,
    "riderId" TEXT NOT NULL,
    "bankCode" TEXT NOT NULL,
    "bankName" TEXT NOT NULL,
    "accountName" TEXT NOT NULL,
    "accountNumberLast4" TEXT NOT NULL,
    "accountCipher" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3) NOT NULL,
    "verifiedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RiderPayoutAccount_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RiderPayoutAccount_riderId_key" ON "RiderPayoutAccount"("riderId");

ALTER TABLE "RiderPayoutAccount"
ADD CONSTRAINT "RiderPayoutAccount_riderId_fkey"
FOREIGN KEY ("riderId") REFERENCES "Rider"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

UPDATE "Order" o
SET "vendorNameSnapshot" = v."name"
FROM "Vendor" v
WHERE v."id" = o."vendorId" AND o."vendorNameSnapshot" IS NULL;

UPDATE "Order" o
SET "deliveryAddressSnapshot" = json_build_object(
    'label', a."label",
    'line1', a."line1",
    'landmark', a."landmark",
    'instructions', a."instructions",
    'contactPhone', a."contactPhone",
    'latitude', a."latitude",
    'longitude', a."longitude"
  )::text
FROM "Address" a
WHERE a."id" = o."addressId" AND o."deliveryAddressSnapshot" IS NULL;
