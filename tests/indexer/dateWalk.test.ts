import { describe, it, expect } from "vitest";
import { datesBackFrom } from "../../src/indexer/dateWalk.js";

describe("datesBackFrom", () => {
  it("yields dates newest-first", () => {
    const got = [...datesBackFrom("2026-06-13", 3)];
    expect(got).toEqual(["2026-06-13", "2026-06-12", "2026-06-11"]);
  });
  it("stops at the floor date inclusive", () => {
    const got = [...datesBackFrom("2026-06-13", 100, "2026-06-11")];
    expect(got).toEqual(["2026-06-13", "2026-06-12", "2026-06-11"]);
  });
});
