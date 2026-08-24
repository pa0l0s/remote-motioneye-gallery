import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import type { AppConfig } from "../config.js";
import type { AiScanControl } from "../ai/scanner.js";
import { SPIDER_ONLY_KINDS } from "../ai/normalize.js";
import { FOG_VISIBILITY } from "../media/detectionFilter.js";

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
    // AI_TAGGING_ENABLED is a startup config flag, not something that flips at runtime.
    // When it's off, this endpoint is still polled (see web/src/App.tsx and
    // ScanStatusTray) so the UI can learn that fact and stop polling itself -- but it
    // must learn it WITHOUT paying for seven aggregate queries over the whole ~209k-row
    // local-image table first. None of those aggregates lead with a cameraId equality,
    // so each one is a table scan; on NAS-class hardware that competes directly with
    // loop A's own indexing work for no purpose, since every count would be reported
    // through a disabled/zeroed response anyway. The response shape is identical to the
    // enabled path (same keys, zeroed/null values) so the client needs no special case.
    if (!cfg.ai.enabled) {
      return {
        enabled: false,
        paused: control?.paused ?? false,
        scanning: false,
        modelLoaded: false,
        activeUrl: null,
        activeModel: null,
        model: cfg.ai.model,
        lastProbeAt: null,
        totalLocalImages: 0,
        scanned: 0,
        pending: 0,
        weatherScanned: 0,
        withPeople: 0,
        withAnimals: 0,
        withSpiders: 0,
        withWeather: 0,
        avgLatencyMs: null,
        lastError: null,
      };
    }

    const [total, scanned, weatherScanned, withPeople, withAnimals, withSpiders, withWeather, latency] =
      await Promise.all([
        prisma.mediaFile.count({ where: localImage }),
        prisma.mediaFile.count({ where: { ...localImage, aiScannedAt: { not: null } } }),
        prisma.mediaFile.count({ where: { ...localImage, weatherVisibility: { not: null } } }),
        prisma.mediaFile.count({ where: { ...localImage, aiPeopleCount: { gt: 0 } } }),
        // Same rule as the "any animal" filter: a lens spider is not an animal in the scene.
        prisma.mediaFile.count({
          where: {
            ...localImage,
            AND: [{ aiAnimalKinds: { not: null } }, { aiAnimalKinds: { not: SPIDER_ONLY_KINDS } }],
          },
        }),
        // Counted on its own, not folded into withAnimals: the spider filter is a
        // separate row in the UI and needs its own tally.
        prisma.mediaFile.count({
          where: { ...localImage, aiAnimalKinds: { contains: ",spider," } },
        }),
        prisma.mediaFile.count({
          where: {
            ...localImage,
            OR: [
              { weatherVisibility: { in: [...FOG_VISIBILITY] } },
              { weatherPrecipitation: { in: ["snow", "heavy_rain"] } },
            ],
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
      activeUrl: control?.activeUrl ?? null,
      activeModel: control?.activeModel ?? null,
      model: cfg.ai.model,
      lastProbeAt: control?.lastProbeAt ?? null,
      totalLocalImages: total,
      scanned,
      pending: total - scanned,
      weatherScanned,
      withPeople,
      withAnimals,
      withSpiders,
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
