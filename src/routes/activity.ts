import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import type { ScanControl } from "../activity/scanner.js";

export interface ActivityDeps {
  prisma: PrismaClient;
  control: ScanControl;
  enabled: boolean;
  /** Current activityScore threshold, applied directly by keepScores=true (see below). */
  scoreThreshold: number;
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

  // With keepScores=true the stored per-frame scores are re-applied AGAINST THE CURRENT
  // THRESHOLD directly, right here — not by clearing activityScannedAt and deferring to
  // the scanner. runActivityScanOnce (src/activity/scanner.ts) has no threshold-only
  // path: it unconditionally reads and re-decodes every frame it revisits, so nulling
  // activityScannedAt for 209k rows would silently re-run the full, expensive scan under
  // a different name while claiming "scores kept". Leaving activityScannedAt untouched is
  // what actually keeps the scanner from ever revisiting these frames.
  //
  // Without keepScores, the classic behaviour is unchanged: everything is cleared and the
  // scanner re-processes the archive from scratch (used after a change to something the
  // stored score itself can't answer, e.g. pixelThreshold or downscale).
  app.post("/api/activity/rescan", async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const keepScores = q.keepScores === "true";
    if (keepScores) {
      const reset = await prisma.$executeRaw`
        UPDATE MediaFile
        SET hasActivity = (activityScore > ${deps.scoreThreshold})
        WHERE activityScore IS NOT NULL
      `;
      return { reset, keptScores: true };
    }
    const res = await prisma.mediaFile.updateMany({
      where: { activityScannedAt: { not: null } },
      data: { activityScannedAt: null, hasActivity: false, activityScore: null },
    });
    return { reset: res.count, keptScores: false };
  });
}
