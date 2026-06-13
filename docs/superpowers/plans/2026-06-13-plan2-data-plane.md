# Data Plane Implementation Plan (Plan 2 of 5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Index the remote archive into SQLite by walking per-date, serve media on demand (download-once, cache forever, generate thumbnails locally), and expose read APIs for the time-series grid, activity histogram, and time seek.

**Architecture:** A shared rate-limited fetch gate funnels all remote access. A background indexer walks calendar dates (newest first), stores metadata only, and reconciles against local disk so pre-synced files cost zero bytes. A media store downloads missing files on demand (preserving structure, never overwriting) and a thumbnail service renders previews into the config volume. Read routes paginate by timestamp keyset and aggregate counts for the timeline.

**Tech Stack:** Builds on Plan 1 (Fastify, Prisma/SQLite, undici). Adds `sharp` (image thumbs), `ffmpeg-static` + `fluent-ffmpeg` (video poster frames).

**Prerequisite:** Plan 1 complete (config, MotionEyeClient, Prisma schema incl. MediaFile/IndexCursor).

---

## File Structure

- `src/db.ts` — Prisma client singleton
- `src/remote/fetchGate.ts` — concurrency-limited queue with retry/backoff/timeout
- `src/motioneye/client.ts` — extend with `downloadStream()` (Plan 1 file)
- `src/util/size.ts` — parse `sizeStr` ("606.2 kB") → bytes
- `src/indexer/dateWalk.ts` — date sequence generator
- `src/indexer/mediaPaths.ts` — local/thumbnail path computation + fileType
- `src/indexer/indexer.ts` — the per-date crawl + reconcile + cursor
- `src/media/store.ts` — ensureDownloaded (download-once, no overwrite)
- `src/media/thumbnails.ts` — ensureThumb (sharp / ffmpeg)
- `src/routes/media.ts` — `/api/media`, `/api/media/:id/file`, `/api/media/:id/thumb`
- `src/routes/timeline.ts` — `/api/cameras/:id/histogram`, `/api/cameras/:id/seek`
- `tests/helpers/testDb.ts` — fresh sqlite + Prisma for DB-touching tests
- `tests/...` — colocated

---

### Task 1: Dependencies + Prisma singleton + test DB helper

**Files:**
- Modify: `package.json` (add deps)
- Create: `src/db.ts`
- Create: `tests/helpers/testDb.ts`

- [ ] **Step 1: Add dependencies**

Run:
```bash
npm install sharp fluent-ffmpeg ffmpeg-static
npm install -D @types/fluent-ffmpeg
```
Expected: packages added. If install scripts are gated, run `npm approve-scripts sharp` (and any others listed).

- [ ] **Step 2: Create the Prisma client singleton**

```ts
// src/db.ts
import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient();
```

- [ ] **Step 3: Create the test DB helper**

```ts
// tests/helpers/testDb.ts
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";

/** Creates a throwaway sqlite DB with the current schema and returns a client. */
export function makeTestDb(): { prisma: PrismaClient; url: string } {
  const dir = mkdtempSync(join(tmpdir(), "meg-test-"));
  const url = `file:${join(dir, "test.db")}`;
  execSync("npx prisma db push --skip-generate --accept-data-loss", {
    env: { ...process.env, DATABASE_URL: url },
    stdio: "ignore",
  });
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  return { prisma, url };
}
```

- [ ] **Step 4: Verify the helper boots a DB**

Create `tests/helpers/testDb.smoke.test.ts`:
```ts
import { describe, it, expect, afterAll } from "vitest";
import { makeTestDb } from "./testDb.js";

const { prisma } = makeTestDb();
afterAll(async () => { await prisma.$disconnect(); });

describe("makeTestDb", () => {
  it("can create and read a camera", async () => {
    const c = await prisma.camera.create({ data: { motionEyeId: 1, name: "Camera1" } });
    expect(c.id).toBeGreaterThan(0);
    expect(await prisma.camera.count()).toBe(1);
  });
});
```

Run: `npx vitest run tests/helpers/testDb.smoke.test.ts`
Expected: PASS (1 test). (First run is slower due to `prisma db push`.)

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/db.ts tests/helpers
git commit -m "feat: add media deps, Prisma singleton, test DB helper"
```

---

### Task 2: Parse sizeStr → bytes

**Files:**
- Create: `src/util/size.ts`
- Test: `tests/util/size.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { parseSizeStr } from "../../src/util/size.js";

