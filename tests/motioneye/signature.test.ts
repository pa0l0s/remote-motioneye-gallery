import { describe, it, expect } from "vitest";
import { sha1Hex, computeSignature } from "../../src/motioneye/signature.js";

describe("motionEye signature", () => {
  it("derives the key as sha1(password) hex", () => {
    expect(sha1Hex("pw")).toBe("1a91d62f7ca67399625a4368a6ab5d4a3baa6073");
  });

  it("matches the live-server reference signature for /config/list", () => {
    const key = sha1Hex("pw");
    const sig = computeSignature("GET", "/config/list?_username=admin", "", key);
    expect(sig).toBe("870e1a7823970553d92522a7d95d2d3cf81c8c24");
  });

  it("matches the reference signature for a dated picture listing", () => {
    const key = sha1Hex("pw");
    const sig = computeSignature(
      "GET",
      "/picture/1/list?_username=admin&prefix=2026-06-13&with_stat=true",
      "",
      key,
    );
    expect(sig).toBe("bae24e33e84e86556ba52b7ab7011a745c01f59a");
  });
});
