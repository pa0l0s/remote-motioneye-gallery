import { describe, it, expect } from "vitest";
import { buildDetectionWhere, buildCoverageWhere } from "../../src/media/detectionFilter.js";

describe("buildDetectionWhere", () => {
  it("returns null when nothing is selected — no filtering at all", () => {
    expect(buildDetectionWhere(undefined)).toBeNull();
    expect(buildDetectionWhere("")).toBeNull();
  });

  it("ORs the selected kinds together", () => {
    expect(buildDetectionWhere("motion,people")).toEqual({
      OR: [{ hasActivity: true }, { aiPeopleCount: { gt: 0 } }],
    });
  });

  it("matches a species without matching a longer word containing it", () => {
    expect(buildDetectionWhere("animal:bird")).toEqual({
      OR: [{ aiAnimalKinds: { contains: ",bird," } }],
    });
  });

  it("supports any-animal, weather and night", () => {
    expect(buildDetectionWhere("animal,fog,snow,snow_ground,night")).toEqual({
      OR: [
        { AND: [{ aiAnimalKinds: { not: null } }, { aiAnimalKinds: { not: ",spider," } }] },
        { weatherVisibility: "dense_fog" },
        { weatherPrecipitation: "snow" },
        { weatherSnowOnGround: true },
        { isNightIr: true },
      ],
    });
  });

  it("keeps the lens spider out of any-animal but filterable on its own", () => {
    // A spider sits on the glass, not in the scene: "animal" must skip a frame labelled
    // only ",spider," while animal:spider is the way to find those frames.
    expect(buildDetectionWhere("animal:spider")).toEqual({
      OR: [{ aiAnimalKinds: { contains: ",spider," } }],
    });
  });

  it("ignores unknown kinds rather than failing the request", () => {
    // "rain" and "vehicle" are deliberately not exposed — measured as carrying no signal
    expect(buildDetectionWhere("people,rain,vehicle")).toEqual({
      OR: [{ aiPeopleCount: { gt: 0 } }],
    });
    expect(buildDetectionWhere("rain")).toBeNull();
  });
});

describe("buildCoverageWhere", () => {
  it("distinguishes which pass has seen a frame", () => {
    expect(buildCoverageWhere("basic")).toEqual({ activityScannedAt: { not: null } });
    expect(buildCoverageWhere("ai")).toEqual({ aiScannedAt: { not: null } });
    expect(buildCoverageWhere("both")).toEqual({
      AND: [{ activityScannedAt: { not: null } }, { aiScannedAt: { not: null } }],
    });
    expect(buildCoverageWhere("none")).toEqual({
      AND: [{ activityScannedAt: null }, { aiScannedAt: null }],
    });
    expect(buildCoverageWhere(undefined)).toBeNull();
  });
});
