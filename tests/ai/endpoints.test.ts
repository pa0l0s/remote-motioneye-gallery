import { describe, it, expect } from "vitest";
import { parseAiEndpoints } from "../../src/ai/endpoints.js";

const FALLBACK = { url: "http://legacy:1234", model: "legacy-model" };

describe("parseAiEndpoints", () => {
  it("falls back to the single legacy endpoint when the list is unset or blank", () => {
    // Keeps every existing deploy.local.env working untouched.
    expect(parseAiEndpoints(undefined, FALLBACK)).toEqual([FALLBACK]);
    expect(parseAiEndpoints("", FALLBACK)).toEqual([FALLBACK]);
    expect(parseAiEndpoints("   ", FALLBACK)).toEqual([FALLBACK]);
  });

  it("parses url|model pairs in priority order", () => {
    expect(
      parseAiEndpoints("http://a:1234|model-a,http://b:1234|model-b", FALLBACK),
    ).toEqual([
      { url: "http://a:1234", model: "model-a" },
      { url: "http://b:1234", model: "model-b" },
    ]);
  });

  it("tolerates whitespace and trailing separators", () => {
    expect(parseAiEndpoints("  http://a:1234 | model-a , , http://b:1234|model-b ,", FALLBACK)).toEqual([
      { url: "http://a:1234", model: "model-a" },
      { url: "http://b:1234", model: "model-b" },
    ]);
  });

  it("strips a trailing slash so the URL joins cleanly", () => {
    expect(parseAiEndpoints("http://a:1234/|model-a", FALLBACK)).toEqual([
      { url: "http://a:1234", model: "model-a" },
    ]);
  });

  it("drops entries missing a model or a url rather than producing a half-built endpoint", () => {
    // An endpoint without a model cannot be probed: each host here runs a different one.
    expect(parseAiEndpoints("http://a:1234,http://b:1234|model-b", FALLBACK)).toEqual([
      { url: "http://b:1234", model: "model-b" },
    ]);
    expect(parseAiEndpoints("http://a:1234|,|model-b,http://c:1234|model-c", FALLBACK)).toEqual([
      { url: "http://c:1234", model: "model-c" },
    ]);
  });

  it("falls back rather than leaving the pass with nothing when every entry is malformed", () => {
    // Silently ending up with an empty list would disable the extended pass with no
    // signal at all — the failure mode this project has already been bitten by.
    expect(parseAiEndpoints("garbage,also-garbage", FALLBACK)).toEqual([FALLBACK]);
  });
});
