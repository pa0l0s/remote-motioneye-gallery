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
import { isZeroByte } from "./media/validate.js";
import { thumbPathFor } from "./indexer/mediaPaths.js";
import { runIndexOnce, startIndexLoop } from "./indexer/runner.js";
import { DownloadManager } from "./downloads/manager.js";
import { registerDownloadRoutes } from "./routes/downloads.js";
import { runActivityScanOnce, type ScanControl } from "./activity/scanner.js";
import { registerActivityRoutes } from "./routes/activity.js";

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
  // Thumbnails are LOCAL-ONLY: never download from the remote GSM site. If the source
  // isn't a valid local file, return null and the client shows a placeholder. Remote
  // downloads only ever happen via explicit user actions (lightbox click, download jobs).
  async function ensureThumbFor(mf: MediaFile): Promise<string | null> {
    const local = mf.localPath;
    if (!existsSync(local) || isZeroByte(local)) return null;
    const cam = await prisma.camera.findUnique({ where: { id: mf.cameraId } });
    const thumb = thumbPathFor(cfg.configDir, cam?.name ?? "Camera", mf.remotePath);
    try {
      return await ensureThumb(local, thumb, mf.fileType as "image" | "video");
    } catch {
      // Corrupt local source: do NOT auto-refetch; surface as "not available".
      return null;
    }
  }

  const downloads = new DownloadManager(prisma, gate, client);

  const scanControl: ScanControl = { paused: false, scanning: false };

  registerCamerasRoute(app, client);
  registerMediaRoutes(app, { prisma, ensureFile, ensureThumbFor });
  registerTimelineRoutes(app, { prisma });
  registerDownloadRoutes(app, { prisma, manager: downloads });
  registerActivityRoutes(app, { prisma, control: scanControl, enabled: cfg.activity.enabled });

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
  // "today" must be computed PER RUN (not at boot) so the indexer advances to new
  // calendar days. Periodic cycles scan only a recent window (today back N days) so they
  // are cheap on GSM and always pick up the current day + newly-added recent files. A
  // full historical backfill runs once, only when the DB is empty (fresh deploy).
  const isoToday = () => new Date().toISOString().slice(0, 10);
  const isoDaysAgo = (n: number) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - n);
    return d.toISOString().slice(0, 10);
  };
  const emptyDayLimit = Number(process.env.INDEX_EMPTY_DAY_LIMIT ?? "30");
  const recentDays = Number(process.env.INDEX_RECENT_DAYS ?? "3");
  const existsOnDisk = (p: string) => {
    try {
      return statSync(p).size > 0;
    } catch {
      return false;
    }
  };

  const indexCycle = (recentOnly: boolean) =>
    runIndexOnce({
      prisma,
      client,
      mediaRoot: cfg.mediaRoot,
      startDate: isoToday(),
      emptyDayLimit,
      // Recent cycles stop at today-N; the one-time backfill honours INDEX_START_DATE.
      floorDate: recentOnly ? isoDaysAgo(recentDays) : process.env.INDEX_START_DATE,
      existsOnDisk,
    });

  void (async () => {
    try {
      if ((await prisma.mediaFile.count()) === 0) await indexCycle(false); // full backfill once
    } catch (err) {
      app.log.error(err);
    }
    startIndexLoop(() => indexCycle(true), cfg.indexIntervalSeconds, (err) => app.log.error(err));
  })();

  // Background activity detection (local-only frame-differencing). Runs on its own cadence,
  // independent of indexing, and only touches frames already on disk (no remote/GSM fetch).
  if (cfg.activity.enabled) {
    const scanCycle = async () => {
      if (scanControl.paused) return;
      scanControl.scanning = true;
      try {
        const { scanned, flagged } = await runActivityScanOnce({
          prisma,
          control: scanControl,
          opts: {
            batch: cfg.activity.batch,
            downscale: cfg.activity.downscale,
            pixelThreshold: cfg.activity.pixelThreshold,
            colorThreshold: cfg.activity.colorThreshold,
            scoreThreshold: cfg.activity.scoreThreshold,
            maxGapSeconds: cfg.activity.maxGapSeconds,
          },
        });
        if (scanned > 0) app.log.info({ scanned, flagged }, "activity scan cycle");
      } finally {
        scanControl.scanning = false;
      }
    };
    startIndexLoop(scanCycle, cfg.activity.intervalSeconds, (err) => app.log.error(err));
  }

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
