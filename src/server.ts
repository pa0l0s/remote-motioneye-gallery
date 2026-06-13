import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { loadConfig } from "./config.js";
import { logger } from "./logger.js";
import { MotionEyeClient } from "./motioneye/client.js";
import { registerAuth } from "./auth/middleware.js";
import { registerCamerasRoute } from "./routes/cameras.js";

export async function buildApp() {
  const cfg = loadConfig();
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
  await app.register(cookie);

  const client = new MotionEyeClient({
    baseUrl: cfg.motionEyeUrl,
    username: cfg.motionEyeUser,
    password: cfg.motionEyePassword,
    timeoutMs: cfg.requestTimeoutMs,
  });

  registerAuth(app, {
    authEnabled: cfg.authEnabled,
    secret: cfg.secretKey,
    maxAgeSeconds: 30 * 24 * 3600,
    loginUrl: cfg.kuklePowerLoginUrl,
  });

  app.get("/health", async () => ({ status: "ok" }));
  registerCamerasRoute(app, client);

  return app;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  buildApp()
    .then((app) => app.listen({ host: "0.0.0.0", port: Number(process.env.PORT ?? 8762) }))
    .catch((err) => {
      logger.error(err);
      process.exit(1);
    });
}
