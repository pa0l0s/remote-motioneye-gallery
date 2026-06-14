import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { generateImageThumb, ensureThumb } from "../../src/media/thumbnails.js";

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

describe("ensureThumb self-healing", () => {
  it("refetches a corrupt source then generates the thumbnail", async () => {
    const dir = mkdtempSync(join(tmpdir(), "thumb-"));
    const src = join(dir, "src.png");
    const out = join(dir, "out/thumb.webp");
    // Corrupt source: random non-image bytes.
    writeFileSync(src, Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff]));

    let refetchCalls = 0;
    const refetch = async () => {
      refetchCalls++;
      await sharp({ create: { width: 400, height: 300, channels: 3, background: "green" } })
        .png()
        .toFile(src);
      return src;
    };

    await ensureThumb(src, out, "image", 320, refetch);
    expect(refetchCalls).toBe(1);
    expect(existsSync(out)).toBe(true);
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.width).toBe(320);
  });

  it("does not refetch when the source is already valid", async () => {
    const dir = mkdtempSync(join(tmpdir(), "thumb-"));
    const src = join(dir, "src.png");
    const out = join(dir, "out/thumb.webp");
    await sharp({ create: { width: 800, height: 600, channels: 3, background: "red" } })
      .png()
      .toFile(src);
    let refetchCalls = 0;
    await ensureThumb(src, out, "image", 320, async () => {
      refetchCalls++;
      return src;
    });
    expect(refetchCalls).toBe(0);
    expect(existsSync(out)).toBe(true);
  });
});
