import type { PrismaClient } from "@prisma/client";
import { ModelUnavailableError, ModelTimeoutError, type SemanticResult, type WeatherResult } from "./lmstudio.js";
import { normalizeAnimals } from "./normalize.js";

/**
 * Mutable state shared with the HTTP layer: pause toggle, "currently running" flag, and the
 * last known state of the LM Studio model. Deliberately a SEPARATE object from the basic
 * pass's ScanControl (src/activity/scanner.ts) — pausing this extended pass must never pause
 * frame differencing, and vice versa. The two passes are independent products with
 * independent operators and independent failure modes.
 */
export interface AiScanControl {
  paused: boolean;
  scanning: boolean;
  modelLoaded: boolean;
  lastProbeAt: Date | null;
  lastError: string | null;
}

export interface AiScanOptions {
  model: string;
  promptVersion: string;
  weatherPromptVersion: string;
  imageWidth: number;
  weatherMinGapSeconds: number;
  batch: number;
  colorThreshold: number;
  maxFailures: number;
}

/**
 * Every external effect this pass has — reading the file, scaling it, both model calls, and
 * the night gate — is injected here. That is what lets the tests run with neither network
 * access nor real image files: they hand in fakes for all four.
 */
export interface AiScanDeps {
  loadJpeg: (path: string, width: number) => Promise<Buffer>;
  isNight: (path: string, colorThreshold: number) => Promise<boolean>;
  askSemantics: (jpeg: Buffer) => Promise<SemanticResult>;
  askWeather: (jpeg: Buffer) => Promise<WeatherResult>;
}

export interface AiScanResult {
  scanned: number;
  weatherScanned: number;
  /**
   * "timeout" is distinct from "unavailable": both abort the batch and mark nothing, but
   * a timeout must not push the runner's next probe out by a full probe interval the way
   * a genuine outage does -- see aiRunnerTick in runner.ts.
   */
  stopped: "empty" | "batch" | "paused" | "unavailable" | "timeout";
}

const PAGE = 50;

/**
 * Extended pass ("loop B"). Walks locally-cached image frames NEWEST FIRST and labels them
 * with a vision model. Independent of the basic differencing pass ("loop A") in every
 * respect: this function reads and writes only the ai-prefixed, weather-prefixed, and
 * isNightIr columns, and never inspects loop A's frame-differencing columns.
 *
 * Newest first, deliberately, unlike loop A's oldest-first walk: a full backfill over
 * ~209k frames runs for days, and today's frames should be searchable long before it
 * finishes, not after. A stale aiPromptVersion counts as "unscanned" for selection
 * purposes, so bumping the prompt version turns into an ordinary resumable pass over the
 * whole archive rather than a wipe-and-restart.
 *
 * Three failure modes are deliberately distinguished:
 *  - ModelUnavailableError means the model process itself is gone (host down, unloaded
 *    mid-batch, 5xx). The whole batch aborts immediately and NOTHING is marked scanned:
 *    if aiScannedAt kept being written while every call failed, the first time the
 *    workstation is switched off mid-backfill would silently record the entire remaining
 *    archive as "scanned, found nothing" — a data-destroying false negative.
 *  - A local file read failure (loadJpeg/isNight throwing) for EVERY frame in a fetched
 *    page means the media mount itself is gone (unmounted NAS bind, dropped volume) —
 *    an environment fault, not 50-or-200 individually corrupt JPEGs. Each page is read in
 *    full before anything is written; if every read in it failed, the call aborts exactly
 *    like ModelUnavailableError — nothing marked, control.lastError bound from the read
 *    error — instead of burning every frame's aiFailures down to "scanned, found nothing".
 *  - FrameRejectedError, or a read failure for only SOME frames in a page (the ordinary
 *    "one corrupt JPEG among many good ones" case), means this one frame is unusable. It
 *    counts against that frame's aiFailures only; once aiFailures reaches maxFailures the
 *    frame is marked scanned anyway so the loop keeps making forward progress instead of
 *    retrying a permanently bad frame forever.
 */
