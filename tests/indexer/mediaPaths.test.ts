import { describe, it, expect } from "vitest";
import { localPathFor, thumbPathFor, fileTypeFromMime } from "../../src/indexer/mediaPaths.js";

describe("mediaPaths", () => {
  it("joins media root, camera, and remote path (no double slash)", () => {
    expect(localPathFor("/media", "Camera1", "/2026-06-13/16-07-30.jpg")).toBe(
      "/media/Camera1/2026-06-13/16-07-30.jpg",
    );
  });
  it("derives a thumbnail path under config/thumbnails as .webp", () => {
    expect(thumbPathFor("/cfg", "Camera1", "/2026-06-13/16-07-30.jpg")).toBe(
      "/cfg/thumbnails/Camera1/2026-06-13/16-07-30.webp",
    );
  });
  it("maps mime to fileType", () => {
    expect(fileTypeFromMime("image/jpeg")).toBe("image");
    expect(fileTypeFromMime("video/mp4")).toBe("video");
    expect(fileTypeFromMime(undefined)).toBe("image"); // default
  });
});
