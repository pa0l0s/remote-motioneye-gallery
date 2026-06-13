import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { generateImageThumb } from "../../src/media/thumbnails.js";

describe("generateImageThumb", () => {
  it("writes a resized webp thumbnail", async () => {
    const dir = mkdtempSync(join(tmpdir(), "thumb-"));
    const src = join(dir, "src.png");
    const out = join(dir, "out/thumb.webp");
    await sharp({ create: { width: 800, height: 600, channels: 3, background: "red" } })
      .png()
      .toFile(src);
    await generateImageThumb(src, out, 320);
    expect(existsSync(out)).toBe(true);
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.width).toBe(320);
  });
});
