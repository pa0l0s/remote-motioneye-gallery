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
