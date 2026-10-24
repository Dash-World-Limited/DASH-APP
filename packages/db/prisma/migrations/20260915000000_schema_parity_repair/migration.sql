-- Four schema objects that reached `schema.prisma` without reaching a migration.
--
-- The SQLite half of the same repair. See the PostgreSQL migration of this name
-- for how they got here: they were added to the schema and then pushed into a
-- local database with `db:push`, which syncs a database without writing a
-- migration, so development had them and the migration history never did.
--
-- This matters for SQLite too even though development uses `db:push`. The
-- history is what `migrate diff` is measured against, what a fresh checkout
-- replays, and what the new parity test asserts -- and a history that cannot
-- rebuild the schema it claims to describe is not a history.
--
-- Forward-only. Nothing already applied is edited.
--
-- `ALTER TABLE ... ADD COLUMN` rather than the table rebuild Prisma's own diff
-- emits for `DispatchOffer`. SQLite has allowed adding a NOT NULL column with a
-- non-null default since 3.2, the end state is identical, and a rebuild means
-- dropping and recreating a table with live foreign keys pointed at it -- more
-- moving parts, for a column addition.

-- Which rule admitted this rider to the offer round: `fresh` on their own
-- merit, `grace` under the widened criteria a later round uses. Required, and
-- every existing offer was made under the original rule.
ALTER TABLE "DispatchOffer" ADD COLUMN "eligibilityMode" TEXT NOT NULL DEFAULT 'fresh';

-- Second-hand condition, for Declutter listings. Nullable because it is
-- meaningless for everything else -- a plate of jollof has no condition.
ALTER TABLE "MenuItem" ADD COLUMN "condition" TEXT;

-- When the current online session lapses. Nullable: a rider who has never gone
-- online has no such time, and NULL says that rather than encoding it as a date
-- in the past.
ALTER TABLE "Rider" ADD COLUMN "onlineUntil" DATETIME;

-- `Device.pushToken` unique across the whole table.
--
-- An FCM token identifies a physical installation, and an installation belongs
-- to whoever is signed into it now. Without this, the same token can sit on two
-- identities at once and a borrowed handset keeps receiving the previous
-- rider's dispatch offers -- the push goes to the device, not to the person.
--
-- Duplicates are cleared before the index is created, keeping the most recently
-- seen claim, because creating a unique index over duplicates fails and would
-- leave the migration half-applied. Clearing the token revokes a push route
-- rather than deleting a device row. NULL is exempt: SQL permits many NULLs
-- under a unique index, which is what lets every revoked device coexist.
UPDATE "Device"
SET "pushToken" = NULL
WHERE "pushToken" IS NOT NULL
  AND "id" <> (
    SELECT "other"."id"
    FROM "Device" AS "other"
    WHERE "other"."pushToken" = "Device"."pushToken"
    ORDER BY "other"."lastSeenAt" DESC, "other"."id"
    LIMIT 1
  );

-- CreateIndex
CREATE UNIQUE INDEX "Device_pushToken_key" ON "Device"("pushToken");
