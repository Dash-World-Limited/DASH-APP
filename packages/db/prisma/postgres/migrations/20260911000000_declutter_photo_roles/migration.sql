-- Photo roles and captions.
--
-- Which view of an item a photograph shows, asked for at upload rather than
-- guessed. A valuation that cannot tell a box shot from a photograph of the
-- serial label has to assume the worst about both; captions exist so a
-- published listing is not a wall of unlabelled images to a screen reader.
--
-- Both default to a safe value, so every existing row is valid without a
-- backfill: an old photo is honestly "other", not falsely "front".

-- AlterTable
ALTER TABLE "DeclutterSubmissionPhoto" ADD COLUMN     "caption" TEXT,
ADD COLUMN     "role" TEXT NOT NULL DEFAULT 'other';

-- AlterTable
ALTER TABLE "DeclutterListingPhoto" ADD COLUMN     "caption" TEXT,
ADD COLUMN     "role" TEXT NOT NULL DEFAULT 'other';

