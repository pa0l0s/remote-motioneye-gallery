import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import ffmpegPath from "ffmpeg-static";
import ffmpeg from "fluent-ffmpeg";

if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);

export async function generateImageThumb(src: string, out: string, width: number): Promise<void> {
  await mkdir(dirname(out), { recursive: true });
  await sharp(src).resize({ width }).webp({ quality: 80 }).toFile(out);
}

export async function generateVideoThumb(src: string, out: string, width: number): Promise<void> {
  await mkdir(dirname(out), { recursive: true });
  const frame = join(tmpdir(), `frame-${randomUUID()}.png`);
  await new Promise<void>((resolve, reject) => {
    ffmpeg(src)
      .on("end", () => resolve())
      .on("error", reject)
      .screenshots({ count: 1, timemarks: ["1"], filename: frame, folder: dirname(frame) });
  });
  await generateImageThumb(frame, out, width);
}

/** Returns the thumb path, generating it if missing. */
export async function ensureThumb(
  localFile: string,
  thumbPath: string,
  fileType: "image" | "video",
  width = 320,
): Promise<string> {
  if (existsSync(thumbPath)) return thumbPath;
  if (fileType === "video") await generateVideoThumb(localFile, thumbPath, width);
  else await generateImageThumb(localFile, thumbPath, width);
  return thumbPath;
}
