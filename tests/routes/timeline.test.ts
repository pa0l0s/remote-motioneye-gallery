import { describe, it, expect, afterAll, beforeEach } from "vitest";
import Fastify from "fastify";
import { makeTestDb } from "../helpers/testDb.js";
import { registerTimelineRoutes } from "../../src/routes/timeline.js";

const { prisma } = makeTestDb();
afterAll(async () => {
  await prisma.$disconnect();
});
beforeEach(async () => {
  await prisma.mediaFile.deleteMany();
  await prisma.camera.deleteMany();
});

describe("GET /api/cameras/:id/histogram", () => {
  it("buckets counts by day", async () => {
    const cam = await prisma.camera.create({ data: { motionEyeId: 1, name: "Camera1" } });
    const mk = (iso: string) =>
      prisma.mediaFile.create({
        data: {
          cameraId: cam.id,
          fileType: "image",
          remotePath: iso,
          localPath: iso,
          timestamp: new Date(iso),
        },
      });
    await mk("2026-06-13T01:00:00Z");
    await mk("2026-06-13T05:00:00Z");
    await mk("2026-06-12T05:00:00Z");
    const a = Fastify();
    registerTimelineRoutes(a, { prisma });
    const res = await a.inject({ method: "GET", url: `/api/cameras/${cam.id}/histogram?bucket=day` });
    expect(res.statusCode).toBe(200);
    const buckets = res.json() as Array<{ bucket: string; count: number }>;
    const map = Object.fromEntries(buckets.map((b) => [b.bucket, b.count]));
    expect(map["2026-06-13"]).toBe(2);
    expect(map["2026-06-12"]).toBe(1);
  });
});

describe("GET /api/cameras/:id/seek", () => {
  it("returns the ordinal index and the nearest forward mediaId", async () => {
    const cam = await prisma.camera.create({ data: { motionEyeId: 1, name: "Camera1" } });
    const ids: number[] = [];
    for (const iso of ["2026-06-13T01:00:00Z", "2026-06-13T02:00:00Z", "2026-06-13T03:00:00Z"]) {
      const m = await prisma.mediaFile.create({
        data: {
          cameraId: cam.id,
          fileType: "image",
          remotePath: iso,
          localPath: iso,
          timestamp: new Date(iso),
        },
      });
      ids.push(m.id);
    }
    const a = Fastify();
    registerTimelineRoutes(a, { prisma });
    const res = await a.inject({
      method: "GET",
      url: `/api/cameras/${cam.id}/seek?at=2026-06-13T02:00:00Z`,
    });
    expect(res.json()).toEqual({ index: 1, mediaId: ids[1] });
  });
});
