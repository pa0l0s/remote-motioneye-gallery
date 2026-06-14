import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { isZeroByte, isValidImage } from "../../src/media/validate.js";

describe("isZeroByte", () => {
  it("is true for a 0-byte file", () => {
    const dir = mkdtempSync(join(tmpdir(), "validate-"));
    const f = join(dir, "empty.jpg");
    writeFileSync(f, "");
    expect(isZeroByte(f)).toBe(true);
  });

  it("is false for a non-empty file", () => {
    const dir = mkdtempSync(join(tmpdir(), "validate-"));
    const f = join(dir, "data.bin");
    writeFileSync(f, "hello");
    expect(isZeroByte(f)).toBe(false);
  });

  it("is false for a missing file", () => {
    const dir = mkdtempSync(join(tmpdir(), "validate-"));
    expect(isZeroByte(join(dir, "nope.jpg"))).toBe(false);
  });
});

describe("isValidImage", () => {
  it("is true for a real png", async () => {
    const dir = mkdtempSync(join(tmpdir(), "validate-"));
    const f = join(dir, "real.png");
    await sharp({ create: { width: 64, height: 48, channels: 3, background: "blue" } })
      .png()
      .toFile(f);
    expect(await isValidImage(f)).toBe(true);
  });

  it("is false for a 0-byte file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "validate-"));
    const f = join(dir, "empty.png");
    writeFileSync(f, "");
    expect(await isValidImage(f)).toBe(false);
  });

  it("is false for random non-image bytes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "validate-"));
    const f = join(dir, "junk.png");
    writeFileSync(f, Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe, 0x42, 0x13]));
    expect(await isValidImage(f)).toBe(false);
  });

  it("is false for a missing file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "validate-"));
    expect(await isValidImage(join(dir, "missing.png"))).toBe(false);
  });
});
