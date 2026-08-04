/**
 * Regression gate for the extended pass. Requires the model to be loaded in LM Studio.
 * Exits non-zero when any threshold from the spec is missed, so a prompt or model change
 * cannot silently degrade detection.
 *
 *   npm run ai:eval
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { probeModelLoaded, askSemantics, askWeather, type AskOptions } from "../src/ai/lmstudio.js";
import { normalizeAnimals } from "../src/ai/normalize.js";

const fixture = JSON.parse(readFileSync("tests/ai/fixtures/reference-set.json", "utf8"));
const root = process.env.EVAL_MEDIA_ROOT ?? fixture.mediaRoot;
const ask: AskOptions = {
  url: process.env.AI_LMSTUDIO_URL ?? "http://192.168.0.11:1234",
  model: process.env.AI_MODEL ?? "qwen/qwen3-vl-8b",
  timeoutMs: 60000,
};
const width = Number(process.env.AI_IMAGE_WIDTH ?? "1024");

if (!(await probeModelLoaded({ ...ask, timeoutMs: 5000 }))) {
  console.error(`Model ${ask.model} is not loaded in LM Studio at ${ask.url}.`);
  process.exit(2);
}

const jpeg = (p: string) =>
  sharp(join(root, p)).resize({ width, withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer();

let personHit = 0, personTotal = 0, personFalse = 0, personNegTotal = 0;
let animalHit = 0, animalTotal = 0, animalInvented = 0;
const latencies: number[] = [];

for (const f of fixture.frames) {
  const t0 = Date.now();
  const r = await askSemantics(ask, await jpeg(f.path));
  latencies.push(Date.now() - t0);
  const kinds = normalizeAnimals(r.animals).kinds;

  if (f.people > 0) { personTotal++; if (r.peopleCount > 0) personHit++; }
  else { personNegTotal++; if (r.peopleCount > 0) personFalse++; }

  if (f.animals.length > 0) { animalTotal++; if (kinds.length > 0) animalHit++; }
  else if (kinds.length > 0) { animalInvented++; }

  console.log(`${f.path.padEnd(28)} people=${r.peopleCount} animals=${JSON.stringify(kinds)}`);
}

let fogHit = 0, fogTotal = 0, snowHit = 0, snowTotal = 0;
const wLatencies: number[] = [];
for (const w of fixture.weather) {
  const t0 = Date.now();
  const r = await askWeather(ask, await jpeg(w.path));
  wLatencies.push(Date.now() - t0);
  if (w.visibility === "dense_fog") { fogTotal++; if (r.visibility === "dense_fog") fogHit++; }
  if (w.precipitation === "snow") { snowTotal++; if (r.precipitation === "snow") snowHit++; }
  if (w.precipitation === "none") { snowTotal++; if (r.precipitation === "none") snowHit++; }
  console.log(`${w.path.padEnd(28)} visibility=${r.visibility} precipitation=${r.precipitation}`);
}

const median = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1];

const checks: Array<[string, boolean, string]> = [
  ["person recall", personHit === personTotal, `${personHit}/${personTotal}`],
  ["person false alarms", personFalse === 0, `${personFalse}/${personNegTotal}`],
  ["animal recall", animalHit === animalTotal, `${animalHit}/${animalTotal}`],
  ["invented animals", animalInvented === 0, String(animalInvented)],
  ["dense fog", fogHit === fogTotal, `${fogHit}/${fogTotal}`],
  ["snow", snowHit === snowTotal, `${snowHit}/${snowTotal}`],
  ["semantic latency <= 2000 ms", median(latencies) <= 2000, `${median(latencies)} ms`],
  ["weather latency <= 4000 ms", median(wLatencies) <= 4000, `${median(wLatencies)} ms`],
];

console.log("\n=== thresholds ===");
let failed = false;
for (const [name, ok, detail] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(30)} ${detail}`);
  if (!ok) failed = true;
}
process.exit(failed ? 1 : 0);
