import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import type { MediaFile } from "@prisma/client";
import { loadConfig } from "./config.js";
import { logger } from "./logger.js";
import { prisma, initDb } from "./db.js";
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
  await initDb();
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
  async function ensureFile(mf: MediaFile, force = false): Promise<string> {
    const cam = await prisma.camera.findUnique({ where: { id: mf.cameraId } });
    return ensureDownloaded({
      prisma,
      gate,
      client,
      mediaFile: mf,
      remoteCameraId: cam?.motionEyeId,
      force,
    });
  }
  async function ensureThumbFor(mf: MediaFile): Promise<string> {
    const local = await ensureFile(mf);
    const cam = await prisma.camera.findUnique({ where: { id: mf.cameraId } });
    const thumb = thumbPathFor(cfg.configDir, cam?.name ?? "Camera", mf.remotePath);
    // Self-healing: if the local source is corrupt/0-byte, force a re-download and retry once.
    return ensureThumb(local, thumb, mf.fileType as "image" | "video", undefined, () =>
      ensureFile(mf, true),
    );
  }

  registerCamerasRoute(app, client);
  registerMediaRoutes(app, { prisma, ensureFile, ensureThumbFor });
  registerTimelineRoutes(app, { prisma });

  // Serve the built SPA (web/dist) with a history-API fallback.
  const staticDir = resolve(process.env.STATIC_DIR ?? "web/dist");
  if (existsSync(staticDir)) {
    await app.register(fastifyStatic, { root: staticDir });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === "GET" && !req.url.startsWith("/api/")) {
        return reply.sendFile("index.html");
      }
      return reply.code(404).send({ error: "not found" });
    });
  }

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
        // A 0-byte file counts as NOT downloaded; full image validation is lazy
        // (at serve/thumbnail time), too expensive to do for every file here.
        existsOnDisk: (p) => {
          try {
            return statSync(p).size > 0;
          } catch {
            return false;
          }
        },
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
