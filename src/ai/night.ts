import { loadFrame } from "../activity/diff.js";

/**
 * Infrared night frames are detected classically, from colour saturation — the same
 * measure the basic pass already computes. This was 100% reliable on the reference set,
 * whereas the model called black IR frames "dense fog", so the weather question is only
 * ever asked of daylight frames.
 *
 * Note this reads diff.ts but writes nothing: loop B stays out of loop A's columns.
 */
export async function isNightFrame(path: string, colorThreshold: number): Promise<boolean> {
  const frame = await loadFrame(path, 64);
  return frame.colorfulness < colorThreshold;
}
