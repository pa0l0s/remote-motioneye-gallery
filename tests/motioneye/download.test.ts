import { describe, it, expect } from "vitest";
import { MotionEyeClient } from "../../src/motioneye/client.js";

const client = new MotionEyeClient({
  baseUrl: "http://eye.local:8765",
  username: "admin",
  password: "pw",
  timeoutMs: 1000,
});

describe("fileUrl", () => {
  it("builds a signed download URL for a picture", () => {
    const url = client.fileUrl("picture", 1, "/2026-06-13/16-07-30.jpg");
    expect(url).toContain("/picture/1/download//2026-06-13/16-07-30.jpg");
    expect(url).toMatch(/_signature=[0-9a-f]{40}/);
  });
  it("uses playback for movies", () => {
    const url = client.fileUrl("movie", 1, "/2026-06-13/clip.mp4");
    expect(url).toContain("/movie/1/playback//2026-06-13/clip.mp4");
  });
});
