import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import type { DownloadManager } from "../downloads/manager.js";

export interface DownloadDeps {
  prisma: PrismaClient;
  manager: DownloadManager;
}

interface CreateBody {
  cameraId: number;
  mediaIds?: number[];
  day?: string; // YYYY-MM-DD
}

export function registerDownloadRoutes(app: FastifyInstance, deps: DownloadDeps): void {
  const { prisma, manager } = deps;

  // Create a user-triggered download job: either an explicit list of mediaIds, or every
  // not-yet-local frame of a given day. Only files that are not downloaded are queued.
  app.post("/api/downloads", async (req, reply) => {
    const body = req.body as CreateBody;
    const cameraId = Number(body.cameraId);
    if (!cameraId) return reply.code(400).send({ error: "cameraId required" });

    let mediaIds: number[] = [];
    let label = "";

    if (Array.isArray(body.mediaIds) && body.mediaIds.length > 0) {
      const rows = await prisma.mediaFile.findMany({
        where: { cameraId, id: { in: body.mediaIds }, isDownloaded: false },
        select: { id: true },
      });
      mediaIds = rows.map((r) => r.id);
      label = `${body.mediaIds.length} selected`;
    } else if (body.day) {
      const from = new Date(`${body.day}T00:00:00.000Z`);
      const to = new Date(`${body.day}T23:59:59.999Z`);
      const rows = await prisma.mediaFile.findMany({
        where: { cameraId, isDownloaded: false, timestamp: { gte: from, lte: to } },
        select: { id: true },
      });
      mediaIds = rows.map((r) => r.id);
      label = `${body.day} (${mediaIds.length})`;
    } else {
      return reply.code(400).send({ error: "mediaIds or day required" });
    }

    if (mediaIds.length === 0) {
      return reply.send({ id: null, total: 0, message: "nothing to download (already local)" });
    }
    const job = manager.create({ cameraId, mediaIds, label });
    return reply.send(job);
  });

  app.get("/api/downloads", async () => manager.list());

  app.post("/api/downloads/:id/cancel", async (req) => {
    manager.cancel((req.params as { id: string }).id);
    return { ok: true };
  });
}
