import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { registerCamerasRoute } from "../../src/routes/cameras.js";

describe("GET /api/cameras", () => {
  it("returns cameras from the client", async () => {
    const app = Fastify();
    await app.register(cookie);
    const fakeClient = {
      listCameras: async () => [{ id: 1, name: "Camera1" }],
    } as any;
    registerCamerasRoute(app, fakeClient);
    const res = await app.inject({ method: "GET", url: "/api/cameras" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([{ id: 1, name: "Camera1" }]);
  });
});
