export interface AppConfig {
  motionEyeUrl: string;
  motionEyeUser: string;
  motionEyePassword: string;
  secretKey: string;
  authEnabled: boolean;
  kuklePowerLoginUrl: string;
  configDir: string;
  mediaRoot: string;
  indexIntervalSeconds: number;
  requestTimeoutMs: number;
  maxRetries: number;
  activity: {
    enabled: boolean;
    intervalSeconds: number;
    batch: number;
    downscale: number;
    pixelThreshold: number;
    colorThreshold: number;
    scoreThreshold: number;
    maxGapSeconds: number;
  };
  /** Extended pass — optional, driven by a vision model in LM Studio. */
  ai: {
    enabled: boolean;
    lmStudioUrl: string;
    model: string;
    probeIntervalSeconds: number;
    imageWidth: number;
    promptVersion: string;
    weatherPromptVersion: string;
    weatherMinGapSeconds: number;
    batch: number;
    requestTimeoutMs: number;
    maxFailures: number;
    /**
     * Own night/IR gate for loop B, separate from activity.colorThreshold. Retuning loop
     * A's motion-detection sensitivity must never silently change which frames loop B
     * calls "night" (and therefore weather-scans, and matches the `night` filter) — the
     * two passes are independent products and this is the one place a loop-A action used
     * to leak into loop-B output.
     */
    nightColorThreshold: number;
    /**
     * When true (default), the gallery itself triggers LM Studio's just-in-time load for
     * the configured model whenever it is reachable and listed but not yet resident —
     * the owner no longer has to load it by hand. When false, the old behaviour is still
     * reachable: only an already-loaded model counts.
     */
    autoloadModel: boolean;
    /**
     * TTL (seconds) attached to the request that triggers the JIT load, so LM Studio
     * evicts the model and frees the GPU once the backfill goes idle rather than holding
     * it resident forever. Only takes effect on the load-triggering request.
     */
    modelTtlSeconds: number;
  };
}

function required(env: Record<string, string | undefined>, key: string): string {
  const v = env[key];
  if (!v) throw new Error(`Missing required env var: ${key}`);
  return v;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  return {
    motionEyeUrl: required(env, "MOTIONEYE_URL"),
    motionEyeUser: required(env, "MOTIONEYE_USER"),
    motionEyePassword: required(env, "MOTIONEYE_PASSWORD"),
    secretKey: required(env, "SECRET_KEY"),
    authEnabled: (env.AUTH_ENABLED ?? "true") !== "false",
    kuklePowerLoginUrl: env.KUKLE_POWER_LOGIN_URL ?? "/",
    configDir: env.CONFIG_DIR ?? "./data",
    mediaRoot: env.MEDIA_ROOT ?? "./media",
    indexIntervalSeconds: Number(env.INDEX_INTERVAL_SECONDS ?? "900"),
    requestTimeoutMs: Number(env.REQUEST_TIMEOUT_MS ?? "30000"),
    maxRetries: Number(env.MAX_RETRIES ?? "5"),
    activity: {
      enabled: (env.ACTIVITY_DETECTION_ENABLED ?? "true") !== "false",
      intervalSeconds: Number(env.ACTIVITY_SCAN_INTERVAL_SECONDS ?? "120"),
      batch: Number(env.ACTIVITY_SCAN_BATCH ?? "500"),
      downscale: Number(env.ACTIVITY_DOWNSCALE ?? "64"),
      pixelThreshold: Number(env.ACTIVITY_PIXEL_THRESHOLD ?? "25"),
      colorThreshold: Number(env.ACTIVITY_COLOR_THRESHOLD ?? "8"),
      scoreThreshold: Number(env.ACTIVITY_SCORE_THRESHOLD ?? "0.04"),
      maxGapSeconds: Number(env.ACTIVITY_MAX_GAP_SECONDS ?? "900"),
    },
    ai: {
      // Off by default: the extended pass is opt-in, the gallery is complete without it.
      enabled: env.AI_TAGGING_ENABLED === "true",
      lmStudioUrl: env.AI_LMSTUDIO_URL ?? "http://192.168.0.11:1234",
      model: env.AI_MODEL ?? "qwen/qwen3-vl-8b",
      probeIntervalSeconds: Number(env.AI_PROBE_INTERVAL_SECONDS ?? "300"),
      // Do not raise this without measuring. Sustained 1440px traffic made LM Studio
      // return HTTP 400 and then die mid-run, twice, where 1024 ran dozens of calls
      // clean — suspected VRAM pressure (the model had been loaded with a 262144
      // context). Warm latency at 1440 was otherwise identical (2082 vs 2078 ms).
      //
      // A caution about attributing detection quality to this number: the small dawn
      // spider in 2026-05-24/05-30-00 read as "bird" 3/3 at 1024 and "spider" at 1440
      // and 1920, which looked like a clean resolution effect. After LM Studio was
      // restarted and the model reloaded, the same frame at 1024 answered "spider" 5/5.
      // Answers are repeatable within one model-load session but not necessarily across
      // reloads, so measure inside the session you care about.
      imageWidth: Number(env.AI_IMAGE_WIDTH ?? "1024"),
      promptVersion: env.AI_PROMPT_VERSION ?? "semantics-v2",
      weatherPromptVersion: env.AI_WEATHER_PROMPT_VERSION ?? "weather-v1",
      weatherMinGapSeconds: Number(env.AI_WEATHER_MIN_GAP_SECONDS ?? "600"),
      batch: Number(env.AI_BATCH ?? "200"),
      requestTimeoutMs: Number(env.AI_REQUEST_TIMEOUT_MS ?? "120000"),
      maxFailures: Number(env.AI_MAX_FAILURES ?? "5"),
      nightColorThreshold: Number(env.AI_NIGHT_COLOR_THRESHOLD ?? "8"),
      autoloadModel: (env.AI_AUTOLOAD_MODEL ?? "true") !== "false",
      modelTtlSeconds: Number(env.AI_MODEL_TTL_SECONDS ?? "1800"),
    },
  };
}
