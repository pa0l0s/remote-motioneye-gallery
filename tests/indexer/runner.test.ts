import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { makeTestDb } from "../helpers/testDb.js";
import { runIndexOnce } from "../../src/indexer/runner.js";

const { prisma } = makeTestDb();
afterAll(async () => {
  await prisma.$disconnect();
});
beforeEach(async () => {
  await prisma.mediaFile.deleteMany();
  await prisma.indexCursor.deleteMany();
  await prisma.camera.deleteMany();
});

describe("runIndexOnce", () => {
  it("upserts cameras then indexes each", async () => {
    const client = {
      listCameras: async () => [{ id: 1, name: "Camera1" }],
      listDir: async (kind: string, _id: number, prefix: string) =>
        kind === "picture" && prefix === "2026-06-13"
          ? [
              {
                path: "/2026-06-13/a.jpg",
                timestamp: 1781359650,
                mimeType: "image/jpeg",
                sizeStr: "1 kB",
              },
            ]
          : [],
    } as any;
    await runIndexOnce({
      prisma,
      client,
      mediaRoot: "/m",
      startDate: "2026-06-13",
      emptyDayLimit: 1,
      existsOnDisk: () => false,
    });
    expect(await prisma.camera.count()).toBe(1);
    expect(await prisma.mediaFile.count()).toBe(1);
  });
});
