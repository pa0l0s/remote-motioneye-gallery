/**
 * Detection filters. `detections` is a comma-separated list of kinds; a frame matches if
 * it satisfies ANY of them, which is what per-kind toggles in the UI mean.
 *
 * Kinds measured as carrying no signal are deliberately absent and are ignored rather
 * than rejected, so a stale bookmark cannot break the grid: rain (unverifiable from this
 * camera), vehicles (the model answers "1" whether or not a car is present), lens
 * obstruction (true almost always), and haze (unstable at the overcast boundary).
 */

type Where = Record<string, unknown>;

// Must stay in step with the SPECIES list in src/ai/normalize.ts — adding a species means
// changing both files. "other" is the fallback bucket normalize.ts uses for an unrecognised
// animal, but it is still a real value that can land in the comma-wrapped column, so it is
// filterable too.
const SPECIES = ["bird", "dog", "cat", "horse", "deer", "boar", "fox", "hare", "other"];

function clauseFor(kind: string): Where | null {
  if (kind === "motion") return { hasActivity: true };
  if (kind === "people") return { aiPeopleCount: { gt: 0 } };
  if (kind === "animal") return { aiAnimalKinds: { not: null } };
  if (kind === "fog") return { weatherVisibility: "dense_fog" };
  if (kind === "snow") return { weatherPrecipitation: "snow" };
  if (kind === "snow_ground") return { weatherSnowOnGround: true };
  if (kind === "night") return { isNightIr: true };
  if (kind.startsWith("animal:")) {
    const species = kind.slice("animal:".length);
    // Comma-wrapped storage makes this an exact species match, not a substring match.
    return SPECIES.includes(species) ? { aiAnimalKinds: { contains: `,${species},` } } : null;
  }
  return null;
}

export function buildDetectionWhere(spec: string | undefined): Where | null {
  if (!spec) return null;
  const clauses = spec
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(clauseFor)
    .filter((c): c is Where => c !== null);
  return clauses.length ? { OR: clauses } : null;
}

export function buildCoverageWhere(spec: string | undefined): Where | null {
  if (spec === "basic") return { activityScannedAt: { not: null } };
  if (spec === "ai") return { aiScannedAt: { not: null } };
  if (spec === "both") {
    return { AND: [{ activityScannedAt: { not: null } }, { aiScannedAt: { not: null } }] };
  }
  if (spec === "none") return { AND: [{ activityScannedAt: null }, { aiScannedAt: null }] };
  return null;
}
