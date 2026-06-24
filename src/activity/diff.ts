import sharp from "sharp";

export interface DiffOptions {
  /** Edge length the frame is downscaled to (NxN). */
  downscale: number;
  /** Per-pixel grayscale delta (0..255) above which a pixel counts as "changed". */
  pixelThreshold: number;
  /**
   * Mean per-pixel saturation (max-min of RGB, 0..255) below which a frame is considered
   * grayscale / night-IR mode. A day(color)<->night(grayscale) switch is NOT activity.
   */
  colorThreshold: number;
}

export const DEFAULT_DIFF: DiffOptions = { downscale: 64, pixelThreshold: 25, colorThreshold: 8 };

/** A decoded frame: a small grayscale buffer for differencing + a colorfulness measure. */
export interface Frame {
  /** Grayscale raw buffer, length downscale^2. */
  gray: Buffer;
  /** Mean RGB saturation (0..255). ~0 for night/IR grayscale frames, higher for daytime color. */
  colorfulness: number;
}

/**
 * Decode an image to a small fixed square (`fit: "fill"` so frames always align pixel-for-pixel
 * regardless of source aspect ratio), forced to sRGB so we always get 3 channels. Returns the
 * grayscale buffer plus how colorful the frame is.
 */
export async function loadFrame(path: string, downscale: number): Promise<Frame> {
  const { data } = await sharp(path)
    .resize(downscale, downscale, { fit: "fill" })
    .toColourspace("srgb")
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const px = downscale * downscale;
  const gray = Buffer.allocUnsafe(px);
  let satSum = 0;
  for (let i = 0; i < px; i++) {
    const r = data[i * 3];
    const g = data[i * 3 + 1];
    const b = data[i * 3 + 2];
    gray[i] = (r * 299 + g * 587 + b * 114) / 1000;
    satSum += Math.max(r, g, b) - Math.min(r, g, b);
  }
  return { gray, colorfulness: satSum / px };
}

/**
 * True if the two frames are on opposite sides of the color/grayscale boundary — i.e. the
 * camera flipped between day (color) and night (IR/grayscale) mode. These transitions look
 * like a huge whole-frame change but are not real activity, so the scanner skips them.
 */
export function isModeSwitch(a: Frame, b: Frame, opts: DiffOptions): boolean {
  return a.colorfulness < opts.colorThreshold !== b.colorfulness < opts.colorThreshold;
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
 * lighting change (gradual sunset/dawn, auto-exposure) cancels out and does not register as
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

/** Score two already-decoded frames (grayscale differencing). */
export function scoreFrames(prev: Frame, curr: Frame, opts: DiffOptions): number {
  return scoreBuffers(prev.gray, curr.gray, opts);
}

/**
 * Convenience: load both frames from disk and score them, returning 0 for a day/night mode
 * switch. Throws if either image is unreadable.
 */
export async function frameActivityScore(
  prevPath: string,
  currPath: string,
  opts: DiffOptions = DEFAULT_DIFF,
): Promise<number> {
  const [a, b] = await Promise.all([
    loadFrame(prevPath, opts.downscale),
    loadFrame(currPath, opts.downscale),
  ]);
  if (isModeSwitch(a, b, opts)) return 0;
  return scoreFrames(a, b, opts);
}
