import { describe, it, expect } from "vitest";
import { parseSizeStr } from "../../src/util/size.js";

describe("parseSizeStr", () => {
  it("parses kB/MB/GB to bytes (SI, 1000-based to match motionEye)", () => {
    expect(parseSizeStr("606.2 kB")).toBe(606200);
    expect(parseSizeStr("1.5 MB")).toBe(1500000);
    expect(parseSizeStr("2 GB")).toBe(2000000000);
    expect(parseSizeStr("512 B")).toBe(512);
  });
  it("returns null for unparseable input", () => {
    expect(parseSizeStr("")).toBeNull();
    expect(parseSizeStr("n/a")).toBeNull();
  });
});
