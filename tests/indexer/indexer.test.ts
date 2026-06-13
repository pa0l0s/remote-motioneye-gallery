import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { makeTestDb } from "../helpers/testDb.js";
import { indexCamera } from "../../src/indexer/indexer.js";
import type { RemoteEntry } from "../../src/motioneye/client.js";

const { prisma } = makeTestDb();
afterAll(async () => {
  await prisma.$disconnect();
});
beforeEach(async () => {
  await prisma.mediaFile.deleteMany();
  await prisma.indexCursor.deleteMany();
  await prisma.camera.deleteMany();
});

function fakeClient(byDate: Record<string, RemoteEntry[]>) {
  return {
    listDir: async (kind: "picture" | "movie", _cam: number, prefix: string) =>
      kind === "picture" ? (byDate[prefix] ?? []) : [],
  } as any;
}

describe("indexCamera", () => {
  it("inserts metadata rows and marks local files downloaded", async () => {
    const cam = await prisma.camera.create({ data: { motionEyeId: 1, name: "Camera1" } });
    const client = fakeClient({
      "2026-06-13": [
        {
          path: "/2026-06-13/16-07-30.jpg",
          timestamp: 1781359650,
          mimeType: "image/jpeg",
          sizeStr: "600 kB",
        },
      ],
    });
    const localSet = new Set(["/media/Camera1/2026-06-13/16-07-30.jpg"]);
    await indexCamera({
      prisma,
      client,
      camera: cam,
      mediaRoot: "/media",
      startDate: "2026-06-13",
      emptyDayLimit: 2,
      existsOnDisk: (p) => localSet.has(p),
    });
    const rows = await prisma.mediaFile.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].fileType).toBe("image");
    expect(rows[0].isDownloaded).toBe(true);
    expect(rows[0].sizeBytes).toBe(600000);
  });

  it("stops after emptyDayLimit consecutive empty days", async () => {
    const cam = await prisma.camera.create({ data: { motionEyeId: 1, name: "Camera1" } });
    const client = fakeClient({});
    await indexCamera({
      prisma,
      client,
      camera: cam,
      mediaRoot: "/media",
      startDate: "2026-06-13",
      emptyDayLimit: 3,
      existsOnDisk: () => false,
    });
    expect(await prisma.mediaFile.count()).toBe(0);
    const cur = await prisma.indexCursor.findUnique({ where: { cameraId: cam.id } });
    expect(cur?.status).toBe("idle");
  });

  it("is idempotent (re-running does not duplicate rows)", async () => {
    const cam = await prisma.camera.create({ data: { motionEyeId: 1, name: "Camera1" } });
    const client = fakeClient({
      "2026-06-13": [
        { path: "/2026-06-13/a.jpg", timestamp: 1781359650, mimeType: "image/jpeg", sizeStr: "1 kB" },
      ],
    });
    const args = {
      prisma,
      client,
      camera: cam,
      mediaRoot: "/media",
      startDate: "2026-06-13",
      emptyDayLimit: 1,
      existsOnDisk: () => false,
    };
    await indexCamera(args);
    await indexCamera(args);
    expect(await prisma.mediaFile.count()).toBe(1);
  });
});
