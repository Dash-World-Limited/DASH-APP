-- Milestone IV: the transactional outbox and the maintenance lease.
--
-- Hand-written rather than generated. `prisma migrate diff` needs a live
-- PostgreSQL shadow database to produce a PostgreSQL migration, and the machine
-- this was authored on has none. It mirrors the generated SQLite migration of
-- the same name, translated using the conventions already visible in
-- `20260902000000_init`: TEXT for String, TIMESTAMP(3) for DateTime, INTEGER
-- for Int, and a named `_pkey` constraint rather than an inline PRIMARY KEY.
--
-- **Verified against a real PostgreSQL server.** Applied from zero to an empty
-- PostgreSQL 16 + PostGIS 3.4 database via `npm run check:postgres`, which
-- passed 17/17: the history applies, `migrate status` is clean, and
-- `migrate diff` reports no drift against postgres/schema.prisma. Re-run that
-- check after any change here.

-- CreateTable
CREATE TABLE "OutboxEvent" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "idempotencyKey" TEXT,
    "delayMs" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 8,
    "lastError" TEXT,
    "publishedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "claimId" TEXT,
    "claimUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaintenanceLease" (
    "job" TEXT NOT NULL,
    "holder" TEXT NOT NULL,
    "acquiredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastSucceededAt" TIMESTAMP(3),
    "lastFailedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MaintenanceLease_pkey" PRIMARY KEY ("job")
);

-- CreateIndex
CREATE INDEX "OutboxEvent_status_availableAt_idx" ON "OutboxEvent"("status", "availableAt");

-- CreateIndex
CREATE INDEX "OutboxEvent_status_claimUntil_idx" ON "OutboxEvent"("status", "claimUntil");

-- CreateIndex
CREATE INDEX "MaintenanceLease_expiresAt_idx" ON "MaintenanceLease"("expiresAt");
