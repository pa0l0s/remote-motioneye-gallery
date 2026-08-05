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
  it("with keepScores applies the NEW threshold to stored scores without re-scanning", async () => {
    // The whole point of keepScores is to avoid the scanner re-decoding 209k JPEGs just
    // to reproduce numbers it already computed. That only holds if the route itself
    // applies the new threshold — if it just cleared activityScannedAt and left the
    // scanner to redo the work (the old, buggy behaviour), this test would pass by
    // checking DB state immediately after the call while proving nothing about what the
    // route actually accomplished. So: assert the verdict flips AND that neither the
    // stored score nor the scanned timestamp were touched, which is what stops the
    // scanner from ever revisiting this frame.
    const cam = await prisma.camera.create({ data: { motionEyeId: 1, name: "Cam" } });
    const scannedAt = new Date("2026-01-01T00:00:00Z");
    const belowOld = await prisma.mediaFile.create({
      data: {
        cameraId: cam.id, fileType: "image", remotePath: "a.jpg", localPath: "/m/a.jpg",
        timestamp: new Date(), isDownloaded: true,
        // Computed under an old, stricter threshold: 0.12 was below it, so hasActivity
        // was false. The new threshold (0.05, below) should flip it to true.
        activityScore: 0.12, hasActivity: false, activityScannedAt: scannedAt,
      },
    });
    const aboveNew = await prisma.mediaFile.create({
      data: {
        cameraId: cam.id, fileType: "image", remotePath: "b.jpg", localPath: "/m/b.jpg",
        timestamp: new Date(), isDownloaded: true,
        // Computed under an old, looser threshold: 0.03 was above it, so hasActivity was
        // true. The new, stricter threshold (0.05, above) should flip it to false.
        activityScore: 0.03, hasActivity: true, activityScannedAt: scannedAt,
      },
    });
    const neverScanned = await prisma.mediaFile.create({
      data: {
        cameraId: cam.id, fileType: "image", remotePath: "c.jpg", localPath: "/m/c.jpg",
        timestamp: new Date(), isDownloaded: true,
        activityScore: null, hasActivity: false, activityScannedAt: null,
      },
    });
    const app = Fastify();
    registerActivityRoutes(app, {
      prisma,
      control: { paused: false, scanning: false },
      enabled: true,
      scoreThreshold: 0.05,
    });

    const res = await app.inject({ method: "POST", url: "/api/activity/rescan?keepScores=true" });
    expect(res.json()).toEqual({ reset: 2, keptScores: true });

    const a = await prisma.mediaFile.findUniqueOrThrow({ where: { id: belowOld.id } });
    expect(a.activityScore).toBe(0.12); // untouched -- no re-decode
    expect(a.activityScannedAt).toEqual(scannedAt); // untouched -- scanner will not revisit
    expect(a.hasActivity).toBe(true); // flipped: 0.12 > 0.05

    const b = await prisma.mediaFile.findUniqueOrThrow({ where: { id: aboveNew.id } });
    expect(b.activityScore).toBe(0.03);
    expect(b.activityScannedAt).toEqual(scannedAt);
    expect(b.hasActivity).toBe(false); // flipped: 0.03 <= 0.05

    // A frame with no stored score (no usable neighbor) is left alone entirely — there
    // is nothing for the new threshold to re-apply.
    const c = await prisma.mediaFile.findUniqueOrThrow({ where: { id: neverScanned.id } });
    expect(c.activityScore).toBeNull();
    expect(c.activityScannedAt).toBeNull();
    expect(c.hasActivity).toBe(false);
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
      scoreThreshold: 0.04,
    });

    await app.inject({ method: "POST", url: "/api/activity/rescan" });
    const mf = await prisma.mediaFile.findFirstOrThrow();
    expect(mf.activityScore).toBeNull(); // cleared as before
    expect(mf.activityScannedAt).toBeNull();
    expect(mf.hasActivity).toBe(false);
  });
});
