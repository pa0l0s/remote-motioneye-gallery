/**
 * The model answers with free-form strings ("horse", "1 dog", "1 bird on a tire"),
 * so the raw array is kept verbatim and a controlled vocabulary is derived from it.
 *
 * `kindsColumn` is comma-wrapped (",bird,dog,") so that a species filter can use
 * `contains: ",bird,"` without also matching ",blackbird,".
 */

const SPECIES = ["bird", "dog", "cat", "horse", "deer", "boar", "fox", "hare", "spider"] as const;

/**
 * A spider on the lens is recorded like any other kind so it stays filterable, but it is
 * NOT what "an animal was in the scene" means: it is an insect sitting on the glass, and
 * counting it would flood the generic animal filter and the timeline rail with night
 * frames. Because `kindsColumn` joins the kinds sorted and comma-wrapped, a column equal
 * to exactly this string is the precise test for "spider and nothing else"; ",bird,spider,"
 * still counts as an animal, correctly.
 */
export const SPIDER_ONLY_KINDS = ",spider,";

export interface NormalisedAnimals {
  kinds: string[];
  kindsColumn: string | null;
  count: number;
}

export function normalizeAnimals(raw: string[]): NormalisedAnimals {
  const kinds = new Set<string>();
  for (const entry of raw) {
    // Word-boundary match so "blackbird" does not count as "bird".
    const words = entry.toLowerCase().split(/[^a-z]+/).filter(Boolean);
    const hit = SPECIES.find((s) => words.includes(s));
    kinds.add(hit ?? "other");
  }
  const sorted = [...kinds].sort();
  return {
    kinds: sorted,
    kindsColumn: sorted.length ? `,${sorted.join(",")},` : null,
    count: raw.length,
  };
}