describe("parseSizeStr", () => {
  it("parses kB/MB/GB to bytes (SI, 1000-based to match motionEye)", () => {
    expect(parseSizeStr("606.2 kB")).toBe(606200);
    expect(parseSizeStr("1.5 MB")).toBe(1500000);
    expect(parseSizeStr("2 GB")).toBe(2000000000);
    expect(parseSizeStr("512 B")).toBe(512);
  });
  it("returns null for unparseable input", () => {
    expect(parseSizeStr("")).toBeNull();
    expect(parseSizeStr("n/a")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/util/size.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write minimal implementation**

```ts
// src/util/size.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/util/size.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/util/size.ts tests/util/size.test.ts
git commit -m "feat: parse motionEye sizeStr to bytes"
```

---

### Task 3: Date-walk generator

**Files:**
- Create: `src/indexer/dateWalk.ts`
- Test: `tests/indexer/dateWalk.test.ts`

**Background:** The indexer walks dates newest-first. This generator yields ISO `YYYY-MM-DD`
strings from a start date backward, stopping at an optional floor date.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { datesBackFrom } from "../../src/indexer/dateWalk.js";

describe("datesBackFrom", () => {
  it("yields dates newest-first", () => {
    const got = [...datesBackFrom("2026-06-13", 3)];
    expect(got).toEqual(["2026-06-13", "2026-06-12", "2026-06-11"]);
  });
  it("stops at the floor date inclusive", () => {
    const got = [...datesBackFrom("2026-06-13", 100, "2026-06-11")];
    expect(got).toEqual(["2026-06-13", "2026-06-12", "2026-06-11"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/indexer/dateWalk.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write minimal implementation**

```ts
// src/indexer/dateWalk.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/indexer/dateWalk.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/indexer/dateWalk.ts tests/indexer/dateWalk.test.ts
git commit -m "feat: date-walk generator (newest-first, floor)"
```

---

### Task 4: Shared remote-fetch gate

**Files:**
- Create: `src/remote/fetchGate.ts`
- Test: `tests/remote/fetchGate.test.ts`

**Background:** All remote access goes through one gate: a concurrency limiter plus
retry-with-backoff. Keeps the indexer and (later) timelapse from saturating GSM.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { FetchGate } from "../../src/remote/fetchGate.js";

describe("FetchGate", () => {
  it("never runs more than `concurrency` tasks at once", async () => {
    const gate = new FetchGate({ concurrency: 2, maxRetries: 0, baseDelayMs: 1 });
    let active = 0;
    let peak = 0;
    const task = () =>
      gate.run(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 20));
        active--;
        return true;
      });
    await Promise.all([task(), task(), task(), task(), task()]);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("retries the configured number of times then rethrows", async () => {
    const gate = new FetchGate({ concurrency: 1, maxRetries: 2, baseDelayMs: 1 });
    let calls = 0;
    await expect(
      gate.run(async () => {
        calls++;
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(calls).toBe(3); // initial + 2 retries
  });

  it("resolves if a retry succeeds", async () => {
    const gate = new FetchGate({ concurrency: 1, maxRetries: 3, baseDelayMs: 1 });
    let calls = 0;
    const res = await gate.run(async () => {
      calls++;
      if (calls < 2) throw new Error("transient");
      return "ok";
    });
    expect(res).toBe("ok");
    expect(calls).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/remote/fetchGate.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write minimal implementation**

```ts
// src/remote/fetchGate.ts
export interface FetchGateOptions {
  concurrency: number;
  maxRetries: number;
  baseDelayMs: number;
}

export class FetchGate {
  private active = 0;
  private queue: Array<() => void> = [];

  constructor(private readonly opts: FetchGateOptions) {}

  private async acquire(): Promise<void> {
    if (this.active < this.opts.concurrency) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active++;
  }

  private release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      let attempt = 0;
      for (;;) {
        try {
          return await fn();
        } catch (err) {
          if (attempt >= this.opts.maxRetries) throw err;
          const delay = this.opts.baseDelayMs * 2 ** attempt;
          await new Promise((r) => setTimeout(r, delay));
          attempt++;
        }
      }
    } finally {
      this.release();
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/remote/fetchGate.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/remote/fetchGate.ts tests/remote/fetchGate.test.ts
git commit -m "feat: shared remote-fetch gate (concurrency + retry/backoff)"
```

---

### Task 5: MotionEye client downloadStream

**Files:**
- Modify: `src/motioneye/client.ts`
- Test: `tests/motioneye/download.test.ts`

**Background:** Add a method that returns the raw response body stream + status for a file
URL, so the media store can pipe it to disk. Uses undici `request`.

- [ ] **Step 1: Write the failing test (URL building only, no network)**

```ts
import { describe, it, expect } from "vitest";
import { MotionEyeClient } from "../../src/motioneye/client.js";

const client = new MotionEyeClient({
  baseUrl: "http://eye.local:8765",
  username: "admin",
  password: "pw",
  timeoutMs: 1000,
});

describe("fileUrl", () => {
  it("builds a signed download URL for a picture", () => {
    const url = client.fileUrl("picture", 1, "/2026-06-13/16-07-30.jpg");
    expect(url).toContain("/picture/1/download//2026-06-13/16-07-30.jpg");
    expect(url).toMatch(/_signature=[0-9a-f]{40}/);
  });
  it("uses playback for movies", () => {
    const url = client.fileUrl("movie", 1, "/2026-06-13/clip.mp4");
    expect(url).toContain("/movie/1/playback//2026-06-13/clip.mp4");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/motioneye/download.test.ts`
Expected: FAIL until the method exists (fileUrl exists from Plan 1, but add downloadStream below; this test should actually PASS for fileUrl — run to confirm, then add downloadStream).

- [ ] **Step 3: Add `downloadStream` to MotionEyeClient**

Append this method inside the `MotionEyeClient` class in `src/motioneye/client.ts`:
```ts
  /** Open a streaming GET for a media file. Caller consumes `body`. */
  async downloadStream(
    kind: "picture" | "movie",
    cameraId: number,
    path: string,
  ): Promise<{ statusCode: number; body: NodeJS.ReadableStream }> {
    const url = this.fileUrl(kind, cameraId, path);
    const res = await request(url, {
      method: "GET",
      headersTimeout: this.opts.timeoutMs,
      bodyTimeout: this.opts.timeoutMs,
    });
    return { statusCode: res.statusCode, body: res.body };
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/motioneye/download.test.ts`
Expected: PASS (2 tests). Confirm `npx tsc -p tsconfig.json --noEmit` is clean.

- [ ] **Step 5: Commit**

```bash
git add src/motioneye/client.ts tests/motioneye/download.test.ts
git commit -m "feat: MotionEye client streaming download"
```

---

### Task 6: Media path helpers

**Files:**
- Create: `src/indexer/mediaPaths.ts`
- Test: `tests/indexer/mediaPaths.test.ts`

**Background:** Map a remote `path` to its on-disk local path under
`MEDIA_ROOT/<cameraName>/...`, the thumbnail path under `CONFIG_DIR/thumbnails/...`, and
the `fileType` from `mimeType`. Remote paths begin with `/` (e.g. `/2026-06-13/16-07-30.jpg`).

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/indexer/mediaPaths.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write minimal implementation**

```ts
// src/indexer/mediaPaths.ts
import { join } from "node:path";

export function localPathFor(mediaRoot: string, cameraName: string, remotePath: string): string {
  return join(mediaRoot, cameraName, remotePath);
}

export function thumbPathFor(configDir: string, cameraName: string, remotePath: string): string {
  const webp = remotePath.replace(/\.[^.]+$/, ".webp");
  return join(configDir, "thumbnails", cameraName, webp);
}

export function fileTypeFromMime(mime: string | undefined): "image" | "video" {
  return mime?.startsWith("video/") ? "video" : "image";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/indexer/mediaPaths.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/indexer/mediaPaths.ts tests/indexer/mediaPaths.test.ts
git commit -m "feat: media path + fileType helpers"
```

---

### Task 7: Indexer (per-date crawl + reconcile + cursor)

**Files:**
- Create: `src/indexer/indexer.ts`
- Test: `tests/indexer/indexer.test.ts`

**Background:** For a camera, walk dates newest-first. For each date, list pictures and
movies, upsert `MediaFile` rows (metadata only), set `isDownloaded` by checking local disk,
and advance the `IndexCursor`. Stop after `emptyDayLimit` consecutive empty days or at the
floor date. Takes its client and an `existsOnDisk` predicate as dependencies for testability.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { makeTestDb } from "../helpers/testDb.js";
import { indexCamera } from "../../src/indexer/indexer.js";
import type { RemoteEntry } from "../../src/motioneye/client.js";

const { prisma } = makeTestDb();
afterAll(async () => { await prisma.$disconnect(); });
beforeEach(async () => {
  await prisma.mediaFile.deleteMany();
  await prisma.indexCursor.deleteMany();
  await prisma.camera.deleteMany();
});

function fakeClient(byDate: Record<string, RemoteEntry[]>) {
  return {
    listDir: async (_kind: "picture" | "movie", _cam: number, prefix: string) =>
      _kind === "picture" ? (byDate[prefix] ?? []) : [],
  } as any;
}

describe("indexCamera", () => {
  it("inserts metadata rows and marks local files downloaded", async () => {
    const cam = await prisma.camera.create({ data: { motionEyeId: 1, name: "Camera1" } });
    const client = fakeClient({
      "2026-06-13": [
        { path: "/2026-06-13/16-07-30.jpg", timestamp: 1781359650, mimeType: "image/jpeg", sizeStr: "600 kB" },
      ],
    });
    const localSet = new Set(["/media/Camera1/2026-06-13/16-07-30.jpg"]);
    await indexCamera({
      prisma, client, camera: cam,
      mediaRoot: "/media", startDate: "2026-06-13", emptyDayLimit: 2,
      existsOnDisk: (p) => localSet.has(p),
    });
    const rows = await prisma.mediaFile.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].fileType).toBe("image");
    expect(rows[0].isDownloaded).toBe(true);
    expect(rows[0].sizeBytes).toBe(600000);
  });

  it("stops after emptyDayLimit consecutive empty days", async () => {
    const cam = await prisma.camera.create({ data: { motionEyeId: 1, name: "Camera1" } });
    const client = fakeClient({}); // every day empty
    await indexCamera({
      prisma, client, camera: cam,
      mediaRoot: "/media", startDate: "2026-06-13", emptyDayLimit: 3,
      existsOnDisk: () => false,
    });
    expect(await prisma.mediaFile.count()).toBe(0);
    const cur = await prisma.indexCursor.findUnique({ where: { cameraId: cam.id } });
    expect(cur?.status).toBe("idle");
  });

  it("is idempotent (re-running does not duplicate rows)", async () => {
    const cam = await prisma.camera.create({ data: { motionEyeId: 1, name: "Camera1" } });
    const client = fakeClient({
      "2026-06-13": [
        { path: "/2026-06-13/a.jpg", timestamp: 1781359650, mimeType: "image/jpeg", sizeStr: "1 kB" },
      ],
    });
    const args = {
      prisma, client, camera: cam,
      mediaRoot: "/media", startDate: "2026-06-13", emptyDayLimit: 1,
      existsOnDisk: () => false,
    };
    await indexCamera(args);
    await indexCamera(args);
    expect(await prisma.mediaFile.count()).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/indexer/indexer.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write minimal implementation**

```ts
// src/indexer/indexer.ts
import type { PrismaClient, Camera } from "@prisma/client";
import type { MotionEyeClient } from "../motioneye/client.js";
import { datesBackFrom } from "./dateWalk.js";
import { localPathFor, fileTypeFromMime } from "./mediaPaths.js";
import { parseSizeStr } from "../util/size.js";

export interface IndexArgs {
  prisma: PrismaClient;
  client: Pick<MotionEyeClient, "listDir">;
  camera: Camera;
  mediaRoot: string;
  startDate: string;
  emptyDayLimit: number;
  floorDate?: string;
  existsOnDisk: (localPath: string) => boolean;
}

export async function indexCamera(args: IndexArgs): Promise<void> {
  const { prisma, client, camera, mediaRoot, startDate, emptyDayLimit, floorDate, existsOnDisk } =
    args;

  await prisma.indexCursor.upsert({
    where: { cameraId: camera.id },
    create: { cameraId: camera.id, status: "running" },
    update: { status: "running", lastRunAt: new Date() },
  });

  let emptyStreak = 0;
  try {
    for (const date of datesBackFrom(startDate, 100000, floorDate)) {
      const pics = await client.listDir("picture", camera.motionEyeId, date);
      const movies = await client.listDir("movie", camera.motionEyeId, date);
      const entries = [...pics, ...movies];

      if (entries.length === 0) {
        emptyStreak++;
        if (emptyStreak >= emptyDayLimit) break;
        continue;
      }
      emptyStreak = 0;

      for (const e of entries) {
        const local = localPathFor(mediaRoot, camera.name, e.path);
        const ts = e.timestamp ? new Date(e.timestamp * 1000) : new Date();
        await prisma.mediaFile.upsert({
          where: { cameraId_remotePath: { cameraId: camera.id, remotePath: e.path } },
          create: {
            cameraId: camera.id,
            fileType: fileTypeFromMime(e.mimeType),
            remotePath: e.path,
            localPath: local,
            timestamp: ts,
            sizeBytes: e.sizeStr ? parseSizeStr(e.sizeStr) : null,
            isDownloaded: existsOnDisk(local),
          },
          update: {
            isDownloaded: existsOnDisk(local),
            sizeBytes: e.sizeStr ? parseSizeStr(e.sizeStr) : null,
          },
        });
      }
      await prisma.indexCursor.update({
        where: { cameraId: camera.id },
        data: { lastDateDir: date },
      });
    }
    await prisma.indexCursor.update({
      where: { cameraId: camera.id },
      data: { status: "idle", lastRunAt: new Date() },
    });
  } catch (err) {
    await prisma.indexCursor.update({
      where: { cameraId: camera.id },
      data: { status: "error" },
    });
    throw err;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/indexer/indexer.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/indexer/indexer.ts tests/indexer/indexer.test.ts
git commit -m "feat: per-date indexer with local reconcile and cursor"
```

---

### Task 8: Media store (download-once, never overwrite)

**Files:**
- Create: `src/media/store.ts`
- Test: `tests/media/store.test.ts`

**Background:** Given a `MediaFile`, ensure the bytes are on disk. If the file already
exists, do nothing (0 bytes, never overwrite). Otherwise stream it from the remote through
the fetch gate into the local path (creating parent dirs), then mark `isDownloaded=true`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { Readable } from "node:stream";
import { makeTestDb } from "../helpers/testDb.js";
import { FetchGate } from "../../src/remote/fetchGate.js";
import { ensureDownloaded } from "../../src/media/store.js";

const { prisma } = makeTestDb();
afterAll(async () => { await prisma.$disconnect(); });
beforeEach(async () => {
  await prisma.mediaFile.deleteMany();
  await prisma.camera.deleteMany();
});

const gate = new FetchGate({ concurrency: 1, maxRetries: 0, baseDelayMs: 1 });

async function seedFile(localPath: string, isDownloaded: boolean) {
  const cam = await prisma.camera.create({ data: { motionEyeId: 1, name: "Camera1" } });
  return prisma.mediaFile.create({
    data: {
      cameraId: cam.id, fileType: "image", remotePath: "/2026-06-13/a.jpg",
      localPath, timestamp: new Date(), isDownloaded,
    },
  });
}

describe("ensureDownloaded", () => {
  it("downloads and writes the file, preserving structure, when missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "store-"));
    const local = join(dir, "Camera1/2026-06-13/a.jpg");
    const mf = await seedFile(local, false);
    const client = {
      downloadStream: async () => ({ statusCode: 200, body: Readable.from([Buffer.from("JPEGDATA")]) }),
    } as any;
    await ensureDownloaded({ prisma, gate, client, mediaFile: mf });
    expect(existsSync(local)).toBe(true);
    expect(readFileSync(local).toString()).toBe("JPEGDATA");
    const updated = await prisma.mediaFile.findUnique({ where: { id: mf.id } });
    expect(updated?.isDownloaded).toBe(true);
  });

  it("does not overwrite an existing file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "store-"));
    const local = join(dir, "Camera1/2026-06-13/a.jpg");
    mkdirSync(dirname(local), { recursive: true });
    writeFileSync(local, "ORIGINAL");
    const mf = await seedFile(local, false);
    let called = false;
    const client = {
      downloadStream: async () => { called = true; return { statusCode: 200, body: Readable.from(["X"]) }; },
    } as any;
    await ensureDownloaded({ prisma, gate, client, mediaFile: mf });
    expect(readFileSync(local).toString()).toBe("ORIGINAL");
    expect(called).toBe(false);
    const updated = await prisma.mediaFile.findUnique({ where: { id: mf.id } });
    expect(updated?.isDownloaded).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/media/store.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write minimal implementation**

```ts
// src/media/store.ts
import { createWriteStream, existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { pipeline } from "node:stream/promises";
import type { PrismaClient, MediaFile } from "@prisma/client";
import type { MotionEyeClient } from "../motioneye/client.js";
import type { FetchGate } from "../remote/fetchGate.js";

export interface EnsureArgs {
  prisma: PrismaClient;
  gate: FetchGate;
  client: Pick<MotionEyeClient, "downloadStream">;
  mediaFile: MediaFile;
}

export async function ensureDownloaded(args: EnsureArgs): Promise<string> {
  const { prisma, gate, client, mediaFile } = args;
  const local = mediaFile.localPath;

  if (existsSync(local)) {
    if (!mediaFile.isDownloaded) {
      await prisma.mediaFile.update({ where: { id: mediaFile.id }, data: { isDownloaded: true } });
    }
    return local;
  }

  await mkdir(dirname(local), { recursive: true });
  const kind = mediaFile.fileType === "video" ? "movie" : "picture";

  await gate.run(async () => {
    const { statusCode, body } = await client.downloadStream(
      kind,
      // motionEyeId is needed; callers pass a MediaFile whose camera has it.
      // We resolve it via the stored relation id at the route layer; here cameraId is the
      // local id, so the route must pass a client already bound. To keep this unit simple,
      // the route resolves motionEyeId. See Task 10 wiring.
      (mediaFile as MediaFile & { motionEyeId: number }).motionEyeId ?? mediaFile.cameraId,
      mediaFile.remotePath,
    );
    if (statusCode >= 400) throw new Error(`download ${mediaFile.remotePath} -> HTTP ${statusCode}`);
    await pipeline(body, createWriteStream(local));
  });

  await prisma.mediaFile.update({ where: { id: mediaFile.id }, data: { isDownloaded: true } });
  return local;
}
```

> Note: the `motionEyeId` resolution is finalized in Task 10, where the route loads the
> camera and passes the correct remote id. The test above uses `cameraId` since the fake
> client ignores it.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/media/store.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/media/store.ts tests/media/store.test.ts
git commit -m "feat: media store download-once with no-overwrite guarantee"
```

---

### Task 9: Thumbnail service

**Files:**
- Create: `src/media/thumbnails.ts`
- Test: `tests/media/thumbnails.test.ts`

**Background:** Generate a small `.webp` thumbnail into the config volume. Images use
`sharp`; videos extract a poster frame with ffmpeg then `sharp`-resize. If the thumb
already exists, return it. Tests cover the image path (deterministic with a generated PNG);
the video path is exercised manually in Task 14's live check.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { generateImageThumb } from "../../src/media/thumbnails.js";

describe("generateImageThumb", () => {
  it("writes a resized webp thumbnail", async () => {
    const dir = mkdtempSync(join(tmpdir(), "thumb-"));
    const src = join(dir, "src.png");
    const out = join(dir, "out/thumb.webp");
    await sharp({ create: { width: 800, height: 600, channels: 3, background: "red" } })
      .png()
      .toFile(src);
    await generateImageThumb(src, out, 320);
    expect(existsSync(out)).toBe(true);
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.width).toBe(320);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/media/thumbnails.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write minimal implementation**

```ts
// src/media/thumbnails.ts
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import ffmpegPath from "ffmpeg-static";
import ffmpeg from "fluent-ffmpeg";

if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);

export async function generateImageThumb(src: string, out: string, width: number): Promise<void> {
  await mkdir(dirname(out), { recursive: true });
  await sharp(src).resize({ width }).webp({ quality: 80 }).toFile(out);
}

export async function generateVideoThumb(src: string, out: string, width: number): Promise<void> {
  await mkdir(dirname(out), { recursive: true });
  const frame = join(tmpdir(), `frame-${randomUUID()}.png`);
  await new Promise<void>((resolve, reject) => {
    ffmpeg(src)
      .on("end", () => resolve())
      .on("error", reject)
      .screenshots({ count: 1, timemarks: ["1"], filename: frame, folder: dirname(frame) });
  });
  await generateImageThumb(frame, out, width);
}

/** Returns the thumb path, generating it if missing. */
export async function ensureThumb(
  localFile: string,
  thumbPath: string,
  fileType: "image" | "video",
  width = 320,
): Promise<string> {
  if (existsSync(thumbPath)) return thumbPath;
  if (fileType === "video") await generateVideoThumb(localFile, thumbPath, width);
  else await generateImageThumb(localFile, thumbPath, width);
  return thumbPath;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/media/thumbnails.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add src/media/thumbnails.ts tests/media/thumbnails.test.ts
git commit -m "feat: thumbnail service (sharp images, ffmpeg video posters)"
```

---

### Task 10: Media routes (list, file, thumb)

**Files:**
- Create: `src/routes/media.ts`
- Test: `tests/routes/media.test.ts`

**Background:** Three routes. `/api/media` is a keyset-paginated, time-ordered list.
`/api/media/:id/file` ensures the file is local then streams it. `/api/media/:id/thumb`
ensures the thumb then streams it. The route resolves the camera's `motionEyeId` and binds
a download client. For testability, the route module takes injected `deps`.

- [ ] **Step 1: Write the failing test (list pagination + 404)**

```ts
import { describe, it, expect, afterAll, beforeEach } from "vitest";
import Fastify from "fastify";
import { makeTestDb } from "../helpers/testDb.js";
import { registerMediaRoutes } from "../../src/routes/media.js";

const { prisma } = makeTestDb();
afterAll(async () => { await prisma.$disconnect(); });
beforeEach(async () => {
  await prisma.mediaFile.deleteMany();
  await prisma.camera.deleteMany();
});

async function app() {
  const a = Fastify();
  registerMediaRoutes(a, { prisma, ensureFile: async () => "/x", ensureThumbFor: async () => "/x.webp" });
  return a;
}

describe("GET /api/media", () => {
  it("returns rows ordered by timestamp ascending, keyset paginated", async () => {
    const cam = await prisma.camera.create({ data: { motionEyeId: 1, name: "Camera1" } });
    for (let i = 0; i < 5; i++) {
      await prisma.mediaFile.create({
        data: {
          cameraId: cam.id, fileType: "image", remotePath: `/d/${i}.jpg`,
          localPath: `/m/${i}.jpg`, timestamp: new Date(1000 + i * 1000),
        },
      });
    }
    const a = await app();
    const res = await a.inject({ method: "GET", url: `/api/media?cameraId=${cam.id}&limit=2` });
    expect(res.statusCode).toBe(200);
    const page = res.json();
    expect(page.items).toHaveLength(2);
    expect(page.items[0].remotePath).toBe("/d/0.jpg");
    expect(page.nextCursor).toBeTruthy();

    const res2 = await a.inject({
      method: "GET",
      url: `/api/media?cameraId=${cam.id}&limit=2&cursor=${encodeURIComponent(page.nextCursor)}`,
    });
    expect(res2.json().items[0].remotePath).toBe("/d/2.jpg");
  });

  it("404s an unknown media file", async () => {
    const a = await app();
    const res = await a.inject({ method: "GET", url: "/api/media/9999/thumb" });
    expect(res.statusCode).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/routes/media.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write minimal implementation**

```ts
// src/routes/media.ts
import { createReadStream } from "node:fs";
import type { FastifyInstance } from "fastify";
import type { PrismaClient, MediaFile } from "@prisma/client";

export interface MediaDeps {
  prisma: PrismaClient;
  ensureFile: (mf: MediaFile) => Promise<string>;
  ensureThumbFor: (mf: MediaFile) => Promise<string>;
}

// Cursor encodes "<timestampMs>_<id>" for stable keyset pagination.
function encodeCursor(mf: { timestamp: Date; id: number }): string {
  return `${mf.timestamp.getTime()}_${mf.id}`;
}
function decodeCursor(c: string): { ts: number; id: number } | null {
  const m = c.match(/^(\d+)_(\d+)$/);
  return m ? { ts: Number(m[1]), id: Number(m[2]) } : null;
}

export function registerMediaRoutes(app: FastifyInstance, deps: MediaDeps): void {
  const { prisma } = deps;

  app.get("/api/media", async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const cameraId = Number(q.cameraId);
    const limit = Math.min(Number(q.limit ?? "100"), 500);
    const cur = q.cursor ? decodeCursor(q.cursor) : null;

    const where: Record<string, unknown> = { cameraId };
    if (q.from || q.to) {
      where.timestamp = {
        ...(q.from ? { gte: new Date(q.from) } : {}),
        ...(q.to ? { lte: new Date(q.to) } : {}),
      };
    }
    if (cur) {
      where.OR = [
        { timestamp: { gt: new Date(cur.ts) } },
        { timestamp: new Date(cur.ts), id: { gt: cur.id } },
      ];
    }

    const items = await prisma.mediaFile.findMany({
      where,
      orderBy: [{ timestamp: "asc" }, { id: "asc" }],
      take: limit,
    });
    const nextCursor = items.length === limit ? encodeCursor(items[items.length - 1]) : null;
    return { items, nextCursor };
  });

  async function load(id: number): Promise<MediaFile | null> {
    return prisma.mediaFile.findUnique({ where: { id } });
  }

  app.get("/api/media/:id/file", async (req, reply) => {
    const mf = await load(Number((req.params as { id: string }).id));
    if (!mf) return reply.code(404).send({ error: "not found" });
    const path = await deps.ensureFile(mf);
    reply.header("content-type", mf.fileType === "video" ? "video/mp4" : "image/jpeg");
    return reply.send(createReadStream(path));
  });

  app.get("/api/media/:id/thumb", async (req, reply) => {
    const mf = await load(Number((req.params as { id: string }).id));
    if (!mf) return reply.code(404).send({ error: "not found" });
    const path = await deps.ensureThumbFor(mf);
    reply.header("content-type", "image/webp");
    return reply.send(createReadStream(path));
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/routes/media.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/routes/media.ts tests/routes/media.test.ts
git commit -m "feat: media routes (keyset list, file, thumb)"
```

---

### Task 11: Histogram route

**Files:**
- Create: `src/routes/timeline.ts`
- Test: `tests/routes/timeline.test.ts`

**Background:** Aggregate frame counts per time bucket. Prisma stores SQLite `DateTime` as
milliseconds; use a raw query with `strftime` on `timestamp/1000`. Bucket maps to a format
string: day `%Y-%m-%d`, hour `%Y-%m-%d %H`, minute `%Y-%m-%d %H:%M`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, afterAll, beforeEach } from "vitest";
import Fastify from "fastify";
import { makeTestDb } from "../helpers/testDb.js";
import { registerTimelineRoutes } from "../../src/routes/timeline.js";

const { prisma } = makeTestDb();
afterAll(async () => { await prisma.$disconnect(); });
beforeEach(async () => {
  await prisma.mediaFile.deleteMany();
  await prisma.camera.deleteMany();
});

describe("GET /api/cameras/:id/histogram", () => {
  it("buckets counts by day", async () => {
    const cam = await prisma.camera.create({ data: { motionEyeId: 1, name: "Camera1" } });
    const mk = (iso: string) => prisma.mediaFile.create({
      data: { cameraId: cam.id, fileType: "image", remotePath: iso, localPath: iso, timestamp: new Date(iso) },
    });
    await mk("2026-06-13T01:00:00Z");
    await mk("2026-06-13T05:00:00Z");
    await mk("2026-06-12T05:00:00Z");
    const a = Fastify();
    registerTimelineRoutes(a, { prisma });
    const res = await a.inject({ method: "GET", url: `/api/cameras/${cam.id}/histogram?bucket=day` });
    expect(res.statusCode).toBe(200);
    const buckets = res.json() as Array<{ bucket: string; count: number }>;
    const map = Object.fromEntries(buckets.map((b) => [b.bucket, b.count]));
    expect(map["2026-06-13"]).toBe(2);
    expect(map["2026-06-12"]).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/routes/timeline.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write minimal implementation**

```ts
// src/routes/timeline.ts
import type { FastifyInstance } from "fastify";
import { Prisma, type PrismaClient } from "@prisma/client";

export interface TimelineDeps {
  prisma: PrismaClient;
}

const BUCKET_FMT: Record<string, string> = {
  day: "%Y-%m-%d",
  hour: "%Y-%m-%d %H",
  minute: "%Y-%m-%d %H:%M",
};

export function registerTimelineRoutes(app: FastifyInstance, deps: TimelineDeps): void {
  const { prisma } = deps;

  app.get("/api/cameras/:id/histogram", async (req, reply) => {
    const cameraId = Number((req.params as { id: string }).id);
    const q = req.query as Record<string, string | undefined>;
    const fmt = BUCKET_FMT[q.bucket ?? "day"];
    if (!fmt) return reply.code(400).send({ error: "bad bucket" });

    const rows = await prisma.$queryRaw<Array<{ bucket: string; count: bigint }>>(Prisma.sql`
      SELECT strftime(${fmt}, timestamp / 1000, 'unixepoch') AS bucket, COUNT(*) AS count
      FROM MediaFile
      WHERE cameraId = ${cameraId}
      GROUP BY bucket
      ORDER BY bucket ASC
    `);
    return rows.map((r) => ({ bucket: r.bucket, count: Number(r.count) }));
  });

  app.get("/api/cameras/:id/seek", async (req) => {
    const cameraId = Number((req.params as { id: string }).id);
    const q = req.query as Record<string, string | undefined>;
    const at = new Date(q.at ?? new Date().toISOString());
    const index = await prisma.mediaFile.count({
      where: { cameraId, timestamp: { lt: at } },
    });
    const target = await prisma.mediaFile.findFirst({
      where: { cameraId, timestamp: { gte: at } },
      orderBy: { timestamp: "asc" },
    });
    return { index, mediaId: target?.id ?? null };
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/routes/timeline.test.ts`
Expected: PASS (1 test). If the bucket keys are wrong, confirm Prisma stores DateTime as ms
(divide by 1000 for `unixepoch`); adjust if a future Prisma version changes storage.

- [ ] **Step 5: Commit**

```bash
git add src/routes/timeline.ts tests/routes/timeline.test.ts
git commit -m "feat: timeline histogram + seek routes"
```

---

### Task 12: Seek route test

**Files:**
- Modify: `tests/routes/timeline.test.ts` (add seek coverage)

- [ ] **Step 1: Add the failing test**

```ts
describe("GET /api/cameras/:id/seek", () => {
  it("returns the ordinal index and the nearest forward mediaId", async () => {
    const cam = await prisma.camera.create({ data: { motionEyeId: 1, name: "Camera1" } });
    const ids: number[] = [];
    for (const iso of ["2026-06-13T01:00:00Z", "2026-06-13T02:00:00Z", "2026-06-13T03:00:00Z"]) {
      const m = await prisma.mediaFile.create({
        data: { cameraId: cam.id, fileType: "image", remotePath: iso, localPath: iso, timestamp: new Date(iso) },
      });
      ids.push(m.id);
    }
    const a = Fastify();
    registerTimelineRoutes(a, { prisma });
    const res = await a.inject({
      method: "GET",
      url: `/api/cameras/${cam.id}/seek?at=2026-06-13T02:00:00Z`,
    });
    expect(res.json()).toEqual({ index: 1, mediaId: ids[1] });
  });
});
```

- [ ] **Step 2: Run to verify it passes** (the route already exists from Task 11)

Run: `npx vitest run tests/routes/timeline.test.ts`
Expected: PASS (2 tests total).

- [ ] **Step 3: Commit**

```bash
git add tests/routes/timeline.test.ts
git commit -m "test: cover seek route"
```

---

### Task 13: Indexer runner + background loop

**Files:**
- Create: `src/indexer/runner.ts`
- Modify: `src/server.ts` (start the loop)
- Test: `tests/indexer/runner.test.ts`

**Background:** A runner discovers cameras from the remote, upserts them, then runs
`indexCamera` for each using the real `existsOnDisk` (fs) and config values. The server
starts it on a timer (non-blocking). The runner takes injected deps for testing.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { makeTestDb } from "../helpers/testDb.js";
import { runIndexOnce } from "../../src/indexer/runner.js";

const { prisma } = makeTestDb();
afterAll(async () => { await prisma.$disconnect(); });
beforeEach(async () => {
  await prisma.mediaFile.deleteMany();
  await prisma.indexCursor.deleteMany();
  await prisma.camera.deleteMany();
});

describe("runIndexOnce", () => {
  it("upserts cameras then indexes each", async () => {
    const client = {
      listCameras: async () => [{ id: 1, name: "Camera1" }],
      listDir: async (kind: string, _id: number, prefix: string) =>
        kind === "picture" && prefix === "2026-06-13"
          ? [{ path: "/2026-06-13/a.jpg", timestamp: 1781359650, mimeType: "image/jpeg", sizeStr: "1 kB" }]
          : [],
    } as any;
    await runIndexOnce({
      prisma, client, mediaRoot: "/m", startDate: "2026-06-13",
      emptyDayLimit: 1, existsOnDisk: () => false,
    });
    expect(await prisma.camera.count()).toBe(1);
    expect(await prisma.mediaFile.count()).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/indexer/runner.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write minimal implementation**

```ts
// src/indexer/runner.ts
import type { PrismaClient } from "@prisma/client";
import type { MotionEyeClient } from "../motioneye/client.js";
import { indexCamera } from "./indexer.js";

export interface RunIndexArgs {
  prisma: PrismaClient;
  client: Pick<MotionEyeClient, "listCameras" | "listDir">;
  mediaRoot: string;
  startDate: string;
  emptyDayLimit: number;
  floorDate?: string;
  existsOnDisk: (localPath: string) => boolean;
}

export async function runIndexOnce(args: RunIndexArgs): Promise<void> {
  const cameras = await args.client.listCameras();
  for (const rc of cameras) {
    const camera = await args.prisma.camera.upsert({
      where: { motionEyeId: rc.id },
      create: { motionEyeId: rc.id, name: rc.name },
      update: { name: rc.name },
    });
    await indexCamera({
      prisma: args.prisma,
      client: args.client,
      camera,
      mediaRoot: args.mediaRoot,
      startDate: args.startDate,
      emptyDayLimit: args.emptyDayLimit,
      floorDate: args.floorDate,
      existsOnDisk: args.existsOnDisk,
    });
  }
}

export function startIndexLoop(
  runOnce: () => Promise<void>,
  intervalSeconds: number,
  onError: (err: unknown) => void,
): () => void {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      await runOnce();
    } catch (err) {
      onError(err);
    }
    if (!stopped) setTimeout(tick, intervalSeconds * 1000);
  };
  void tick();
  return () => {
    stopped = true;
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/indexer/runner.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Wire into the server**

In `src/server.ts`, after registering routes, add the data-plane wiring. Replace the
`registerCamerasRoute(app, client)` line block with:
```ts
import { existsSync } from "node:fs";
import { prisma } from "./db.js";
import { FetchGate } from "./remote/fetchGate.js";
import { registerMediaRoutes } from "./routes/media.js";
import { registerTimelineRoutes } from "./routes/timeline.js";
import { ensureDownloaded } from "./media/store.js";
import { ensureThumb } from "./media/thumbnails.js";
import { thumbPathFor } from "./indexer/mediaPaths.js";
import { runIndexOnce, startIndexLoop } from "./indexer/runner.js";
import type { MediaFile } from "@prisma/client";

// ...inside buildApp(), after `registerAuth(...)` and `app.get("/health", ...)`:
const gate = new FetchGate({ concurrency: Number(process.env.REMOTE_CONCURRENCY ?? "1"), maxRetries: cfg.maxRetries, baseDelayMs: 1000 });

// Resolve a camera's motionEyeId and bind download for a MediaFile.
async function ensureFile(mf: MediaFile): Promise<string> {
  const cam = await prisma.camera.findUnique({ where: { id: mf.cameraId } });
  const bound = {
    downloadStream: (k: "picture" | "movie", _id: number, p: string) =>
      client.downloadStream(k, cam!.motionEyeId, p),
  };
  return ensureDownloaded({ prisma, gate, client: bound as typeof client, mediaFile: mf });
}
async function ensureThumbFor(mf: MediaFile): Promise<string> {
  const local = await ensureFile(mf);
  const cam = await prisma.camera.findUnique({ where: { id: mf.cameraId } });
  const thumb = thumbPathFor(cfg.configDir, cam!.name, mf.remotePath);
  return ensureThumb(local, thumb, mf.fileType as "image" | "video");
}

registerCamerasRoute(app, client);
registerMediaRoutes(app, { prisma, ensureFile, ensureThumbFor });
registerTimelineRoutes(app, { prisma });

// Background indexing (non-blocking).
const today = new Date().toISOString().slice(0, 10);
startIndexLoop(
  () =>
    runIndexOnce({
      prisma,
      client,
      mediaRoot: cfg.mediaRoot,
      startDate: today,
      emptyDayLimit: Number(process.env.INDEX_EMPTY_DAY_LIMIT ?? "30"),
      floorDate: process.env.INDEX_START_DATE,
      existsOnDisk: (p) => existsSync(p),
    }),
  cfg.indexIntervalSeconds,
  (err) => app.log.error(err),
);
```

> The `motionEyeId` resolution noted in Task 8 is satisfied here: `ensureFile` binds the
> remote id from the camera row, so the store's fallback is never relied upon in production.

- [ ] **Step 6: Run the full suite + typecheck**

Run: `npx vitest run && npx tsc -p tsconfig.json --noEmit`
Expected: all tests PASS; tsc clean.

- [ ] **Step 7: Commit**

```bash
git add src/indexer/runner.ts src/server.ts tests/indexer/runner.test.ts
git commit -m "feat: indexer runner + background loop wired into server"
```

---

### Task 14: Live data-plane verification (manual)

**Files:** none (uses `deploy.local.env`; writes only to temp dirs).

- [ ] **Step 1: Index a couple of recent days against the real remote into a temp DB**

Run:
```bash
set -a && . ./deploy.local.env && set +a
npm run build
DATABASE_URL="file:./live-check.db" npx prisma db push --skip-generate --accept-data-loss
node --input-type=module -e '
import { PrismaClient } from "@prisma/client";
import { MotionEyeClient } from "./dist/src/motioneye/client.js";
import { runIndexOnce } from "./dist/src/indexer/runner.js";
const prisma = new PrismaClient({ datasources: { db: { url: "file:./live-check.db" } } });
const client = new MotionEyeClient({ baseUrl: process.env.MOTIONEYE_URL, username: process.env.MOTIONEYE_USER, password: process.env.MOTIONEYE_PASSWORD, timeoutMs: 30000 });
await runIndexOnce({ prisma, client, mediaRoot: "/tmp/meg-media", startDate: new Date().toISOString().slice(0,10), emptyDayLimit: 2, existsOnDisk: () => false });
console.log("cameras:", await prisma.camera.count(), "media:", await prisma.mediaFile.count());
await prisma.$disconnect();
'
```
Expected: `cameras: 1` and `media:` a few hundred to ~1000 (a couple days of frames). Confirms
the indexer talks to the real API, parses timestamps/sizes, and persists rows. Clean up:
`rm -f live-check.db`.

- [ ] **Step 2: No commit** (verification only; `live-check.db` is gitignored).

---

## Self-Review

**Spec coverage (Plan 2 portion):**
- Shared remote-fetch gate (§5.1) → Task 4. ✓
- Indexer date-walk + reconcile + cursor + resilience (§7) → Tasks 3, 7, 13. ✓
- Media proxy download-once / no-overwrite / preserve structure (§8) → Task 8. ✓
- Thumbnails sharp/ffmpeg in config volume (§8) → Task 9. ✓
- Media list keyset (§9 grid feed) → Task 10. ✓
- Histogram + seek (§9) → Tasks 11, 12. ✓
- Timelapse subsystem (§10, §11) → **Plan 3** (intentional).
- Frontend (§9, §11, §12) → **Plan 4**; deploy (§13) → **Plan 5**.

**Placeholder scan:** No TODO/TBD. The Task 8 `motionEyeId` note is resolved concretely in
Task 13's `ensureFile`; the store's fallback exists only to keep that unit test simple.

**Type consistency:** `RemoteEntry` (path/timestamp/mimeType/sizeStr) matches Plan 1.
`indexCamera(IndexArgs)`, `runIndexOnce(RunIndexArgs)`, `ensureDownloaded(EnsureArgs)`,
`ensureThumb(local, thumb, fileType)`, `registerMediaRoutes(app, {prisma, ensureFile,
ensureThumbFor})`, `registerTimelineRoutes(app, {prisma})` are used consistently across
tasks and the server wiring.

**Risk flagged for execution:** Task 11 assumes Prisma stores SQLite `DateTime` as epoch
milliseconds (so `timestamp/1000` feeds `unixepoch`). The histogram test asserts real
bucket values, so a storage-format surprise fails loudly there rather than silently.
