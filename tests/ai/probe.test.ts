import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { probeModelLoaded, probeModelAvailable, ensureModelLoaded } from "../../src/ai/lmstudio.js";

let server: Server | null = null;

function serve(handler: (req: { url: string; method: string; body: string }) => { status: number; body: string }): Promise<string> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const { status, body } = handler({
          url: req.url ?? "",
          method: req.method ?? "GET",
          body: Buffer.concat(chunks).toString("utf8"),
        });
        res.writeHead(status, { "content-type": "application/json" });
        res.end(body);
      });
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

describe("probeModelAvailable", () => {
  it('is "loaded" when the configured model reports state=loaded', async () => {
    const url = await serve(() => ({ status: 200, body: MODELS("loaded") }));
    await expect(probeModelAvailable({ url, model: "qwen/qwen3-vl-8b", timeoutMs: 2000 })).resolves.toBe("loaded");
  });

  it('is "available" when the model is downloaded but not loaded', async () => {
    const url = await serve(() => ({ status: 200, body: MODELS("not-loaded") }));
    await expect(probeModelAvailable({ url, model: "qwen/qwen3-vl-8b", timeoutMs: 2000 })).resolves.toBe("available");
  });

  it('is "absent" when the model is missing from the list', async () => {
    const url = await serve(() => ({ status: 200, body: JSON.stringify({ object: "list", data: [] }) }));
    await expect(probeModelAvailable({ url, model: "qwen/qwen3-vl-8b", timeoutMs: 2000 })).resolves.toBe("absent");
  });

  it('is "absent" — never throws — when the host refuses the connection', async () => {
    // Port 1 is reserved and refuses connections; this is the "workstation is off" case,
    // which is a normal operating state and must not surface as an error.
    await expect(
      probeModelAvailable({ url: "http://127.0.0.1:1", model: "qwen/qwen3-vl-8b", timeoutMs: 500 }),
    ).resolves.toBe("absent");
  });

  it('is "absent" when the response is not valid JSON', async () => {
    const url = await serve(() => ({ status: 200, body: "<html>nope</html>" }));
    await expect(probeModelAvailable({ url, model: "qwen/qwen3-vl-8b", timeoutMs: 2000 })).resolves.toBe("absent");
  });
});

describe("ensureModelLoaded", () => {
  it("posts to /api/v0/chat/completions with the configured model and ttl, and returns true on success", async () => {
    let seen: { url: string; method: string; body: string } | null = null;
    const url = await serve((req) => {
      seen = req;
      return { status: 200, body: JSON.stringify({ choices: [{ message: { content: "hi" } }] }) };
    });
    await expect(ensureModelLoaded({ url, model: "qwen/qwen3-vl-8b", timeoutMs: 2000 }, 1800)).resolves.toBe(true);
    expect(seen).not.toBeNull();
    expect(seen!.url).toBe("/api/v0/chat/completions");
    expect(seen!.method).toBe("POST");
    const parsed = JSON.parse(seen!.body);
    expect(parsed.model).toBe("qwen/qwen3-vl-8b");
    expect(parsed.ttl).toBe(1800);
    expect(parsed.max_tokens).toBe(1);
  });

  it("returns false when the host responds with an error status", async () => {
    const url = await serve(() => ({ status: 500, body: JSON.stringify({ error: "boom" }) }));
    await expect(ensureModelLoaded({ url, model: "qwen/qwen3-vl-8b", timeoutMs: 2000 }, 1800)).resolves.toBe(false);
  });

  it("returns false — never throws — when the host refuses the connection", async () => {
    await expect(
      ensureModelLoaded({ url: "http://127.0.0.1:1", model: "qwen/qwen3-vl-8b", timeoutMs: 500 }, 1800),
    ).resolves.toBe(false);
  });
});
