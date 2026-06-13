import type { PrismaClient } from "@prisma/client";
import type { MotionEyeClient } from "../motioneye/client.js";
import { indexCamera } from "./indexer.js";

export interface RunIndexArgs {
  prisma: PrismaClient;
  client: Pick<MotionEyeClient, "listCameras" | "listDir">;
  mediaRoot: string;
  startDate: string;
  emptyDayLimit: number;
  floorDate?: string;
  existsOnDisk: (localPath: string) => boolean;
}

export async function runIndexOnce(args: RunIndexArgs): Promise<void> {
  const cameras = await args.client.listCameras();
  for (const rc of cameras) {
    const camera = await args.prisma.camera.upsert({
      where: { motionEyeId: rc.id },
      create: { motionEyeId: rc.id, name: rc.name },
      update: { name: rc.name },
    });
    await indexCamera({
      prisma: args.prisma,
      client: args.client,
      camera,
      mediaRoot: args.mediaRoot,
      startDate: args.startDate,
      emptyDayLimit: args.emptyDayLimit,
      floorDate: args.floorDate,
      existsOnDisk: args.existsOnDisk,
    });
  }
}

export function startIndexLoop(
  runOnce: () => Promise<void>,
  intervalSeconds: number,
  onError: (err: unknown) => void,
): () => void {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      await runOnce();
    } catch (err) {
      onError(err);
    }
    if (!stopped) setTimeout(tick, intervalSeconds * 1000);
  };
  void tick();
  return () => {
    stopped = true;
  };
}
