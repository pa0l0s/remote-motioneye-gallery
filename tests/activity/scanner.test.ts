import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { makeTestDb } from "../helpers/testDb.js";
import { runActivityScanOnce } from "../../src/activity/scanner.js";

const { prisma } = makeTestDb();
const dir = mkdtempSync(join(tmpdir(), "act-scan-"));

afterAll(async () => {
  await prisma.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  await prisma.mediaFile.deleteMany();
  await prisma.camera.deleteMany();
});

async function grayImage(name: string): Promise<string> {
  const path = join(dir, name);
  await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 90, g: 90, b: 90 } } })
    .png()
    .toFile(path);
  return path;
}
async function objectImage(name: string): Promise<string> {
  const path = join(dir, name);
  await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 90, g: 90, b: 90 } } })
    .composite([
      {
        input: { create: { width: 24, height: 24, channels: 3, background: { r: 255, g: 255, b: 255 } } },
        top: 12,
        left: 12,
      },
    ])
    .png()
    .toFile(path);
  return path;
}

describe("runActivityScanOnce", () => {
  it("scans only local image frames, flags real activity, and skips videos/remote", async () => {
    const cam = await prisma.camera.create({ data: { motionEyeId: 1, name: "Cam" } });
    const f0 = await grayImage("f0.png");
    const f1 = await grayImage("f1.png"); // identical to f0 -> no activity
    const f2 = await objectImage("f2.png"); // object appears -> activity
    const base = Date.now();
    const mk = (remote: string, local: string, off: number, extra: object = {}) =>
      prisma.mediaFile.create({
        data: {
          cameraId: cam.id,
          fileType: "image",
          remotePath: remote,
          localPath: local,
          timestamp: new Date(base + off * 60_000),
          isDownloaded: true,
          ...extra,
        },
      });

    const r0 = await mk("/d/0.jpg", f0, 0);
    const r1 = await mk("/d/1.jpg", f1, 1);
    const r2 = await mk("/d/2.jpg", f2, 2);
    // a video frame (must be skipped) and a remote image (not downloaded -> skipped)
    const vid = await prisma.mediaFile.create({
      data: {
        cameraId: cam.id,
        fileType: "video",
        remotePath: "/d/v.mp4",
        localPath: join(dir, "v.mp4"),
        timestamp: new Date(base + 3 * 60_000),
        isDownloaded: true,
      },
    });
    const remote = await prisma.mediaFile.create({
      data: {
        cameraId: cam.id,
        fileType: "image",
        remotePath: "/d/r.jpg",
        localPath: join(dir, "missing.jpg"),
        timestamp: new Date(base + 4 * 60_000),
        isDownloaded: false,
      },
    });

    const res = await runActivityScanOnce({
      prisma,
      opts: { batch: 100, maxGapSeconds: 900, scoreThreshold: 0.02 },
    });

    expect(res.scanned).toBe(3); // the three local images
    expect(res.flagged).toBe(1); // only f2

    const rows = Object.fromEntries(
      (await prisma.mediaFile.findMany()).map((m) => [m.id, m]),
    );
    // first frame: scanned but no neighbor -> null score, not flagged
    expect(rows[r0.id].activityScannedAt).not.toBeNull();
    expect(rows[r0.id].hasActivity).toBe(false);
    expect(rows[r0.id].activityScore).toBeNull();
    // identical neighbor -> scanned, not flagged
    expect(rows[r1.id].activityScannedAt).not.toBeNull();
    expect(rows[r1.id].hasActivity).toBe(false);
    // object appears -> flagged
    expect(rows[r2.id].activityScannedAt).not.toBeNull();
    expect(rows[r2.id].hasActivity).toBe(true);
    // video + remote left untouched
    expect(rows[vid.id].activityScannedAt).toBeNull();
    expect(rows[remote.id].activityScannedAt).toBeNull();
  });

  it("makes forward progress (already-scanned frames are not rescanned)", async () => {
    const cam = await prisma.camera.create({ data: { motionEyeId: 2, name: "Cam2" } });
    const f0 = await grayImage("p0.png");
    const f1 = await grayImage("p1.png");
    const base = Date.now();
    for (const [i, p] of [f0, f1].entries()) {
      await prisma.mediaFile.create({
        data: {
          cameraId: cam.id,
          fileType: "image",
          remotePath: `/p/${i}.jpg`,
          localPath: p,
          timestamp: new Date(base + i * 60_000),
          isDownloaded: true,
        },
      });
    }
    const first = await runActivityScanOnce({ prisma });
    expect(first.scanned).toBe(2);
    const second = await runActivityScanOnce({ prisma });
    expect(second.scanned).toBe(0); // nothing left to scan
  });
});
