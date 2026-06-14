import { statSync } from "node:fs";
import sharp from "sharp";

/** True if the file exists and its size is exactly 0 bytes. */
export function isZeroByte(path: string): boolean {
  try {
    return statSync(path).size === 0;
  } catch {
    return false;
  }
}

/**
 * True if `path` is a readable image (sharp can parse its metadata).
 * Returns false if the file is missing, 0 bytes, or sharp throws (corrupt/unreadable).
 */
export async function isValidImage(path: string): Promise<boolean> {
  try {
    if (statSync(path).size === 0) return false;
  } catch {
    return false;
  }
  try {
    const meta = await sharp(path).metadata();
    return Boolean(meta.width && meta.height);
  } catch {
    return false;
  }
}
