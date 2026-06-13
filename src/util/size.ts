const UNITS: Record<string, number> = {
  B: 1,
  kB: 1000,
  MB: 1000 ** 2,
  GB: 1000 ** 3,
  TB: 1000 ** 4,
};

export function parseSizeStr(s: string): number | null {
  const m = s.trim().match(/^([\d.]+)\s*(B|kB|MB|GB|TB)$/);
  if (!m) return null;
  const value = parseFloat(m[1]);
  const unit = UNITS[m[2]];
  if (!Number.isFinite(value) || !unit) return null;
  return Math.round(value * unit);
}
