import sharp from "sharp";

export interface DiffOptions {
  /** Edge length the frame is downscaled to (NxN grayscale). */
  downscale: number;
  /** Per-pixel grayscale delta (0..255) above which a pixel counts as "changed". */
  pixelThreshold: number;
}

export const DEFAULT_DIFF: DiffOptions = { downscale: 64, pixelThreshold: 25 };

/**
 * Decode an image to a small grayscale raw buffer (length = downscale^2). Stretched to a
 * fixed square (`fit: "fill"`) so two frames always align pixel-for-pixel regardless of the
 * source aspect ratio.
 */
export async function loadGrayBuffer(path: string, downscale: number): Promise<Buffer> {
  return sharp(path)
    .greyscale()
    .resize(downscale, downscale, { fit: "fill" })
    .raw()
    .toBuffer();
}

function mean(buf: Buffer): number {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i];
  return sum / buf.length;
}

/**
 * Activity score between two equally-sized grayscale buffers: the fraction of pixels whose
 * brightness-normalized delta exceeds `pixelThreshold`.
 *
 * The current frame is shifted by (meanPrev - meanCurr) before comparing, so a *uniform*
 * lighting change (sunset/dawn/dusk, auto-exposure) cancels out and does not register as
 * activity — only localized changes (something entering the static scene) do.
 */
export function scoreBuffers(prev: Buffer, curr: Buffer, opts: DiffOptions): number {
  const n = Math.min(prev.length, curr.length);
  if (n === 0) return 0;
  const shift = mean(prev) - mean(curr);
  let changed = 0;
  for (let i = 0; i < n; i++) {
    if (Math.abs(prev[i] - (curr[i] + shift)) > opts.pixelThreshold) changed++;
  }
  return changed / n;
}

/**
 * Convenience: load both frames from disk and score them. Throws if either image is
 * unreadable (caller decides how to handle — typically: leave the frame unscanned).
 */
export async function frameActivityScore(
  prevPath: string,
  currPath: string,
  opts: DiffOptions = DEFAULT_DIFF,
): Promise<number> {
  const [a, b] = await Promise.all([
    loadGrayBuffer(prevPath, opts.downscale),
    loadGrayBuffer(currPath, opts.downscale),
  ]);
  return scoreBuffers(a, b, opts);
}
