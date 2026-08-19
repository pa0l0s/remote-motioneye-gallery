/**
 * Detection filters. `detections` is a comma-separated list of kinds; a frame matches if
 * it satisfies ANY of them, which is what per-kind toggles in the UI mean.
 *
 * Kinds measured as carrying no signal are deliberately absent and are ignored rather
 * than rejected, so a stale bookmark cannot break the grid: rain (unverifiable from this
 * camera), vehicles (the model answers "1" whether or not a car is present), lens
 * obstruction (true almost always), and haze (unstable at the overcast boundary).
 */

import { SPIDER_ONLY_KINDS } from "../ai/normalize.js";

/**
 * What "fog" means when filtering. The model's 4-point visibility scale has an unstable
 * top step: measured 2026-08-19, the same frame comes back "fog" or "dense_fog" depending
 * only on the resize width (2025-09-26/06-27-30: fog at 640/1024/1536, dense_fog at
 * 1280/1920), with zero run-to-run variation at any fixed width. What IS stable is the
 * binary underneath — whether the background is gone. Requiring "dense_fog" alone made the
 * filter miss the two thickest fogs in the archive. Widening is safe rather than noisy:
 * across 1341 weather-labelled frames the model answered clear 1336, fog 3, dense_fog 2,
 * and never once slight_haze.
 */
export const FOG_VISIBILITY = ["fog", "dense_fog"] as const;

type Where = Record<string, unknown>;

// Must stay in step with the SPECIES list in src/ai/normalize.ts — adding a species means
// changing both files. "other" is the fallback bucket normalize.ts uses for an unrecognised
// animal, but it is still a real value that can land in the comma-wrapped column, so it is
// filterable too.
const SPECIES = ["bird", "dog", "cat", "horse", "deer", "boar", "fox", "hare", "spider", "other"];

function clauseFor(kind: string): Where | null {
  if (kind === "motion") return { hasActivity: true };
  if (kind === "people") return { aiPeopleCount: { gt: 0 } };
  // "any animal" deliberately excludes a frame whose only kind is the lens spider: it is
  // an insect on the glass rather than an animal in the scene, and folding it in here
  // would swamp the filter with night frames. It stays reachable as animal:spider.
  if (kind === "animal") {
    return { AND: [{ aiAnimalKinds: { not: null } }, { aiAnimalKinds: { not: SPIDER_ONLY_KINDS } }] };
  }
  if (kind === "fog") return { weatherVisibility: { in: [...FOG_VISIBILITY] } };
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
