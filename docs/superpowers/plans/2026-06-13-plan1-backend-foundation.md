# Backend Foundation Implementation Plan (Plan 1 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the TypeScript/Fastify backend skeleton with the Prisma schema, a working MotionEye signed-request client, and itsdangerous cookie SSO that validates kukle-power's existing `admin_session` cookie.

**Architecture:** A Fastify server loads config from env, exposes a health route and an auth-gated `/api/cameras` route. The MotionEye client signs each request (sha1(password) key + HMAC-SHA1 over a normalized request string) and lists cameras. The auth layer re-implements itsdangerous `URLSafeTimedSerializer` verification so the gallery trusts the cookie kukle-power already set, with no JWT and no changes to kukle-power.

**Tech Stack:** Node 22, TypeScript, Fastify, Prisma + SQLite, Vitest, undici (HTTP), Pino logging.

---

## File Structure

- `package.json`, `tsconfig.json`, `vitest.config.ts` — project + test config
- `prisma/schema.prisma` — Camera, MediaFile, IndexCursor models
- `src/config.ts` — typed env loader
- `src/logger.ts` — Pino logger
- `src/motioneye/signature.ts` — request signature computation (pure, tested)
- `src/motioneye/client.ts` — MotionEyeClient (listCameras, listDir, fileUrl)
- `src/auth/itsdangerous.ts` — verifyTimedToken (pure, tested)
- `src/auth/middleware.ts` — Fastify preHandler that gates routes on the cookie
- `src/routes/cameras.ts` — GET /api/cameras
- `src/server.ts` — buildApp() factory + start
- `tests/...` — colocated under `tests/` mirroring `src/`

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "motioneye-proxy-gallery",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc -p tsconfig.json",
    "start": "node dist/server.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "prisma:generate": "prisma generate",
    "prisma:migrate": "prisma migrate dev"
  },
  "dependencies": {
    "@prisma/client": "^5.22.0",
    "fastify": "^5.1.0",
    "@fastify/cookie": "^11.0.1",
    "undici": "^6.21.0",
    "pino": "^9.5.0"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "prisma": "^5.22.0",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "outDir": "dist",
    "rootDir": ".",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "tests/**/*.ts"]
}
```

- [ ] **Step 3: Create vitest.config.ts**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
```

- [ ] **Step 4: Install dependencies**

Run: `npm install`
Expected: dependencies install, `node_modules/` created (gitignored).

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts
git commit -m "chore: scaffold backend project"
```

---

### Task 2: Prisma schema

**Files:**
- Create: `prisma/schema.prisma`

- [ ] **Step 1: Write the schema**

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "sqlite"
  url      = env("DATABASE_URL")
}

model Camera {
  id            Int            @id @default(autoincrement())
  motionEyeId   Int            @unique
  name          String
  createdAt     DateTime       @default(now())
  mediaFiles    MediaFile[]
  cursor        IndexCursor?
  timelapseJobs TimelapseJob[]
}

model MediaFile {
  id            Int      @id @default(autoincrement())
  camera        Camera   @relation(fields: [cameraId], references: [id])
  cameraId      Int
  fileType      String   // "image" | "video"
  remotePath    String
  localPath     String
  thumbnailPath String?
  timestamp     DateTime
  sizeBytes     Int?
  isDownloaded  Boolean  @default(false)
  thumbReady    Boolean  @default(false)
  createdAt     DateTime @default(now())

  @@unique([cameraId, remotePath])
  @@index([cameraId, timestamp])
}

model IndexCursor {
  cameraId    Int      @id
  camera      Camera   @relation(fields: [cameraId], references: [id])
  lastDateDir String?
  lastRunAt   DateTime?
  status      String   @default("idle") // idle | running | error
}

model TimelapseJob {
  id          String   @id @default(cuid())
  camera      Camera   @relation(fields: [cameraId], references: [id])
  cameraId    Int
  fromTs      DateTime
  toTs        DateTime
  fps         Int      @default(24)
  everyNth    Int      @default(1)
  width       Int?     // null = source resolution
  quality     String   @default("medium") // low | medium | high
  status      String   @default("pending") // pending | downloading | encoding | done | failed | canceled
  phase       String?
  progress    Float    @default(0) // 0..1
  framesTotal Int      @default(0)
  framesReady Int      @default(0)
  outputPath  String?
  error       String?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@index([status])
}
```

