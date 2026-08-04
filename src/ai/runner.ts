import type { PrismaClient } from "@prisma/client";
import sharp from "sharp";
import type { AppConfig } from "../config.js";
import { probeModelLoaded, askSemantics, askWeather, type AskOptions } from "./lmstudio.js";
import { isNightFrame } from "./night.js";
import { runAiScanOnce, type AiScanControl, type AiScanResult } from "./scanner.js";

export interface AiRunnerState {
  control: AiScanControl;
  lastProbeMs: number;
  /** Set when the backlog ran dry, so we idle until the next probe instead of hot-looping. */
  backlogEmpty?: boolean;
}

export interface TickDeps {
  probe: () => Promise<boolean>;
  scan: () => Promise<AiScanResult>;
  probeIntervalMs: number;
  now: number;
}

/**
 * One turn of the extended pass.
 *
 * While the model is loaded we scan continuously rather than on a fixed interval: the
 * owner loaded it precisely to hand the GPU over, so idling would waste that window. The
 * 5-minute probe interval governs only the "model absent" state, which is the normal
 * condition whenever the workstation is off.
 */
export async function aiRunnerTick(state: AiRunnerState, deps: TickDeps): Promise<void> {
  if (state.control.paused) return;

  const dueForProbe = deps.now - state.lastProbeMs >= deps.probeIntervalMs;

  if (!state.control.modelLoaded || state.backlogEmpty) {
    if (!dueForProbe) return;
    state.lastProbeMs = deps.now;
    state.control.lastProbeAt = new Date(deps.now);
    state.control.modelLoaded = await deps.probe();
    state.backlogEmpty = false;
    if (!state.control.modelLoaded) return;
  }

  state.control.scanning = true;
  try {
    const res = await deps.scan();
    if (res.stopped === "unavailable") {
      state.control.modelLoaded = false;
      state.lastProbeMs = deps.now; // do not hammer a host that just went away
    } else if (res.stopped === "empty") {
      state.backlogEmpty = true;
      state.lastProbeMs = deps.now;
    }
  } finally {
    state.control.scanning = false;
  }
}

/** Wires the tick into a timer and returns the shared control plus a stop handle. */
export function startAiRunner(args: {
  prisma: PrismaClient;
  cfg: AppConfig;
  log: (msg: string, err?: unknown) => void;
}): { control: AiScanControl; stop: () => void } {
  const { prisma, cfg, log } = args;
  const control: AiScanControl = {
    paused: false, scanning: false, modelLoaded: false, lastProbeAt: null, lastError: null,
  };
  const state: AiRunnerState = { control, lastProbeMs: -Infinity };

  const ask: AskOptions = {
    url: cfg.ai.lmStudioUrl,
    model: cfg.ai.model,
    timeoutMs: cfg.ai.requestTimeoutMs,
  };

  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  async function loop(): Promise<void> {
    if (stopped) return;
    try {
      await aiRunnerTick(state, {
        probe: () => probeModelLoaded({ ...ask, timeoutMs: 5000 }),
        scan: () =>
          runAiScanOnce({
            prisma,
            control,
            opts: {
              model: cfg.ai.model,
              promptVersion: cfg.ai.promptVersion,
              weatherPromptVersion: cfg.ai.weatherPromptVersion,
              imageWidth: cfg.ai.imageWidth,
              weatherMinGapSeconds: cfg.ai.weatherMinGapSeconds,
              batch: cfg.ai.batch,
              colorThreshold: cfg.activity.colorThreshold,
              maxFailures: cfg.ai.maxFailures,
            },
            deps: {
              loadJpeg: (path, width) =>
                sharp(path).resize({ width, withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer(),
              isNight: (path, threshold) => isNightFrame(path, threshold),
              askSemantics: (jpeg) => askSemantics(ask, jpeg),
              askWeather: (jpeg) => askWeather(ask, jpeg),
            },
          }),
        probeIntervalMs: cfg.ai.probeIntervalSeconds * 1000,
        now: Date.now(),
      });
    } catch (e) {
      control.lastError = (e as Error).message;
      log("ai runner tick failed", e);
    }
    // Short cadence: the tick itself decides whether to probe, scan or idle.
    timer = setTimeout(() => void loop(), 5000);
  }

  void loop();

  return {
    control,
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
