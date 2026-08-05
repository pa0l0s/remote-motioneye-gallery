import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { probeModelLoaded } from "../../src/ai/lmstudio.js";

let server: Server | null = null;

function serve(handler: (url: string) => { status: number; body: string }): Promise<string> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      const { status, body } = handler(req.url ?? "");
      res.writeHead(status, { "content-type": "application/json" });
      res.end(body);
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server!.address() as { port: number };
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
}

afterEach(() => {
  server?.close();
  server = null;
});

const MODELS = (state: string) =>
  JSON.stringify({
    object: "list",
    data: [
      { id: "some/other-model", object: "model", type: "llm", state: "loaded" },
      { id: "qwen/qwen3-vl-8b", object: "model", type: "vlm", state },
    ],
  });

describe("probeModelLoaded", () => {
  it("is true only when the configured model reports state=loaded", async () => {
    const url = await serve(() => ({ status: 200, body: MODELS("loaded") }));
    await expect(probeModelLoaded({ url, model: "qwen/qwen3-vl-8b", timeoutMs: 2000 })).resolves.toBe(true);
  });

  it("is false when the model is downloaded but not loaded", async () => {
    const url = await serve(() => ({ status: 200, body: MODELS("not-loaded") }));
    await expect(probeModelLoaded({ url, model: "qwen/qwen3-vl-8b", timeoutMs: 2000 })).resolves.toBe(false);
  });

  it("is false when the model is absent from the list", async () => {
    const url = await serve(() => ({ status: 200, body: JSON.stringify({ object: "list", data: [] }) }));
    await expect(probeModelLoaded({ url, model: "qwen/qwen3-vl-8b", timeoutMs: 2000 })).resolves.toBe(false);
  });

  it("is false — never throws — when the host is unreachable", async () => {
    // Port 1 is reserved and refuses connections; this is the "workstation is off" case,
    // which is a normal operating state and must not surface as an error.
    await expect(
      probeModelLoaded({ url: "http://127.0.0.1:1", model: "qwen/qwen3-vl-8b", timeoutMs: 500 }),
    ).resolves.toBe(false);
  });

  it("is false when the response is not valid JSON", async () => {
    const url = await serve(() => ({ status: 200, body: "<html>nope</html>" }));
    await expect(probeModelLoaded({ url, model: "qwen/qwen3-vl-8b", timeoutMs: 2000 })).resolves.toBe(false);
  });
});
