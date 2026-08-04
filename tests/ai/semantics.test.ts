import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { askSemantics, ModelUnavailableError, FrameRejectedError } from "../../src/ai/lmstudio.js";

let server: Server | null = null;
let lastBody: any = null;

function serve(status: number, body: string): Promise<string> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        lastBody = raw ? JSON.parse(raw) : null;
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

const reply = (content: object) =>
  JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] });

afterEach(() => { server?.close(); server = null; lastBody = null; });

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

describe("askSemantics", () => {
  it("parses people and animals from a well-formed answer", async () => {
    const url = await serve(200, reply({ people_count: 2, animals: ["1 bird on a tire", "horse"] }));
    const r = await askSemantics({ url, model: "m", timeoutMs: 2000 }, JPEG);
    expect(r).toEqual({ peopleCount: 2, animals: ["1 bird on a tire", "horse"] });
  });

  it("sends the measured parameters and a strict json schema", async () => {
    const url = await serve(200, reply({ people_count: 0, animals: [] }));
    await askSemantics({ url, model: "qwen/qwen3-vl-8b", timeoutMs: 2000 }, JPEG);
    expect(lastBody.model).toBe("qwen/qwen3-vl-8b");
    expect(lastBody.temperature).toBe(0);
    expect(lastBody.reasoning_effort).toBe("none");
    expect(lastBody.response_format.json_schema.strict).toBe(true);
    // no free-text field may leak into the schema — it destroys repeatability
    expect(Object.keys(lastBody.response_format.json_schema.schema.properties).sort())
      .toEqual(["animals", "people_count"]);
    expect(lastBody.messages[1].content[1].image_url.url).toMatch(/^data:image\/jpeg;base64,/);
  });

  it("raises ModelUnavailableError when the host refuses the connection", async () => {
    await expect(
      askSemantics({ url: "http://127.0.0.1:1", model: "m", timeoutMs: 500 }, JPEG),
    ).rejects.toBeInstanceOf(ModelUnavailableError);
  });

  it("raises ModelUnavailableError on a 5xx (model was unloaded mid-batch)", async () => {
    const url = await serve(503, "{}");
    await expect(askSemantics({ url, model: "m", timeoutMs: 2000 }, JPEG))
      .rejects.toBeInstanceOf(ModelUnavailableError);
  });

  it("raises FrameRejectedError on a 4xx", async () => {
    const url = await serve(400, JSON.stringify({ error: "bad image" }));
    await expect(askSemantics({ url, model: "m", timeoutMs: 2000 }, JPEG))
      .rejects.toBeInstanceOf(FrameRejectedError);
  });

  it("raises FrameRejectedError when content is not the promised JSON", async () => {
    const url = await serve(200, JSON.stringify({ choices: [{ message: { content: "" } }] }));
    await expect(askSemantics({ url, model: "m", timeoutMs: 2000 }, JPEG))
      .rejects.toBeInstanceOf(FrameRejectedError);
  });
});
