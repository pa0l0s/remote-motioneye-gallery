import { mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import ffmpegPath from "ffmpeg-static";
import ffmpeg from "fluent-ffmpeg";
import { isValidImage } from "./validate.js";

if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);

export async function generateImageThumb(src: string, out: string, width: number): Promise<void> {
  await mkdir(dirname(out), { recursive: true });
  await sharp(src).resize({ width }).webp({ quality: 80 }).toFile(out);
}

export async function generateVideoThumb(src: string, out: string, width: number): Promise<void> {
  await mkdir(dirname(out), { recursive: true });
  const frame = join(tmpdir(), `frame-${randomUUID()}.png`);
  try {
    await new Promise<void>((resolve, reject) => {
      ffmpeg(src)
        .on("end", () => resolve())
        .on("error", reject)
        .screenshots({ count: 1, timemarks: ["1"], filename: frame, folder: dirname(frame) });
    });
    await generateImageThumb(frame, out, width);
  } finally {
    // Never let extracted poster frames pile up in the container's /tmp (root FS).
    await rm(frame, { force: true });
  }
}

/**
 * Returns the thumb path, generating it if missing.
 *
 * For images, if the local source is invalid (corrupt / 0-byte) the optional
 * `refetch` callback is invoked to re-download a valid source, and generation is
 * retried once. If it still fails, the error propagates (frontend shows "no signal").
 */
export async function ensureThumb(
  localFile: string,
  thumbPath: string,
  fileType: "image" | "video",
  width = 320,
  refetch?: () => Promise<string>,
): Promise<string> {
  if (existsSync(thumbPath)) return thumbPath;
  if (fileType === "video") {
    await generateVideoThumb(localFile, thumbPath, width);
    return thumbPath;
  }

  if (refetch && !(await isValidImage(localFile))) {
    // Source is corrupt/0-byte: re-download and retry once.
    const fresh = await refetch();
    await generateImageThumb(fresh, thumbPath, width);
    return thumbPath;
  }

  try {
    await generateImageThumb(localFile, thumbPath, width);
  } catch (err) {
    if (!refetch) throw err;
    const fresh = await refetch();
    await generateImageThumb(fresh, thumbPath, width);
  }
  return thumbPath;
}
