import type { PrismaClient } from "@prisma/client";
import { isValidImage } from "../media/validate.js";
import { loadFrame, scoreFrames, isModeSwitch, type DiffOptions, type Frame } from "./diff.js";

export interface ScanOptions extends DiffOptions {
  /** Max frames to score+write per cycle (keeps NAS CPU bounded). */
  batch: number;
  /** A neighbor older than this (seconds) is too far to compare → no score. */
  maxGapSeconds: number;
  /** activityScore above this flags the frame as activity. */
  scoreThreshold: number;
}

export const DEFAULT_SCAN: ScanOptions = {
  downscale: 64,
  pixelThreshold: 25,
  colorThreshold: 8,
  batch: 500,
  maxGapSeconds: 900,
  scoreThreshold: 0.04,
};

/** Mutable control shared with the HTTP layer (pause toggle + a "currently running" flag). */
export interface ScanControl {
  paused: boolean;
  scanning: boolean;
}

const PAGE = 200;

/**
 * Local-only background activity detection. Walks locally-cached image frames in time order
 * and scores each against the previous available frame (brightness-normalized differencing,
 * see diff.ts). Stateless per-pair, so it tolerates gaps and out-of-order availability.
 *
 * Every frame it visits is marked scanned (activityScannedAt set) so the scan always makes
 * forward progress — frames with no usable neighbor or an unreadable file get a null score
 * and hasActivity=false rather than being retried forever.
 */
export async function runActivityScanOnce(args: {
  prisma: PrismaClient;
  opts?: Partial<ScanOptions>;
  control?: ScanControl;
  isValid?: (path: string) => Promise<boolean>;
}): Promise<{ scanned: number; flagged: number }> {
  const { prisma } = args;
  const opts = { ...DEFAULT_SCAN, ...args.opts };
  const control = args.control;
  const isValid = args.isValid ?? isValidImage;

  let scanned = 0;
  let flagged = 0;

  const cameras = await prisma.camera.findMany({ select: { id: true } });
  for (const cam of cameras) {
    if (control?.paused) break;

    const localImage = { cameraId: cam.id, fileType: "image", isDownloaded: true } as const;

    // Earliest not-yet-scanned local image frame for this camera.
    const first = await prisma.mediaFile.findFirst({
      where: { ...localImage, activityScannedAt: null },
      orderBy: [{ timestamp: "asc" }, { id: "asc" }],
      select: { id: true, timestamp: true },
    });
    if (!first) continue;

    // Seed the rolling frame with the immediately-preceding local frame (if any), and start
    // the forward walk strictly after it — which includes `first` as the first frame scored.
    let prevFrame: Frame | null = null;
    let prevTs = 0;
    let cursorTs = first.timestamp.getTime() - 1;
    let cursorId = Number.MAX_SAFE_INTEGER;

    const pred = await prisma.mediaFile.findFirst({
      where: {
        ...localImage,
        OR: [
          { timestamp: { lt: first.timestamp } },
          { timestamp: first.timestamp, id: { lt: first.id } },
        ],
      },
      orderBy: [{ timestamp: "desc" }, { id: "desc" }],
    });
    if (pred) {
      cursorTs = pred.timestamp.getTime();
      cursorId = pred.id;
      if (await isValid(pred.localPath)) {
        try {
          prevFrame = await loadFrame(pred.localPath, opts.downscale);
          prevTs = pred.timestamp.getTime();
        } catch {
          prevFrame = null;
        }
      }
    }

    let written = 0;
    walk: while (written < opts.batch) {
      if (control?.paused) break;
      const page = await prisma.mediaFile.findMany({
        where: {
          ...localImage,
          OR: [
            { timestamp: { gt: new Date(cursorTs) } },
            { timestamp: new Date(cursorTs), id: { gt: cursorId } },
          ],
        },
        orderBy: [{ timestamp: "asc" }, { id: "asc" }],
        take: PAGE,
        select: { id: true, timestamp: true, localPath: true, activityScannedAt: true },
      });
      if (page.length === 0) break;

      for (const f of page) {
        if (control?.paused) break walk;
        cursorTs = f.timestamp.getTime();
        cursorId = f.id;

        let currFrame: Frame | null = null;
        if (await isValid(f.localPath)) {
          try {
            currFrame = await loadFrame(f.localPath, opts.downscale);
          } catch {
            currFrame = null;
          }
        }

        // Only persist results for frames not yet scanned; already-scanned frames are loaded
        // purely to keep the rolling-neighbor chain intact.
        if (f.activityScannedAt === null) {
          const gapOk =
            prevFrame !== null && f.timestamp.getTime() - prevTs <= opts.maxGapSeconds * 1000;
          let score: number | null = null;
          let active = false;
          if (gapOk && currFrame && !isModeSwitch(prevFrame as Frame, currFrame, opts)) {
            score = scoreFrames(prevFrame as Frame, currFrame, opts);
            active = score > opts.scoreThreshold;
          }
          await prisma.mediaFile.update({
            where: { id: f.id },
            data: { activityScore: score, hasActivity: active, activityScannedAt: new Date() },
          });
          scanned++;
          if (active) flagged++;
          written++;
        }

        if (currFrame) {
          prevFrame = currFrame;
          prevTs = f.timestamp.getTime();
        }
        if (written >= opts.batch) break walk;
      }
    }
  }

  return { scanned, flagged };
}
