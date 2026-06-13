import { describe, it, expect } from "vitest";
import { MotionEyeClient } from "../../src/motioneye/client.js";

const client = new MotionEyeClient({
  baseUrl: "http://eye.local:8765",
  username: "admin",
  password: "pw",
  timeoutMs: 1000,
});

describe("MotionEyeClient.signUrl", () => {
  it("appends _username and a hex _signature", () => {
    const url = client.signUrl("GET", "/config/list");
    expect(url).toContain("http://eye.local:8765/config/list?");
    expect(url).toMatch(/_username=admin/);
    expect(url).toMatch(/_signature=[0-9a-f]{40}/);
  });

  it("preserves existing query params", () => {
    const url = client.signUrl("GET", "/picture/1/list?prefix=2026-06-13&with_stat=true");
    expect(url).toMatch(/prefix=2026-06-13/);
    expect(url).toMatch(/with_stat=true/);
    expect(url).toMatch(/_signature=[0-9a-f]{40}/);
  });
});
