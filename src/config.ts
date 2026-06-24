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
    scoreThreshold: number;
    maxGapSeconds: number;
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
      scoreThreshold: Number(env.ACTIVITY_SCORE_THRESHOLD ?? "0.02"),
      maxGapSeconds: Number(env.ACTIVITY_MAX_GAP_SECONDS ?? "900"),
    },
  };
}
