/**
 * Client for a local LM Studio instance (OpenAI-compatible API).
 *
 * The availability probe deliberately uses /api/v0/models rather than /v1/models:
 * with just-in-time loading enabled, /v1/models lists every *downloaded* model, so it
 * cannot tell us whether the model is actually resident on the GPU. /api/v0/models
 * carries a per-model `state` field, which is what the owner's on/off switch is.
 */

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
