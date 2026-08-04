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
      imageWidth: Number(env.AI_IMAGE_WIDTH ?? "1024"),
      promptVersion: env.AI_PROMPT_VERSION ?? "semantics-v1",
      weatherPromptVersion: env.AI_WEATHER_PROMPT_VERSION ?? "weather-v1",
      weatherMinGapSeconds: Number(env.AI_WEATHER_MIN_GAP_SECONDS ?? "600"),
      batch: Number(env.AI_BATCH ?? "200"),
      requestTimeoutMs: Number(env.AI_REQUEST_TIMEOUT_MS ?? "60000"),
      maxFailures: Number(env.AI_MAX_FAILURES ?? "5"),
    },
  };
}
