/**
 * Regression gate for the extended pass. Requires the model to be loaded in LM Studio.
 * Exits non-zero when any threshold from the spec is missed, so a prompt or model change
 * cannot silently degrade detection.
 *
 *   npm run ai:eval
 *
 * Uses `process.exitCode` rather than `process.exit()` throughout. On this project's
 * Windows/Node combination, calling `process.exit()` while an `AbortSignal.timeout()`
 * timer from a completed `fetch()` is still pending (which askJson in src/ai/lmstudio.ts
 * always leaves behind) crashes the process with a native libuv assertion and exit code
 * 127 instead of the intended code — silently defeating this gate's exit-code contract.
 * Setting `process.exitCode` and returning normally avoids that crash; verified below.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { probeModelLoaded, askSemantics, askWeather, ModelUnavailableError, type AskOptions } from "../src/ai/lmstudio.js";
import { normalizeAnimals } from "../src/ai/normalize.js";

/** Thrown to unwind out of the frame/weather loops when the model itself went away. */
class ModelWentAway extends Error {}

async function main(): Promise<void> {
  const fixture = JSON.parse(readFileSync("tests/ai/fixtures/reference-set.json", "utf8"));
  const root = process.env.EVAL_MEDIA_ROOT ?? fixture.mediaRoot;
  const ask: AskOptions = {
    url: process.env.AI_LMSTUDIO_URL ?? "http://192.168.0.11:1234",
    model: process.env.AI_MODEL ?? "qwen/qwen3-vl-8b",
    // Honour AI_REQUEST_TIMEOUT_MS (same default as src/config.ts) rather than a
    // hardcoded value: this gate is the branch's only regression guard, and a timeout
    // shorter than what production actually tolerates makes it fail on frames that
    // production would have handled fine (29-36 s measured under GPU contention).
    timeoutMs: Number(process.env.AI_REQUEST_TIMEOUT_MS ?? "120000"),
  };
  const width = Number(process.env.AI_IMAGE_WIDTH ?? "1024");

  if (!(await probeModelLoaded({ ...ask, timeoutMs: 5000 }))) {
    console.error(`Model ${ask.model} is not loaded in LM Studio at ${ask.url}.`);
    process.exitCode = 2;
    return;
  }

  const jpeg = (p: string) =>
    sharp(join(root, p)).resize({ width, withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer();

  /**
   * The model process itself is gone (host down, unloaded mid-batch, 5xx / transport
   * failure). Continuing would silently score the remaining, untested frames as passes.
   * Unwinds to the same distinct exit code the absent-model precondition uses, so this
   * failure mode is never confused with "all thresholds passed."
   */
  function modelWentAway(context: string, e: unknown): never {
    const detail = e instanceof Error ? e.message : String(e);
    console.error(`Model became unavailable mid-run while processing ${context}: ${detail}`);
    throw new ModelWentAway();
  }

  let personHit = 0, personTotal = 0, personFalse = 0, personNegTotal = 0;
  let animalHit = 0, animalTotal = 0, animalInvented = 0, animalNegTotal = 0;
  // Frames whose only subject is a spider on the lens. These are scored on their own,
  // never as animal negatives: "spider" IS the wanted answer for them, so counting them
  // in `animalInvented` would fail the run for behaving correctly.
  let spiderHit = 0, spiderTotal = 0, spiderAsAnimal = 0;
  // A fixture entry carrying `knownFail` is a case that is understood and root-caused but
  // not fixable at the configured settings. It is measured and reported, but excluded
  // from the thresholds — and if it starts PASSING the run fails, because a stale
  // exemption silently lowers the bar for everything measured after it.
  const xfail: Array<[string, boolean, string]> = [];
  const latencies: number[] = [];
  let fogHit = 0, fogTotal = 0, snowHit = 0, snowTotal = 0;
  const wLatencies: number[] = [];

  try {
    for (const f of fixture.frames) {
      try {
        const t0 = Date.now();
        const r = await askSemantics(ask, await jpeg(f.path));
        latencies.push(Date.now() - t0);
        const kinds = normalizeAnimals(r.animals).kinds;

        if (f.people > 0) { personTotal++; if (r.peopleCount > 0) personHit++; }
        else { personNegTotal++; if (r.peopleCount > 0) personFalse++; }

        if (f.spider && f.knownFail) {
          const ok = kinds.includes("spider") && !kinds.some((k: string) => k !== "spider");
          xfail.push([f.path, ok, `${JSON.stringify(kinds)} — ${f.knownFail}`]);
        } else if (f.spider) {
          spiderTotal++;
          if (kinds.includes("spider")) spiderHit++;
          // The regression this guards: a lens spider reported as a bird (or any other
          // species), which is what put it in the "animals were here" filter.
          if (kinds.some((k) => k !== "spider")) spiderAsAnimal++;
        } else if (f.animals.length > 0) { animalTotal++; if (kinds.length > 0) animalHit++; }
        else { animalNegTotal++; if (kinds.length > 0) animalInvented++; }

        console.log(`${f.path.padEnd(28)} people=${r.peopleCount} animals=${JSON.stringify(kinds)}`);
      } catch (e) {
        if (e instanceof ModelUnavailableError) modelWentAway(f.path, e);
        // Anything else — missing/unreadable file (e.g. pruned by disk hygiene, or a
        // wrong EVAL_MEDIA_ROOT), a rejected answer — counts against this frame's
        // measure as a miss rather than crashing the run. A recall total is still
        // bumped so the frame isn't silently dropped from the denominator; a negative
        // frame is excluded from the false-alarm/invented sample since no answer was
        // observed for it.
        console.error(`SKIP ${f.path}: ${e instanceof Error ? e.message : String(e)}`);
        if (f.people > 0) personTotal++;
        if (f.spider && !f.knownFail) spiderTotal++;
        else if (f.animals.length > 0) animalTotal++;
      }
    }

    for (const w of fixture.weather) {
      try {
        const t0 = Date.now();
        const r = await askWeather(ask, await jpeg(w.path));
        wLatencies.push(Date.now() - t0);
        // Scored as the binary "is the background gone", not on the scale's top step.
        // The fog/dense_fog boundary tracks the resize width rather than the weather
        // (see FOG_VISIBILITY in src/media/detectionFilter.ts), so gating on "dense_fog"
        // tested the resampler. The clear references are scored too — before this they
        // were read from the fixture but never checked, which would have left the
        // widened accept-set guarding nothing in the other direction.
        const gone = (v: string) => v === "fog" || v === "dense_fog";
        if (w.visibility === "dense_fog") { fogTotal++; if (gone(r.visibility)) fogHit++; }
        if (w.visibility === "clear") { fogTotal++; if (!gone(r.visibility)) fogHit++; }
        if (w.precipitation === "snow") { snowTotal++; if (r.precipitation === "snow") snowHit++; }
        if (w.precipitation === "none") { snowTotal++; if (r.precipitation === "none") snowHit++; }
        console.log(`${w.path.padEnd(28)} visibility=${r.visibility} precipitation=${r.precipitation}`);
      } catch (e) {
        if (e instanceof ModelUnavailableError) modelWentAway(w.path, e);
        console.error(`SKIP ${w.path}: ${e instanceof Error ? e.message : String(e)}`);
        if (w.visibility === "dense_fog" || w.visibility === "clear") fogTotal++;
        if (w.precipitation === "snow" || w.precipitation === "none") snowTotal++;
      }
    }
  } catch (e) {
    if (e instanceof ModelWentAway) {
      process.exitCode = 2;
      return;
    }
    throw e;
  }

  const median = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[a.length >> 1] : undefined);
  const fmtMs = (a: number[]) => (a.length ? `${median(a)} ms` : "n/a (no successful calls)");

  // Every ratio-style threshold below guards on total > 0: without it, a fixture category
  // that ends up with zero entries (e.g. every frame in it was skipped) would satisfy its
  // `hit === total` or `count === 0` check vacuously and report PASS despite testing nothing.
  const checks: Array<[string, boolean, string]> = [
    ["person recall", personTotal > 0 && personHit === personTotal, `${personHit}/${personTotal}`],
    ["person false alarms", personNegTotal > 0 && personFalse === 0, `${personFalse}/${personNegTotal}`],
    ["animal recall", animalTotal > 0 && animalHit === animalTotal, `${animalHit}/${animalTotal}`],
    ["invented animals", animalNegTotal > 0 && animalInvented === 0, `${animalInvented}/${animalNegTotal}`],
    ["lens spider labelled", spiderTotal > 0 && spiderHit === spiderTotal, `${spiderHit}/${spiderTotal}`],
    ["spider taken for an animal", spiderTotal > 0 && spiderAsAnimal === 0, `${spiderAsAnimal}/${spiderTotal}`],
    ["fog vs clear", fogTotal > 0 && fogHit === fogTotal, `${fogHit}/${fogTotal}`],
    ["snow", snowTotal > 0 && snowHit === snowTotal, `${snowHit}/${snowTotal}`],
    ["semantic latency <= 2000 ms", latencies.length > 0 && (median(latencies) as number) <= 2000, fmtMs(latencies)],
    ["weather latency <= 4000 ms", wLatencies.length > 0 && (median(wLatencies) as number) <= 4000, fmtMs(wLatencies)],
  ];

  if (xfail.length) {
    console.log("\n=== known limitations (measured, not gated) ===");
    for (const [path, passed, detail] of xfail) {
      console.log(`${passed ? "XPASS" : "xfail"} ${path.padEnd(24)} ${detail}`);
    }
  }

  console.log("\n=== thresholds ===");
  let failed = false;
  for (const [path, passed] of xfail) {
    if (passed) {
      console.log(`FAIL  known limitation now passes — ${path}: remove its knownFail marker`);
      failed = true;
    }
  }
  for (const [name, ok, detail] of checks) {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(30)} ${detail}`);
    if (!ok) failed = true;
  }
  process.exitCode = failed ? 1 : 0;
}

await main();
