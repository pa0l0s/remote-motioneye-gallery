import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { scoreBuffers, frameActivityScore, DEFAULT_DIFF } from "../../src/activity/diff.js";

describe("scoreBuffers", () => {
  it("scores identical frames as 0", () => {
    const a = Buffer.alloc(100, 120);
    const b = Buffer.alloc(100, 120);
    expect(scoreBuffers(a, b, DEFAULT_DIFF)).toBe(0);
  });

  it("ignores a uniform brightness shift (sunset/dawn/dusk)", () => {
    const a = Buffer.alloc(100, 80);
    const b = Buffer.alloc(100, 160); // entire frame got brighter, but uniformly
    expect(scoreBuffers(a, b, DEFAULT_DIFF)).toBe(0);
  });

  it("flags a localized change", () => {
    const a = Buffer.alloc(100, 100);
    const b = Buffer.alloc(100, 100);
    for (let i = 0; i < 30; i++) b[i] = 255; // something bright appears in part of the frame
    expect(scoreBuffers(a, b, DEFAULT_DIFF)).toBeGreaterThan(0.2);
  });
});

describe("frameActivityScore (real images via sharp)", () => {
  const dir = mkdtempSync(join(tmpdir(), "act-diff-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const gray = (path: string) =>
    sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 90, g: 90, b: 90 } } })
      .png()
      .toFile(path);

  it("is 0 for the same image and >0 when an object appears", async () => {
    const base = join(dir, "a.png");
    const withObj = join(dir, "b.png");
    await gray(base);
    await sharp({
      create: { width: 64, height: 64, channels: 3, background: { r: 90, g: 90, b: 90 } },
    })
      .composite([
        {
          input: {
            create: { width: 18, height: 18, channels: 3, background: { r: 255, g: 255, b: 255 } },
          },
          top: 10,
          left: 10,
        },
      ])
      .png()
      .toFile(withObj);

    expect(await frameActivityScore(base, base)).toBe(0);
    expect(await frameActivityScore(base, withObj)).toBeGreaterThan(0);
  });
});
