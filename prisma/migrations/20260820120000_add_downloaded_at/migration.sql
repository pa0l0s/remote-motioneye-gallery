-- AlterTable
-- Nullable and deliberately NOT backfilled: null means "already here / unknown", which is
-- exactly what every pre-existing row is — the backlog. Backfilling would make the whole
-- archive look freshly downloaded and swamp the extended pass's priority tier.
ALTER TABLE "MediaFile" ADD COLUMN "downloadedAt" DATETIME;

-- CreateIndex
CREATE INDEX "MediaFile_aiScannedAt_downloadedAt_idx" ON "MediaFile"("aiScannedAt", "downloadedAt");
