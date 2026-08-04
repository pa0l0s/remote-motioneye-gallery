import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import type { AppConfig } from "../config.js";
import type { AiScanControl } from "../ai/scanner.js";

export interface AiRouteDeps {
  prisma: PrismaClient;
  /** null when the extended pass is disabled — the routes still answer, reporting idle. */
  control: AiScanControl | null;
  cfg: AppConfig;
}

/**
 * Status and controls for the EXTENDED pass only. The basic pass keeps its own
 * /api/activity/* routes; mixing the two would make it impossible for the UI to show
 * that one pass is working while the other sleeps.
 */
export function registerAiRoutes(app: FastifyInstance, deps: AiRouteDeps): void {
  const { prisma, control, cfg } = deps;
  const localImage = { fileType: "image", isDownloaded: true } as const;

  app.get("/api/ai/status", async () => {
    const [total, scanned, weatherScanned, withPeople, withAnimals, withWeather, latency] =
      await Promise.all([
        prisma.mediaFile.count({ where: localImage }),
        prisma.mediaFile.count({ where: { ...localImage, aiScannedAt: { not: null } } }),
        prisma.mediaFile.count({ where: { ...localImage, weatherVisibility: { not: null } } }),
        prisma.mediaFile.count({ where: { ...localImage, aiPeopleCount: { gt: 0 } } }),
        prisma.mediaFile.count({ where: { ...localImage, aiAnimalKinds: { not: null } } }),
        prisma.mediaFile.count({
          where: {
            ...localImage,
            OR: [{ weatherVisibility: "dense_fog" }, { weatherPrecipitation: { in: ["snow", "heavy_rain"] } }],
          },
        }),
        prisma.mediaFile.aggregate({
          _avg: { aiLatencyMs: true },
          where: { ...localImage, aiLatencyMs: { not: null } },
        }),
      ]);

    return {
      enabled: cfg.ai.enabled,
      paused: control?.paused ?? false,
      scanning: control?.scanning ?? false,
      modelLoaded: control?.modelLoaded ?? false,
      model: cfg.ai.model,
      lastProbeAt: control?.lastProbeAt ?? null,
      totalLocalImages: total,
      scanned,
      pending: total - scanned,
      weatherScanned,
      withPeople,
      withAnimals,
      withWeather,
      avgLatencyMs: latency._avg.aiLatencyMs ? Math.round(latency._avg.aiLatencyMs) : null,
      lastError: control?.lastError ?? null,
    };
  });

  app.post("/api/ai/pause", async () => {
    if (control) control.paused = true;
    return { paused: true };
  });

  app.post("/api/ai/resume", async () => {
    if (control) control.paused = false;
    return { paused: false };
  });
}
