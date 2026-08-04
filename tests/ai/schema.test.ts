import { describe, it, expect, afterAll } from "vitest";
import { makeTestDb } from "../helpers/testDb.js";

const { prisma } = makeTestDb();
afterAll(async () => { await prisma.$disconnect(); });

describe("MediaFile — extended-pass columns", () => {
  it("stores AI and weather columns independently of the activity columns", async () => {
    const cam = await prisma.camera.create({ data: { motionEyeId: 1, name: "Cam" } });
    const mf = await prisma.mediaFile.create({
      data: {
        cameraId: cam.id,
        fileType: "image",
        remotePath: "2026-01-01/00-00-00.jpg",
        localPath: "/media/Cam/2026-01-01/00-00-00.jpg",
        timestamp: new Date("2026-01-01T00:00:00Z"),
        isDownloaded: true,
        activityScore: 0.5,
        hasActivity: true,
        activityScannedAt: new Date("2026-01-01T01:00:00Z"),
      },
    });

    // defaults: nothing from the extended pass yet
    expect(mf.aiScannedAt).toBeNull();
    expect(mf.aiFailures).toBe(0);
    expect(mf.weatherVisibility).toBeNull();
    expect(mf.isNightIr).toBeNull();

    const updated = await prisma.mediaFile.update({
      where: { id: mf.id },
      data: {
        aiScannedAt: new Date("2026-01-02T00:00:00Z"),
        aiModel: "qwen/qwen3-vl-8b",
        aiPromptVersion: "semantics-v1",
        aiPeopleCount: 2,
        aiAnimals: JSON.stringify(["1 bird on a tire", "horse"]),
        aiAnimalKinds: ",bird,horse,",
        aiLatencyMs: 1336,
        weatherScannedAt: new Date("2026-01-02T00:00:00Z"),
        weatherPromptVersion: "weather-v1",
        weatherVisibility: "dense_fog",
        weatherPrecipitation: "snow",
        weatherSnowOnGround: true,
        isNightIr: false,
      },
    });

    expect(updated.aiPeopleCount).toBe(2);
    expect(updated.aiAnimalKinds).toBe(",bird,horse,");
    expect(updated.weatherVisibility).toBe("dense_fog");
    // the basic pass result must be untouched by writing extended-pass columns
    expect(updated.activityScore).toBe(0.5);
    expect(updated.hasActivity).toBe(true);
    expect(updated.activityScannedAt).toEqual(new Date("2026-01-01T01:00:00Z"));
  });
});
