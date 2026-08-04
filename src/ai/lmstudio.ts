/**
 * Client for a local LM Studio instance (OpenAI-compatible API).
 *
 * The availability probe deliberately uses /api/v0/models rather than /v1/models:
 * with just-in-time loading enabled, /v1/models lists every *downloaded* model, so it
 * cannot tell us whether the model is actually resident on the GPU. /api/v0/models
 * carries a per-model `state` field, which is what the owner's on/off switch is.
 */

import { SEMANTICS_SYSTEM, SEMANTICS_USER, SEMANTICS_SCHEMA, WEATHER_SYSTEM, WEATHER_USER, WEATHER_SCHEMA } from "./prompts.js";

export interface ProbeOptions {
  url: string;
  model: string;
  timeoutMs: number;
}

interface ModelsResponse {
  data?: Array<{ id?: string; state?: string }>;
}

/**
 * True when the configured model is loaded and ready. Never throws: an unreachable
 * host means "the workstation is off", which is a normal state, not an error.
 */
export async function probeModelLoaded(opts: ProbeOptions): Promise<boolean> {
  try {
    const res = await fetch(`${opts.url.replace(/\/+$/, "")}/api/v0/models`, {
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
    if (!res.ok) return false;
    const json = (await res.json()) as ModelsResponse;
    return (json.data ?? []).some((m) => m.id === opts.model && m.state === "loaded");
  } catch {
    return false;
  }
}

export interface AskOptions {
  url: string;
  model: string;
  timeoutMs: number;
}

export interface SemanticResult {
  peopleCount: number;
  animals: string[];
}

/** The model went away (host down, unloaded mid-batch, 5xx). Abort the batch, mark nothing. */
export class ModelUnavailableError extends Error {}
/**
 * The request timed out (AbortSignal.timeout fired) rather than failing outright. The
 * host did not go away — it is busy, most often GPU contention from another process on
 * the owner's workstation. Measured 29-36 s per frame under contention against a 60 s
 * timeout is enough to trip this regularly. Deliberately NOT a subclass of
 * ModelUnavailableError: callers must tell the two apart (see aiRunnerTick), because a
 * timeout must not push out the next probe the way a genuine outage does, and must not
 * be reclassified as a frame failure either -- five slow frames would then give up on a
 * perfectly good one.
 */
export class ModelTimeoutError extends Error {}
/** The model answered but this frame is unusable (4xx, malformed content). Count against the frame. */
export class FrameRejectedError extends Error {}

/** Shared request path for both the semantic and the weather call. */
export async function askJson<T>(
  opts: AskOptions,
  jpeg: Buffer,
  system: string,
  user: string,
  schema: object,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${opts.url.replace(/\/+$/, "")}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(opts.timeoutMs),
      body: JSON.stringify({
        model: opts.model,
        messages: [
          { role: "system", content: system },
          {
            role: "user",
            content: [
              { type: "text", text: user },
              {
                type: "image_url",
                image_url: { url: `data:image/jpeg;base64,${jpeg.toString("base64")}` },
              },
            ],
          },
        ],
        response_format: { type: "json_schema", json_schema: { name: "frame_report", strict: true, schema } },
        temperature: 0,
        max_tokens: 250,
        // Reasoning models otherwise spend the whole token budget thinking and return
        // an empty content field. Models without reasoning ignore this parameter.
        reasoning_effort: "none",
      }),
    });
  } catch (e) {
    const err = e as Error;
    // Node's fetch rejects an AbortSignal.timeout()-triggered abort with a DOMException
    // named "TimeoutError" (a plain user-initiated abort would be "AbortError"); either
    // way it is the request taking too long, not the host being gone.
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      throw new ModelTimeoutError(`timed out after ${opts.timeoutMs}ms: ${err.message}`);
    }
    throw new ModelUnavailableError(`transport: ${err.message}`);
  }

  if (res.status >= 500) throw new ModelUnavailableError(`http ${res.status}`);
  if (!res.ok) throw new FrameRejectedError(`http ${res.status}`);

  try {
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = json.choices?.[0]?.message?.content;
    if (!content) throw new Error("empty content");
    return JSON.parse(content) as T;
  } catch (e) {
    throw new FrameRejectedError(`unusable answer: ${(e as Error).message}`);
  }
}

export async function askSemantics(opts: AskOptions, jpeg: Buffer): Promise<SemanticResult> {
  const raw = await askJson<{ people_count: number; animals: string[] }>(
    opts, jpeg, SEMANTICS_SYSTEM, SEMANTICS_USER, SEMANTICS_SCHEMA,
  );
  return { peopleCount: raw.people_count ?? 0, animals: raw.animals ?? [] };
}

export interface WeatherResult {
  visibility: string;
  precipitation: string;
  snowOnGround: boolean;
}

export async function askWeather(opts: AskOptions, jpeg: Buffer): Promise<WeatherResult> {
  const raw = await askJson<{ visibility: string; precipitation: string; snow_on_ground: boolean }>(
    opts, jpeg, WEATHER_SYSTEM, WEATHER_USER, WEATHER_SCHEMA,
  );
  return {
    visibility: raw.visibility,
    precipitation: raw.precipitation,
    snowOnGround: !!raw.snow_on_ground,
  };
}
