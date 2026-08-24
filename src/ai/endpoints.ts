/**
 * The extended pass can be served by more than one LM Studio host. Each host runs its own
 * model — a fast workstation with an 8B vision model, a weaker spare with a smaller one —
 * so an endpoint is a (url, model) PAIR. A bare list of URLs would not be enough to probe
 * or call them.
 *
 * Order is priority: index 0 is preferred, and the runner keeps checking back for it while
 * running on anything further down the list.
 */

export interface AiEndpoint {
  url: string;
  model: string;
}

/**
 * Parses `AI_ENDPOINTS` — comma-separated `url|model` pairs:
 *
 *   http://192.168.0.11:1234|qwen/qwen3-vl-8b,http://192.168.0.63:1234|qwen2.5-vl-3b-instruct
 *
 * Parsing is lenient: a malformed entry is dropped rather than taking down a gallery whose
 * basic pass is perfectly healthy. It never returns an empty list, because "no endpoints"
 * disables the extended pass with no visible signal — the exact silent-inertness this
 * project has been bitten by before. When nothing usable is configured it returns the
 * legacy single endpoint, and the runner logs the resolved list at startup so a typo
 * surfaces as "not the hosts I expected" rather than as silence.
 */
export function parseAiEndpoints(spec: string | undefined, fallback: AiEndpoint): AiEndpoint[] {
  const parsed = (spec ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [rawUrl = "", rawModel = ""] = entry.split("|");
      // Trailing slashes are stripped here rather than at every call site: lmstudio.ts
      // appends absolute paths like /api/v0/models.
      const url = rawUrl.trim().replace(/\/+$/, "");
      const model = rawModel.trim();
      return { url, model };
    })
    .filter((e) => e.url !== "" && e.model !== "");

  return parsed.length ? parsed : [fallback];
}
