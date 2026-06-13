-- CreateTable
CREATE TABLE "Camera" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "motionEyeId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "MediaFile" (
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
    CONSTRAINT "MediaFile_cameraId_fkey" FOREIGN KEY ("cameraId") REFERENCES "Camera" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "IndexCursor" (
    "cameraId" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "lastDateDir" TEXT,
    "lastRunAt" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'idle',
    CONSTRAINT "IndexCursor_cameraId_fkey" FOREIGN KEY ("cameraId") REFERENCES "Camera" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TimelapseJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "cameraId" INTEGER NOT NULL,
    "fromTs" DATETIME NOT NULL,
    "toTs" DATETIME NOT NULL,
    "fps" INTEGER NOT NULL DEFAULT 24,
    "everyNth" INTEGER NOT NULL DEFAULT 1,
    "width" INTEGER,
    "quality" TEXT NOT NULL DEFAULT 'medium',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "phase" TEXT,
    "progress" REAL NOT NULL DEFAULT 0,
    "framesTotal" INTEGER NOT NULL DEFAULT 0,
    "framesReady" INTEGER NOT NULL DEFAULT 0,
    "outputPath" TEXT,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TimelapseJob_cameraId_fkey" FOREIGN KEY ("cameraId") REFERENCES "Camera" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Camera_motionEyeId_key" ON "Camera"("motionEyeId");

-- CreateIndex
CREATE INDEX "MediaFile_cameraId_timestamp_idx" ON "MediaFile"("cameraId", "timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "MediaFile_cameraId_remotePath_key" ON "MediaFile"("cameraId", "remotePath");

-- CreateIndex
CREATE INDEX "TimelapseJob_status_idx" ON "TimelapseJob"("status");
