import { describe, it, expect } from "vitest";
import { FetchGate } from "../../src/remote/fetchGate.js";

describe("FetchGate", () => {
  it("never runs more than `concurrency` tasks at once", async () => {
    const gate = new FetchGate({ concurrency: 2, maxRetries: 0, baseDelayMs: 1 });
    let active = 0;
    let peak = 0;
    const task = () =>
      gate.run(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 20));
        active--;
        return true;
      });
    await Promise.all([task(), task(), task(), task(), task()]);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("retries the configured number of times then rethrows", async () => {
    const gate = new FetchGate({ concurrency: 1, maxRetries: 2, baseDelayMs: 1 });
    let calls = 0;
    await expect(
      gate.run(async () => {
        calls++;
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(calls).toBe(3); // initial + 2 retries
  });

  it("resolves if a retry succeeds", async () => {
    const gate = new FetchGate({ concurrency: 1, maxRetries: 3, baseDelayMs: 1 });
    let calls = 0;
    const res = await gate.run(async () => {
      calls++;
      if (calls < 2) throw new Error("transient");
      return "ok";
    });
    expect(res).toBe("ok");
    expect(calls).toBe(2);
  });
});
