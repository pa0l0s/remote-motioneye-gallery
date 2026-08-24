import type { PrismaClient } from "@prisma/client";
import sharp from "sharp";
import type { AppConfig } from "../config.js";
import { probeModelAvailable, ensureModelLoaded, askSemantics, askWeather, type AskOptions } from "./lmstudio.js";
import { isNightFrame } from "./night.js";
import { runAiScanOnce, type AiScanControl, type AiScanResult } from "./scanner.js";

export interface AiRunnerState {
  control: AiScanControl;
  lastProbeMs: number;
  /** Set when the backlog ran dry, so we idle until the next probe instead of hot-looping. */
  backlogEmpty?: boolean;
  /** Index into the configured endpoint list currently serving the pass; 0 is preferred. */
  activeEndpoint: number;
}

export interface TickDeps {
  probe: (index: number) => Promise<"loaded" | "available" | "absent">;
  /**
   * Triggers LM Studio's JIT load on one endpoint. Only ever called when that endpoint's
   * probe reported "available" and autoloadModel is on -- "absent" has nothing to load,
   * and "loaded" needs no loading.
   */
  ensureLoaded: (index: number) => Promise<boolean>;
  /** How many endpoints are configured. Index 0 is the preferred one. */
  endpointCount: number;
  /** Called whenever an endpoint is chosen, so the caller can publish which host is live. */
  onEndpointChange?: (index: number) => void;
  /**
   * When false, only "loaded" counts, reproducing the old manual-load-only behaviour:
   * "available" is treated the same as "absent" and the runner just keeps sleeping.
   */
  autoloadModel: boolean;
  scan: () => Promise<AiScanResult>;
  probeIntervalMs: number;
  now: number;
}

/**
 * Walks endpoints [start, end) in priority order and returns the first one that can serve
 * the pass, or null. Short-circuits on the first already-loaded host, so the common case —
 * the preferred host is up — costs exactly one probe no matter how long the list is.
 *
 * Loading is a strictly second pass: a resident model anywhere beats loading one onto a
 * host the owner has not chosen to hand over.
 */
