-- The signup profile, on Customer rather than Identity.
--
-- Identity answers "who is authenticating". Where somebody lives, how they
-- plan to use DASH and how they heard about it are profile and analytics data,
-- and putting them on the auth table is how an auth table becomes a CRM table
-- nobody dares change.
--
-- Every column is nullable. The signup form requires them; the customers
-- already in this database were created before that form existed, and a
-- backfill inventing a state for them would be inventing data.
--
-- None of these columns grants anything. usageIntent is a self-reported plan,
-- not a permission; acquisitionSource is attribution, not a credential.
-- Selling still requires the existing KYC and admin approval.

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN "acquisitionDetail" TEXT;
ALTER TABLE "Customer" ADD COLUMN "acquisitionSource" TEXT;
ALTER TABLE "Customer" ADD COLUMN "ageConfirmedAt" DATETIME;
ALTER TABLE "Customer" ADD COLUMN "cityArea" TEXT;
ALTER TABLE "Customer" ADD COLUMN "marketingOptInAt" DATETIME;
ALTER TABLE "Customer" ADD COLUMN "marketingOptInIp" TEXT;
ALTER TABLE "Customer" ADD COLUMN "state" TEXT;
ALTER TABLE "Customer" ADD COLUMN "usageIntent" TEXT;

