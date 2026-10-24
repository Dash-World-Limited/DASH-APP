-- Four schema objects that reached `schema.prisma` without reaching a migration.
--
-- Found by the first real run of `npm run check:postgres` against a throwaway
-- RDS database. All nine committed migrations applied cleanly and
-- `_prisma_migrations` held nothing unfinished, yet `migrate diff` reported the
-- database and the datamodel disagreeing -- because these four were added to
-- the schema and then pushed into local SQLite with `db:push`, which syncs a
-- database without writing a migration. Local development therefore had them
-- and the migration history never did.
--
-- Forward-only. Nothing already applied is edited: an applied migration is a
-- fact about every database that ran it, and rewriting one makes the checksum
-- in `_prisma_migrations` disagree with the file for reasons that have nothing
-- to do with the schema.
--
-- Each is additive, and all four are safe on a table with rows in it. The one
-- to look at twice is the unique index, below.

-- `DispatchOffer.eligibilityMode` -- which rule admitted this rider to the
-- offer round. `fresh` is an offer made on the rider's own merit; `grace` is
-- one made under the widened criteria a later round uses. Required, because
-- every offer was admitted by one rule or the other, and existing rows were all
-- made under the original rule.
ALTER TABLE "DispatchOffer" ADD COLUMN "eligibilityMode" TEXT NOT NULL DEFAULT 'fresh';

-- `MenuItem.condition` -- second-hand condition, for Declutter listings.
-- Nullable because it is meaningless for everything else: a plate of jollof has
-- no condition, and the alternative of a default would assert something untrue
-- about every catalogue row DASH APP already holds.
ALTER TABLE "MenuItem" ADD COLUMN "condition" TEXT;

-- `Rider.onlineUntil` -- when the current online session lapses. Nullable: a
-- rider who has never gone online has no such time, and NULL says that rather
-- than encoding it as a date in the past.
ALTER TABLE "Rider" ADD COLUMN "onlineUntil" TIMESTAMP(3);

-- `Device.pushToken` unique across the whole table.
--
-- This is the one with teeth, and it is the reason this migration matters
-- beyond tidiness. An FCM token identifies a physical installation, and an
-- installation belongs to whoever is signed into it now. Without the
-- constraint, the same token can sit on two identities at once, and a handset
-- somebody borrowed and signed out of keeps receiving the previous rider's
-- dispatch offers alongside its new owner's -- the push is delivered to the
-- device, not to the person. Registration is written to rebind a token rather
-- than add a second claim on it, and this index is what makes that the only
-- representable outcome.
--
-- Production has been running without it, so duplicates may exist. Creating a
-- unique index over duplicate rows fails, which would leave the migration
-- half-applied, so the duplicates are resolved first: for any token claimed
-- more than once, every claim except the most recently seen has its token
-- cleared. That is the same answer registration would have reached -- the
-- newest sign-in owns the device -- and it revokes a push route rather than
-- deleting a row, so no device registration is lost.
--
-- NULL is exempt throughout. SQL permits many NULLs under a unique index, which
-- is what lets a device that has revoked its token coexist with every other
-- revoked one.
UPDATE "Device"
SET "pushToken" = NULL
WHERE "pushToken" IS NOT NULL
  AND "id" NOT IN (
    SELECT DISTINCT ON ("pushToken") "id"
    FROM "Device"
    WHERE "pushToken" IS NOT NULL
    ORDER BY "pushToken", "lastSeenAt" DESC, "id"
  );

-- CreateIndex
CREATE UNIQUE INDEX "Device_pushToken_key" ON "Device"("pushToken");
