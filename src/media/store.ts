import { createWriteStream, existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { pipeline } from "node:stream/promises";
import type { PrismaClient, MediaFile } from "@prisma/client";
import type { MotionEyeClient } from "../motioneye/client.js";
import type { FetchGate } from "../remote/fetchGate.js";

export interface EnsureArgs {
  prisma: PrismaClient;
  gate: FetchGate;
  client: Pick<MotionEyeClient, "downloadStream">;
  mediaFile: MediaFile;
  /** Remote (motionEye) camera id; defaults to the local cameraId when omitted (tests). */
  remoteCameraId?: number;
}

export async function ensureDownloaded(args: EnsureArgs): Promise<string> {
  const { prisma, gate, client, mediaFile } = args;
  const local = mediaFile.localPath;

  if (existsSync(local)) {
    if (!mediaFile.isDownloaded) {
      await prisma.mediaFile.update({ where: { id: mediaFile.id }, data: { isDownloaded: true } });
    }
    return local;
  }

  await mkdir(dirname(local), { recursive: true });
  const kind = mediaFile.fileType === "video" ? "movie" : "picture";
  const remoteCameraId = args.remoteCameraId ?? mediaFile.cameraId;

  await gate.run(async () => {
    const { statusCode, body } = await client.downloadStream(
      kind,
      remoteCameraId,
      mediaFile.remotePath,
    );
    if (statusCode >= 400) throw new Error(`download ${mediaFile.remotePath} -> HTTP ${statusCode}`);
    await pipeline(body, createWriteStream(local));
  });

  await prisma.mediaFile.update({ where: { id: mediaFile.id }, data: { isDownloaded: true } });
  return local;
}
