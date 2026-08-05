/**
 * The model answers with free-form strings ("horse", "1 dog", "1 bird on a tire"),
 * so the raw array is kept verbatim and a controlled vocabulary is derived from it.
 *
 * `kindsColumn` is comma-wrapped (",bird,dog,") so that a species filter can use
 * `contains: ",bird,"` without also matching ",blackbird,".
 */

const SPECIES = ["bird", "dog", "cat", "horse", "deer", "boar", "fox", "hare"] as const;

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
