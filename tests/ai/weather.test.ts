import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { askWeather } from "../../src/ai/lmstudio.js";

let server: Server | null = null;
let lastBody: any = null;

function serve(body: string): Promise<string> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        lastBody = JSON.parse(raw);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(body);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server!.address() as { port: number };
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
}
afterEach(() => { server?.close(); server = null; lastBody = null; });

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

describe("askWeather", () => {
  it("parses the weather answer", async () => {
    const url = await serve(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        visibility: "dense_fog", precipitation: "snow", snow_on_ground: true,
      }) } }],
    }));
    await expect(askWeather({ url, model: "m", timeoutMs: 2000 }, JPEG)).resolves.toEqual({
      visibility: "dense_fog", precipitation: "snow", snowOnGround: true,
    });
  });

  it("constrains the answer with enums and asks nothing else", async () => {
    const url = await serve(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        visibility: "clear", precipitation: "none", snow_on_ground: false,
      }) } }],
    }));
    await askWeather({ url, model: "m", timeoutMs: 2000 }, JPEG);
    const props = lastBody.response_format.json_schema.schema.properties;
    expect(Object.keys(props).sort()).toEqual(["precipitation", "snow_on_ground", "visibility"]);
    expect(props.visibility.enum).toEqual(["clear", "slight_haze", "fog", "dense_fog"]);
  });
});
