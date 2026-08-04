import { describe, it, expect, afterAll, beforeEach } from "vitest";
import Fastify from "fastify";
import { makeTestDb } from "../helpers/testDb.js";
import { registerActivityRoutes } from "../../src/routes/activity.js";

const { prisma } = makeTestDb();
afterAll(async () => { await prisma.$disconnect(); });
beforeEach(async () => {
  await prisma.mediaFile.deleteMany();
  await prisma.camera.deleteMany();
});

describe("POST /api/activity/rescan", () => {
  it("with keepScores keeps the stored scores and only clears the verdict", async () => {
    const cam = await prisma.camera.create({ data: { motionEyeId: 1, name: "Cam" } });
    await prisma.mediaFile.create({
      data: {
        cameraId: cam.id, fileType: "image", remotePath: "a.jpg", localPath: "/m/a.jpg",
        timestamp: new Date(), isDownloaded: true,
        activityScore: 0.12, hasActivity: true, activityScannedAt: new Date(),
      },
    });
    const app = Fastify();
    registerActivityRoutes(app, {
      prisma,
      control: { paused: false, scanning: false },
      enabled: true,
    });

    await app.inject({ method: "POST", url: "/api/activity/rescan?keepScores=true" });
    const mf = await prisma.mediaFile.findFirstOrThrow();
    expect(mf.activityScore).toBe(0.12); // no re-decode needed
    expect(mf.activityScannedAt).toBeNull();
    expect(mf.hasActivity).toBe(false);
  });

  it("without keepScores clears everything (backward compatibility)", async () => {
    const cam = await prisma.camera.create({ data: { motionEyeId: 1, name: "Cam" } });
    await prisma.mediaFile.create({
      data: {
        cameraId: cam.id, fileType: "image", remotePath: "b.jpg", localPath: "/m/b.jpg",
        timestamp: new Date(), isDownloaded: true,
        activityScore: 0.12, hasActivity: true, activityScannedAt: new Date(),
      },
    });
    const app = Fastify();
    registerActivityRoutes(app, {
      prisma,
      control: { paused: false, scanning: false },
      enabled: true,
    });

    await app.inject({ method: "POST", url: "/api/activity/rescan" });
    const mf = await prisma.mediaFile.findFirstOrThrow();
    expect(mf.activityScore).toBeNull(); // cleared as before
    expect(mf.activityScannedAt).toBeNull();
    expect(mf.hasActivity).toBe(false);
  });
});
