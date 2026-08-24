import { describe, it, expect, vi } from "vitest";
import { aiRunnerTick, type AiRunnerState } from "../../src/ai/runner.js";

function state(over: Partial<AiRunnerState> = {}): AiRunnerState {
  return {
    control: { paused: false, scanning: false, modelLoaded: false, lastProbeAt: null, lastError: null },
    lastProbeMs: 0,
    activeEndpoint: 0,
    ...over,
  };
}

/** Default test wiring: autoload on, ensureLoaded never expected to be called. */
function deps(over: Partial<Parameters<typeof aiRunnerTick>[1]> = {}) {
  return {
    probe: vi.fn().mockResolvedValue("absent"),
    ensureLoaded: vi.fn().mockResolvedValue(false),
    autoloadModel: true,
    scan: vi.fn(),
    endpointCount: 1,
    probeIntervalMs: 300_000,
    now: 1_000_000,
    ...over,
  };
}

describe("aiRunnerTick", () => {
  it("probes when the model is not known to be loaded, and does not scan", async () => {
    const d = deps({ probe: vi.fn().mockResolvedValue("absent") });
    const s = state();
    await aiRunnerTick(s, d);
    expect(d.probe).toHaveBeenCalledOnce();
    expect(d.ensureLoaded).not.toHaveBeenCalled();
    expect(d.scan).not.toHaveBeenCalled();
    expect(s.control.modelLoaded).toBe(false);
  });

  it("scans continuously while the model stays loaded, without re-probing", async () => {
    const probe = vi.fn().mockResolvedValue("loaded");
    const scan = vi.fn().mockResolvedValue({ scanned: 200, weatherScanned: 5, stopped: "batch" });
    const d = deps({ probe, scan });
    const s = state();
    await aiRunnerTick(s, { ...d, now: 1_000_000 });
    expect(s.control.modelLoaded).toBe(true);
    expect(scan).toHaveBeenCalledOnce();

    // next tick, one second later: still loaded, so scan again without probing
    await aiRunnerTick(s, { ...d, now: 1_001_000 });
    expect(probe).toHaveBeenCalledOnce(); // not re-probed
    expect(scan).toHaveBeenCalledTimes(2);

    // third tick, well past the probe interval: still no re-probe while continuously
    // loaded — this is what distinguishes "scan continuously" from "scan on a timer that
    // just hasn't fired yet".
    await aiRunnerTick(s, { ...d, now: 1_400_000 });
    expect(probe).toHaveBeenCalledOnce();
    expect(scan).toHaveBeenCalledTimes(3);
  });

  it("stops scanning and returns to probing when the model disappears mid-batch", async () => {
    const probe = vi.fn().mockResolvedValue("loaded");
    const scan = vi.fn().mockResolvedValue({ scanned: 3, weatherScanned: 0, stopped: "unavailable" });
    const d = deps({ probe, scan });
    const s = state();
    await aiRunnerTick(s, { ...d, now: 1_000_000 });
    expect(s.control.modelLoaded).toBe(false);

    // too soon for another probe -> idle
    await aiRunnerTick(s, { ...d, now: 1_010_000 });
    expect(probe).toHaveBeenCalledOnce();
    expect(scan).toHaveBeenCalledOnce();

    // probe interval elapsed -> probe again
    await aiRunnerTick(s, { ...d, now: 1_400_000 });
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("on a timeout, stops scanning but does NOT push the next probe out", async () => {
    const probe = vi.fn().mockResolvedValue("loaded");
    const scan = vi.fn().mockResolvedValue({ scanned: 0, weatherScanned: 0, stopped: "timeout" });
    const d = deps({ probe, scan });
    const s = state();
    // Model already loaded (as if a prior probe succeeded well before now); lastProbeMs
    // reflects that earlier probe, deliberately far enough in the past that a real probe
    // interval has already elapsed -- the steady-state condition this fix targets.
    s.control.modelLoaded = true;
    s.lastProbeMs = 0;
    await aiRunnerTick(s, { ...d, now: 1_000_000 });
    expect(scan).toHaveBeenCalledOnce();
    expect(s.control.modelLoaded).toBe(false); // batch still aborted, like "unavailable"
    expect(s.lastProbeMs).toBe(0); // NOT advanced to `now` -- contrast with "unavailable" below

    // Next tick: because lastProbeMs was left stale, the probe fires immediately rather
    // than waiting out probeIntervalMs.
    await aiRunnerTick(s, { ...d, now: 1_000_100 });
    expect(probe).toHaveBeenCalledOnce();
  });

  it("contrast: on a genuine outage, the next probe IS pushed out by a full interval", async () => {
    const probe = vi.fn().mockResolvedValue("loaded");
    const scan = vi.fn().mockResolvedValue({ scanned: 0, weatherScanned: 0, stopped: "unavailable" });
    const d = deps({ probe, scan });
    const s = state();
    s.control.modelLoaded = true;
    s.lastProbeMs = 0;
    await aiRunnerTick(s, { ...d, now: 1_000_000 });
    expect(s.control.modelLoaded).toBe(false);
    expect(s.lastProbeMs).toBe(1_000_000); // advanced -- back off from a host that's gone

    // Too soon for another probe.
    await aiRunnerTick(s, { ...d, now: 1_010_000 });
    expect(probe).not.toHaveBeenCalled();
  });

  it("does nothing at all while paused", async () => {
    const probe = vi.fn().mockResolvedValue("loaded");
    const scan = vi.fn();
    const d = deps({ probe, scan });
    const s = state();
    s.control.paused = true;
    await aiRunnerTick(s, { ...d, now: 1_000_000 });
    expect(probe).not.toHaveBeenCalled();
    expect(scan).not.toHaveBeenCalled();
  });

  it("goes back to probing after the backlog is exhausted", async () => {
    const probe = vi.fn().mockResolvedValue("loaded");
    const scan = vi.fn().mockResolvedValue({ scanned: 0, weatherScanned: 0, stopped: "empty" });
    const d = deps({ probe, scan });
    const s = state();
    await aiRunnerTick(s, { ...d, now: 1_000_000 });
    // backlog empty: stay "loaded" but idle until the probe interval elapses again
    await aiRunnerTick(s, { ...d, now: 1_001_000 });
    expect(scan).toHaveBeenCalledOnce();
  });

  it("with autoload on, an \"available\" model is loaded and then scanned", async () => {
    const probe = vi.fn().mockResolvedValue("available");
    const ensureLoaded = vi.fn().mockResolvedValue(true);
    const scan = vi.fn().mockResolvedValue({ scanned: 1, weatherScanned: 0, stopped: "batch" });
    const d = deps({ probe, ensureLoaded, autoloadModel: true, scan });
    const s = state();
    await aiRunnerTick(s, { ...d, now: 1_000_000 });
    expect(probe).toHaveBeenCalledOnce();
    expect(ensureLoaded).toHaveBeenCalledOnce();
    expect(scan).toHaveBeenCalledOnce();
    expect(s.control.modelLoaded).toBe(true);
  });

  it("with autoload off, an \"available\" model is neither loaded nor scanned", async () => {
    const probe = vi.fn().mockResolvedValue("available");
    const ensureLoaded = vi.fn().mockResolvedValue(true);
    const scan = vi.fn();
    const d = deps({ probe, ensureLoaded, autoloadModel: false, scan });
    const s = state();
    await aiRunnerTick(s, { ...d, now: 1_000_000 });
    expect(probe).toHaveBeenCalledOnce();
    expect(ensureLoaded).not.toHaveBeenCalled();
    expect(scan).not.toHaveBeenCalled();
    expect(s.control.modelLoaded).toBe(false);
  });

  it("an \"absent\" model is neither loaded nor scanned, regardless of autoload", async () => {
    const probe = vi.fn().mockResolvedValue("absent");
    const ensureLoaded = vi.fn().mockResolvedValue(true);
    const scan = vi.fn();
    const d = deps({ probe, ensureLoaded, autoloadModel: true, scan });
    const s = state();
    await aiRunnerTick(s, { ...d, now: 1_000_000 });
    expect(probe).toHaveBeenCalledOnce();
    expect(ensureLoaded).not.toHaveBeenCalled();
    expect(scan).not.toHaveBeenCalled();
    expect(s.control.modelLoaded).toBe(false);
  });

  it("when ensureLoaded fails, the model stays unloaded and nothing scans", async () => {
    const probe = vi.fn().mockResolvedValue("available");
    const ensureLoaded = vi.fn().mockResolvedValue(false);
    const scan = vi.fn();
    const d = deps({ probe, ensureLoaded, autoloadModel: true, scan });
    const s = state();
    await aiRunnerTick(s, { ...d, now: 1_000_000 });
    expect(ensureLoaded).toHaveBeenCalledOnce();
    expect(scan).not.toHaveBeenCalled();
    expect(s.control.modelLoaded).toBe(false);
  });
});

/**
 * Multi-endpoint selection. The scenario that matters: the pass falls back to a weaker
 * host, and 172k frames of backlog mean it would otherwise never look up again — the
 * continuous-scan design deliberately skips probing while the model stays loaded.
 */
describe("aiRunnerTick — endpoint selection", () => {
  /** Wiring for N endpoints; probes answers per index. */
  function multi(answers: Array<"loaded" | "available" | "absent">, over: Record<string, unknown> = {}) {
    return {
      probe: vi.fn(async (i: number) => answers[i]),
      ensureLoaded: vi.fn(async () => false),
      endpointCount: answers.length,
      autoloadModel: true,
      scan: vi.fn().mockResolvedValue({ scanned: 200, weatherScanned: 0, stopped: "batch" }),
      probeIntervalMs: 300_000,
      now: 1_000_000,
      ...over,
    };
  }

  it("takes the first loaded endpoint and does not probe the rest", async () => {
    const d = multi(["loaded", "loaded"]);
    const s = state();
    await aiRunnerTick(s, d as never);
    expect(s.activeEndpoint).toBe(0);
    expect(d.probe).toHaveBeenCalledTimes(1); // short-circuits on the first hit
  });

  it("falls through to a lower-priority endpoint when the preferred one is absent", async () => {
    const d = multi(["absent", "loaded"]);
    const s = state();
    await aiRunnerTick(s, d as never);
    expect(s.activeEndpoint).toBe(1);
    expect(s.control.modelLoaded).toBe(true);
  });

  it("autoloads in priority order when nothing is resident anywhere", async () => {
    const d = multi(["available", "available"], {
      ensureLoaded: vi.fn(async (i: number) => i === 1), // the strong host refuses to load
    });
    const s = state();
    await aiRunnerTick(s, d as never);
    expect(d.ensureLoaded).toHaveBeenNthCalledWith(1, 0); // tried the preferred one first
    expect(s.activeEndpoint).toBe(1);
  });

  it("does not spend a probe on upgrades while already on the preferred endpoint", async () => {
    const d = multi(["loaded", "loaded"]);
    const s = state();
    await aiRunnerTick(s, d as never);
    d.probe.mockClear();
    // Well past the probe interval, still scanning happily on index 0.
    await aiRunnerTick(s, { ...d, now: 2_000_000 } as never);
    expect(d.probe).not.toHaveBeenCalled();
    expect(d.scan).toHaveBeenCalledTimes(2);
  });

  it("keeps checking back for the preferred endpoint while running on a weaker one", async () => {
    const answers: Array<"loaded" | "available" | "absent"> = ["absent", "loaded"];
    const d = multi(answers);
    const s = state();
    await aiRunnerTick(s, d as never);
    expect(s.activeEndpoint).toBe(1);

    // Before the interval elapses: no upgrade probe, just scanning.
    d.probe.mockClear();
    await aiRunnerTick(s, { ...d, now: 1_100_000 } as never);
    expect(d.probe).not.toHaveBeenCalled();

    // Past the interval, the strong host is back — the pass must notice and switch even
    // though the model never stopped being "loaded" and the backlog never ran dry.
    answers[0] = "loaded";
    await aiRunnerTick(s, { ...d, now: 1_400_000 } as never);
    expect(s.activeEndpoint).toBe(0);
    expect(d.probe).toHaveBeenCalledWith(0);
  });

  it("never probes below the active endpoint when looking for an upgrade", async () => {
    const d = multi(["absent", "absent", "loaded"]);
    const s = state();
    await aiRunnerTick(s, d as never);
    expect(s.activeEndpoint).toBe(2);

    d.probe.mockClear();
    await aiRunnerTick(s, { ...d, now: 1_400_000 } as never);
    expect(d.probe.mock.calls.map((c) => c[0])).toEqual([0, 1]);
  });

  it("restarts selection from the top of the list after the active endpoint dies", async () => {
    const answers: Array<"loaded" | "available" | "absent"> = ["absent", "loaded"];
    const d = multi(answers, {
      scan: vi.fn().mockResolvedValue({ scanned: 3, weatherScanned: 0, stopped: "unavailable" }),
    });
    const s = state();
    await aiRunnerTick(s, d as never);
    expect(s.activeEndpoint).toBe(1);
    expect(s.control.modelLoaded).toBe(false);

    answers[0] = "loaded";
    d.probe.mockClear();
    await aiRunnerTick(s, { ...d, now: 1_400_000 } as never);
    expect(d.probe).toHaveBeenNthCalledWith(1, 0);
    expect(s.activeEndpoint).toBe(0);
  });
});
