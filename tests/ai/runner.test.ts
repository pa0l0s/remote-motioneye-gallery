import { describe, it, expect, vi } from "vitest";
import { aiRunnerTick, type AiRunnerState } from "../../src/ai/runner.js";

function state(over: Partial<AiRunnerState> = {}): AiRunnerState {
  return {
    control: { paused: false, scanning: false, modelLoaded: false, lastProbeAt: null, lastError: null },
    lastProbeMs: 0,
    ...over,
  };
}

describe("aiRunnerTick", () => {
  it("probes when the model is not known to be loaded, and does not scan", async () => {
    const probe = vi.fn().mockResolvedValue(false);
    const scan = vi.fn();
    const s = state();
    await aiRunnerTick(s, { probe, scan, probeIntervalMs: 300_000, now: 1_000_000 });
    expect(probe).toHaveBeenCalledOnce();
    expect(scan).not.toHaveBeenCalled();
    expect(s.control.modelLoaded).toBe(false);
  });

  it("scans continuously while the model stays loaded, without re-probing", async () => {
    const probe = vi.fn().mockResolvedValue(true);
    const scan = vi.fn().mockResolvedValue({ scanned: 200, weatherScanned: 5, stopped: "batch" });
    const s = state();
    await aiRunnerTick(s, { probe, scan, probeIntervalMs: 300_000, now: 1_000_000 });
    expect(s.control.modelLoaded).toBe(true);
    expect(scan).toHaveBeenCalledOnce();

    // next tick, one second later: still loaded, so scan again without probing
    await aiRunnerTick(s, { probe, scan, probeIntervalMs: 300_000, now: 1_001_000 });
    expect(probe).toHaveBeenCalledOnce(); // not re-probed
    expect(scan).toHaveBeenCalledTimes(2);

    // third tick, well past the probe interval: still no re-probe while continuously
    // loaded — this is what distinguishes "scan continuously" from "scan on a timer that
    // just hasn't fired yet".
    await aiRunnerTick(s, { probe, scan, probeIntervalMs: 300_000, now: 1_400_000 });
    expect(probe).toHaveBeenCalledOnce();
    expect(scan).toHaveBeenCalledTimes(3);
  });

  it("stops scanning and returns to probing when the model disappears mid-batch", async () => {
    const probe = vi.fn().mockResolvedValue(true);
    const scan = vi.fn().mockResolvedValue({ scanned: 3, weatherScanned: 0, stopped: "unavailable" });
    const s = state();
    await aiRunnerTick(s, { probe, scan, probeIntervalMs: 300_000, now: 1_000_000 });
    expect(s.control.modelLoaded).toBe(false);

    // too soon for another probe -> idle
    await aiRunnerTick(s, { probe, scan, probeIntervalMs: 300_000, now: 1_010_000 });
    expect(probe).toHaveBeenCalledOnce();
    expect(scan).toHaveBeenCalledOnce();

    // probe interval elapsed -> probe again
    await aiRunnerTick(s, { probe, scan, probeIntervalMs: 300_000, now: 1_400_000 });
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("on a timeout, stops scanning but does NOT push the next probe out", async () => {
    const probe = vi.fn().mockResolvedValue(true);
    const scan = vi.fn().mockResolvedValue({ scanned: 0, weatherScanned: 0, stopped: "timeout" });
    const s = state();
    // Model already loaded (as if a prior probe succeeded well before now); lastProbeMs
    // reflects that earlier probe, deliberately far enough in the past that a real probe
    // interval has already elapsed -- the steady-state condition this fix targets.
    s.control.modelLoaded = true;
    s.lastProbeMs = 0;
    await aiRunnerTick(s, { probe, scan, probeIntervalMs: 300_000, now: 1_000_000 });
    expect(scan).toHaveBeenCalledOnce();
    expect(s.control.modelLoaded).toBe(false); // batch still aborted, like "unavailable"
    expect(s.lastProbeMs).toBe(0); // NOT advanced to `now` -- contrast with "unavailable" below

    // Next tick: because lastProbeMs was left stale, the probe fires immediately rather
    // than waiting out probeIntervalMs.
    await aiRunnerTick(s, { probe, scan, probeIntervalMs: 300_000, now: 1_000_100 });
    expect(probe).toHaveBeenCalledOnce();
  });

  it("contrast: on a genuine outage, the next probe IS pushed out by a full interval", async () => {
    const probe = vi.fn().mockResolvedValue(true);
    const scan = vi.fn().mockResolvedValue({ scanned: 0, weatherScanned: 0, stopped: "unavailable" });
    const s = state();
    s.control.modelLoaded = true;
    s.lastProbeMs = 0;
    await aiRunnerTick(s, { probe, scan, probeIntervalMs: 300_000, now: 1_000_000 });
    expect(s.control.modelLoaded).toBe(false);
    expect(s.lastProbeMs).toBe(1_000_000); // advanced -- back off from a host that's gone

    // Too soon for another probe.
    await aiRunnerTick(s, { probe, scan, probeIntervalMs: 300_000, now: 1_010_000 });
    expect(probe).not.toHaveBeenCalled();
  });

  it("does nothing at all while paused", async () => {
    const probe = vi.fn().mockResolvedValue(true);
    const scan = vi.fn();
    const s = state();
    s.control.paused = true;
    await aiRunnerTick(s, { probe, scan, probeIntervalMs: 300_000, now: 1_000_000 });
    expect(probe).not.toHaveBeenCalled();
    expect(scan).not.toHaveBeenCalled();
  });

  it("goes back to probing after the backlog is exhausted", async () => {
    const probe = vi.fn().mockResolvedValue(true);
    const scan = vi.fn().mockResolvedValue({ scanned: 0, weatherScanned: 0, stopped: "empty" });
    const s = state();
    await aiRunnerTick(s, { probe, scan, probeIntervalMs: 300_000, now: 1_000_000 });
    // backlog empty: stay "loaded" but idle until the probe interval elapses again
    await aiRunnerTick(s, { probe, scan, probeIntervalMs: 300_000, now: 1_001_000 });
    expect(scan).toHaveBeenCalledOnce();
  });
});
