import { createReadStream } from "node:fs";
import type { FastifyInstance } from "fastify";
import type { PrismaClient, MediaFile } from "@prisma/client";

export interface MediaDeps {
  prisma: PrismaClient;
  ensureFile: (mf: MediaFile) => Promise<string>;
  /** Returns the local thumb path, or null when the source is not local (no remote fetch). */
  ensureThumbFor: (mf: MediaFile) => Promise<string | null>;
}

// Cursor encodes "<timestampMs>_<id>" for stable keyset pagination.
function encodeCursor(mf: { timestamp: Date; id: number }): string {
  return `${mf.timestamp.getTime()}_${mf.id}`;
}
function decodeCursor(c: string): { ts: number; id: number } | null {
  const m = c.match(/^(\d+)_(\d+)$/);
  return m ? { ts: Number(m[1]), id: Number(m[2]) } : null;
}

export function registerMediaRoutes(app: FastifyInstance, deps: MediaDeps): void {
  const { prisma } = deps;

  app.get("/api/media", async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const cameraId = Number(q.cameraId);
    const limit = Math.min(Number(q.limit ?? "100"), 500);
    const cur = q.cursor ? decodeCursor(q.cursor) : null;

    const where: Record<string, unknown> = { cameraId };
    if (q.activityOnly === "true") where.hasActivity = true;
    if (q.from || q.to) {
      where.timestamp = {
        ...(q.from ? { gte: new Date(q.from) } : {}),
        ...(q.to ? { lte: new Date(q.to) } : {}),
      };
    }
    if (cur) {
      where.OR = [
        { timestamp: { gt: new Date(cur.ts) } },
        { timestamp: new Date(cur.ts), id: { gt: cur.id } },
      ];
    }

    const items = await prisma.mediaFile.findMany({
      where,
      orderBy: [{ timestamp: "asc" }, { id: "asc" }],
      take: limit,
    });
    const nextCursor = items.length === limit ? encodeCursor(items[items.length - 1]) : null;
    return { items, nextCursor };
  });

  async function load(id: number): Promise<MediaFile | null> {
    return prisma.mediaFile.findUnique({ where: { id } });
  }

  app.get("/api/media/:id/file", async (req, reply) => {
    const mf = await load(Number((req.params as { id: string }).id));
    if (!mf) return reply.code(404).send({ error: "not found" });
    const path = await deps.ensureFile(mf);
    reply.header("content-type", mf.fileType === "video" ? "video/mp4" : "image/jpeg");
    return reply.send(createReadStream(path));
  });

  app.get("/api/media/:id/thumb", async (req, reply) => {
    const mf = await load(Number((req.params as { id: string }).id));
    if (!mf) return reply.code(404).send({ error: "not found" });
    const path = await deps.ensureThumbFor(mf);
    // 409 means "not available locally" — the client shows a placeholder and never
    // triggers a remote download for a thumbnail.
    if (!path) return reply.code(409).send({ error: "not downloaded" });
    reply.header("content-type", "image/webp");
    return reply.send(createReadStream(path));
  });
}
