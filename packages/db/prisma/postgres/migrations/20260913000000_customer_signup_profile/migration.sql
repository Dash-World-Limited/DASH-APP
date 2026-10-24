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
ALTER TABLE "Customer" ADD COLUMN     "acquisitionDetail" TEXT,
ADD COLUMN     "acquisitionSource" TEXT,
ADD COLUMN     "ageConfirmedAt" TIMESTAMP(3),
ADD COLUMN     "cityArea" TEXT,
ADD COLUMN     "marketingOptInAt" TIMESTAMP(3),
ADD COLUMN     "marketingOptInIp" TEXT,
ADD COLUMN     "state" TEXT,
ADD COLUMN     "usageIntent" TEXT;

