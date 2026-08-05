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

const app = () => {
  const instance = Fastify();
  registerTimelineRoutes(instance, { prisma });
  return instance;
};

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

  it("counts both passes separately in one histogram row", async () => {
    const cam = await prisma.camera.create({ data: { motionEyeId: 9, name: "Camera1" } });
    const day = (h: number) => new Date(Date.UTC(2026, 0, 5, h, 0, 0));
    const mk = (remotePath: string, hour: number, extra: object) =>
      prisma.mediaFile.create({
        data: {
          cameraId: cam.id,
          fileType: "image",
          remotePath,
          localPath: `/m/${remotePath}`,
          timestamp: day(hour),
          isDownloaded: true,
          ...extra,
        },
      });
    await mk("a.jpg", 1, { hasActivity: true });
    await mk("b.jpg", 2, { aiPeopleCount: 2 });
    await mk("c.jpg", 3, { aiAnimalKinds: ",bird,", weatherVisibility: "dense_fog" });
    await mk("d.jpg", 4, {}); // nothing found by either pass

    const a = app();
    const res = await a.inject({ method: "GET", url: `/api/cameras/${cam.id}/histogram?bucket=day` });
    const row = res.json()[0];
    expect(row.count).toBe(4);
    expect(row.activityCount).toBe(1);
    expect(row.peopleCount).toBe(1);
    expect(row.animalCount).toBe(1);
    expect(row.weatherCount).toBe(1);
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
