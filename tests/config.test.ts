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

describe("loadConfig — extended pass", () => {
  const base = { MOTIONEYE_URL: "x", MOTIONEYE_USER: "u", MOTIONEYE_PASSWORD: "p", SECRET_KEY: "s" };

  it("keeps the extended pass off by default", () => {
    const cfg = loadConfig(base);
    expect(cfg.ai.enabled).toBe(false);
    expect(cfg.ai.probeIntervalSeconds).toBe(300);
    expect(cfg.ai.imageWidth).toBe(1024);
    expect(cfg.ai.weatherMinGapSeconds).toBe(600);
    expect(cfg.ai.model).toBe("qwen/qwen3-vl-8b");
    // 60s sat inside the 29-36s contended-GPU range measured on the owner's workstation,
    // tripping the timeout on an ordinary frame.
    expect(cfg.ai.requestTimeoutMs).toBe(120000);
    // Loop B's own night gate — must default independently of ACTIVITY_COLOR_THRESHOLD.
    expect(cfg.ai.nightColorThreshold).toBe(8);
    // Autoload defaults on: the gallery loads the model itself unless told not to.
    expect(cfg.ai.autoloadModel).toBe(true);
    expect(cfg.ai.modelTtlSeconds).toBe(1800);
  });

  it("parses AI_AUTOLOAD_MODEL=false and a custom AI_MODEL_TTL_SECONDS", () => {
    const cfg = loadConfig({ ...base, AI_AUTOLOAD_MODEL: "false", AI_MODEL_TTL_SECONDS: "600" });
    expect(cfg.ai.autoloadModel).toBe(false);
    expect(cfg.ai.modelTtlSeconds).toBe(600);
  });

  it("reads AI_NIGHT_COLOR_THRESHOLD independently of ACTIVITY_COLOR_THRESHOLD", () => {
    const cfg = loadConfig({ ...base, AI_NIGHT_COLOR_THRESHOLD: "12", ACTIVITY_COLOR_THRESHOLD: "3" });
    expect(cfg.ai.nightColorThreshold).toBe(12);
    expect(cfg.activity.colorThreshold).toBe(3);
  });

  it("enables it only on an explicit true", () => {
    expect(loadConfig({ ...base, AI_TAGGING_ENABLED: "true" }).ai.enabled).toBe(true);
    expect(loadConfig({ ...base, AI_TAGGING_ENABLED: "yes" }).ai.enabled).toBe(false);
  });

  it("does not touch the basic pass defaults", () => {
    const cfg = loadConfig({ ...base, AI_TAGGING_ENABLED: "true" });
    expect(cfg.activity.enabled).toBe(true);
    expect(cfg.activity.scoreThreshold).toBe(0.04);
  });
});
