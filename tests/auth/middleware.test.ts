import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { registerAuth } from "../../src/auth/middleware.js";

async function buildTestApp(authEnabled: boolean, secret: string) {
  const app = Fastify();
  await app.register(cookie);
  registerAuth(app, { authEnabled, secret, maxAgeSeconds: 1000, loginUrl: "/login" });
  app.get("/api/secret", async () => ({ ok: true }));
  return app;
}

describe("registerAuth", () => {
  it("allows all when auth disabled", async () => {
    const app = await buildTestApp(false, "s");
    const res = await app.inject({ method: "GET", url: "/api/secret" });
    expect(res.statusCode).toBe(200);
  });

  it("401s an unauthenticated API request", async () => {
    const app = await buildTestApp(true, "s");
    const res = await app.inject({ method: "GET", url: "/api/secret" });
    expect(res.statusCode).toBe(401);
  });
});
