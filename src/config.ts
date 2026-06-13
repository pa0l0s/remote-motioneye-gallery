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
  };
}