async function selectEndpoint(deps: TickDeps, start: number, end: number): Promise<number | null> {
  const loadable: number[] = [];
  for (let i = start; i < end; i++) {
    const r = await deps.probe(i);
    if (r === "loaded") return i;
    if (r === "available") loadable.push(i);
  }
  if (deps.autoloadModel) {
    for (const i of loadable) {
      if (await deps.ensureLoaded(i)) return i;
    }
  }
  return null;
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
    state.backlogEmpty = false;
    // Always restarts at index 0, never at whichever endpoint just died: an outage is
    // exactly when the preferred host might have come back.
    const picked = await selectEndpoint(deps, 0, deps.endpointCount);
    if (picked === null) {
      state.control.modelLoaded = false;
      return;
    }
    state.activeEndpoint = picked;
    state.control.modelLoaded = true;
    deps.onEndpointChange?.(picked);
    // The model is back: a stale error from a past outage would otherwise pin
    // /api/ai/status to "failed" long after recovery.
    state.control.lastError = null;
  } else if (state.activeEndpoint > 0 && dueForProbe) {
    // Running on a fallback host. Nothing above would ever notice the preferred host
    // returning: while the model stays loaded and the backlog is non-empty the branch
    // above is skipped entirely, and with a six-figure backlog that is effectively
    // forever. So check upwards on the probe cadence, between batches, never mid-batch.
    state.lastProbeMs = deps.now;
    state.control.lastProbeAt = new Date(deps.now);
    const better = await selectEndpoint(deps, 0, state.activeEndpoint);
    if (better !== null) {
      state.activeEndpoint = better;
      deps.onEndpointChange?.(better);
    }
  }

  state.control.scanning = true;
  try {
    const res = await deps.scan();
    if (res.stopped === "unavailable") {
      state.control.modelLoaded = false;
      state.lastProbeMs = deps.now; // do not hammer a host that just went away
    } else if (res.stopped === "timeout") {
      // The host did not go away -- it is busy (GPU contention). Stop scanning for this
      // tick like any other abort, but deliberately do NOT advance lastProbeMs: leaving
      // it stale means the next tick's `dueForProbe` check fires immediately instead of
      // waiting out the full probe interval, so a slow frame degrades throughput for one
      // tick instead of for probeIntervalSeconds.
      state.control.modelLoaded = false;
    } else {
      // A batch (or an empty backlog) that completes without throwing means the model
      // answered fine this tick, so any earlier error no longer describes the present.
      state.control.lastError = null;
      if (res.stopped === "empty") {
        state.backlogEmpty = true;
        state.lastProbeMs = deps.now;
      }
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
    activeUrl: null, activeModel: null,
  };
  const state: AiRunnerState = { control, lastProbeMs: -Infinity, activeEndpoint: 0 };

  const endpoints = cfg.ai.endpoints;
  // Logged rather than left implicit: a typo in AI_ENDPOINTS drops that entry, and the
  // pass would otherwise run quietly against a different host than the operator meant.
  log(
    `ai runner endpoints (priority order): ${endpoints
      .map((e, i) => `${i}=${e.url} [${e.model}]`)
      .join(", ")}`,
  );

  /** Options for whichever endpoint is serving right now — read per call, never frozen
   *  at startup, or a switch would keep talking to the previous host. */
  const askFor = (index: number): AskOptions => ({
    url: endpoints[index].url,
    model: endpoints[index].model,
    timeoutMs: cfg.ai.requestTimeoutMs,
  });

  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  async function loop(): Promise<void> {
    if (stopped) return;
    try {
      await aiRunnerTick(state, {
        probe: (i) => probeModelAvailable({ ...askFor(i), timeoutMs: 5000 }),
        // The JIT load itself (not just the health check) can take several seconds
        // (measured ~8s from unloaded to a 200 response), so this needs a longer
        // timeout than the plain probe above.
        ensureLoaded: (i) =>
          ensureModelLoaded(
            // An explicit load is a cold start, not a health check: measured 7.1 s on the
            // spare host, and slower hardware is exactly where this path is wanted.
            { ...askFor(i), timeoutMs: 300000 },
            cfg.ai.modelTtlSeconds,
            cfg.ai.modelParallel,
          ),
        endpointCount: endpoints.length,
        onEndpointChange: (i) => {
          if (control.activeUrl !== endpoints[i].url) {
            log(`ai runner using endpoint ${i}: ${endpoints[i].url} [${endpoints[i].model}]`);
          }
          control.activeUrl = endpoints[i].url;
          control.activeModel = endpoints[i].model;
        },
        autoloadModel: cfg.ai.autoloadModel,
        scan: () =>
          runAiScanOnce({
            prisma,
            control,
            opts: {
              // The endpoint's model, not the configured default: aiModel is stored per
              // frame, and recording the wrong one would make the quality trail a lie.
              model: endpoints[state.activeEndpoint].model,
              promptVersion: cfg.ai.promptVersion,
              weatherPromptVersion: cfg.ai.weatherPromptVersion,
              imageWidth: cfg.ai.imageWidth,
              weatherMinGapSeconds: cfg.ai.weatherMinGapSeconds,
              batch: cfg.ai.batch,
              colorThreshold: cfg.ai.nightColorThreshold,
              maxFailures: cfg.ai.maxFailures,
            },
            deps: {
              loadJpeg: (path, width) =>
                sharp(path).resize({ width, withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer(),
              isNight: (path, threshold) => isNightFrame(path, threshold),
              askSemantics: (jpeg) => askSemantics(askFor(state.activeEndpoint), jpeg),
              askWeather: (jpeg) => askWeather(askFor(state.activeEndpoint), jpeg),
            },
          }),
        probeIntervalMs: cfg.ai.probeIntervalSeconds * 1000,
        now: Date.now(),
      });
    } catch (e) {
      control.lastError = (e as Error).message;
      log("ai runner tick failed", e);
    }
    // Short cadence: the tick itself decides whether to probe, scan or idle. Guarded by
    // `stopped` so an in-flight tick that finishes just after stop() was called does not
    // schedule one more timer than the caller asked for.
    if (!stopped) timer = setTimeout(() => void loop(), 5000);
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
