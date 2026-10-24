-- Photo roles and captions.
--
-- Which view of an item a photograph shows, asked for at upload rather than
-- guessed. A valuation that cannot tell a box shot from a photograph of the
-- serial label has to assume the worst about both; captions exist so a
-- published listing is not a wall of unlabelled images to a screen reader.
--
-- Both default to a safe value, so every existing row is valid without a
-- backfill: an old photo is honestly "other", not falsely "front".

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_DeclutterSubmissionPhoto" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "submissionId" TEXT NOT NULL,
    "fingerprintId" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "bytes" INTEGER,
    "role" TEXT NOT NULL DEFAULT 'other',
    "caption" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DeclutterSubmissionPhoto_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "DeclutterSubmission" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DeclutterSubmissionPhoto_fingerprintId_fkey" FOREIGN KEY ("fingerprintId") REFERENCES "DeclutterImageFingerprint" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_DeclutterSubmissionPhoto" ("bytes", "createdAt", "fingerprintId", "height", "id", "position", "storageKey", "submissionId", "width") SELECT "bytes", "createdAt", "fingerprintId", "height", "id", "position", "storageKey", "submissionId", "width" FROM "DeclutterSubmissionPhoto";
DROP TABLE "DeclutterSubmissionPhoto";
ALTER TABLE "new_DeclutterSubmissionPhoto" RENAME TO "DeclutterSubmissionPhoto";
CREATE INDEX "DeclutterSubmissionPhoto_fingerprintId_idx" ON "DeclutterSubmissionPhoto"("fingerprintId");
CREATE UNIQUE INDEX "DeclutterSubmissionPhoto_submissionId_position_key" ON "DeclutterSubmissionPhoto"("submissionId", "position");
CREATE TABLE "new_DeclutterListingPhoto" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "listingId" TEXT NOT NULL,
    "fingerprintId" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "role" TEXT NOT NULL DEFAULT 'other',
    "caption" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DeclutterListingPhoto_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "DeclutterListing" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DeclutterListingPhoto_fingerprintId_fkey" FOREIGN KEY ("fingerprintId") REFERENCES "DeclutterImageFingerprint" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_DeclutterListingPhoto" ("createdAt", "fingerprintId", "height", "id", "listingId", "position", "storageKey", "width") SELECT "createdAt", "fingerprintId", "height", "id", "listingId", "position", "storageKey", "width" FROM "DeclutterListingPhoto";
DROP TABLE "DeclutterListingPhoto";
ALTER TABLE "new_DeclutterListingPhoto" RENAME TO "DeclutterListingPhoto";
CREATE INDEX "DeclutterListingPhoto_fingerprintId_idx" ON "DeclutterListingPhoto"("fingerprintId");
CREATE UNIQUE INDEX "DeclutterListingPhoto_listingId_position_key" ON "DeclutterListingPhoto"("listingId", "position");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

