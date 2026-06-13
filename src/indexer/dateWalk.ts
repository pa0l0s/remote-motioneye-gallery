function toIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Yields YYYY-MM-DD from `start` backward, up to `maxDays`, not past `floor`. */
export function* datesBackFrom(
  start: string,
  maxDays: number,
  floor?: string,
): Generator<string> {
  const d = new Date(`${start}T00:00:00Z`);
  for (let i = 0; i < maxDays; i++) {
    const iso = toIso(d);
    yield iso;
    if (floor && iso === floor) return;
    d.setUTCDate(d.getUTCDate() - 1);
  }
}
