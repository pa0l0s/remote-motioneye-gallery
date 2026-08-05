import { describe, it, expect, afterAll, beforeEach } from "vitest";
import Fastify from "fastify";
import { makeTestDb } from "../helpers/testDb.js";
import { registerMediaRoutes } from "../../src/routes/media.js";

const { prisma } = makeTestDb();
afterAll(async () => {
  await prisma.$disconnect();
});
beforeEach(async () => {
  await prisma.mediaFile.deleteMany();
  await prisma.camera.deleteMany();
});

async function app() {
  const a = Fastify();
  registerMediaRoutes(a, {
    prisma,
    ensureFile: async () => "/x",
    ensureThumbFor: async () => "/x.webp",
  });
  return a;
}

describe("GET /api/media", () => {
  it("returns rows ordered by timestamp ascending, keyset paginated", async () => {
    const cam = await prisma.camera.create({ data: { motionEyeId: 1, name: "Camera1" } });
    for (let i = 0; i < 5; i++) {
      await prisma.mediaFile.create({
        data: {
          cameraId: cam.id,
          fileType: "image",
          remotePath: `/d/${i}.jpg`,
          localPath: `/m/${i}.jpg`,
          timestamp: new Date(1000 + i * 1000),
        },
      });
    }
    const a = await app();
    const res = await a.inject({ method: "GET", url: `/api/media?cameraId=${cam.id}&limit=2` });
    expect(res.statusCode).toBe(200);
    const page = res.json();
    expect(page.items).toHaveLength(2);
    expect(page.items[0].remotePath).toBe("/d/0.jpg");
    expect(page.nextCursor).toBeTruthy();

    const res2 = await a.inject({
      method: "GET",
      url: `/api/media?cameraId=${cam.id}&limit=2&cursor=${encodeURIComponent(page.nextCursor)}`,
    });
    expect(res2.json().items[0].remotePath).toBe("/d/2.jpg");
  });

  it("404s an unknown media file", async () => {
    const a = await app();
    const res = await a.inject({ method: "GET", url: "/api/media/9999/thumb" });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /api/media — detection filters", () => {
  async function seedThree() {
    const cam = await prisma.camera.create({ data: { motionEyeId: 7, name: "Camera1" } });
    const mk = (remotePath: string, extra: object) =>
      prisma.mediaFile.create({
        data: {
          cameraId: cam.id,
          fileType: "image",
          remotePath,
          localPath: `/m/${remotePath}`,
          timestamp: new Date(2_000_000),
          isDownloaded: true,
          ...extra,
        },
      });
    // basic pass only
    await mk("motion.jpg", { hasActivity: true, activityScannedAt: new Date() });
    // extended pass only
    await mk("bird.jpg", { aiScannedAt: new Date(), aiAnimalKinds: ",bird," });
    // seen by neither pass
    await mk("quiet.jpg", {});
    return cam;
  }

  it("returns the union of the selected kinds", async () => {
    const cam = await seedThree();
    const a = await app();
    const res = await a.inject({
      method: "GET",
      url: `/api/media?cameraId=${cam.id}&detections=motion,animal:bird`,
    });
    const paths = res.json().items.map((i: { remotePath: string }) => i.remotePath).sort();
    expect(paths).toEqual(["bird.jpg", "motion.jpg"]);
  });

  it("does not match a species by substring", async () => {
    const cam = await seedThree();
    const a = await app();
    const res = await a.inject({
      method: "GET",
      url: `/api/media?cameraId=${cam.id}&detections=animal:dog`,
    });
    expect(res.json().items).toHaveLength(0);
  });

  it("returns everything when no kind is selected", async () => {
    const cam = await seedThree();
    const a = await app();
    const res = await a.inject({ method: "GET", url: `/api/media?cameraId=${cam.id}` });
    expect(res.json().items).toHaveLength(3);
  });

  it("separates frames by which pass has seen them", async () => {
    const cam = await seedThree();
    const a = await app();
    const only = async (scannedBy: string) => {
      const r = await a.inject({ method: "GET", url: `/api/media?cameraId=${cam.id}&scannedBy=${scannedBy}` });
      return r.json().items.map((i: { remotePath: string }) => i.remotePath).sort();
    };
    expect(await only("basic")).toEqual(["motion.jpg"]);
    expect(await only("ai")).toEqual(["bird.jpg"]);
    expect(await only("none")).toEqual(["quiet.jpg"]);
    expect(await only("both")).toEqual([]);
  });
});
