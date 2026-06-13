import type { FastifyInstance } from "fastify";
import type { MotionEyeClient } from "../motioneye/client.js";

export function registerCamerasRoute(app: FastifyInstance, client: MotionEyeClient): void {
  app.get("/api/cameras", async () => {
    return client.listCameras();
  });
}
