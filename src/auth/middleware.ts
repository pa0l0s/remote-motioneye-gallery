import type { FastifyInstance } from "fastify";
import { verifyTimedToken } from "./itsdangerous.js";

export interface AuthOptions {
  authEnabled: boolean;
  secret: string;
  maxAgeSeconds: number;
  loginUrl: string;
}

export function registerAuth(app: FastifyInstance, opts: AuthOptions): void {
  app.addHook("preHandler", async (req, reply) => {
    if (!opts.authEnabled) return;
    if (req.url === "/health") return;

    const token = req.cookies?.admin_session;
    const result = token
      ? verifyTimedToken(token, opts.secret, opts.maxAgeSeconds)
      : { valid: false };

    if (result.valid && result.payload === "admin") return;

    if (req.url.startsWith("/api/")) {
      reply.code(401).send({ error: "Not authenticated" });
    } else {
      reply.redirect(opts.loginUrl);
    }
  });
}
