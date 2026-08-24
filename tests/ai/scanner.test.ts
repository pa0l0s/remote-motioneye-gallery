import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { makeTestDb } from "../helpers/testDb.js";
import { runAiScanOnce, type AiScanControl } from "../../src/ai/scanner.js";
import { ModelUnavailableError, ModelTimeoutError, FrameRejectedError } from "../../src/ai/lmstudio.js";

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

  it("bumping weatherPromptVersion re-samples instead of being blocked by old-version neighbours", async () => {
    // Without weatherPromptVersion in the neighbour predicate, shouldAskWeather only ever
    // checks weatherVisibility != null -- so once the archive is backfilled, EVERY window
    // already has an old-version neighbour and a version bump does nothing at all.
    await seed(10); // 10 frames, 150 s apart = 22.5 min span
    await runAiScanOnce({
      prisma, opts: OPTS, control: control(),
      deps: deps({ askWeather: async () => ({ visibility: "clear", precipitation: "none", snowOnGround: false }) }),
    });
    const beforeCount = await prisma.mediaFile.count({ where: { weatherVisibility: { not: null } } });
    expect(beforeCount).toBe(3); // only the sampled frames got a weatherVisibility written

    let weatherCalls = 0;
    await runAiScanOnce({
      prisma,
      opts: { ...OPTS, promptVersion: "semantics-v2", weatherPromptVersion: "weather-v2" },
      control: control(),
      deps: deps({
        askWeather: async () => { weatherCalls++; return { visibility: "clear", precipitation: "none", snowOnGround: false }; },
      }),
    });
    // Same sampling density as the first pass (3 of 10, 600 s gap over a 1350 s span) --
    // NOT zero, which is what the old (pre-fix) predicate would have produced since every
    // window already had a weather-v1-tagged neighbour.
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

  it("aborts the batch and marks nothing on a timeout, distinctly from an outage", async () => {
    // A timeout means the host is busy, not gone. It must still abort the batch and mark
    // nothing (the same SAFETY property as ModelUnavailableError) but is reported as a
    // distinct "timeout" stop reason -- aiRunnerTick relies on that distinction to avoid
    // pushing the next probe out by a full interval over a merely-slow frame.
    await seed(3);
    const ctl = control();
    const res = await runAiScanOnce({
      prisma, opts: OPTS, control: ctl,
      deps: deps({ askSemantics: async () => { throw new ModelTimeoutError("timed out after 60000ms"); } }),
    });
    expect(res.stopped).toBe("timeout");
    expect(res.scanned).toBe(0);
    const rows = await prisma.mediaFile.findMany();
    expect(rows.every((r) => r.aiScannedAt === null)).toBe(true);
    expect(rows.every((r) => r.aiFailures === 0)).toBe(true);
    expect(ctl.modelLoaded).toBe(false);
    expect(ctl.lastError).toMatch(/timed out/);
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
    // aiFailures resets to 0 on give-up (not left at maxFailures): the eligibility filter
    // excludes aiFailures >= maxFailures unconditionally, so leaving it at maxFailures
    // would make the frame permanently unreachable even after a prompt-version bump.
    expect(mf.aiFailures).toBe(0);
    expect(mf.aiScannedAt).not.toBeNull(); // given up, loop moves on
    expect(mf.aiPeopleCount).toBeNull();
  });

  it("re-opens a given-up frame once the prompt version bumps", async () => {
    await seed(1);
    // Give up on the only frame under semantics-v1.
    await runAiScanOnce({
      prisma, opts: { ...OPTS, maxFailures: 1 }, control: control(),
      deps: deps({ askSemantics: async () => { throw new FrameRejectedError("bad jpeg"); } }),
    });
    let mf = await prisma.mediaFile.findFirstOrThrow();
    expect(mf.aiScannedAt).not.toBeNull();
    expect(mf.aiFailures).toBe(0);

    // A version bump must pick it back up rather than leaving it excluded forever by
    // the aiFailures gate.
    let calls = 0;
    const res = await runAiScanOnce({
      prisma, opts: { ...OPTS, maxFailures: 1, promptVersion: "semantics-v2" }, control: control(),
      deps: deps({ askSemantics: async () => { calls++; return { peopleCount: 0, animals: [] }; } }),
    });
    expect(calls).toBe(1);
    expect(res.scanned).toBe(1);
    mf = await prisma.mediaFile.findFirstOrThrow();
    expect(mf.aiPromptVersion).toBe("semantics-v2");
  });

  it("aborts and marks nothing when every read in a page fails (media mount outage)", async () => {
    // A read outage (unmounted volume, dropped NAS bind mount) makes loadJpeg throw for
    // every frame. This must NOT be treated as 200 individually corrupt JPEGs: bumping
    // every visited frame's aiFailures would, over a handful of calls, falsely record
    // the whole archive as "scanned, found nothing" -- exactly the false-negative outcome
    // the ModelUnavailableError abort-and-mark-nothing path exists to prevent, reached
    // through the file-read door instead of the model door.
    await seed(10);
    const ctl = control();
    const res = await runAiScanOnce({
      prisma, opts: { ...OPTS, batch: 4 }, control: ctl,
      deps: deps({ loadJpeg: async () => { throw new Error("ENOENT: no such file or directory"); } }),
    });
    expect(res.stopped).toBe("unavailable");
    expect(res.scanned).toBe(0);
    const touched = await prisma.mediaFile.count({ where: { aiFailures: { gt: 0 } } });
    expect(touched).toBe(0); // nothing marked -- not even a failure count
    const rows = await prisma.mediaFile.findMany();
    expect(rows.every((r) => r.aiScannedAt === null)).toBe(true);
    expect(ctl.modelLoaded).toBe(false);
    expect(ctl.lastError).toMatch(/ENOENT/);
  });

  it("does NOT abort on a single-frame page whose read fails -- bumps aiFailures and eventually gives up like any other bad frame", async () => {
    // Steady-state backfill: the pending backlog is 1-2 frames (one new frame every
    // ~150 s against a 5 s runner tick), so a page of exactly one frame is the common
    // case, not an edge case. A single failed read on a page that size must NOT be
    // treated as an environment fault (see MIN_PAGE_FOR_OUTAGE in scanner.ts) -- if it
    // were, this one corrupt/zero-byte frame would abort every call forever, its
    // aiFailures would never increment, it would never reach maxFailures, and loop B
    // would stall on it permanently.
    await seed(1);
    const run = () => runAiScanOnce({
      prisma, opts: { ...OPTS, maxFailures: 2 }, control: control(),
      deps: deps({ loadJpeg: async () => { throw new Error("ENOENT: no such file or directory"); } }),
    });

    const res1 = await run();
    expect(res1.stopped).not.toBe("unavailable");
    let mf = await prisma.mediaFile.findFirstOrThrow();
    expect(mf.aiFailures).toBe(1);
    expect(mf.aiScannedAt).toBeNull(); // still retryable

    const res2 = await run();
    expect(res2.stopped).not.toBe("unavailable");
    mf = await prisma.mediaFile.findFirstOrThrow();
    // Gave up after maxFailures, exactly like a bad frame did before the regression --
    // aiFailures resets to 0 (see the give-up comment in bumpFailure) and aiScannedAt is
    // set so the loop moves on instead of retrying this frame forever.
    expect(mf.aiFailures).toBe(0);
    expect(mf.aiScannedAt).not.toBeNull();
  });

  it("still bumps aiFailures per-frame when only SOME reads in a page fail", async () => {
    // The mount is fine; a handful of frames are individually unreadable (e.g. corrupt
    // JPEGs). That is the ordinary per-frame failure path, not an environment fault, so
    // it must not trip the whole-page abort above.
    await seed(3);
    const rows0 = await prisma.mediaFile.findMany({ orderBy: { timestamp: "desc" } });
    const badPath = rows0[1].localPath; // the middle (by timestamp) of the 3 seeded frames
    const res = await runAiScanOnce({
      prisma, opts: OPTS, control: control(),
      deps: deps({
        loadJpeg: async (p: string) => {
          if (p === badPath) throw new Error("corrupt jpeg");
          return Buffer.from([1]);
        },
      }),
    });
    expect(res.stopped).toBe("empty"); // only 3 frames seeded, well under the batch cap
    expect(res.scanned).toBe(2);
    const bad = await prisma.mediaFile.findFirstOrThrow({ where: { localPath: badPath } });
    expect(bad.aiFailures).toBe(1);
    expect(bad.aiScannedAt).toBeNull(); // still retryable, not given up on yet
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

/**
 * On-demand downloads. The archive is ~200k frames and most are not local; a frame the
 * owner just pulled over the metered link must be labelled while they are still looking
 * at it, not after the backlog drains. Capture-time ordering cannot express that: a frame
 * shot in March and fetched today sorts to its March position, behind everything newer.
 */
describe("runAiScanOnce — freshly downloaded frames", () => {
  it("serves a just-downloaded old frame before the newest backlog frame", async () => {
    const cam = await seed(5); // captured 2026-01-01, newest is d/4.jpg
    const old = await prisma.mediaFile.create({
      data: {
        cameraId: cam.id,
        fileType: "image",
        remotePath: "old/1.jpg",
        localPath: "/media/old/1.jpg",
        timestamp: new Date(Date.UTC(2025, 2, 1)), // captured long before every seeded frame
        isDownloaded: true,
        downloadedAt: new Date(), // ...but fetched just now
      },
    });

    const seen: string[] = [];
    await runAiScanOnce({
      prisma,
      control: control(),
      opts: { ...OPTS, batch: 1 },
      deps: deps({ loadJpeg: async (p: string) => { seen.push(p); return Buffer.from([1]); } }),
    });
    expect(seen).toEqual([old.localPath]);
  });

  it("orders several fresh downloads newest-fetched first", async () => {
    const cam = await seed(1);
    const mk = (n: string, fetchedMsAgo: number) =>
      prisma.mediaFile.create({
        data: {
          cameraId: cam.id, fileType: "image", remotePath: `f/${n}.jpg`, localPath: `/media/f/${n}.jpg`,
          timestamp: new Date(Date.UTC(2025, 2, 1)), isDownloaded: true,
          downloadedAt: new Date(Date.now() - fetchedMsAgo),
        },
      });
    await mk("older", 60_000);
    const newest = await mk("newest", 1_000);

    const seen: string[] = [];
    await runAiScanOnce({
      prisma, control: control(), opts: { ...OPTS, batch: 1 },
      deps: deps({ loadJpeg: async (p: string) => { seen.push(p); return Buffer.from([1]); } }),
    });
    expect(seen).toEqual([newest.localPath]);
  });

  it("does not let an already-scanned frame jump the queue again after a prompt bump", async () => {
    // Re-scanning on a new prompt version is backlog work, not a fresh arrival. Without
    // this the same downloaded frames would keep pre-empting everything on every bump.
    const cam = await seed(3);
    await prisma.mediaFile.create({
      data: {
        cameraId: cam.id, fileType: "image", remotePath: "done/1.jpg", localPath: "/media/done/1.jpg",
        timestamp: new Date(Date.UTC(2025, 2, 1)), isDownloaded: true,
        downloadedAt: new Date(),
        aiScannedAt: new Date(), aiPromptVersion: "semantics-v0", aiPeopleCount: 0,
      },
    });

    const seen: string[] = [];
    await runAiScanOnce({
      prisma, control: control(), opts: { ...OPTS, batch: 1 },
      deps: deps({ loadJpeg: async (p: string) => { seen.push(p); return Buffer.from([1]); } }),
    });
    expect(seen).toEqual(["/media/d/2.jpg"]); // newest seeded frame, not the re-scan
  });

  it("stops preferring a fresh frame once it has exhausted its retries", async () => {
    const cam = await seed(2);
    await prisma.mediaFile.create({
      data: {
        cameraId: cam.id, fileType: "image", remotePath: "bad/1.jpg", localPath: "/media/bad/1.jpg",
        timestamp: new Date(Date.UTC(2025, 2, 1)), isDownloaded: true,
        downloadedAt: new Date(), aiFailures: OPTS.maxFailures,
      },
    });

    const seen: string[] = [];
    await runAiScanOnce({
      prisma, control: control(), opts: { ...OPTS, batch: 1 },
      deps: deps({ loadJpeg: async (p: string) => { seen.push(p); return Buffer.from([1]); } }),
    });
    expect(seen).toEqual(["/media/d/1.jpg"]);
  });
});
