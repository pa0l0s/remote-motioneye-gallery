import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import type { ScanControl } from "../activity/scanner.js";

export interface ActivityDeps {
  prisma: PrismaClient;
  control: ScanControl;
  enabled: boolean;
}

/**
 * Scan status for the UI tray + pause/resume. All counts are over LOCAL image frames (the
 * only ones the local-only scanner can ever process), so "scanned / total" reflects real,
 * achievable coverage rather than the full remote archive.
 */
export function registerActivityRoutes(app: FastifyInstance, deps: ActivityDeps): void {
  const { prisma, control } = deps;
  const localImage = { fileType: "image", isDownloaded: true } as const;

  app.get("/api/activity/status", async () => {
    const [total, scanned, withActivity] = await Promise.all([
      prisma.mediaFile.count({ where: localImage }),
      prisma.mediaFile.count({ where: { ...localImage, activityScannedAt: { not: null } } }),
      prisma.mediaFile.count({ where: { ...localImage, hasActivity: true } }),
    ]);
    return {
      enabled: deps.enabled,
      paused: control.paused,
      scanning: control.scanning,
      totalLocalImages: total,
      scanned,
      pending: total - scanned,
      withActivity,
    };
  });

  app.post("/api/activity/pause", async () => {
    control.paused = true;
    return { paused: true };
  });

  app.post("/api/activity/resume", async () => {
    control.paused = false;
    return { paused: false };
  });

  // Clear activity results so the scanner re-processes frames after a tuning change.
  // With keepScores=true the stored per-frame scores survive: re-applying a threshold
  // does not require decoding 209k JPEGs again, only re-evaluating numbers already held.
  app.post("/api/activity/rescan", async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const keepScores = q.keepScores === "true";
    const res = await prisma.mediaFile.updateMany({
      where: { activityScannedAt: { not: null } },
      data: keepScores
        ? { activityScannedAt: null, hasActivity: false }
        : { activityScannedAt: null, hasActivity: false, activityScore: null },
    });
    return { reset: res.count, keptScores: keepScores };
  });
}
