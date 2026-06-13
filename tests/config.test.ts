import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("reads required values from the environment", () => {
    const cfg = loadConfig({
      MOTIONEYE_URL: "http://eye.local:8765",
      MOTIONEYE_USER: "admin",
      MOTIONEYE_PASSWORD: "pw",
      SECRET_KEY: "shhh",
    });
    expect(cfg.motionEyeUrl).toBe("http://eye.local:8765");
    expect(cfg.authEnabled).toBe(true); // default
  });

  it("throws when a required value is missing", () => {
    expect(() => loadConfig({})).toThrow(/MOTIONEYE_URL/);
  });

  it("parses AUTH_ENABLED=false", () => {
    const cfg = loadConfig({
      MOTIONEYE_URL: "x",
      MOTIONEYE_USER: "u",
      MOTIONEYE_PASSWORD: "p",
      SECRET_KEY: "s",
      AUTH_ENABLED: "false",
    });
    expect(cfg.authEnabled).toBe(false);
  });
});
