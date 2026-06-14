import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { Readable } from "node:stream";
import { makeTestDb } from "../helpers/testDb.js";
import { FetchGate } from "../../src/remote/fetchGate.js";
import { ensureDownloaded } from "../../src/media/store.js";

const { prisma } = makeTestDb();
afterAll(async () => {
  await prisma.$disconnect();
});
beforeEach(async () => {
  await prisma.mediaFile.deleteMany();
  await prisma.camera.deleteMany();
});

const gate = new FetchGate({ concurrency: 1, maxRetries: 0, baseDelayMs: 1 });

async function seedFile(localPath: string, isDownloaded: boolean) {
  const cam = await prisma.camera.create({ data: { motionEyeId: 1, name: "Camera1" } });
  return prisma.mediaFile.create({
    data: {
      cameraId: cam.id,
      fileType: "image",
      remotePath: "/2026-06-13/a.jpg",
      localPath,
      timestamp: new Date(),
      isDownloaded,
    },
  });
}

describe("ensureDownloaded", () => {
  it("downloads and writes the file, preserving structure, when missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "store-"));
    const local = join(dir, "Camera1/2026-06-13/a.jpg");
    const mf = await seedFile(local, false);
    const client = {
      downloadStream: async () => ({
        statusCode: 200,
        body: Readable.from([Buffer.from("JPEGDATA")]),
      }),
    } as any;
    await ensureDownloaded({ prisma, gate, client, mediaFile: mf });
    expect(existsSync(local)).toBe(true);
    expect(readFileSync(local).toString()).toBe("JPEGDATA");
    const updated = await prisma.mediaFile.findUnique({ where: { id: mf.id } });
    expect(updated?.isDownloaded).toBe(true);
  });

  it("re-downloads and replaces a 0-byte existing file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "store-"));
    const local = join(dir, "Camera1/2026-06-13/a.jpg");
    mkdirSync(dirname(local), { recursive: true });
    writeFileSync(local, "");
    const mf = await seedFile(local, true);
    let called = false;
    const client = {
      downloadStream: async () => {
        called = true;
        return { statusCode: 200, body: Readable.from([Buffer.from("FRESHDATA")]) };
      },
    } as any;
    await ensureDownloaded({ prisma, gate, client, mediaFile: mf });
    expect(called).toBe(true);
    expect(readFileSync(local).toString()).toBe("FRESHDATA");
    const updated = await prisma.mediaFile.findUnique({ where: { id: mf.id } });
    expect(updated?.isDownloaded).toBe(true);
  });

  it("overwrites an existing file when force is true", async () => {
    const dir = mkdtempSync(join(tmpdir(), "store-"));
    const local = join(dir, "Camera1/2026-06-13/a.jpg");
    mkdirSync(dirname(local), { recursive: true });
    writeFileSync(local, "ORIGINAL");
    const mf = await seedFile(local, true);
    const client = {
      downloadStream: async () => ({
        statusCode: 200,
        body: Readable.from([Buffer.from("REPLACED")]),
      }),
    } as any;
    await ensureDownloaded({ prisma, gate, client, mediaFile: mf, force: true });
    expect(readFileSync(local).toString()).toBe("REPLACED");
    const updated = await prisma.mediaFile.findUnique({ where: { id: mf.id } });
    expect(updated?.isDownloaded).toBe(true);
  });

  it("does not overwrite an existing file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "store-"));
    const local = join(dir, "Camera1/2026-06-13/a.jpg");
    mkdirSync(dirname(local), { recursive: true });
    writeFileSync(local, "ORIGINAL");
    const mf = await seedFile(local, false);
    let called = false;
    const client = {
      downloadStream: async () => {
        called = true;
        return { statusCode: 200, body: Readable.from(["X"]) };
      },
    } as any;
    await ensureDownloaded({ prisma, gate, client, mediaFile: mf });
    expect(readFileSync(local).toString()).toBe("ORIGINAL");
    expect(called).toBe(false);
    const updated = await prisma.mediaFile.findUnique({ where: { id: mf.id } });
    expect(updated?.isDownloaded).toBe(true);
  });
});
