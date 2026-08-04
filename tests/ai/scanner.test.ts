import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { makeTestDb } from "../helpers/testDb.js";
import { runAiScanOnce, type AiScanControl } from "../../src/ai/scanner.js";
import { ModelUnavailableError, FrameRejectedError } from "../../src/ai/lmstudio.js";

const { prisma } = makeTestDb();
afterAll(async () => { await prisma.$disconnect(); });
beforeEach(async () => {
  await prisma.mediaFile.deleteMany();
  await prisma.camera.deleteMany();
});

const OPTS = {
  model: "test-model",
  promptVersion: "semantics-v1",
  weatherPromptVersion: "weather-v1",
  imageWidth: 1024,
  weatherMinGapSeconds: 600,
  batch: 50,
  colorThreshold: 8,
  maxFailures: 5,
};

function control(): AiScanControl {
  return { paused: false, scanning: false, modelLoaded: true, lastProbeAt: null, lastError: null };
}

async function seed(n: number, stepSeconds = 150) {
  const cam = await prisma.camera.create({ data: { motionEyeId: 1, name: "Cam" } });
  const base = Date.UTC(2026, 0, 1, 12, 0, 0);
  for (let i = 0; i < n; i++) {
    await prisma.mediaFile.create({
      data: {
        cameraId: cam.id,
        fileType: "image",
        remotePath: `d/${i}.jpg`,
        localPath: `/media/d/${i}.jpg`,
        timestamp: new Date(base + i * stepSeconds * 1000),
        isDownloaded: true,
      },
    });
  }
  return cam;
}

const deps = (over: Partial<Parameters<typeof runAiScanOnce>[0]["deps"]> = {}) => ({
  loadJpeg: async () => Buffer.from([1]),
  isNight: async () => false,
  askSemantics: async () => ({ peopleCount: 0, animals: [] as string[] }),
  askWeather: async () => ({ visibility: "clear", precipitation: "none", snowOnGround: false }),
  ...over,
});

