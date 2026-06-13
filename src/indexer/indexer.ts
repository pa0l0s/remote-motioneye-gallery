import type { PrismaClient, Camera } from "@prisma/client";
import type { MotionEyeClient } from "../motioneye/client.js";
import { datesBackFrom } from "./dateWalk.js";
import { localPathFor, fileTypeFromMime } from "./mediaPaths.js";
import { parseSizeStr } from "../util/size.js";

export interface IndexArgs {
  prisma: PrismaClient;
  client: Pick<MotionEyeClient, "listDir">;
  camera: Camera;
  mediaRoot: string;
  startDate: string;
  emptyDayLimit: number;
  floorDate?: string;
  existsOnDisk: (localPath: string) => boolean;
}

export async function indexCamera(args: IndexArgs): Promise<void> {
  const { prisma, client, camera, mediaRoot, startDate, emptyDayLimit, floorDate, existsOnDisk } =
    args;

  await prisma.indexCursor.upsert({
    where: { cameraId: camera.id },
    create: { cameraId: camera.id, status: "running" },
    update: { status: "running", lastRunAt: new Date() },
  });

  let emptyStreak = 0;
  try {
    for (const date of datesBackFrom(startDate, 100000, floorDate)) {
      const pics = await client.listDir("picture", camera.motionEyeId, date);
      const movies = await client.listDir("movie", camera.motionEyeId, date);
      const entries = [...pics, ...movies];

      if (entries.length === 0) {
        emptyStreak++;
        if (emptyStreak >= emptyDayLimit) break;
        continue;
      }
      emptyStreak = 0;

      for (const e of entries) {
        const local = localPathFor(mediaRoot, camera.name, e.path);
        const ts = e.timestamp ? new Date(e.timestamp * 1000) : new Date();
        const sizeBytes = e.sizeStr ? parseSizeStr(e.sizeStr) : null;
        await prisma.mediaFile.upsert({
          where: { cameraId_remotePath: { cameraId: camera.id, remotePath: e.path } },
          create: {
            cameraId: camera.id,
            fileType: fileTypeFromMime(e.mimeType),
            remotePath: e.path,
            localPath: local,
            timestamp: ts,
            sizeBytes,
            isDownloaded: existsOnDisk(local),
          },
          update: {
            isDownloaded: existsOnDisk(local),
            sizeBytes,
          },
        });
      }
      await prisma.indexCursor.update({
        where: { cameraId: camera.id },
        data: { lastDateDir: date },
      });
    }
    await prisma.indexCursor.update({
      where: { cameraId: camera.id },
      data: { status: "idle", lastRunAt: new Date() },
    });
  } catch (err) {
    await prisma.indexCursor.update({
      where: { cameraId: camera.id },
      data: { status: "error" },
    });
    throw err;
  }
}
