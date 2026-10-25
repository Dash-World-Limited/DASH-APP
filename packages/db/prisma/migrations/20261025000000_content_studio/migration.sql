-- CreateTable
CREATE TABLE "ContentEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "draft" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdBy" TEXT NOT NULL,
    "updatedBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "publishedRevisionId" TEXT,
    CONSTRAINT "ContentEntry_publishedRevisionId_fkey" FOREIGN KEY ("publishedRevisionId") REFERENCES "ContentRevision" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ContentRevision" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "entryId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mediaId" TEXT,
    "logoMediaId" TEXT,
    CONSTRAINT "ContentRevision_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "ContentEntry" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ContentRevision_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES "ContentMedia" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ContentRevision_logoMediaId_fkey" FOREIGN KEY ("logoMediaId") REFERENCES "ContentMedia" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ContentMedia" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storageKey" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "alt" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "uploadedBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archivedAt" DATETIME
);

-- CreateIndex
CREATE UNIQUE INDEX "ContentEntry_publishedRevisionId_key" ON "ContentEntry"("publishedRevisionId");

-- CreateIndex
CREATE INDEX "ContentRevision_mediaId_idx" ON "ContentRevision"("mediaId");

-- CreateIndex
CREATE INDEX "ContentRevision_logoMediaId_idx" ON "ContentRevision"("logoMediaId");

-- CreateIndex
CREATE UNIQUE INDEX "ContentRevision_entryId_number_key" ON "ContentRevision"("entryId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "ContentMedia_storageKey_key" ON "ContentMedia"("storageKey");

-- CreateIndex
CREATE INDEX "ContentMedia_createdAt_idx" ON "ContentMedia"("createdAt");
