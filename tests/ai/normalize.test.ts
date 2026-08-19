import { describe, it, expect } from "vitest";
import { normalizeAnimals, SPIDER_ONLY_KINDS } from "../../src/ai/normalize.js";

describe("normalizeAnimals", () => {
  it("maps the phrasings the model actually produced in testing", () => {
    expect(normalizeAnimals(["horse", "horse"])).toEqual({
      kinds: ["horse"], kindsColumn: ",horse,", count: 2,
    });
    expect(normalizeAnimals(["1 dog"])).toEqual({
      kinds: ["dog"], kindsColumn: ",dog,", count: 1,
    });
    expect(normalizeAnimals(["1 bird on a tire", "1 bird on the bow of the boat"])).toEqual({
      kinds: ["bird"], kindsColumn: ",bird,", count: 2,
    });
  });

  it("keeps distinct kinds sorted and de-duplicated", () => {
    const r = normalizeAnimals(["a dog", "bird", "Dog", "deer"]);
    expect(r.kinds).toEqual(["bird", "deer", "dog"]);
    expect(r.kindsColumn).toBe(",bird,deer,dog,");
    expect(r.count).toBe(4);
  });

  it("falls back to 'other' for an unrecognised animal", () => {
    expect(normalizeAnimals(["a badger"])).toEqual({
      kinds: ["other"], kindsColumn: ",other,", count: 1,
    });
  });

  it("recognises the lens spider as its own kind", () => {
    expect(normalizeAnimals(["spider"])).toEqual({
      kinds: ["spider"], kindsColumn: SPIDER_ONLY_KINDS, count: 1,
    });
    // A spider alongside a real animal must NOT collapse to the spider-only column, or
    // the frame would drop out of the "any animal" filter.
    expect(normalizeAnimals(["a large spider on the lens", "bird"]).kindsColumn).toBe(",bird,spider,");
  });

  it("returns nothing for an empty list", () => {
    expect(normalizeAnimals([])).toEqual({ kinds: [], kindsColumn: null, count: 0 });
  });

  it("does not match a species inside a longer word", () => {
    // "blackbird" must not register as "bird" via naive substring matching
    expect(normalizeAnimals(["blackbird"]).kinds).toEqual(["other"]);
  });
});
