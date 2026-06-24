-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_MediaFile" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "cameraId" INTEGER NOT NULL,
    "fileType" TEXT NOT NULL,
    "remotePath" TEXT NOT NULL,
    "localPath" TEXT NOT NULL,
    "thumbnailPath" TEXT,
    "timestamp" DATETIME NOT NULL,
    "sizeBytes" INTEGER,
    "isDownloaded" BOOLEAN NOT NULL DEFAULT false,
    "thumbReady" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activityScore" REAL,
    "hasActivity" BOOLEAN NOT NULL DEFAULT false,
    "activityScannedAt" DATETIME,
    CONSTRAINT "MediaFile_cameraId_fkey" FOREIGN KEY ("cameraId") REFERENCES "Camera" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_MediaFile" ("cameraId", "createdAt", "fileType", "id", "isDownloaded", "localPath", "remotePath", "sizeBytes", "thumbReady", "thumbnailPath", "timestamp") SELECT "cameraId", "createdAt", "fileType", "id", "isDownloaded", "localPath", "remotePath", "sizeBytes", "thumbReady", "thumbnailPath", "timestamp" FROM "MediaFile";
DROP TABLE "MediaFile";
ALTER TABLE "new_MediaFile" RENAME TO "MediaFile";
CREATE INDEX "MediaFile_cameraId_timestamp_idx" ON "MediaFile"("cameraId", "timestamp");
CREATE INDEX "MediaFile_cameraId_hasActivity_timestamp_idx" ON "MediaFile"("cameraId", "hasActivity", "timestamp");
CREATE UNIQUE INDEX "MediaFile_cameraId_remotePath_key" ON "MediaFile"("cameraId", "remotePath");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
