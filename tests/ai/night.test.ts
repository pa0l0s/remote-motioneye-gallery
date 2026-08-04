import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { isNightFrame } from "../../src/ai/night.js";

const dir = mkdtempSync(join(tmpdir(), "night-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function make(name: string, rgb: { r: number; g: number; b: number }): Promise<string> {
  const p = join(dir, name);
  await sharp({ create: { width: 64, height: 64, channels: 3, background: rgb } }).jpeg().toFile(p);
  return p;
}

describe("isNightFrame", () => {
  it("treats a colourless frame as infrared night", async () => {
    const p = await make("grey.jpg", { r: 90, g: 90, b: 90 });
    await expect(isNightFrame(p, 8)).resolves.toBe(true);
  });

  it("treats a colourful frame as daylight", async () => {
    const p = await make("green.jpg", { r: 40, g: 160, b: 60 });
    await expect(isNightFrame(p, 8)).resolves.toBe(false);
  });
});