- [ ] **Step 2: Generate client against a temp DB**

Run: `DATABASE_URL="file:./dev.db" npx prisma migrate dev --name init`
Expected: migration created under `prisma/migrations/`, client generated, `dev.db` created (gitignored).

- [ ] **Step 3: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat: add Prisma schema for cameras, media files, index cursor"
```

---

### Task 3: Config loader

**Files:**
- Create: `src/config.ts`
- Test: `tests/config.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("reads required values from the environment", () => {
    const cfg = loadConfig({
      MOTIONEYE_URL: "http://eye.local:8765",
      MOTIONEYE_USER: "admin",
      MOTIONEYE_PASSWORD: "pw",
      SECRET_KEY: "shhh",
    });
    expect(cfg.motionEyeUrl).toBe("http://eye.local:8765");
    expect(cfg.authEnabled).toBe(true); // default
  });

  it("throws when a required value is missing", () => {
    expect(() => loadConfig({})).toThrow(/MOTIONEYE_URL/);
  });

  it("parses AUTH_ENABLED=false", () => {
    const cfg = loadConfig({
      MOTIONEYE_URL: "x",
      MOTIONEYE_USER: "u",
      MOTIONEYE_PASSWORD: "p",
      SECRET_KEY: "s",
      AUTH_ENABLED: "false",
    });
    expect(cfg.authEnabled).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL with "Cannot find module ../src/config.js" / loadConfig not defined.

- [ ] **Step 3: Write minimal implementation**

```ts
export interface AppConfig {
  motionEyeUrl: string;
  motionEyeUser: string;
  motionEyePassword: string;
  secretKey: string;
  authEnabled: boolean;
  kuklePowerLoginUrl: string;
  configDir: string;
  mediaRoot: string;
  indexIntervalSeconds: number;
  requestTimeoutMs: number;
  maxRetries: number;
}

function required(env: Record<string, string | undefined>, key: string): string {
  const v = env[key];
  if (!v) throw new Error(`Missing required env var: ${key}`);
  return v;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  return {
    motionEyeUrl: required(env, "MOTIONEYE_URL"),
    motionEyeUser: required(env, "MOTIONEYE_USER"),
    motionEyePassword: required(env, "MOTIONEYE_PASSWORD"),
    secretKey: required(env, "SECRET_KEY"),
    authEnabled: (env.AUTH_ENABLED ?? "true") !== "false",
    kuklePowerLoginUrl: env.KUKLE_POWER_LOGIN_URL ?? "/",
    configDir: env.CONFIG_DIR ?? "./data",
    mediaRoot: env.MEDIA_ROOT ?? "./media",
    indexIntervalSeconds: Number(env.INDEX_INTERVAL_SECONDS ?? "900"),
    requestTimeoutMs: Number(env.REQUEST_TIMEOUT_MS ?? "30000"),
    maxRetries: Number(env.MAX_RETRIES ?? "5"),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/config.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat: typed env config loader"
```

---

### Task 4: MotionEye request signature

**Files:**
- Create: `src/motioneye/signature.ts`
- Test: `tests/motioneye/signature.test.ts`

**Background (verified against the live server):** motionEye signs requests as
**plain `sha1("METHOD:path:body:key")`** (NOT HMAC) where `key = sha1(password).hexdigest()`.
The path normalization (from `motioneye-client/utils.py`): blank the scheme/host, drop the
`_signature` param, sort remaining params by name, re-encode each value like
`encodeURIComponent` (Python `quote(v, safe="!'()*~")`), rejoin as `path?a=1&b=2`, then
replace any char NOT in `[a-zA-Z0-9/?_.=&{}\[\]":, -]` (note the trailing space and hyphen
are allowed) with `-`. The key string is normalized the same way. `_username` must already
be in the query before signing (the server keeps it, strips only `_signature`). Because we
pass a relative path (no scheme/host), the blanking step is a no-op for us.

Golden vectors are pre-computed (password `pw`); no need to regenerate, but the Python that
produced them is below for reference.

```python
# Reference generator (already run; values baked into the test):
import hashlib, re
from urllib.parse import parse_qsl, quote, urlsplit, urlunsplit
SIG_RE = re.compile(r'[^a-zA-Z0-9/?_.=&{}\[\]":, -]')
def cs(method, path, body, key):
    parts = list(urlsplit(path))
    q = [t for t in parse_qsl(parts[3], keep_blank_values=True) if t[0] != "_signature"]
    q.sort(key=lambda t: t[0])
    qq = [(n, quote(v, safe="!'()*~")) for n, v in q]
    parts[0] = parts[1] = ""; parts[3] = "&".join(n + "=" + v for n, v in qq)
    p = SIG_RE.sub("-", urlunsplit(parts)); k = SIG_RE.sub("-", key)
    return hashlib.sha1(("%s:%s:%s:%s" % (method, p, body or "", k)).encode()).hexdigest().lower()
# sha1("pw")                                       = 1a91d62f7ca67399625a4368a6ab5d4a3baa6073
# cs GET /config/list?_username=admin              = 870e1a7823970553d92522a7d95d2d3cf81c8c24
# cs GET /picture/1/list?_username=admin&prefix=2026-06-13&with_stat=true
#                                                  = bae24e33e84e86556ba52b7ab7011a745c01f59a
```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { sha1Hex, computeSignature } from "../../src/motioneye/signature.js";

describe("motionEye signature", () => {
  it("derives the key as sha1(password) hex", () => {
    expect(sha1Hex("pw")).toBe("1a91d62f7ca67399625a4368a6ab5d4a3baa6073");
  });

  it("matches the live-server reference signature for /config/list", () => {
    const key = sha1Hex("pw");
    const sig = computeSignature("GET", "/config/list?_username=admin", "", key);
    expect(sig).toBe("870e1a7823970553d92522a7d95d2d3cf81c8c24");
  });

  it("matches the reference signature for a dated picture listing", () => {
    const key = sha1Hex("pw");
    const sig = computeSignature(
      "GET",
      "/picture/1/list?_username=admin&prefix=2026-06-13&with_stat=true",
      "",
      key,
    );
    expect(sig).toBe("bae24e33e84e86556ba52b7ab7011a745c01f59a");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/motioneye/signature.test.ts`
Expected: FAIL (module not found / functions undefined).

- [ ] **Step 3: Write minimal implementation**

```ts
import { createHash } from "node:crypto";

// Allowed set matches motioneye-client (space and hyphen included).
const SIG_RE = /[^a-zA-Z0-9/?_.=&{}\[\]":, -]/g;

export function sha1Hex(input: string): string {
  return createHash("sha1").update(input, "utf8").digest("hex");
}

function normalize(s: string): string {
  return s.replace(SIG_RE, "-");
}

/** Mirrors motioneye-client utils.compute_signature (plain SHA1, not HMAC). */
export function computeSignature(
  method: string,
  path: string,
  body: string,
  key: string,
): string {
  const qIndex = path.indexOf("?");
  const basePath = qIndex === -1 ? path : path.slice(0, qIndex);
  const rawQuery = qIndex === -1 ? "" : path.slice(qIndex + 1);

  const pairs = rawQuery
    .split("&")
    .filter((p) => p.length > 0)
    .map((p) => {
      const eq = p.indexOf("=");
      return eq === -1 ? [p, ""] : [p.slice(0, eq), p.slice(eq + 1)];
    })
    .filter(([k]) => k !== "_signature")
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    // Re-encode values like Python quote(v, safe="!'()*~") == encodeURIComponent.
    .map(([k, v]) => `${k}=${encodeURIComponent(decodeURIComponent(v))}`);

  const query = pairs.join("&");
  const np = normalize(`${basePath}?${query}`);
  const nkey = normalize(key);
  const msg = `${method}:${np}:${body ?? ""}:${nkey}`;
  return createHash("sha1").update(msg, "utf8").digest("hex").toLowerCase();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/motioneye/signature.test.ts`
Expected: PASS (3 tests). If a signature mismatches, compare the normalized `np` string in Node vs the Python reference; they must be byte-identical.

- [ ] **Step 5: Commit**

```bash
git add src/motioneye/signature.ts tests/motioneye/signature.test.ts
git commit -m "feat: motionEye request signature (plain SHA1) with live golden vectors"
```

---

### Task 5: MotionEye client

**Files:**
- Create: `src/motioneye/client.ts`
- Test: `tests/motioneye/client.test.ts`

**Background (verified live):** The client builds signed URLs and fetches via undici.
Cameras come from `GET /config/list` → `{ cameras: [{ id, name, ... }] }`. Dated listings
come from `GET /picture/{id}/list?prefix=YYYY-MM-DD&with_stat=true` →
`{ cameraName, mediaList: [{ path:"/2026-06-13/16-07-30.jpg", mimeType:"image/jpeg",
timestamp:1781359650.05, sizeStr:"606.2 kB", momentStr, momentStrShort }] }`. `timestamp`
is a float epoch (seconds); `sizeStr` is human-readable. The movie equivalent is
`/movie/{id}/list`.

- [ ] **Step 1: Write the failing test (signed URL building, no network)**

```ts
import { describe, it, expect } from "vitest";
import { MotionEyeClient } from "../../src/motioneye/client.js";

const client = new MotionEyeClient({
  baseUrl: "http://eye.local:8765",
  username: "admin",
  password: "pw",
  timeoutMs: 1000,
});

describe("MotionEyeClient.signUrl", () => {
  it("appends _username and a hex _signature", () => {
    const url = client.signUrl("GET", "/config/list");
    expect(url).toContain("http://eye.local:8765/config/list?");
    expect(url).toMatch(/_username=admin/);
    expect(url).toMatch(/_signature=[0-9a-f]{40}/);
  });

  it("preserves existing query params", () => {
    const url = client.signUrl("GET", "/picture/1/list?prefix=2026-06-13&with_stat=false");
    expect(url).toMatch(/prefix=2026-06-13/);
    expect(url).toMatch(/with_stat=false/);
    expect(url).toMatch(/_signature=[0-9a-f]{40}/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/motioneye/client.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write minimal implementation**

```ts
import { request } from "undici";
import { sha1Hex, computeSignature } from "./signature.js";

export interface MotionEyeOptions {
  baseUrl: string;
  username: string;
  password: string;
  timeoutMs: number;
}

export interface RemoteCamera {
  id: number;
  name: string;
}

export interface RemoteEntry {
  path: string;       // path relative to the camera root, e.g. "/2026-06-13/16-07-30.jpg"
  timestamp?: number; // float epoch seconds (with_stat=true)
  mimeType?: string;  // e.g. "image/jpeg" | "video/mp4"
  sizeStr?: string;   // e.g. "606.2 kB"
}

export class MotionEyeClient {
  constructor(private readonly opts: MotionEyeOptions) {}

  /** Build a fully-signed absolute URL for the given method + path-with-query. */
  signUrl(method: string, pathWithQuery: string): string {
    const sep = pathWithQuery.includes("?") ? "&" : "?";
    const withUser = `${pathWithQuery}${sep}_username=${encodeURIComponent(this.opts.username)}`;
    const key = sha1Hex(this.opts.password);
    const sig = computeSignature(method, withUser, "", key);
    return `${this.opts.baseUrl}${withUser}&_signature=${sig}`;
  }

  private async getJson<T>(pathWithQuery: string): Promise<T> {
    const url = this.signUrl("GET", pathWithQuery);
    const res = await request(url, {
      method: "GET",
      headersTimeout: this.opts.timeoutMs,
      bodyTimeout: this.opts.timeoutMs,
    });
    if (res.statusCode >= 400) {
      throw new Error(`MotionEye ${pathWithQuery} -> HTTP ${res.statusCode}`);
    }
    return (await res.body.json()) as T;
  }

  async listCameras(): Promise<RemoteCamera[]> {
    const data = await this.getJson<{ cameras: Array<{ id: number; name: string }> }>(
      "/config/list",
    );
    return data.cameras.map((c) => ({ id: c.id, name: c.name }));
  }

  async listDir(
    kind: "picture" | "movie",
    cameraId: number,
    prefix: string,
  ): Promise<RemoteEntry[]> {
    const q = `/${kind}/${cameraId}/list?prefix=${encodeURIComponent(prefix)}&with_stat=true`;
    const data = await this.getJson<{
      mediaList: Array<{ path: string; timestamp?: number; mimeType?: string; sizeStr?: string }>;
    }>(q);
    return (data.mediaList ?? []).map((m) => ({
      path: m.path,
      timestamp: m.timestamp,
      mimeType: m.mimeType,
      sizeStr: m.sizeStr,
    }));
  }

  /** Absolute signed URL to fetch the full file bytes. */
  fileUrl(kind: "picture" | "movie", cameraId: number, path: string): string {
    const verb = kind === "picture" ? "download" : "playback";
    return this.signUrl("GET", `/${kind}/${cameraId}/${verb}/${path}`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/motioneye/client.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/motioneye/client.ts tests/motioneye/client.test.ts
git commit -m "feat: MotionEye signed client (cameras, dir listing, file URLs)"
```

---

### Task 6: itsdangerous cookie verification

**Files:**
- Create: `src/auth/itsdangerous.ts`
- Test: `tests/auth/itsdangerous.test.ts`

**Background:** kukle-power sets `admin_session = URLSafeTimedSerializer(SECRET_KEY).dumps("admin")`.
Token = `payload "." b64(timestamp) "." b64(sig)`. Derived key = `sha1("itsdangerous"+"signer"+secret)`.
sig = `hmac_sha1(derived_key, payload + "." + b64(timestamp))`. base64 is url-safe, no padding.
Timestamp is raw `int(time.time())`. We verify signature, decode payload (JSON) and timestamp,
and enforce `maxAgeSeconds`.

- [ ] **Step 1: Generate a real reference token with Python (for the test)**

Run:
```bash
pip install itsdangerous >/dev/null 2>&1
python3 - <<'PY'
from itsdangerous import URLSafeTimedSerializer
s = URLSafeTimedSerializer("test-secret")
print(s.dumps("admin"))
PY
```
Paste the printed token into the test as `FRESH_TOKEN`. (Because it carries a current
timestamp, the "valid" test uses a large maxAge so it never expires in CI.)

- [ ] **Step 2: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { verifyTimedToken } from "../../src/auth/itsdangerous.js";

const SECRET = "test-secret";
const FRESH_TOKEN = "PASTE_FROM_PYTHON_STEP";

describe("verifyTimedToken", () => {
  it("accepts a valid token and returns the payload", () => {
    const res = verifyTimedToken(FRESH_TOKEN, SECRET, 10 * 365 * 24 * 3600);
    expect(res.valid).toBe(true);
    expect(res.payload).toBe("admin");
  });

  it("rejects a tampered signature", () => {
    const bad = FRESH_TOKEN.slice(0, -2) + (FRESH_TOKEN.endsWith("a") ? "bb" : "aa");
    expect(verifyTimedToken(bad, SECRET, 10 * 365 * 24 * 3600).valid).toBe(false);
  });

  it("rejects when signed with a different secret", () => {
    expect(verifyTimedToken(FRESH_TOKEN, "wrong-secret", 10 * 365 * 24 * 3600).valid).toBe(false);
  });

  it("rejects an expired token (maxAge 0)", () => {
    expect(verifyTimedToken(FRESH_TOKEN, SECRET, 0).valid).toBe(false);
  });

  it("rejects malformed tokens", () => {
    expect(verifyTimedToken("not-a-token", SECRET, 1000).valid).toBe(false);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/auth/itsdangerous.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 4: Write minimal implementation**

```ts
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export interface VerifyResult {
  valid: boolean;
  payload?: unknown;
}

function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

function b64urlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function deriveKey(secret: string): Buffer {
  // django-concat: sha1(salt + b"signer" + secret)
  return createHash("sha1")
    .update(Buffer.concat([Buffer.from("itsdangerous"), Buffer.from("signer"), Buffer.from(secret)]))
    .digest();
}

function bytesToInt(buf: Buffer): number {
  let n = 0;
  for (const b of buf) n = n * 256 + b;
  return n;
}

export function verifyTimedToken(
  token: string,
  secret: string,
  maxAgeSeconds: number,
): VerifyResult {
  const parts = token.split(".");
  if (parts.length !== 3) return { valid: false };
  const [payloadB64, tsB64, sigB64] = parts;

  const signed = `${payloadB64}.${tsB64}`;
  const key = deriveKey(secret);
  const expected = createHmac("sha1", key).update(signed, "utf8").digest();
  let provided: Buffer;
  try {
    provided = b64urlDecode(sigB64);
  } catch {
    return { valid: false };
  }
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return { valid: false };
  }

  // Timestamp check
  let ts: number;
  try {
    ts = bytesToInt(b64urlDecode(tsB64));
  } catch {
    return { valid: false };
  }
  const age = Math.floor(Date.now() / 1000) - ts;
  if (age < 0 || age > maxAgeSeconds) return { valid: false };

  // Payload decode (URLSafeSerializer: optional zlib prefix ".", else JSON)
  try {
    let raw = payloadB64;
    let decompress = false;
    if (raw.startsWith(".")) {
      decompress = true;
      raw = raw.slice(1);
    }
    let bytes = b64urlDecode(raw);
    if (decompress) {
      // zlib-compressed payloads are not expected for "admin"; bail safely.
      return { valid: false };
    }
    const payload = JSON.parse(bytes.toString("utf8"));
    return { valid: true, payload };
  } catch {
    return { valid: false };
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/auth/itsdangerous.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add src/auth/itsdangerous.ts tests/auth/itsdangerous.test.ts
git commit -m "feat: itsdangerous URLSafeTimedSerializer cookie verification"
```

---

### Task 7: Auth middleware

**Files:**
- Create: `src/auth/middleware.ts`
- Test: `tests/auth/middleware.test.ts`

**Background:** A Fastify preHandler reads the `admin_session` cookie and verifies it. When
`authEnabled` is false it allows all. On failure it returns 401 for `/api/*` and redirects
to the kukle-power login URL otherwise.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { registerAuth } from "../../src/auth/middleware.js";

async function buildTestApp(authEnabled: boolean, secret: string) {
  const app = Fastify();
  await app.register(cookie);
  registerAuth(app, { authEnabled, secret, maxAgeSeconds: 1000, loginUrl: "/login" });
  app.get("/api/secret", async () => ({ ok: true }));
  return app;
}

describe("registerAuth", () => {
  it("allows all when auth disabled", async () => {
    const app = await buildTestApp(false, "s");
    const res = await app.inject({ method: "GET", url: "/api/secret" });
    expect(res.statusCode).toBe(200);
  });

  it("401s an unauthenticated API request", async () => {
    const app = await buildTestApp(true, "s");
    const res = await app.inject({ method: "GET", url: "/api/secret" });
    expect(res.statusCode).toBe(401);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/auth/middleware.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write minimal implementation**

```ts
import type { FastifyInstance } from "fastify";
import { verifyTimedToken } from "./itsdangerous.js";

export interface AuthOptions {
  authEnabled: boolean;
  secret: string;
  maxAgeSeconds: number;
  loginUrl: string;
}

export function registerAuth(app: FastifyInstance, opts: AuthOptions): void {
  app.addHook("preHandler", async (req, reply) => {
    if (!opts.authEnabled) return;
    if (req.url === "/health") return;

    const token = req.cookies?.admin_session;
    const result = token
      ? verifyTimedToken(token, opts.secret, opts.maxAgeSeconds)
      : { valid: false };

    if (result.valid && result.payload === "admin") return;

    if (req.url.startsWith("/api/")) {
      reply.code(401).send({ error: "Not authenticated" });
    } else {
      reply.redirect(opts.loginUrl);
    }
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/auth/middleware.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/auth/middleware.ts tests/auth/middleware.test.ts
git commit -m "feat: Fastify auth preHandler gating on admin_session cookie"
```

---

### Task 8: Logger + server factory + cameras route

**Files:**
- Create: `src/logger.ts`
- Create: `src/routes/cameras.ts`
- Create: `src/server.ts`
- Test: `tests/routes/cameras.test.ts`

- [ ] **Step 1: Write the logger**

```ts
import pino from "pino";
export const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });
```

- [ ] **Step 2: Write the failing route test (auth disabled, client stubbed)**

```ts
import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { registerCamerasRoute } from "../../src/routes/cameras.js";

describe("GET /api/cameras", () => {
  it("returns cameras from the client", async () => {
    const app = Fastify();
    await app.register(cookie);
    const fakeClient = {
      listCameras: async () => [{ id: 1, name: "Camera1" }],
    } as any;
    registerCamerasRoute(app, fakeClient);
    const res = await app.inject({ method: "GET", url: "/api/cameras" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([{ id: 1, name: "Camera1" }]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/routes/cameras.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 4: Write the route**

```ts
import type { FastifyInstance } from "fastify";
import type { MotionEyeClient } from "../motioneye/client.js";

export function registerCamerasRoute(app: FastifyInstance, client: MotionEyeClient): void {
  app.get("/api/cameras", async () => {
    return client.listCameras();
  });
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/routes/cameras.test.ts`
Expected: PASS (1 test).

- [ ] **Step 6: Write the server factory (wires config, auth, client, routes)**

```ts
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { loadConfig } from "./config.js";
import { logger } from "./logger.js";
import { MotionEyeClient } from "./motioneye/client.js";
import { registerAuth } from "./auth/middleware.js";
import { registerCamerasRoute } from "./routes/cameras.js";

export async function buildApp() {
  const cfg = loadConfig();
  const app = Fastify({ loggerInstance: logger });
  await app.register(cookie);

  const client = new MotionEyeClient({
    baseUrl: cfg.motionEyeUrl,
    username: cfg.motionEyeUser,
    password: cfg.motionEyePassword,
    timeoutMs: cfg.requestTimeoutMs,
  });

  registerAuth(app, {
    authEnabled: cfg.authEnabled,
    secret: cfg.secretKey,
    maxAgeSeconds: 30 * 24 * 3600,
    loginUrl: cfg.kuklePowerLoginUrl,
  });

  app.get("/health", async () => ({ status: "ok" }));
  registerCamerasRoute(app, client);

  return app;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  buildApp()
    .then((app) => app.listen({ host: "0.0.0.0", port: Number(process.env.PORT ?? 8762) }))
    .catch((err) => {
      logger.error(err);
      process.exit(1);
    });
}
```

- [ ] **Step 7: Run the full test suite**

Run: `npx vitest run`
Expected: PASS (all tests across config, signature, client, itsdangerous, middleware, cameras).

- [ ] **Step 8: Smoke test the server boots (auth disabled)**

Run:
```bash
AUTH_ENABLED=false MOTIONEYE_URL=http://x MOTIONEYE_USER=u MOTIONEYE_PASSWORD=p SECRET_KEY=s \
  DATABASE_URL="file:./dev.db" npx tsx src/server.ts &
sleep 2 && curl -s localhost:8762/health && kill %1
```
Expected: `{"status":"ok"}`.

- [ ] **Step 9: Commit**

```bash
git add src/logger.ts src/routes/cameras.ts src/server.ts tests/routes/cameras.test.ts
git commit -m "feat: Fastify server factory with health and cameras routes"
```

---

### Task 9: Live integration check against the real MotionEye (manual, optional)

**Files:** none (manual verification using `deploy.local.env`).

- [ ] **Step 1: Run a one-off camera list against the real remote**

Run:
```bash
set -a && . ./deploy.local.env && set +a
npx tsx -e "import('./src/motioneye/client.js').then(async m => {
  const c = new m.MotionEyeClient({ baseUrl: process.env.MOTIONEYE_URL, username: process.env.MOTIONEYE_USER, password: process.env.MOTIONEYE_PASSWORD, timeoutMs: 30000 });
  console.log(await c.listCameras());
})"
```
Expected: a list of cameras from the remote (`$MOTIONEYE_URL`). If it returns 403, the signature
normalization differs from the live server; re-check Task 4 against motionEye's `utils.py`.

- [ ] **Step 2: No commit** (verification only).

---

## Self-Review

**Spec coverage (Plan 1 portion):**
- Project structure + Prisma schema → Tasks 1, 2 (spec §6, §4-Phase1). ✓
- MotionEye signed client + per-prefix listing primitives → Tasks 4, 5 (spec §5, §7). ✓
- itsdangerous cookie SSO (no JWT) → Tasks 6, 7 (spec §3). ✓
- Server skeleton + auth gating → Task 8 (spec §3, §4). ✓
- Indexer worker, media proxy, thumbnails → **Plan 2** (intentional).
- Timeline histogram/seek endpoints + timelapse worker (ffmpeg, SSE, retry) → **Plan 2**.
- Frontend (grid, zoomable timeline, timelapse UI, task tray) + deploy → **Plan 3**.
- The `TimelapseJob` model is defined here (Task 2) so migrations are complete from the
  start, even though its worker/endpoints land in Plan 2.

**Placeholder scan:** The only intentional fill-ins are `EXPECTED_SIG` and `FRESH_TOKEN`,
which are generated by the explicit Python steps that precede them. No silent TODOs.

**Type consistency:** `MotionEyeClient` (signUrl, listCameras, listDir, fileUrl),
`RemoteCamera`, `RemoteEntry`, `verifyTimedToken(token, secret, maxAgeSeconds) -> {valid, payload}`,
`registerAuth(app, AuthOptions)`, `registerCamerasRoute(app, client)` are used consistently
across tasks 5-8.

**Note for Plan 2:** the `mediaList` JSON shape and the exact `timestamp` field from
`/list` should be confirmed against the live server during Task 9 and locked into Plan 2.