export async function runAiScanOnce(args: {
  prisma: PrismaClient;
  opts: AiScanOptions;
  control: AiScanControl;
  deps: AiScanDeps;
}): Promise<AiScanResult> {
  const { prisma, opts, control, deps } = args;
  let scanned = 0;
  let weatherScanned = 0;
  // Frames looked at this call, success or failure alike. `scanned` (successes only)
  // cannot bound the walk: a read outage (unmounted media volume, one bad directory)
  // makes loadJpeg throw for every frame, so a bound on successes never trips and a
  // single call would sweep the entire ~209k-row archive, driving every frame to
  // maxFailures and permanently excluding it — the exact "recorded as scanned, found
  // nothing" outcome the transport/frame failure split exists to prevent, just reached
  // through the file-read door instead of the model door. `visited` closes that door.
  let visited = 0;

  if (control.paused) return { scanned, weatherScanned, stopped: "paused" };

  // Descending cursor walk (mirrors loop A's forward walk, but newest-to-oldest): every
  // row is visited at most once per call. Without a cursor, a frame that fails without
  // giving up (aiFailures bumped but still below maxFailures) would still match the
  // eligibility filter below and get re-fetched by the very next page query in the SAME
  // call — nothing about its selection would have changed. The cursor is what guarantees
  // the loop always moves on, whether the previous frame succeeded or failed.
  let cursorTs = new Date("9999-12-31T23:59:59.999Z"); // far future: first page has no real cursor yet
  let cursorId = Number.MAX_SAFE_INTEGER;

  while (visited < opts.batch) {
    if (control.paused) return { scanned, weatherScanned, stopped: "paused" };

    const page = await prisma.mediaFile.findMany({
      where: {
        fileType: "image",
        isDownloaded: true,
        aiFailures: { lt: opts.maxFailures },
        AND: [
          { OR: [{ aiScannedAt: null }, { aiPromptVersion: { not: opts.promptVersion } }] },
          {
            OR: [
              { timestamp: { lt: cursorTs } },
              { timestamp: cursorTs, id: { lt: cursorId } },
            ],
          },
        ],
      },
      orderBy: [{ timestamp: "desc" }, { id: "desc" }],
      take: Math.min(PAGE, opts.batch - visited),
      select: { id: true, cameraId: true, localPath: true, timestamp: true },
    });
    if (page.length === 0) return { scanned, weatherScanned, stopped: "empty" };

    // Read every frame in this page before writing anything. A page where EVERY read
    // fails (unmounted media volume, dropped NAS bind mount) is an environment fault,
    // not up to 50 individually corrupt JPEGs, and must abort the call the same way a
    // dead model does: mark nothing, and let the caller back off instead of hammering a
    // volume that will not come back in the next few seconds. A page with only SOME
    // reads failing is the ordinary case and falls through to the per-frame handling
    // below exactly as before.
    const reads: Array<{ f: (typeof page)[number]; jpeg: Buffer | null; night: boolean | null; error: unknown }> = [];
    for (const f of page) {
      try {
        const jpeg = await deps.loadJpeg(f.localPath, opts.imageWidth);
        const night = await deps.isNight(f.localPath, opts.colorThreshold);
        reads.push({ f, jpeg, night, error: null });
      } catch (e) {
        reads.push({ f, jpeg: null, night: null, error: e });
      }
    }
    if (reads.every((r) => r.error !== null)) {
      const lastError = reads[reads.length - 1].error;
      control.modelLoaded = false;
      control.lastError = lastError instanceof Error ? lastError.message : String(lastError);
      return { scanned, weatherScanned, stopped: "unavailable" };
    }

    for (const r of reads) {
      if (control.paused) return { scanned, weatherScanned, stopped: "paused" };
      const f = r.f;
      cursorTs = f.timestamp;
      cursorId = f.id;
      visited++;

      if (r.error !== null) {
        await bumpFailure(prisma, f.id, opts);
        continue;
      }
      const jpeg = r.jpeg as Buffer;
      const night = r.night as boolean;

      const startedAt = Date.now();
      let semantics: SemanticResult;
      try {
        semantics = await deps.askSemantics(jpeg);
      } catch (e) {
        if (e instanceof ModelTimeoutError) {
          control.modelLoaded = false;
          control.lastError = e.message;
          return { scanned, weatherScanned, stopped: "timeout" };
        }
        if (e instanceof ModelUnavailableError) {
          control.modelLoaded = false;
          control.lastError = e.message;
          return { scanned, weatherScanned, stopped: "unavailable" };
        }
        await bumpFailure(prisma, f.id, opts);
        continue;
      }

      const animals = normalizeAnimals(semantics.animals);
      await prisma.mediaFile.update({
        where: { id: f.id },
        data: {
          aiScannedAt: new Date(),
          aiModel: opts.model,
          aiPromptVersion: opts.promptVersion,
          aiPeopleCount: semantics.peopleCount,
          aiAnimals: JSON.stringify(semantics.animals),
          aiAnimalKinds: animals.kindsColumn,
          aiLatencyMs: Date.now() - startedAt,
          aiFailures: 0,
          isNightIr: night,
        },
      });
      scanned++;

      if (night) {
        // Night frames never get a weather question — the model reliably misreads a
        // black IR frame as "dense fog" — but ARE marked weather-scanned so they are
        // not retried forever; the weather fields themselves stay null.
        await prisma.mediaFile.update({
          where: { id: f.id },
          data: { weatherScannedAt: new Date(), weatherPromptVersion: opts.weatherPromptVersion },
        });
      } else if (await shouldAskWeather(prisma, f, opts)) {
        try {
          const w = await deps.askWeather(jpeg);
          await prisma.mediaFile.update({
            where: { id: f.id },
            data: {
              weatherScannedAt: new Date(),
              weatherPromptVersion: opts.weatherPromptVersion,
              weatherVisibility: w.visibility,
              weatherPrecipitation: w.precipitation,
              weatherSnowOnGround: w.snowOnGround,
            },
          });
          weatherScanned++;
        } catch (e) {
          if (e instanceof ModelTimeoutError) {
            control.modelLoaded = false;
            control.lastError = e.message;
            return { scanned, weatherScanned, stopped: "timeout" };
          }
          if (e instanceof ModelUnavailableError) {
            control.modelLoaded = false;
            control.lastError = e.message;
            return { scanned, weatherScanned, stopped: "unavailable" };
          }
          // A rejected weather answer is not worth failing the whole frame over: the
          // semantic result above is already committed and is the more valuable of the
          // two labels. It will simply be sampled again from a neighbouring frame.
        }
      }

      if (visited >= opts.batch) return { scanned, weatherScanned, stopped: "batch" };
    }
  }

  return { scanned, weatherScanned, stopped: "batch" };
}

