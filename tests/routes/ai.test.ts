import { describe, it, expect, afterAll, beforeEach } from "vitest";
import Fastify from "fastify";
import { makeTestDb } from "../helpers/testDb.js";
import { registerAiRoutes } from "../../src/routes/ai.js";
import { loadConfig } from "../../src/config.js";

const { prisma } = makeTestDb();
const cfg = loadConfig({
  MOTIONEYE_URL: "x", MOTIONEYE_USER: "u", MOTIONEYE_PASSWORD: "p", SECRET_KEY: "s",
  AI_TAGGING_ENABLED: "true",
});

afterAll(async () => { await prisma.$disconnect(); });
beforeEach(async () => {
  await prisma.mediaFile.deleteMany();
  await prisma.camera.deleteMany();
});

function app(control: any) {
  const f = Fastify();
  registerAiRoutes(f, { prisma, control, cfg });
  return f;
}

async function seedOne(over: object = {}) {
  // upsert: seedOne may be called more than once per test, and motionEyeId is unique —
  // reuse the same camera rather than colliding on a second insert.
  const cam = await prisma.camera.upsert({
    where: { motionEyeId: 1 },
    update: {},
    create: { motionEyeId: 1, name: "Cam" },
  });
  await prisma.mediaFile.create({
    data: {
      cameraId: cam.id, fileType: "image", remotePath: "a.jpg", localPath: "/m/a.jpg",
      timestamp: new Date("2026-01-01T12:00:00Z"), isDownloaded: true, ...over,
    },
  });
}

describe("GET /api/ai/status", () => {
  it("reports counts for the extended pass only", async () => {
    await seedOne({
      aiScannedAt: new Date(), aiPeopleCount: 2, aiAnimalKinds: ",bird,",
      weatherScannedAt: new Date(), weatherVisibility: "dense_fog",
      hasActivity: true, activityScannedAt: new Date(),
    });
    await seedOne({ remotePath: "b.jpg" });

    const f = app({ paused: false, scanning: true, modelLoaded: true, lastProbeAt: new Date(), lastError: null });
    const res = await f.inject({ method: "GET", url: "/api/ai/status" });
    const body = res.json();
    expect(body.enabled).toBe(true);
    expect(body.modelLoaded).toBe(true);
    expect(body.totalLocalImages).toBe(2);
    expect(body.scanned).toBe(1);
    expect(body.pending).toBe(1);
    expect(body.withPeople).toBe(1);
    expect(body.withAnimals).toBe(1);
    expect(body.withWeather).toBe(1);
    // must NOT leak the basic pass's numbers into this endpoint
    expect(body.withActivity).toBeUndefined();
  });

  it("reports disabled state without a control", async () => {
    const f = app(null);
    const body = (await f.inject({ method: "GET", url: "/api/ai/status" })).json();
    expect(body.modelLoaded).toBe(false);
    expect(body.scanning).toBe(false);
  });
});

describe("pause and resume", () => {
  it("toggles only the extended pass control", async () => {
    const control = { paused: false, scanning: false, modelLoaded: true, lastProbeAt: null, lastError: null };
    const f = app(control);
    await f.inject({ method: "POST", url: "/api/ai/pause" });
    expect(control.paused).toBe(true);
    await f.inject({ method: "POST", url: "/api/ai/resume" });
    expect(control.paused).toBe(false);
  });
});
