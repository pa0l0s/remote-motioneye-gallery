import { existsSync } from "node:fs";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import type { MediaFile } from "@prisma/client";
import { loadConfig } from "./config.js";
import { logger } from "./logger.js";
import { prisma } from "./db.js";
import { MotionEyeClient } from "./motioneye/client.js";
import { FetchGate } from "./remote/fetchGate.js";
import { registerAuth } from "./auth/middleware.js";
import { registerCamerasRoute } from "./routes/cameras.js";
import { registerMediaRoutes } from "./routes/media.js";
import { registerTimelineRoutes } from "./routes/timeline.js";
import { ensureDownloaded } from "./media/store.js";
import { ensureThumb } from "./media/thumbnails.js";
import { thumbPathFor } from "./indexer/mediaPaths.js";
import { runIndexOnce, startIndexLoop } from "./indexer/runner.js";

export async function buildApp() {
  const cfg = loadConfig();
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
  await app.register(cookie);

  const client = new MotionEyeClient({
    baseUrl: cfg.motionEyeUrl,
    username: cfg.motionEyeUser,
    password: cfg.motionEyePassword,
    timeoutMs: cfg.requestTimeoutMs,
  });

  const gate = new FetchGate({
    concurrency: Number(process.env.REMOTE_CONCURRENCY ?? "1"),
    maxRetries: cfg.maxRetries,
    baseDelayMs: 1000,
  });

  registerAuth(app, {
    authEnabled: cfg.authEnabled,
    secret: cfg.secretKey,
    maxAgeSeconds: 30 * 24 * 3600,
    loginUrl: cfg.kuklePowerLoginUrl,
  });

  app.get("/health", async () => ({ status: "ok" }));

  // Resolve a camera's motionEyeId and ensure the file is local.
  async function ensureFile(mf: MediaFile): Promise<string> {
    const cam = await prisma.camera.findUnique({ where: { id: mf.cameraId } });
    return ensureDownloaded({
      prisma,
      gate,
      client,
      mediaFile: mf,
      remoteCameraId: cam?.motionEyeId,
    });
  }
  async function ensureThumbFor(mf: MediaFile): Promise<string> {
    const local = await ensureFile(mf);
    const cam = await prisma.camera.findUnique({ where: { id: mf.cameraId } });
    const thumb = thumbPathFor(cfg.configDir, cam?.name ?? "Camera", mf.remotePath);
    return ensureThumb(local, thumb, mf.fileType as "image" | "video");
  }

  registerCamerasRoute(app, client);
  registerMediaRoutes(app, { prisma, ensureFile, ensureThumbFor });
  registerTimelineRoutes(app, { prisma });

  // Background indexing (non-blocking).
  const today = new Date().toISOString().slice(0, 10);
  startIndexLoop(
    () =>
      runIndexOnce({
        prisma,
        client,
        mediaRoot: cfg.mediaRoot,
        startDate: today,
        emptyDayLimit: Number(process.env.INDEX_EMPTY_DAY_LIMIT ?? "30"),
        floorDate: process.env.INDEX_START_DATE,
        existsOnDisk: (p) => existsSync(p),
      }),
    cfg.indexIntervalSeconds,
    (err) => app.log.error(err),
  );

  return app;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  buildApp()
    .then((app) => app.listen({ host: "0.0.0.0", port: Number(process.env.PORT ?? 8762) }))
    .catch((err) => {
      logger.error(err);
      process.exit(1);
    });
}