describe("runAiScanOnce", () => {
  it("scans newest frames first", async () => {
    await seed(3);
    const seen: string[] = [];
    await runAiScanOnce({
      prisma, opts: { ...OPTS, batch: 1 }, control: control(),
      deps: deps({ loadJpeg: async (p: string) => { seen.push(p); return Buffer.from([1]); } }),
    });
    expect(seen).toEqual(["/media/d/2.jpg"]); // newest, not oldest
  });

  it("stores normalised animals and the provenance of the answer", async () => {
    await seed(1);
    await runAiScanOnce({
      prisma, opts: OPTS, control: control(),
      deps: deps({ askSemantics: async () => ({ peopleCount: 1, animals: ["1 bird on a tire", "horse"] }) }),
    });
    const mf = await prisma.mediaFile.findFirstOrThrow();
    expect(mf.aiPeopleCount).toBe(1);
    expect(mf.aiAnimalKinds).toBe(",bird,horse,");
    expect(JSON.parse(mf.aiAnimals!)).toEqual(["1 bird on a tire", "horse"]);
    expect(mf.aiModel).toBe("test-model");
    expect(mf.aiPromptVersion).toBe("semantics-v1");
    expect(mf.aiScannedAt).not.toBeNull();
  });

  it("never touches the basic pass columns", async () => {
    const cam = await seed(1);
    await prisma.mediaFile.updateMany({
      data: { activityScore: 0.9, hasActivity: true, activityScannedAt: new Date("2026-01-01T00:00:00Z") },
    });
    await runAiScanOnce({ prisma, opts: OPTS, control: control(), deps: deps() });
    const mf = await prisma.mediaFile.findFirstOrThrow();
    expect(mf.activityScore).toBe(0.9);
    expect(mf.hasActivity).toBe(true);
    expect(mf.activityScannedAt).toEqual(new Date("2026-01-01T00:00:00Z"));
    expect(cam.id).toBe(mf.cameraId);
  });

  it("asks about the weather at most once per weatherMinGapSeconds, daylight only", async () => {
    await seed(10); // 10 frames, 150 s apart = 22.5 min span
    let weatherCalls = 0;
    await runAiScanOnce({
      prisma, opts: OPTS, control: control(),
      deps: deps({ askWeather: async () => { weatherCalls++; return { visibility: "clear", precipitation: "none", snowOnGround: false }; } }),
    });
    // 600 s gap over a 1350 s span -> 3 sampled frames
    expect(weatherCalls).toBe(3);
  });

  it("never asks about the weather on night frames but still marks them", async () => {
    await seed(3);
    let weatherCalls = 0;
    await runAiScanOnce({
      prisma, opts: OPTS, control: control(),
      deps: deps({
        isNight: async () => true,
        askWeather: async () => { weatherCalls++; return { visibility: "clear", precipitation: "none", snowOnGround: false }; },
      }),
    });
    expect(weatherCalls).toBe(0);
    const rows = await prisma.mediaFile.findMany();
    expect(rows.every((r) => r.isNightIr === true)).toBe(true);
    expect(rows.every((r) => r.weatherScannedAt !== null)).toBe(true);
    expect(rows.every((r) => r.weatherVisibility === null)).toBe(true);
  });

  it("aborts the batch and marks nothing when the model disappears", async () => {
    await seed(3);
    const ctl = control();
    const res = await runAiScanOnce({
      prisma, opts: OPTS, control: ctl,
      deps: deps({ askSemantics: async () => { throw new ModelUnavailableError("gone"); } }),
    });
    expect(res.stopped).toBe("unavailable");
    expect(res.scanned).toBe(0);
    const rows = await prisma.mediaFile.findMany();
    expect(rows.every((r) => r.aiScannedAt === null)).toBe(true);
    expect(rows.every((r) => r.aiFailures === 0)).toBe(true);
    expect(ctl.modelLoaded).toBe(false);
  });

  it("counts a rejected frame against that frame and gives up after maxFailures", async () => {
    await seed(1);
    const run = () => runAiScanOnce({
      prisma, opts: { ...OPTS, maxFailures: 2 }, control: control(),
      deps: deps({ askSemantics: async () => { throw new FrameRejectedError("bad jpeg"); } }),
    });
    await run();
    let mf = await prisma.mediaFile.findFirstOrThrow();
    expect(mf.aiFailures).toBe(1);
    expect(mf.aiScannedAt).toBeNull(); // still retryable
    await run();
    mf = await prisma.mediaFile.findFirstOrThrow();
    expect(mf.aiFailures).toBe(2);
    expect(mf.aiScannedAt).not.toBeNull(); // given up, loop moves on
    expect(mf.aiPeopleCount).toBeNull();
  });

  it("re-scans frames whose prompt version is stale, and leaves current ones alone", async () => {
    await seed(2);
    await runAiScanOnce({ prisma, opts: OPTS, control: control(), deps: deps() });
    const before = await prisma.mediaFile.findMany();
    expect(before.every((r) => r.aiPromptVersion === "semantics-v1")).toBe(true);

    let calls = 0;
    await runAiScanOnce({
      prisma, opts: { ...OPTS, promptVersion: "semantics-v2" }, control: control(),
      deps: deps({ askSemantics: async () => { calls++; return { peopleCount: 0, animals: [] }; } }),
    });
    expect(calls).toBe(2);
    const after = await prisma.mediaFile.findMany();
    expect(after.every((r) => r.aiPromptVersion === "semantics-v2")).toBe(true);
  });

  it("stops immediately when paused", async () => {
    await seed(3);
    const ctl = control();
    ctl.paused = true;
    const res = await runAiScanOnce({ prisma, opts: OPTS, control: ctl, deps: deps() });
    expect(res.stopped).toBe("paused");
    expect(res.scanned).toBe(0);
  });

  it("skips videos and frames that are not downloaded", async () => {
    const cam = await seed(1);
    await prisma.mediaFile.create({
      data: { cameraId: cam.id, fileType: "video", remotePath: "v.mp4", localPath: "/media/v.mp4",
              timestamp: new Date(), isDownloaded: true },
    });
    await prisma.mediaFile.create({
      data: { cameraId: cam.id, fileType: "image", remotePath: "r.jpg", localPath: "/media/r.jpg",
              timestamp: new Date(), isDownloaded: false },
    });
    const res = await runAiScanOnce({ prisma, opts: OPTS, control: control(), deps: deps() });
    expect(res.scanned).toBe(1);
  });
});