async function bumpFailure(prisma: PrismaClient, id: number, opts: AiScanOptions): Promise<void> {
  const row = await prisma.mediaFile.update({
    where: { id },
    data: { aiFailures: { increment: 1 } },
    select: { aiFailures: true },
  });
  if (row.aiFailures >= opts.maxFailures) {
    // Give up on this frame so the loop keeps making forward progress; still record
    // that it was looked at under the current model/prompt, so a version bump can
    // give it another try later. aiFailures is reset here (not left at maxFailures):
    // the eligibility filter below excludes aiFailures >= maxFailures unconditionally,
    // so without this reset a stale-promptVersion re-open could never actually re-open
    // the frame — it would keep failing the failure-count filter forever.
    await prisma.mediaFile.update({
      where: { id },
      data: {
        aiScannedAt: new Date(),
        aiModel: opts.model,
        aiPromptVersion: opts.promptVersion,
        aiFailures: 0,
      },
    });
  }
}

/**
 * Weather is sampled on a TIME interval, not every Nth frame: the capture interval has
 * changed release to release (300 s in 2025, 150 s in 2026), and 2024 frames are motion-
 * triggered 1-3 s apart, where "every 4th frame" would mean a weather question every few
 * seconds. Sampling by wall-clock gap keeps the question rate sane across all three eras
 * without per-era configuration. The window is open (strict gt/lt) so a frame exactly
 * weatherMinGapSeconds away from its nearest sampled neighbour still gets asked, keeping
 * the achieved spacing close to, not double, the configured minimum.
 */
async function shouldAskWeather(
  prisma: PrismaClient,
  f: { cameraId: number; timestamp: Date },
  opts: AiScanOptions,
): Promise<boolean> {
  const gapMs = opts.weatherMinGapSeconds * 1000;
  const neighbour = await prisma.mediaFile.findFirst({
    where: {
      cameraId: f.cameraId,
      weatherVisibility: { not: null },
      timestamp: {
        gt: new Date(f.timestamp.getTime() - gapMs),
        lt: new Date(f.timestamp.getTime() + gapMs),
      },
    },
    select: { id: true },
  });
  return neighbour === null;
}
