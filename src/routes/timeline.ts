import type { FastifyInstance } from "fastify";
import { Prisma, type PrismaClient } from "@prisma/client";

export interface TimelineDeps {
  prisma: PrismaClient;
}

const BUCKET_FMT: Record<string, string> = {
  day: "%Y-%m-%d",
  hour: "%Y-%m-%d %H",
  minute: "%Y-%m-%d %H:%M",
};

export function registerTimelineRoutes(app: FastifyInstance, deps: TimelineDeps): void {
  const { prisma } = deps;

  app.get("/api/cameras/:id/histogram", async (req, reply) => {
    const cameraId = Number((req.params as { id: string }).id);
    const q = req.query as Record<string, string | undefined>;
    const fmt = BUCKET_FMT[q.bucket ?? "day"];
    if (!fmt) return reply.code(400).send({ error: "bad bucket" });

    const rows = await prisma.$queryRaw<
      Array<{
        bucket: string; count: bigint; activityCount: bigint;
        peopleCount: bigint; animalCount: bigint; weatherCount: bigint;
      }>
    >(Prisma.sql`
      SELECT strftime(${fmt}, timestamp / 1000, 'unixepoch') AS bucket,
             COUNT(*) AS count,
             SUM(CASE WHEN hasActivity THEN 1 ELSE 0 END) AS activityCount,
             SUM(CASE WHEN aiPeopleCount > 0 THEN 1 ELSE 0 END) AS peopleCount,
             SUM(CASE WHEN aiAnimalKinds IS NOT NULL THEN 1 ELSE 0 END) AS animalCount,
             SUM(CASE WHEN weatherVisibility = 'dense_fog'
                        OR weatherPrecipitation IN ('snow','heavy_rain') THEN 1 ELSE 0 END) AS weatherCount
      FROM MediaFile
      WHERE cameraId = ${cameraId}
      GROUP BY bucket
      ORDER BY bucket ASC
    `);
    return rows.map((r) => ({
      bucket: r.bucket,
      count: Number(r.count),
      activityCount: Number(r.activityCount),
      peopleCount: Number(r.peopleCount),
      animalCount: Number(r.animalCount),
      weatherCount: Number(r.weatherCount),
    }));
  });

  app.get("/api/cameras/:id/seek", async (req) => {
    const cameraId = Number((req.params as { id: string }).id);
    const q = req.query as Record<string, string | undefined>;
    const at = new Date(q.at ?? new Date().toISOString());
    const index = await prisma.mediaFile.count({
      where: { cameraId, timestamp: { lt: at } },
    });
    const target = await prisma.mediaFile.findFirst({
      where: { cameraId, timestamp: { gte: at } },
      orderBy: { timestamp: "asc" },
    });
    return { index, mediaId: target?.id ?? null };
  });
}
