-- AlterTable
ALTER TABLE "MediaFile" ADD COLUMN "aiScannedAt" DATETIME;
ALTER TABLE "MediaFile" ADD COLUMN "aiModel" TEXT;
ALTER TABLE "MediaFile" ADD COLUMN "aiPromptVersion" TEXT;
ALTER TABLE "MediaFile" ADD COLUMN "aiPeopleCount" INTEGER;
ALTER TABLE "MediaFile" ADD COLUMN "aiAnimals" TEXT;
ALTER TABLE "MediaFile" ADD COLUMN "aiAnimalKinds" TEXT;
ALTER TABLE "MediaFile" ADD COLUMN "aiLatencyMs" INTEGER;
ALTER TABLE "MediaFile" ADD COLUMN "aiFailures" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "MediaFile" ADD COLUMN "weatherScannedAt" DATETIME;
ALTER TABLE "MediaFile" ADD COLUMN "weatherPromptVersion" TEXT;
ALTER TABLE "MediaFile" ADD COLUMN "weatherVisibility" TEXT;
ALTER TABLE "MediaFile" ADD COLUMN "weatherPrecipitation" TEXT;
ALTER TABLE "MediaFile" ADD COLUMN "weatherSnowOnGround" BOOLEAN;
ALTER TABLE "MediaFile" ADD COLUMN "isNightIr" BOOLEAN;

-- CreateIndex
CREATE INDEX "MediaFile_cameraId_aiScannedAt_idx" ON "MediaFile"("cameraId", "aiScannedAt");

-- CreateIndex
CREATE INDEX "MediaFile_cameraId_aiPeopleCount_timestamp_idx" ON "MediaFile"("cameraId", "aiPeopleCount", "timestamp");

-- CreateIndex
CREATE INDEX "MediaFile_cameraId_weatherVisibility_timestamp_idx" ON "MediaFile"("cameraId", "weatherVisibility", "timestamp");
