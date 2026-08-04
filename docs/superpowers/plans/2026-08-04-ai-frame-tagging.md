# Dwa niezależne przebiegi detekcji — plan implementacji

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dołożyć do galerii drugi, niezależny przebieg detekcji oparty na lokalnym modelu wizyjnym (LM Studio), nie zmieniając zachowania istniejącego przebiegu różnicowego.

**Architecture:** Dwie osobne pętle w tym samym procesie Node. Pętla A (istniejąca, `src/activity/`) bez zmian w logice. Pętla B (nowa, `src/ai/`) co 300 s sonduje, czy model jest załadowany w LM Studio na stacji roboczej; gdy jest — skanuje ciągle partiami, gdy go nie ma — śpi. Każda pętla zapisuje wyłącznie własne kolumny w `MediaFile`, ma własny `ScanControl`, własne trasy API i własną sekcję w interfejsie.

**Tech Stack:** TypeScript, Fastify, Prisma + SQLite, sharp, vitest; frontend React + Vite + Tailwind. Model: `qwen/qwen3-vl-8b` przez API zgodne z OpenAI.

**Spec:** `docs/superpowers/specs/2026-08-04-ai-frame-tagging-design.md`

## Global Constraints

- **Niezależność przebiegów jest wymaganiem nadrzędnym.** Pętla B nigdy nie czyta ani nie zapisuje `activityScore`, `hasActivity`, `activityScannedAt`. Pętla A nigdy nie dotyka kolumn `ai*`, `weather*`, `isNightIr`. Żadna nie sprawdza stanu drugiej.
- **Wszystkie zapisy przez `prisma.mediaFile.update({ data: { … } })`** z wypisanymi wprost kolumnami — nigdy `updateMany` na całym wierszu ani zapis obiektu z pola nienależącego do własnego przebiegu.
- **`AI_TAGGING_ENABLED` domyślnie `false`.** Wdrożenie bez zmiany zmiennych zachowuje się dokładnie jak dzisiejsze.
- **Parametry modelu są stałe i zmierzone:** szerokość obrazu `1024` px, `temperature: 0`, `reasoning_effort: "none"`, `response_format: json_schema` ze `strict: true`. Nie zmieniać bez przebiegu `npm run ai:eval`.
- **Żadnego pola tekstowego w schemacie odpowiedzi.** Swobodny tekst psuje powtarzalność (zmierzone).
- **Nie pytamy modelu o:** pojazdy, zasłonięcie obiektywu, noc. Pierwsze dwa nie niosą informacji, trzecie liczy się klasycznie.
- Kod i komentarze w repozytorium po angielsku (jak reszta projektu). Ten plan i spec są po polsku.
- Testy: `npm test` (vitest). Frontend nie ma testów — weryfikacja przez `cd web && npm run build`.

---

### Task 1: Kolumny przebiegu rozszerzonego w schemacie

**Files:**
- Modify: `prisma/schema.prisma:28-45` (model `MediaFile`)
- Create: `prisma/migrations/<timestamp>_add_ai_tagging/migration.sql` (generowana)
- Test: `tests/ai/schema.test.ts`

**Interfaces:**
- Consumes: nic
- Produces: kolumny `aiScannedAt`, `aiModel`, `aiPromptVersion`, `aiPeopleCount`, `aiAnimals`, `aiAnimalKinds`, `aiLatencyMs`, `aiFailures`, `weatherScannedAt`, `weatherPromptVersion`, `weatherVisibility`, `weatherPrecipitation`, `weatherSnowOnGround`, `isNightIr` na `MediaFile`

- [ ] **Step 1: Napisz test, który zapisuje i odczytuje nowe kolumny**

`tests/ai/schema.test.ts`:

```typescript
import { describe, it, expect, afterAll } from "vitest";
import { makeTestDb } from "../helpers/testDb.js";

const { prisma } = makeTestDb();
afterAll(async () => { await prisma.$disconnect(); });

describe("MediaFile — kolumny przebiegu rozszerzonego", () => {
  it("stores AI and weather columns independently of the activity columns", async () => {
    const cam = await prisma.camera.create({ data: { motionEyeId: 1, name: "Cam" } });
    const mf = await prisma.mediaFile.create({
      data: {
        cameraId: cam.id,
        fileType: "image",
        remotePath: "2026-01-01/00-00-00.jpg",
        localPath: "/media/Cam/2026-01-01/00-00-00.jpg",
        timestamp: new Date("2026-01-01T00:00:00Z"),
        isDownloaded: true,
        activityScore: 0.5,
        hasActivity: true,
        activityScannedAt: new Date("2026-01-01T01:00:00Z"),
      },
    });

    // defaults: nothing from the extended pass yet
    expect(mf.aiScannedAt).toBeNull();
    expect(mf.aiFailures).toBe(0);
    expect(mf.weatherVisibility).toBeNull();
    expect(mf.isNightIr).toBeNull();

    const updated = await prisma.mediaFile.update({
      where: { id: mf.id },
      data: {
        aiScannedAt: new Date("2026-01-02T00:00:00Z"),
        aiModel: "qwen/qwen3-vl-8b",
        aiPromptVersion: "semantics-v1",
        aiPeopleCount: 2,
        aiAnimals: JSON.stringify(["1 bird on a tire", "horse"]),
        aiAnimalKinds: ",bird,horse,",
        aiLatencyMs: 1336,
        weatherScannedAt: new Date("2026-01-02T00:00:00Z"),
        weatherPromptVersion: "weather-v1",
        weatherVisibility: "dense_fog",
        weatherPrecipitation: "snow",
        weatherSnowOnGround: true,
        isNightIr: false,
      },
    });

    expect(updated.aiPeopleCount).toBe(2);
    expect(updated.aiAnimalKinds).toBe(",bird,horse,");
    expect(updated.weatherVisibility).toBe("dense_fog");
    // the basic pass result must be untouched by writing extended-pass columns
    expect(updated.activityScore).toBe(0.5);
    expect(updated.hasActivity).toBe(true);
    expect(updated.activityScannedAt).toEqual(new Date("2026-01-01T01:00:00Z"));
  });
});
```

- [ ] **Step 2: Uruchom test i potwierdź, że nie przechodzi**

Run: `npx vitest run tests/ai/schema.test.ts`
Expected: FAIL — Prisma odrzuci nieznane pola (`Unknown arg 'aiScannedAt'`)

- [ ] **Step 3: Dodaj kolumny do schematu**

W `prisma/schema.prisma`, w modelu `MediaFile`, pod blokiem aktywności:

```prisma
  // ---- Extended pass: semantic labels from a local vision model (loop B). ----
  // Loop A never reads or writes anything below this line.
  aiScannedAt     DateTime?
  aiModel         String? // e.g. "qwen/qwen3-vl-8b" — what produced this row
  aiPromptVersion String? // e.g. "semantics-v1" — bump to re-scan without wiping
  aiPeopleCount   Int?
  aiAnimals       String? // raw JSON array as returned by the model
  aiAnimalKinds   String? // normalised, comma-delimited AND comma-wrapped: ",bird,dog,"
  aiLatencyMs     Int?
  aiFailures      Int       @default(0)

  weatherScannedAt     DateTime?
  weatherPromptVersion String?
  weatherVisibility    String? // clear | slight_haze | fog | dense_fog
  weatherPrecipitation String? // none | rain | heavy_rain | snow
  weatherSnowOnGround  Boolean?

  // Classical, deterministic — computed locally, never asked of the model.
  isNightIr Boolean?
```

I dopisz indeksy obok istniejących:

```prisma
  @@index([cameraId, aiScannedAt])
  @@index([cameraId, aiPeopleCount, timestamp])
  @@index([cameraId, weatherVisibility, timestamp])
```

Uwaga do `aiAnimalKinds`: wartość jest **owinięta przecinkami z obu stron** (`,bird,horse,`), żeby filtrowanie po gatunku dało się zrobić przez `contains: ",bird,"` bez trafiania w `,blackbird,`.

- [ ] **Step 4: Wygeneruj migrację i klienta**

Run:
```bash
npx prisma migrate dev --name add_ai_tagging
npx prisma generate
```
Expected: nowy katalog w `prisma/migrations/`, migracja zawiera wyłącznie `ALTER TABLE ... ADD COLUMN` i `CREATE INDEX` (żadnego `DROP`)

- [ ] **Step 5: Uruchom test i potwierdź, że przechodzi**

Run: `npx vitest run tests/ai/schema.test.ts`
Expected: PASS

- [ ] **Step 6: Uruchom cały zestaw testów**

Run: `npm test`
Expected: wszystko przechodzi — istniejące testy aktywności nie mogą się zepsuć

- [ ] **Step 7: Commit**

```bash
git add prisma/schema.prisma prisma/migrations tests/ai/schema.test.ts
git commit -m "Schema: extended-pass columns on MediaFile"
```

---

### Task 2: Konfiguracja przebiegu rozszerzonego

**Files:**
- Modify: `src/config.ts:13-23` (interfejs `AppConfig`), `src/config.ts:44-53` (`loadConfig`)
- Test: `tests/config.test.ts` (dopisz przypadki)

**Interfaces:**
- Consumes: nic
- Produces: `AppConfig.ai: { enabled, lmStudioUrl, model, probeIntervalSeconds, imageWidth, promptVersion, weatherPromptVersion, weatherMinGapSeconds, batch, requestTimeoutMs, maxFailures }`

- [ ] **Step 1: Napisz testy dla nowej sekcji konfiguracji**

Dopisz do `tests/config.test.ts`:

```typescript
describe("loadConfig — extended pass", () => {
  const base = { MOTIONEYE_URL: "x", MOTIONEYE_USER: "u", MOTIONEYE_PASSWORD: "p", SECRET_KEY: "s" };

  it("keeps the extended pass off by default", () => {
    const cfg = loadConfig(base);
    expect(cfg.ai.enabled).toBe(false);
    expect(cfg.ai.probeIntervalSeconds).toBe(300);
    expect(cfg.ai.imageWidth).toBe(1024);
    expect(cfg.ai.weatherMinGapSeconds).toBe(600);
    expect(cfg.ai.model).toBe("qwen/qwen3-vl-8b");
  });

  it("enables it only on an explicit true", () => {
    expect(loadConfig({ ...base, AI_TAGGING_ENABLED: "true" }).ai.enabled).toBe(true);
    expect(loadConfig({ ...base, AI_TAGGING_ENABLED: "yes" }).ai.enabled).toBe(false);
  });

  it("does not touch the basic pass defaults", () => {
    const cfg = loadConfig({ ...base, AI_TAGGING_ENABLED: "true" });
    expect(cfg.activity.enabled).toBe(true);
    expect(cfg.activity.scoreThreshold).toBe(0.04);
  });
});
```

- [ ] **Step 2: Uruchom i potwierdź niepowodzenie**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL — `cfg.ai` jest `undefined`

- [ ] **Step 3: Dodaj sekcję do konfiguracji**

W `src/config.ts`, do interfejsu `AppConfig` (obok istniejącego `activity`):

```typescript
  /** Extended pass — optional, driven by a vision model in LM Studio. */
  ai: {
    enabled: boolean;
    lmStudioUrl: string;
    model: string;
    probeIntervalSeconds: number;
    imageWidth: number;
    promptVersion: string;
    weatherPromptVersion: string;
    weatherMinGapSeconds: number;
    batch: number;
    requestTimeoutMs: number;
    maxFailures: number;
  };
```

I do zwracanego obiektu w `loadConfig`:

```typescript
    ai: {
      // Off by default: the extended pass is opt-in, the gallery is complete without it.
      enabled: env.AI_TAGGING_ENABLED === "true",
      lmStudioUrl: env.AI_LMSTUDIO_URL ?? "http://192.168.0.11:1234",
      model: env.AI_MODEL ?? "qwen/qwen3-vl-8b",
      probeIntervalSeconds: Number(env.AI_PROBE_INTERVAL_SECONDS ?? "300"),
      imageWidth: Number(env.AI_IMAGE_WIDTH ?? "1024"),
      promptVersion: env.AI_PROMPT_VERSION ?? "semantics-v1",
      weatherPromptVersion: env.AI_WEATHER_PROMPT_VERSION ?? "weather-v1",
      weatherMinGapSeconds: Number(env.AI_WEATHER_MIN_GAP_SECONDS ?? "600"),
      batch: Number(env.AI_BATCH ?? "200"),
      requestTimeoutMs: Number(env.AI_REQUEST_TIMEOUT_MS ?? "60000"),
      maxFailures: Number(env.AI_MAX_FAILURES ?? "5"),
    },
```

Zwróć uwagę: `enabled` sprawdza `=== "true"`, a nie `!== "false"` jak `activity.enabled`. To celowa różnica — przebieg podstawowy jest domyślnie włączony, rozszerzony domyślnie wyłączony.

- [ ] **Step 4: Uruchom testy**

Run: `npx vitest run tests/config.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "Config: AI_* settings for the extended pass, off by default"
```

---

### Task 3: Sonda dostępności modelu

**Files:**
- Create: `src/ai/lmstudio.ts`
- Test: `tests/ai/probe.test.ts`

**Interfaces:**
- Consumes: nic
- Produces: `probeModelLoaded(opts: { url: string; model: string; timeoutMs: number }): Promise<boolean>`

- [ ] **Step 1: Napisz testy sondy na lokalnym serwerze HTTP**

`tests/ai/probe.test.ts`:

```typescript
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { probeModelLoaded } from "../../src/ai/lmstudio.js";

let server: Server | null = null;

function serve(handler: (url: string) => { status: number; body: string }): Promise<string> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      const { status, body } = handler(req.url ?? "");
      res.writeHead(status, { "content-type": "application/json" });
      res.end(body);
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server!.address() as { port: number };
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
}

afterEach(() => {
  server?.close();
  server = null;
});

const MODELS = (state: string) =>
  JSON.stringify({
    object: "list",
    data: [
      { id: "some/other-model", object: "model", type: "llm", state: "loaded" },
      { id: "qwen/qwen3-vl-8b", object: "model", type: "vlm", state },
    ],
  });

describe("probeModelLoaded", () => {
  it("is true only when the configured model reports state=loaded", async () => {
    const url = await serve(() => ({ status: 200, body: MODELS("loaded") }));
    await expect(probeModelLoaded({ url, model: "qwen/qwen3-vl-8b", timeoutMs: 2000 })).resolves.toBe(true);
  });

  it("is false when the model is downloaded but not loaded", async () => {
    const url = await serve(() => ({ status: 200, body: MODELS("not-loaded") }));
    await expect(probeModelLoaded({ url, model: "qwen/qwen3-vl-8b", timeoutMs: 2000 })).resolves.toBe(false);
  });

  it("is false when the model is absent from the list", async () => {
    const url = await serve(() => ({ status: 200, body: JSON.stringify({ object: "list", data: [] }) }));
    await expect(probeModelLoaded({ url, model: "qwen/qwen3-vl-8b", timeoutMs: 2000 })).resolves.toBe(false);
  });

  it("is false — never throws — when the host is unreachable", async () => {
    // Port 1 is reserved and refuses connections; this is the "workstation is off" case,
    // which is a normal operating state and must not surface as an error.
    await expect(
      probeModelLoaded({ url: "http://127.0.0.1:1", model: "qwen/qwen3-vl-8b", timeoutMs: 500 }),
    ).resolves.toBe(false);
  });

  it("is false when the response is not valid JSON", async () => {
    const url = await serve(() => ({ status: 200, body: "<html>nope</html>" }));
    await expect(probeModelLoaded({ url, model: "qwen/qwen3-vl-8b", timeoutMs: 2000 })).resolves.toBe(false);
  });
});
```

- [ ] **Step 2: Uruchom i potwierdź niepowodzenie**

Run: `npx vitest run tests/ai/probe.test.ts`
Expected: FAIL — `Cannot find module '../../src/ai/lmstudio.js'`

- [ ] **Step 3: Zaimplementuj sondę**

`src/ai/lmstudio.ts`:

```typescript
/**
 * Client for a local LM Studio instance (OpenAI-compatible API).
 *
 * The availability probe deliberately uses /api/v0/models rather than /v1/models:
 * with just-in-time loading enabled, /v1/models lists every *downloaded* model, so it
 * cannot tell us whether the model is actually resident on the GPU. /api/v0/models
 * carries a per-model `state` field, which is what the owner's on/off switch is.
 */

export interface ProbeOptions {
  url: string;
  model: string;
  timeoutMs: number;
}

interface ModelsResponse {
  data?: Array<{ id?: string; state?: string }>;
}

/**
 * True when the configured model is loaded and ready. Never throws: an unreachable
 * host means "the workstation is off", which is a normal state, not an error.
 */
export async function probeModelLoaded(opts: ProbeOptions): Promise<boolean> {
  try {
    const res = await fetch(`${opts.url.replace(/\/+$/, "")}/api/v0/models`, {
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
    if (!res.ok) return false;
    const json = (await res.json()) as ModelsResponse;
    return (json.data ?? []).some((m) => m.id === opts.model && m.state === "loaded");
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Uruchom testy**

Run: `npx vitest run tests/ai/probe.test.ts`
Expected: PASS (5 testów)

- [ ] **Step 5: Commit**

```bash
git add src/ai/lmstudio.ts tests/ai/probe.test.ts
git commit -m "AI: model availability probe against /api/v0/models"
```

---

### Task 4: Normalizacja nazw zwierząt

**Files:**
- Create: `src/ai/normalize.ts`
- Test: `tests/ai/normalize.test.ts`

**Interfaces:**
- Consumes: nic
- Produces: `normalizeAnimals(raw: string[]): { kinds: string[]; kindsColumn: string | null; count: number }`

Model zwraca swobodne napisy: `"horse"`, `"1 dog"`, `"1 bird on a tire"`. Ta funkcja mapuje je na słownik gatunków i buduje wartość kolumny `aiAnimalKinds` owiniętą przecinkami.

- [ ] **Step 1: Napisz testy**

`tests/ai/normalize.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { normalizeAnimals } from "../../src/ai/normalize.js";

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

  it("returns nothing for an empty list", () => {
    expect(normalizeAnimals([])).toEqual({ kinds: [], kindsColumn: null, count: 0 });
  });

  it("does not match a species inside a longer word", () => {
    // "blackbird" must not register as "bird" via naive substring matching
    expect(normalizeAnimals(["blackbird"]).kinds).toEqual(["other"]);
  });
});
```

- [ ] **Step 2: Uruchom i potwierdź niepowodzenie**

Run: `npx vitest run tests/ai/normalize.test.ts`
Expected: FAIL — moduł nie istnieje

- [ ] **Step 3: Zaimplementuj**

`src/ai/normalize.ts`:

```typescript
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
```

- [ ] **Step 4: Uruchom testy**

Run: `npx vitest run tests/ai/normalize.test.ts`
Expected: PASS (5 testów)

- [ ] **Step 5: Commit**

```bash
git add src/ai/normalize.ts tests/ai/normalize.test.ts
git commit -m "AI: normalise free-form animal strings to a controlled vocabulary"
```

---

### Task 5: Prompty i wywołanie semantyczne

**Files:**
- Create: `src/ai/prompts.ts`
- Modify: `src/ai/lmstudio.ts` (dopisz `askSemantics` i klasy błędów)
- Test: `tests/ai/semantics.test.ts`

**Interfaces:**
- Consumes: `ProbeOptions` z Task 3
- Produces:
  - `SEMANTICS_SYSTEM: string`, `SEMANTICS_USER: string`, `SEMANTICS_SCHEMA: object`
  - `AskOptions = { url: string; model: string; timeoutMs: number }`
  - `SemanticResult = { peopleCount: number; animals: string[] }`
  - `askSemantics(opts: AskOptions, jpeg: Buffer): Promise<SemanticResult>`
  - `class ModelUnavailableError extends Error` — transport padł, model zniknął
  - `class FrameRejectedError extends Error` — model odpowiedział, ale nie da się użyć

Rozróżnienie klas błędów jest kluczowe: pierwsza przerywa partię bez oznaczania czegokolwiek, druga zwiększa licznik porażek konkretnej klatki.

- [ ] **Step 1: Napisz testy**

`tests/ai/semantics.test.ts`:

```typescript
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { askSemantics, ModelUnavailableError, FrameRejectedError } from "../../src/ai/lmstudio.js";

let server: Server | null = null;
let lastBody: any = null;

function serve(status: number, body: string): Promise<string> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        lastBody = raw ? JSON.parse(raw) : null;
        res.writeHead(status, { "content-type": "application/json" });
        res.end(body);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server!.address() as { port: number };
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
}

const reply = (content: object) =>
  JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] });

afterEach(() => { server?.close(); server = null; lastBody = null; });

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

describe("askSemantics", () => {
  it("parses people and animals from a well-formed answer", async () => {
    const url = await serve(200, reply({ people_count: 2, animals: ["1 bird on a tire", "horse"] }));
    const r = await askSemantics({ url, model: "m", timeoutMs: 2000 }, JPEG);
    expect(r).toEqual({ peopleCount: 2, animals: ["1 bird on a tire", "horse"] });
  });

  it("sends the measured parameters and a strict json schema", async () => {
    const url = await serve(200, reply({ people_count: 0, animals: [] }));
    await askSemantics({ url, model: "qwen/qwen3-vl-8b", timeoutMs: 2000 }, JPEG);
    expect(lastBody.model).toBe("qwen/qwen3-vl-8b");
    expect(lastBody.temperature).toBe(0);
    expect(lastBody.reasoning_effort).toBe("none");
    expect(lastBody.response_format.json_schema.strict).toBe(true);
    // no free-text field may leak into the schema — it destroys repeatability
    expect(Object.keys(lastBody.response_format.json_schema.schema.properties).sort())
      .toEqual(["animals", "people_count"]);
    expect(lastBody.messages[1].content[1].image_url.url).toMatch(/^data:image\/jpeg;base64,/);
  });

  it("raises ModelUnavailableError when the host refuses the connection", async () => {
    await expect(
      askSemantics({ url: "http://127.0.0.1:1", model: "m", timeoutMs: 500 }, JPEG),
    ).rejects.toBeInstanceOf(ModelUnavailableError);
  });

  it("raises ModelUnavailableError on a 5xx (model was unloaded mid-batch)", async () => {
    const url = await serve(503, "{}");
    await expect(askSemantics({ url, model: "m", timeoutMs: 2000 }, JPEG))
      .rejects.toBeInstanceOf(ModelUnavailableError);
  });

  it("raises FrameRejectedError on a 4xx", async () => {
    const url = await serve(400, JSON.stringify({ error: "bad image" }));
    await expect(askSemantics({ url, model: "m", timeoutMs: 2000 }, JPEG))
      .rejects.toBeInstanceOf(FrameRejectedError);
  });

  it("raises FrameRejectedError when content is not the promised JSON", async () => {
    const url = await serve(200, JSON.stringify({ choices: [{ message: { content: "" } }] }));
    await expect(askSemantics({ url, model: "m", timeoutMs: 2000 }, JPEG))
      .rejects.toBeInstanceOf(FrameRejectedError);
  });
});
```

- [ ] **Step 2: Uruchom i potwierdź niepowodzenie**

Run: `npx vitest run tests/ai/semantics.test.ts`
Expected: FAIL — brak eksportów `askSemantics`, `ModelUnavailableError`, `FrameRejectedError`

- [ ] **Step 3: Zapisz prompty**

`src/ai/prompts.ts`:

```typescript
/**
 * Prompts are versioned data, not incidental strings. Wording moved animal recall from
 * 2/6 to 6/6 on the reference set with no change of model, image size or latency — so a
 * change here is a change of behaviour and must bump the version in the environment and
 * be re-validated with `npm run ai:eval`.
 *
 * The system prompt names concrete objects of THIS scene on purpose (tyre, boat, fence,
 * treeline). Generic wording measurably loses small animals.
 */

export const SEMANTICS_SYSTEM = `You analyse still frames from one fixed outdoor camera in rural Poland. The scene contains a caravan, sometimes under a wooden carport, a picnic table, parked trailers and a small boat, a mown meadow, a ploughed field, a fence line and a forest edge beyond.

Animals are a main subject of interest. They are often grazing FAR AWAY in the field, standing on the bare ground, or perched on objects such as a tyre, a boat or a fence, and may be only a few dozen pixels across. Scan the whole frame — foreground, mid-field and the distant treeline — and COUNT EVERY ANIMAL you can see, including small and distant ones.

Report only what is actually visible. Never invent an animal that is not there.`;

export const SEMANTICS_USER =
  "How many people and how many animals can you see in this frame?";

export const SEMANTICS_SCHEMA = {
  type: "object",
  properties: {
    people_count: {
      type: "integer",
      description: "How many humans are visible. A jacket or bag on a chair is not a human.",
    },
    animals: {
      type: "array",
      items: { type: "string" },
      description:
        "One entry per animal visible IN THE SCENE: bird, horse, deer, dog, cat, boar, fox, hare. Animals here are often small and far away - on the ground, in the field, or perched on objects. Do NOT list an insect or spider crawling on the camera lens.",
    },
  },
  required: ["people_count", "animals"],
} as const;

export const WEATHER_SYSTEM = `You analyse still frames from one fixed outdoor camera in rural Poland. The camera looks past a caravan towards a meadow, a fence line and a distant forest edge. At night it switches to infrared: the image is monochrome and raindrops or snowflakes close to the lamp appear as bright white dots or streaks against the dark background.

Judge the WEATHER and VISIBILITY, not the objects. The key question is how far you can see: in clear weather the distant treeline is sharp and detailed; in fog it fades into a flat white or grey wall and may disappear entirely, even though the foreground stays perfectly sharp.

Falling snow shows as small white specks scattered across the whole frame. Lying snow is a white layer on the ground. These are different things and can occur separately.

Report only what the image shows.`;

export const WEATHER_USER =
  "How far can you see into the distance, is anything falling, and is there snow lying on the ground?";

export const WEATHER_SCHEMA = {
  type: "object",
  properties: {
    visibility: { type: "string", enum: ["clear", "slight_haze", "fog", "dense_fog"] },
    precipitation: { type: "string", enum: ["none", "rain", "heavy_rain", "snow"] },
    snow_on_ground: { type: "boolean" },
  },
  required: ["visibility", "precipitation", "snow_on_ground"],
} as const;
```

- [ ] **Step 4: Dopisz wywołanie do klienta**

Dopisz do `src/ai/lmstudio.ts`:

```typescript
import { SEMANTICS_SYSTEM, SEMANTICS_USER, SEMANTICS_SCHEMA } from "./prompts.js";

export interface AskOptions {
  url: string;
  model: string;
  timeoutMs: number;
}

export interface SemanticResult {
  peopleCount: number;
  animals: string[];
}

/** The model went away (host down, unloaded mid-batch, 5xx). Abort the batch, mark nothing. */
export class ModelUnavailableError extends Error {}
/** The model answered but this frame is unusable (4xx, malformed content). Count against the frame. */
export class FrameRejectedError extends Error {}

/** Shared request path for both the semantic and the weather call. */
export async function askJson<T>(
  opts: AskOptions,
  jpeg: Buffer,
  system: string,
  user: string,
  schema: object,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${opts.url.replace(/\/+$/, "")}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(opts.timeoutMs),
      body: JSON.stringify({
        model: opts.model,
        messages: [
          { role: "system", content: system },
          {
            role: "user",
            content: [
              { type: "text", text: user },
              {
                type: "image_url",
                image_url: { url: `data:image/jpeg;base64,${jpeg.toString("base64")}` },
              },
            ],
          },
        ],
        response_format: { type: "json_schema", json_schema: { name: "frame_report", strict: true, schema } },
        temperature: 0,
        max_tokens: 250,
        // Reasoning models otherwise spend the whole token budget thinking and return
        // an empty content field. Models without reasoning ignore this parameter.
        reasoning_effort: "none",
      }),
    });
  } catch (e) {
    throw new ModelUnavailableError(`transport: ${(e as Error).message}`);
  }

  if (res.status >= 500) throw new ModelUnavailableError(`http ${res.status}`);
  if (!res.ok) throw new FrameRejectedError(`http ${res.status}`);

  try {
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = json.choices?.[0]?.message?.content;
    if (!content) throw new Error("empty content");
    return JSON.parse(content) as T;
  } catch (e) {
    throw new FrameRejectedError(`unusable answer: ${(e as Error).message}`);
  }
}

export async function askSemantics(opts: AskOptions, jpeg: Buffer): Promise<SemanticResult> {
  const raw = await askJson<{ people_count: number; animals: string[] }>(
    opts, jpeg, SEMANTICS_SYSTEM, SEMANTICS_USER, SEMANTICS_SCHEMA,
  );
  return { peopleCount: raw.people_count ?? 0, animals: raw.animals ?? [] };
}
```

- [ ] **Step 5: Uruchom testy**

Run: `npx vitest run tests/ai/semantics.test.ts`
Expected: PASS (6 testów)

- [ ] **Step 6: Commit**

```bash
git add src/ai/prompts.ts src/ai/lmstudio.ts tests/ai/semantics.test.ts
git commit -m "AI: versioned prompts and the semantic call"
```

---

### Task 6: Wywołanie pogodowe i klasyczna bramka nocna

**Files:**
- Modify: `src/ai/lmstudio.ts` (dopisz `askWeather`)
- Create: `src/ai/night.ts`
- Test: `tests/ai/weather.test.ts`, `tests/ai/night.test.ts`

**Interfaces:**
- Consumes: `askJson`, `AskOptions` z Task 5; `loadFrame` z `src/activity/diff.ts`
- Produces:
  - `WeatherResult = { visibility: string; precipitation: string; snowOnGround: boolean }`
  - `askWeather(opts: AskOptions, jpeg: Buffer): Promise<WeatherResult>`
  - `isNightFrame(path: string, colorThreshold: number): Promise<boolean>`

- [ ] **Step 1: Napisz test bramki nocnej**

`tests/ai/night.test.ts`:

```typescript
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { isNightFrame } from "../../src/ai/night.js";

const dir = mkdtempSync(join(tmpdir(), "night-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function make(name: string, rgb: { r: number; g: number; b: number }): Promise<string> {
  const p = join(dir, name);
  await sharp({ create: { width: 64, height: 64, channels: 3, background: rgb } }).jpeg().toFile(p);
  return p;
}

describe("isNightFrame", () => {
  it("treats a colourless frame as infrared night", async () => {
    const p = await make("grey.jpg", { r: 90, g: 90, b: 90 });
    await expect(isNightFrame(p, 8)).resolves.toBe(true);
  });

  it("treats a colourful frame as daylight", async () => {
    const p = await make("green.jpg", { r: 40, g: 160, b: 60 });
    await expect(isNightFrame(p, 8)).resolves.toBe(false);
  });
});
```

- [ ] **Step 2: Uruchom i potwierdź niepowodzenie**

Run: `npx vitest run tests/ai/night.test.ts`
Expected: FAIL — brak modułu

- [ ] **Step 3: Zaimplementuj bramkę nocną**

`src/ai/night.ts`:

```typescript
import { loadFrame } from "../activity/diff.js";

/**
 * Infrared night frames are detected classically, from colour saturation — the same
 * measure the basic pass already computes. This was 100% reliable on the reference set,
 * whereas the model called black IR frames "dense fog", so the weather question is only
 * ever asked of daylight frames.
 *
 * Note this reads diff.ts but writes nothing: loop B stays out of loop A's columns.
 */
export async function isNightFrame(path: string, colorThreshold: number): Promise<boolean> {
  const frame = await loadFrame(path, 64);
  return frame.colorfulness < colorThreshold;
}
```

- [ ] **Step 4: Uruchom test bramki**

Run: `npx vitest run tests/ai/night.test.ts`
Expected: PASS

- [ ] **Step 5: Napisz test wywołania pogodowego**

`tests/ai/weather.test.ts`:

```typescript
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { askWeather } from "../../src/ai/lmstudio.js";

let server: Server | null = null;
let lastBody: any = null;

function serve(body: string): Promise<string> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        lastBody = JSON.parse(raw);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(body);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server!.address() as { port: number };
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
}
afterEach(() => { server?.close(); server = null; lastBody = null; });

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

describe("askWeather", () => {
  it("parses the weather answer", async () => {
    const url = await serve(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        visibility: "dense_fog", precipitation: "snow", snow_on_ground: true,
      }) } }],
    }));
    await expect(askWeather({ url, model: "m", timeoutMs: 2000 }, JPEG)).resolves.toEqual({
      visibility: "dense_fog", precipitation: "snow", snowOnGround: true,
    });
  });

  it("constrains the answer with enums and asks nothing else", async () => {
    const url = await serve(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        visibility: "clear", precipitation: "none", snow_on_ground: false,
      }) } }],
    }));
    await askWeather({ url, model: "m", timeoutMs: 2000 }, JPEG);
    const props = lastBody.response_format.json_schema.schema.properties;
    expect(Object.keys(props).sort()).toEqual(["precipitation", "snow_on_ground", "visibility"]);
    expect(props.visibility.enum).toEqual(["clear", "slight_haze", "fog", "dense_fog"]);
  });
});
```

- [ ] **Step 6: Dopisz `askWeather` do klienta**

W `src/ai/lmstudio.ts` dopisz do importu z `./prompts.js`: `WEATHER_SYSTEM, WEATHER_USER, WEATHER_SCHEMA`, i dodaj:

```typescript
export interface WeatherResult {
  visibility: string;
  precipitation: string;
  snowOnGround: boolean;
}

export async function askWeather(opts: AskOptions, jpeg: Buffer): Promise<WeatherResult> {
  const raw = await askJson<{ visibility: string; precipitation: string; snow_on_ground: boolean }>(
    opts, jpeg, WEATHER_SYSTEM, WEATHER_USER, WEATHER_SCHEMA,
  );
  return {
    visibility: raw.visibility,
    precipitation: raw.precipitation,
    snowOnGround: !!raw.snow_on_ground,
  };
}
```

- [ ] **Step 7: Uruchom testy**

Run: `npx vitest run tests/ai/weather.test.ts tests/ai/night.test.ts`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/ai/lmstudio.ts src/ai/night.ts tests/ai/weather.test.ts tests/ai/night.test.ts
git commit -m "AI: weather call and the classical night gate"
```

---

### Task 7: Pętla B — `runAiScanOnce`

**Files:**
- Create: `src/ai/scanner.ts`
- Test: `tests/ai/scanner.test.ts`

**Interfaces:**
- Consumes: `SemanticResult`, `WeatherResult`, `ModelUnavailableError`, `FrameRejectedError` (Task 5–6); `normalizeAnimals` (Task 4)
- Produces:
  - `AiScanControl = { paused: boolean; scanning: boolean; modelLoaded: boolean; lastProbeAt: Date | null; lastError: string | null }`
  - `AiScanOptions = { model: string; promptVersion: string; weatherPromptVersion: string; imageWidth: number; weatherMinGapSeconds: number; batch: number; colorThreshold: number; maxFailures: number }`
  - `runAiScanOnce(args): Promise<{ scanned: number; weatherScanned: number; stopped: "empty" | "batch" | "paused" | "unavailable" }>`

Zależności zewnętrzne (odczyt pliku, skalowanie, oba wywołania modelu, bramka nocna) są **wstrzykiwane**, żeby testy nie potrzebowały ani sieci, ani obrazów.

- [ ] **Step 1: Napisz testy pętli**

`tests/ai/scanner.test.ts`:

```typescript
import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { makeTestDb } from "../helpers/testDb.js";
import { runAiScanOnce, type AiScanControl } from "../../src/ai/scanner.js";
import { ModelUnavailableError, FrameRejectedError } from "../../src/ai/lmstudio.js";

const { prisma } = makeTestDb();
afterAll(async () => { await prisma.$disconnect(); });
beforeEach(async () => {
  await prisma.mediaFile.deleteMany();
  await prisma.camera.deleteMany();
});

const OPTS = {
  model: "test-model",
  promptVersion: "semantics-v1",
  weatherPromptVersion: "weather-v1",
  imageWidth: 1024,
  weatherMinGapSeconds: 600,
  batch: 50,
  colorThreshold: 8,
  maxFailures: 5,
};

function control(): AiScanControl {
  return { paused: false, scanning: false, modelLoaded: true, lastProbeAt: null, lastError: null };
}

async function seed(n: number, stepSeconds = 150) {
  const cam = await prisma.camera.create({ data: { motionEyeId: 1, name: "Cam" } });
  const base = Date.UTC(2026, 0, 1, 12, 0, 0);
  for (let i = 0; i < n; i++) {
    await prisma.mediaFile.create({
      data: {
        cameraId: cam.id,
        fileType: "image",
        remotePath: `d/${i}.jpg`,
        localPath: `/media/d/${i}.jpg`,
        timestamp: new Date(base + i * stepSeconds * 1000),
        isDownloaded: true,
      },
    });
  }
  return cam;
}

const deps = (over: Partial<Parameters<typeof runAiScanOnce>[0]["deps"]> = {}) => ({
  loadJpeg: async () => Buffer.from([1]),
  isNight: async () => false,
  askSemantics: async () => ({ peopleCount: 0, animals: [] as string[] }),
  askWeather: async () => ({ visibility: "clear", precipitation: "none", snowOnGround: false }),
  ...over,
});

describe("runAiScanOnce", () => {
  it("scans newest frames first", async () => {
    await seed(3);
    const seen: string[] = [];
    await runAiScanOnce({
      prisma, opts: { ...OPTS, batch: 1 }, control: control(),
      deps: deps({ loadJpeg: async (p: string) => { seen.push(p); return Buffer.from([1]); } }),
    });
    expect(seen).toEqual(["/media/d/2.jpg"]); // newest, not oldest
  });

  it("stores normalised animals and the provenance of the answer", async () => {
    await seed(1);
    await runAiScanOnce({
      prisma, opts: OPTS, control: control(),
      deps: deps({ askSemantics: async () => ({ peopleCount: 1, animals: ["1 bird on a tire", "horse"] }) }),
    });
    const mf = await prisma.mediaFile.findFirstOrThrow();
    expect(mf.aiPeopleCount).toBe(1);
    expect(mf.aiAnimalKinds).toBe(",bird,horse,");
    expect(JSON.parse(mf.aiAnimals!)).toEqual(["1 bird on a tire", "horse"]);
    expect(mf.aiModel).toBe("test-model");
    expect(mf.aiPromptVersion).toBe("semantics-v1");
    expect(mf.aiScannedAt).not.toBeNull();
  });

  it("never touches the basic pass columns", async () => {
    const cam = await seed(1);
    await prisma.mediaFile.updateMany({
      data: { activityScore: 0.9, hasActivity: true, activityScannedAt: new Date("2026-01-01T00:00:00Z") },
    });
    await runAiScanOnce({ prisma, opts: OPTS, control: control(), deps: deps() });
    const mf = await prisma.mediaFile.findFirstOrThrow();
    expect(mf.activityScore).toBe(0.9);
    expect(mf.hasActivity).toBe(true);
    expect(mf.activityScannedAt).toEqual(new Date("2026-01-01T00:00:00Z"));
    expect(cam.id).toBe(mf.cameraId);
  });

  it("asks about the weather at most once per weatherMinGapSeconds, daylight only", async () => {
    await seed(10); // 10 frames, 150 s apart = 22.5 min span
    let weatherCalls = 0;
    await runAiScanOnce({
      prisma, opts: OPTS, control: control(),
      deps: deps({ askWeather: async () => { weatherCalls++; return { visibility: "clear", precipitation: "none", snowOnGround: false }; } }),
    });
    // 600 s gap over a 1350 s span -> 3 sampled frames
    expect(weatherCalls).toBe(3);
  });

  it("never asks about the weather on night frames but still marks them", async () => {
    await seed(3);
    let weatherCalls = 0;
    await runAiScanOnce({
      prisma, opts: OPTS, control: control(),
      deps: deps({
        isNight: async () => true,
        askWeather: async () => { weatherCalls++; return { visibility: "clear", precipitation: "none", snowOnGround: false }; },
      }),
    });
    expect(weatherCalls).toBe(0);
    const rows = await prisma.mediaFile.findMany();
    expect(rows.every((r) => r.isNightIr === true)).toBe(true);
    expect(rows.every((r) => r.weatherScannedAt !== null)).toBe(true);
    expect(rows.every((r) => r.weatherVisibility === null)).toBe(true);
  });

  it("aborts the batch and marks nothing when the model disappears", async () => {
    await seed(3);
    const ctl = control();
    const res = await runAiScanOnce({
      prisma, opts: OPTS, control: ctl,
      deps: deps({ askSemantics: async () => { throw new ModelUnavailableError("gone"); } }),
    });
    expect(res.stopped).toBe("unavailable");
    expect(res.scanned).toBe(0);
    const rows = await prisma.mediaFile.findMany();
    expect(rows.every((r) => r.aiScannedAt === null)).toBe(true);
    expect(rows.every((r) => r.aiFailures === 0)).toBe(true);
    expect(ctl.modelLoaded).toBe(false);
  });

  it("counts a rejected frame against that frame and gives up after maxFailures", async () => {
    await seed(1);
    const run = () => runAiScanOnce({
      prisma, opts: { ...OPTS, maxFailures: 2 }, control: control(),
      deps: deps({ askSemantics: async () => { throw new FrameRejectedError("bad jpeg"); } }),
    });
    await run();
    let mf = await prisma.mediaFile.findFirstOrThrow();
    expect(mf.aiFailures).toBe(1);
    expect(mf.aiScannedAt).toBeNull(); // still retryable
    await run();
    mf = await prisma.mediaFile.findFirstOrThrow();
    expect(mf.aiFailures).toBe(2);
    expect(mf.aiScannedAt).not.toBeNull(); // given up, loop moves on
    expect(mf.aiPeopleCount).toBeNull();
  });

  it("re-scans frames whose prompt version is stale, and leaves current ones alone", async () => {
    await seed(2);
    await runAiScanOnce({ prisma, opts: OPTS, control: control(), deps: deps() });
    const before = await prisma.mediaFile.findMany();
    expect(before.every((r) => r.aiPromptVersion === "semantics-v1")).toBe(true);

    let calls = 0;
    await runAiScanOnce({
      prisma, opts: { ...OPTS, promptVersion: "semantics-v2" }, control: control(),
      deps: deps({ askSemantics: async () => { calls++; return { peopleCount: 0, animals: [] }; } }),
    });
    expect(calls).toBe(2);
    const after = await prisma.mediaFile.findMany();
    expect(after.every((r) => r.aiPromptVersion === "semantics-v2")).toBe(true);
  });

  it("stops immediately when paused", async () => {
    await seed(3);
    const ctl = control();
    ctl.paused = true;
    const res = await runAiScanOnce({ prisma, opts: OPTS, control: ctl, deps: deps() });
    expect(res.stopped).toBe("paused");
    expect(res.scanned).toBe(0);
  });

  it("skips videos and frames that are not downloaded", async () => {
    const cam = await seed(1);
    await prisma.mediaFile.create({
      data: { cameraId: cam.id, fileType: "video", remotePath: "v.mp4", localPath: "/media/v.mp4",
              timestamp: new Date(), isDownloaded: true },
    });
    await prisma.mediaFile.create({
      data: { cameraId: cam.id, fileType: "image", remotePath: "r.jpg", localPath: "/media/r.jpg",
              timestamp: new Date(), isDownloaded: false },
    });
    const res = await runAiScanOnce({ prisma, opts: OPTS, control: control(), deps: deps() });
    expect(res.scanned).toBe(1);
  });
});
```

- [ ] **Step 2: Uruchom i potwierdź niepowodzenie**

Run: `npx vitest run tests/ai/scanner.test.ts`
Expected: FAIL — brak modułu `src/ai/scanner.js`

- [ ] **Step 3: Zaimplementuj pętlę**

`src/ai/scanner.ts`:

```typescript
import type { PrismaClient } from "@prisma/client";
import { ModelUnavailableError, FrameRejectedError, type SemanticResult, type WeatherResult } from "./lmstudio.js";
import { normalizeAnimals } from "./normalize.js";

/** Mutable state shared with the HTTP layer. Separate from the basic pass's control on purpose. */
export interface AiScanControl {
  paused: boolean;
  scanning: boolean;
  modelLoaded: boolean;
  lastProbeAt: Date | null;
  lastError: string | null;
}

export interface AiScanOptions {
  model: string;
  promptVersion: string;
  weatherPromptVersion: string;
  imageWidth: number;
  weatherMinGapSeconds: number;
  batch: number;
  colorThreshold: number;
  maxFailures: number;
}

export interface AiScanDeps {
  loadJpeg: (path: string, width: number) => Promise<Buffer>;
  isNight: (path: string, colorThreshold: number) => Promise<boolean>;
  askSemantics: (jpeg: Buffer) => Promise<SemanticResult>;
  askWeather: (jpeg: Buffer) => Promise<WeatherResult>;
}

export interface AiScanResult {
  scanned: number;
  weatherScanned: number;
  stopped: "empty" | "batch" | "paused" | "unavailable";
}

const PAGE = 50;

/**
 * Extended pass. Walks locally-cached image frames NEWEST FIRST and labels them with a
 * vision model. Independent of the basic differencing pass in every respect: it reads and
 * writes only ai*/weather*/isNightIr columns and never inspects the activity columns.
 *
 * Two failure modes are deliberately distinguished. A transport failure means the model
 * went away — the batch aborts and nothing is marked, because marking would silently
 * record the whole archive as "scanned, found nothing". A per-frame rejection counts
 * against that frame only, and after maxFailures the frame is marked so the loop advances.
 */
export async function runAiScanOnce(args: {
  prisma: PrismaClient;
  opts: AiScanOptions;
  control: AiScanControl;
  deps: AiScanDeps;
}): Promise<AiScanResult> {
  const { prisma, opts, control, deps } = args;
  let scanned = 0;
  let weatherScanned = 0;

  if (control.paused) return { scanned, weatherScanned, stopped: "paused" };

  while (scanned < opts.batch) {
    if (control.paused) return { scanned, weatherScanned, stopped: "paused" };

    // Newest first: fresh frames overtake the backlog automatically. A stale prompt
    // version counts as unscanned, so bumping the version is an ordinary resumable pass.
    const page = await prisma.mediaFile.findMany({
      where: {
        fileType: "image",
        isDownloaded: true,
        aiFailures: { lt: opts.maxFailures },
        OR: [{ aiScannedAt: null }, { aiPromptVersion: { not: opts.promptVersion } }],
      },
      orderBy: [{ timestamp: "desc" }, { id: "desc" }],
      take: Math.min(PAGE, opts.batch - scanned),
      select: { id: true, cameraId: true, localPath: true, timestamp: true },
    });
    if (page.length === 0) return { scanned, weatherScanned, stopped: "empty" };

    for (const f of page) {
      if (control.paused) return { scanned, weatherScanned, stopped: "paused" };

      let jpeg: Buffer;
      let night: boolean;
      try {
        jpeg = await deps.loadJpeg(f.localPath, opts.imageWidth);
        night = await deps.isNight(f.localPath, opts.colorThreshold);
      } catch (e) {
        await bumpFailure(prisma, f.id, opts, `read: ${(e as Error).message}`);
        continue;
      }

      const startedAt = Date.now();
      let semantics: SemanticResult;
      try {
        semantics = await deps.askSemantics(jpeg);
      } catch (e) {
        if (e instanceof ModelUnavailableError) {
          control.modelLoaded = false;
          control.lastError = e.message;
          return { scanned, weatherScanned, stopped: "unavailable" };
        }
        await bumpFailure(prisma, f.id, opts, (e as Error).message);
        continue;
      }

      const animals = normalizeAnimals(semantics.animals);
      await prisma.mediaFile.update({
        where: { id: f.id },
        data: {
          aiScannedAt: new Date(),
          aiModel: opts.model,
          aiPromptVersion: opts.promptVersion,
          aiPeopleCount: semantics.peopleCount,
          aiAnimals: JSON.stringify(semantics.animals),
          aiAnimalKinds: animals.kindsColumn,
          aiLatencyMs: Date.now() - startedAt,
          aiFailures: 0,
          isNightIr: night,
        },
      });
      scanned++;

      if (await shouldAskWeather(prisma, f, night, opts)) {
        try {
          const w = await deps.askWeather(jpeg);
          await prisma.mediaFile.update({
            where: { id: f.id },
            data: {
              weatherScannedAt: new Date(),
              weatherPromptVersion: opts.weatherPromptVersion,
              weatherVisibility: w.visibility,
              weatherPrecipitation: w.precipitation,
              weatherSnowOnGround: w.snowOnGround,
            },
          });
          weatherScanned++;
        } catch (e) {
          if (e instanceof ModelUnavailableError) {
            control.modelLoaded = false;
            control.lastError = e.message;
            return { scanned, weatherScanned, stopped: "unavailable" };
          }
          // A rejected weather answer is not worth failing the frame over — the
          // semantic result is already stored and is the more valuable of the two.
        }
      } else if (night) {
        // Mark night frames as weather-handled so they are not retried forever, but
        // leave the weather fields null: the model calls black IR frames "dense fog".
        await prisma.mediaFile.update({
          where: { id: f.id },
          data: { weatherScannedAt: new Date(), weatherPromptVersion: opts.weatherPromptVersion },
        });
      }

      if (scanned >= opts.batch) return { scanned, weatherScanned, stopped: "batch" };
    }
  }

  return { scanned, weatherScanned, stopped: "batch" };
}

async function bumpFailure(
  prisma: PrismaClient,
  id: number,
  opts: AiScanOptions,
  message: string,
): Promise<void> {
  const row = await prisma.mediaFile.update({
    where: { id },
    data: { aiFailures: { increment: 1 } },
    select: { aiFailures: true },
  });
  if (row.aiFailures >= opts.maxFailures) {
    // Give up on this frame so the loop keeps moving; record that it was seen.
    await prisma.mediaFile.update({
      where: { id },
      data: { aiScannedAt: new Date(), aiModel: opts.model, aiPromptVersion: opts.promptVersion },
    });
  }
  void message;
}

/**
 * Weather is sampled on a TIME interval, not every Nth frame: the capture interval has
 * changed over the years (300 s in 2025, 150 s in 2026) and 2024 frames are motion
 * triggered 1-3 s apart, where "every 4th frame" would mean every few seconds.
 */
async function shouldAskWeather(
  prisma: PrismaClient,
  f: { cameraId: number; timestamp: Date },
  night: boolean,
  opts: AiScanOptions,
): Promise<boolean> {
  if (night) return false;
  const gapMs = opts.weatherMinGapSeconds * 1000;
  const neighbour = await prisma.mediaFile.findFirst({
    where: {
      cameraId: f.cameraId,
      weatherVisibility: { not: null },
      timestamp: {
        gte: new Date(f.timestamp.getTime() - gapMs),
        lte: new Date(f.timestamp.getTime() + gapMs),
      },
    },
    select: { id: true },
  });
  return neighbour === null;
}
```

- [ ] **Step 4: Uruchom testy pętli**

Run: `npx vitest run tests/ai/scanner.test.ts`
Expected: PASS (10 testów)

- [ ] **Step 5: Uruchom cały zestaw — pętla A nie może się zepsuć**

Run: `npm test`
Expected: wszystko przechodzi, w tym `tests/activity/scanner.test.ts`

- [ ] **Step 6: Commit**

```bash
git add src/ai/scanner.ts tests/ai/scanner.test.ts
git commit -m "AI: extended-pass scan loop, newest-first, with transport/frame failure split"
```

---

### Task 8: Wpięcie pętli B do serwera

**Files:**
- Create: `src/ai/runner.ts`
- Modify: `src/server.ts:88-92` (obok rejestracji tras aktywności) oraz sekcja pętli w tle
- Test: `tests/ai/runner.test.ts`

**Interfaces:**
- Consumes: `runAiScanOnce`, `AiScanControl` (Task 7); `probeModelLoaded` (Task 3)
- Produces: `startAiRunner(args): { control: AiScanControl; stop: () => void }`

- [ ] **Step 1: Napisz test sterowania**

`tests/ai/runner.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { aiRunnerTick, type AiRunnerState } from "../../src/ai/runner.js";

function state(over: Partial<AiRunnerState> = {}): AiRunnerState {
  return {
    control: { paused: false, scanning: false, modelLoaded: false, lastProbeAt: null, lastError: null },
    lastProbeMs: 0,
    ...over,
  };
}

describe("aiRunnerTick", () => {
  it("probes when the model is not known to be loaded, and does not scan", async () => {
    const probe = vi.fn().mockResolvedValue(false);
    const scan = vi.fn();
    const s = state();
    await aiRunnerTick(s, { probe, scan, probeIntervalMs: 300_000, now: 1_000_000 });
    expect(probe).toHaveBeenCalledOnce();
    expect(scan).not.toHaveBeenCalled();
    expect(s.control.modelLoaded).toBe(false);
  });

  it("scans continuously while the model stays loaded, without re-probing", async () => {
    const probe = vi.fn().mockResolvedValue(true);
    const scan = vi.fn().mockResolvedValue({ scanned: 200, weatherScanned: 5, stopped: "batch" });
    const s = state();
    await aiRunnerTick(s, { probe, scan, probeIntervalMs: 300_000, now: 1_000_000 });
    expect(s.control.modelLoaded).toBe(true);
    expect(scan).toHaveBeenCalledOnce();

    // next tick, one second later: still loaded, so scan again without probing
    await aiRunnerTick(s, { probe, scan, probeIntervalMs: 300_000, now: 1_001_000 });
    expect(probe).toHaveBeenCalledOnce(); // not re-probed
    expect(scan).toHaveBeenCalledTimes(2);
  });

  it("stops scanning and returns to probing when the model disappears mid-batch", async () => {
    const probe = vi.fn().mockResolvedValue(true);
    const scan = vi.fn().mockResolvedValue({ scanned: 3, weatherScanned: 0, stopped: "unavailable" });
    const s = state();
    await aiRunnerTick(s, { probe, scan, probeIntervalMs: 300_000, now: 1_000_000 });
    expect(s.control.modelLoaded).toBe(false);

    // too soon for another probe -> idle
    await aiRunnerTick(s, { probe, scan, probeIntervalMs: 300_000, now: 1_010_000 });
    expect(probe).toHaveBeenCalledOnce();
    expect(scan).toHaveBeenCalledOnce();

    // probe interval elapsed -> probe again
    await aiRunnerTick(s, { probe, scan, probeIntervalMs: 300_000, now: 1_400_000 });
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("does nothing at all while paused", async () => {
    const probe = vi.fn().mockResolvedValue(true);
    const scan = vi.fn();
    const s = state();
    s.control.paused = true;
    await aiRunnerTick(s, { probe, scan, probeIntervalMs: 300_000, now: 1_000_000 });
    expect(probe).not.toHaveBeenCalled();
    expect(scan).not.toHaveBeenCalled();
  });

  it("goes back to probing after the backlog is exhausted", async () => {
    const probe = vi.fn().mockResolvedValue(true);
    const scan = vi.fn().mockResolvedValue({ scanned: 0, weatherScanned: 0, stopped: "empty" });
    const s = state();
    await aiRunnerTick(s, { probe, scan, probeIntervalMs: 300_000, now: 1_000_000 });
    // backlog empty: stay "loaded" but idle until the probe interval elapses again
    await aiRunnerTick(s, { probe, scan, probeIntervalMs: 300_000, now: 1_001_000 });
    expect(scan).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Uruchom i potwierdź niepowodzenie**

Run: `npx vitest run tests/ai/runner.test.ts`
Expected: FAIL — brak modułu

- [ ] **Step 3: Zaimplementuj sterowanie i osadzenie**

`src/ai/runner.ts`:

```typescript
import type { PrismaClient } from "@prisma/client";
import sharp from "sharp";
import type { AppConfig } from "../config.js";
import { probeModelLoaded, askSemantics, askWeather, type AskOptions } from "./lmstudio.js";
import { isNightFrame } from "./night.js";
import { runAiScanOnce, type AiScanControl, type AiScanResult } from "./scanner.js";

export interface AiRunnerState {
  control: AiScanControl;
  lastProbeMs: number;
  /** Set when the backlog ran dry, so we idle until the next probe instead of hot-looping. */
  backlogEmpty?: boolean;
}

export interface TickDeps {
  probe: () => Promise<boolean>;
  scan: () => Promise<AiScanResult>;
  probeIntervalMs: number;
  now: number;
}

/**
 * One turn of the extended pass.
 *
 * While the model is loaded we scan continuously rather than on a fixed interval: the
 * owner loaded it precisely to hand the GPU over, so idling would waste that window. The
 * 5-minute probe interval governs only the "model absent" state, which is the normal
 * condition whenever the workstation is off.
 */
export async function aiRunnerTick(state: AiRunnerState, deps: TickDeps): Promise<void> {
  if (state.control.paused) return;

  const dueForProbe = deps.now - state.lastProbeMs >= deps.probeIntervalMs;

  if (!state.control.modelLoaded || state.backlogEmpty) {
    if (!dueForProbe) return;
    state.lastProbeMs = deps.now;
    state.control.lastProbeAt = new Date(deps.now);
    state.control.modelLoaded = await deps.probe();
    state.backlogEmpty = false;
    if (!state.control.modelLoaded) return;
  }

  state.control.scanning = true;
  try {
    const res = await deps.scan();
    if (res.stopped === "unavailable") {
      state.control.modelLoaded = false;
      state.lastProbeMs = deps.now; // do not hammer a host that just went away
    } else if (res.stopped === "empty") {
      state.backlogEmpty = true;
      state.lastProbeMs = deps.now;
    }
  } finally {
    state.control.scanning = false;
  }
}

/** Wires the tick into a timer and returns the shared control plus a stop handle. */
export function startAiRunner(args: {
  prisma: PrismaClient;
  cfg: AppConfig;
  log: (msg: string, err?: unknown) => void;
}): { control: AiScanControl; stop: () => void } {
  const { prisma, cfg, log } = args;
  const control: AiScanControl = {
    paused: false, scanning: false, modelLoaded: false, lastProbeAt: null, lastError: null,
  };
  const state: AiRunnerState = { control, lastProbeMs: -Infinity };

  const ask: AskOptions = {
    url: cfg.ai.lmStudioUrl,
    model: cfg.ai.model,
    timeoutMs: cfg.ai.requestTimeoutMs,
  };

  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  async function loop(): Promise<void> {
    if (stopped) return;
    try {
      await aiRunnerTick(state, {
        probe: () => probeModelLoaded({ ...ask, timeoutMs: 5000 }),
        scan: () =>
          runAiScanOnce({
            prisma,
            control,
            opts: {
              model: cfg.ai.model,
              promptVersion: cfg.ai.promptVersion,
              weatherPromptVersion: cfg.ai.weatherPromptVersion,
              imageWidth: cfg.ai.imageWidth,
              weatherMinGapSeconds: cfg.ai.weatherMinGapSeconds,
              batch: cfg.ai.batch,
              colorThreshold: cfg.activity.colorThreshold,
              maxFailures: cfg.ai.maxFailures,
            },
            deps: {
              loadJpeg: (path, width) =>
                sharp(path).resize({ width, withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer(),
              isNight: (path, threshold) => isNightFrame(path, threshold),
              askSemantics: (jpeg) => askSemantics(ask, jpeg),
              askWeather: (jpeg) => askWeather(ask, jpeg),
            },
          }),
        probeIntervalMs: cfg.ai.probeIntervalSeconds * 1000,
        now: Date.now(),
      });
    } catch (e) {
      control.lastError = (e as Error).message;
      log("ai runner tick failed", e);
    }
    // Short cadence: the tick itself decides whether to probe, scan or idle.
    timer = setTimeout(() => void loop(), 5000);
  }

  void loop();

  return {
    control,
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
```

W `src/server.ts`, obok istniejącej pętli aktywności, dodaj (nie modyfikując tamtej):

```typescript
import { startAiRunner } from "./ai/runner.js";

// ...

// Extended pass — entirely separate from the activity loop above. Disabled by default;
// when enabled it idles harmlessly whenever the workstation is off.
if (cfg.ai.enabled) {
  const ai = startAiRunner({
    prisma,
    cfg,
    log: (msg, err) => app.log.warn({ err }, msg),
  });
  app.addHook("onClose", async () => ai.stop());
  registerAiRoutes(app, { prisma, control: ai.control, cfg });
} else {
  registerAiRoutes(app, { prisma, control: null, cfg });
}
```

- [ ] **Step 4: Uruchom testy sterowania**

Run: `npx vitest run tests/ai/runner.test.ts`
Expected: PASS (5 testów)

- [ ] **Step 5: Commit**

```bash
git add src/ai/runner.ts src/server.ts tests/ai/runner.test.ts
git commit -m "AI: runner with 300 s availability probe and continuous scan while loaded"
```

---

### Task 9: Trasy `/api/ai/*`

**Files:**
- Create: `src/routes/ai.ts`
- Test: `tests/routes/ai.test.ts`

**Interfaces:**
- Consumes: `AiScanControl` (Task 7), `AppConfig` (Task 2)
- Produces: `registerAiRoutes(app, deps: { prisma; control: AiScanControl | null; cfg: AppConfig })`

Trasy aktywności zostają **nietknięte** — to jest osobny zestaw dla osobnego przebiegu.

- [ ] **Step 1: Napisz testy tras**

`tests/routes/ai.test.ts`:

```typescript
import { describe, it, expect, afterAll, beforeEach } from "vitest";
import Fastify from "fastify";
import { makeTestDb } from "../helpers/testDb.js";
import { registerAiRoutes } from "../../src/routes/ai.js";
import { loadConfig } from "../../src/config.js";

const { prisma } = makeTestDb();
const cfg = loadConfig({
  MOTIONEYE_URL: "x", MOTIONEYE_USER: "u", MOTIONEYE_PASSWORD: "p", SECRET_KEY: "s",
  AI_TAGGING_ENABLED: "true",
});

afterAll(async () => { await prisma.$disconnect(); });
beforeEach(async () => {
  await prisma.mediaFile.deleteMany();
  await prisma.camera.deleteMany();
});

function app(control: any) {
  const f = Fastify();
  registerAiRoutes(f, { prisma, control, cfg });
  return f;
}

async function seedOne(over: object = {}) {
  const cam = await prisma.camera.create({ data: { motionEyeId: 1, name: "Cam" } });
  await prisma.mediaFile.create({
    data: {
      cameraId: cam.id, fileType: "image", remotePath: "a.jpg", localPath: "/m/a.jpg",
      timestamp: new Date("2026-01-01T12:00:00Z"), isDownloaded: true, ...over,
    },
  });
}

describe("GET /api/ai/status", () => {
  it("reports counts for the extended pass only", async () => {
    await seedOne({
      aiScannedAt: new Date(), aiPeopleCount: 2, aiAnimalKinds: ",bird,",
      weatherScannedAt: new Date(), weatherVisibility: "dense_fog",
      hasActivity: true, activityScannedAt: new Date(),
    });
    await seedOne({ remotePath: "b.jpg" });

    const f = app({ paused: false, scanning: true, modelLoaded: true, lastProbeAt: new Date(), lastError: null });
    const res = await f.inject({ method: "GET", url: "/api/ai/status" });
    const body = res.json();
    expect(body.enabled).toBe(true);
    expect(body.modelLoaded).toBe(true);
    expect(body.totalLocalImages).toBe(2);
    expect(body.scanned).toBe(1);
    expect(body.pending).toBe(1);
    expect(body.withPeople).toBe(1);
    expect(body.withAnimals).toBe(1);
    expect(body.withWeather).toBe(1);
    // must NOT leak the basic pass's numbers into this endpoint
    expect(body.withActivity).toBeUndefined();
  });

  it("reports disabled state without a control", async () => {
    const f = app(null);
    const body = (await f.inject({ method: "GET", url: "/api/ai/status" })).json();
    expect(body.modelLoaded).toBe(false);
    expect(body.scanning).toBe(false);
  });
});

describe("pause and resume", () => {
  it("toggles only the extended pass control", async () => {
    const control = { paused: false, scanning: false, modelLoaded: true, lastProbeAt: null, lastError: null };
    const f = app(control);
    await f.inject({ method: "POST", url: "/api/ai/pause" });
    expect(control.paused).toBe(true);
    await f.inject({ method: "POST", url: "/api/ai/resume" });
    expect(control.paused).toBe(false);
  });
});
```

- [ ] **Step 2: Uruchom i potwierdź niepowodzenie**

Run: `npx vitest run tests/routes/ai.test.ts`
Expected: FAIL — brak modułu

- [ ] **Step 3: Zaimplementuj trasy**

`src/routes/ai.ts`:

```typescript
import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import type { AppConfig } from "../config.js";
import type { AiScanControl } from "../ai/scanner.js";

export interface AiRouteDeps {
  prisma: PrismaClient;
  /** null when the extended pass is disabled — the routes still answer, reporting idle. */
  control: AiScanControl | null;
  cfg: AppConfig;
}

/**
 * Status and controls for the EXTENDED pass only. The basic pass keeps its own
 * /api/activity/* routes; mixing the two would make it impossible for the UI to show
 * that one pass is working while the other sleeps.
 */
export function registerAiRoutes(app: FastifyInstance, deps: AiRouteDeps): void {
  const { prisma, control, cfg } = deps;
  const localImage = { fileType: "image", isDownloaded: true } as const;

  app.get("/api/ai/status", async () => {
    const [total, scanned, weatherScanned, withPeople, withAnimals, withWeather, latency] =
      await Promise.all([
        prisma.mediaFile.count({ where: localImage }),
        prisma.mediaFile.count({ where: { ...localImage, aiScannedAt: { not: null } } }),
        prisma.mediaFile.count({ where: { ...localImage, weatherVisibility: { not: null } } }),
        prisma.mediaFile.count({ where: { ...localImage, aiPeopleCount: { gt: 0 } } }),
        prisma.mediaFile.count({ where: { ...localImage, aiAnimalKinds: { not: null } } }),
        prisma.mediaFile.count({
          where: {
            ...localImage,
            OR: [{ weatherVisibility: "dense_fog" }, { weatherPrecipitation: { in: ["snow", "heavy_rain"] } }],
          },
        }),
        prisma.mediaFile.aggregate({
          _avg: { aiLatencyMs: true },
          where: { ...localImage, aiLatencyMs: { not: null } },
        }),
      ]);

    return {
      enabled: cfg.ai.enabled,
      paused: control?.paused ?? false,
      scanning: control?.scanning ?? false,
      modelLoaded: control?.modelLoaded ?? false,
      model: cfg.ai.model,
      lastProbeAt: control?.lastProbeAt ?? null,
      totalLocalImages: total,
      scanned,
      pending: total - scanned,
      weatherScanned,
      withPeople,
      withAnimals,
      withWeather,
      avgLatencyMs: latency._avg.aiLatencyMs ? Math.round(latency._avg.aiLatencyMs) : null,
      lastError: control?.lastError ?? null,
    };
  });

  app.post("/api/ai/pause", async () => {
    if (control) control.paused = true;
    return { paused: true };
  });

  app.post("/api/ai/resume", async () => {
    if (control) control.paused = false;
    return { paused: false };
  });
}
```

- [ ] **Step 4: Uruchom testy**

Run: `npx vitest run tests/routes/ai.test.ts`
Expected: PASS (3 testy)

- [ ] **Step 5: Commit**

```bash
git add src/routes/ai.ts tests/routes/ai.test.ts
git commit -m "API: /api/ai/status, pause and resume for the extended pass"
```

---

### Task 10: Filtr `detections` i `scannedBy`

**Files:**
- Create: `src/media/detectionFilter.ts`
- Modify: `src/routes/media.ts:33-35` (budowanie `where`)
- Test: `tests/media/detectionFilter.test.ts`, `tests/routes/media.test.ts` (dopisz)

**Interfaces:**
- Consumes: nic
- Produces:
  - `buildDetectionWhere(spec: string | undefined): object | null`
  - `buildCoverageWhere(spec: string | undefined): object | null`

- [ ] **Step 1: Napisz testy budowania warunków**

`tests/media/detectionFilter.test.ts`:

```typescript
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
        { aiAnimalKinds: { not: null } },
        { weatherVisibility: "dense_fog" },
        { weatherPrecipitation: "snow" },
        { weatherSnowOnGround: true },
        { isNightIr: true },
      ],
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
```

- [ ] **Step 2: Uruchom i potwierdź niepowodzenie**

Run: `npx vitest run tests/media/detectionFilter.test.ts`
Expected: FAIL — brak modułu

- [ ] **Step 3: Zaimplementuj**

`src/media/detectionFilter.ts`:

```typescript
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
```

Uwaga na `animal:bird` — ponieważ `clauseFor` zwraca `null` dla nieznanego gatunku, a lista `SPECIES` zawiera te same wartości co `src/ai/normalize.ts`. Przy dodawaniu gatunku trzeba zmienić **oba** miejsca.

- [ ] **Step 4: Wepnij do trasy `/api/media`**

W `src/routes/media.ts` dodaj import i zamień blok filtrowania:

```typescript
import { buildDetectionWhere, buildCoverageWhere } from "../media/detectionFilter.js";
```

```typescript
    const where: Record<string, unknown> = { cameraId };
    // Legacy single-purpose flag, kept so existing bookmarks keep working.
    if (q.activityOnly === "true") where.hasActivity = true;

    const and: Record<string, unknown>[] = [];
    const detections = buildDetectionWhere(q.detections);
    if (detections) and.push(detections);
    const coverage = buildCoverageWhere(q.scannedBy);
    if (coverage) and.push(coverage);
    if (and.length) where.AND = and;
```

Reszta funkcji (zakres dat, kursor, `findMany`) bez zmian.

- [ ] **Step 5: Dopisz test trasy**

Dopisz do `tests/routes/media.test.ts` (plik ma już `makeTestDb`, `beforeEach` i lokalny helper `app()`):

```typescript
describe("GET /api/media — detection filters", () => {
  async function seedThree() {
    const cam = await prisma.camera.create({ data: { motionEyeId: 7, name: "Camera1" } });
    const mk = (remotePath: string, extra: object) =>
      prisma.mediaFile.create({
        data: {
          cameraId: cam.id,
          fileType: "image",
          remotePath,
          localPath: `/m/${remotePath}`,
          timestamp: new Date(2_000_000),
          isDownloaded: true,
          ...extra,
        },
      });
    // basic pass only
    await mk("motion.jpg", { hasActivity: true, activityScannedAt: new Date() });
    // extended pass only
    await mk("bird.jpg", { aiScannedAt: new Date(), aiAnimalKinds: ",bird," });
    // seen by neither pass
    await mk("quiet.jpg", {});
    return cam;
  }

  it("returns the union of the selected kinds", async () => {
    const cam = await seedThree();
    const a = await app();
    const res = await a.inject({
      method: "GET",
      url: `/api/media?cameraId=${cam.id}&detections=motion,animal:bird`,
    });
    const paths = res.json().items.map((i: { remotePath: string }) => i.remotePath).sort();
    expect(paths).toEqual(["bird.jpg", "motion.jpg"]);
  });

  it("does not match a species by substring", async () => {
    const cam = await seedThree();
    const a = await app();
    const res = await a.inject({
      method: "GET",
      url: `/api/media?cameraId=${cam.id}&detections=animal:dog`,
    });
    expect(res.json().items).toHaveLength(0);
  });

  it("returns everything when no kind is selected", async () => {
    const cam = await seedThree();
    const a = await app();
    const res = await a.inject({ method: "GET", url: `/api/media?cameraId=${cam.id}` });
    expect(res.json().items).toHaveLength(3);
  });

  it("separates frames by which pass has seen them", async () => {
    const cam = await seedThree();
    const a = await app();
    const only = async (scannedBy: string) => {
      const r = await a.inject({ method: "GET", url: `/api/media?cameraId=${cam.id}&scannedBy=${scannedBy}` });
      return r.json().items.map((i: { remotePath: string }) => i.remotePath).sort();
    };
    expect(await only("basic")).toEqual(["motion.jpg"]);
    expect(await only("ai")).toEqual(["bird.jpg"]);
    expect(await only("none")).toEqual(["quiet.jpg"]);
    expect(await only("both")).toEqual([]);
  });
});
```

- [ ] **Step 6: Uruchom testy**

Run: `npx vitest run tests/media/detectionFilter.test.ts tests/routes/media.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/media/detectionFilter.ts src/routes/media.ts tests/media/detectionFilter.test.ts tests/routes/media.test.ts
git commit -m "API: per-kind detection filter and coverage filter on /api/media"
```

---

### Task 11: Histogram z licznikami obu przebiegów

**Files:**
- Modify: `src/routes/timeline.ts:19-42`
- Test: `tests/routes/timeline.test.ts` (dopisz)

**Interfaces:**
- Consumes: kolumny z Task 1
- Produces: `{ bucket, count, activityCount, peopleCount, animalCount, weatherCount }`

- [ ] **Step 1: Dopisz test**

Do `tests/routes/timeline.test.ts`:

```typescript
it("counts both passes separately in one histogram row", async () => {
  const cam = await prisma.camera.create({ data: { motionEyeId: 9, name: "Camera1" } });
  const day = (h: number) => new Date(Date.UTC(2026, 0, 5, h, 0, 0));
  const mk = (remotePath: string, hour: number, extra: object) =>
    prisma.mediaFile.create({
      data: {
        cameraId: cam.id,
        fileType: "image",
        remotePath,
        localPath: `/m/${remotePath}`,
        timestamp: day(hour),
        isDownloaded: true,
        ...extra,
      },
    });
  await mk("a.jpg", 1, { hasActivity: true });
  await mk("b.jpg", 2, { aiPeopleCount: 2 });
  await mk("c.jpg", 3, { aiAnimalKinds: ",bird,", weatherVisibility: "dense_fog" });
  await mk("d.jpg", 4, {}); // nothing found by either pass

  const a = await app();
  const res = await a.inject({ method: "GET", url: `/api/cameras/${cam.id}/histogram?bucket=day` });
  const row = res.json()[0];
  expect(row.count).toBe(4);
  expect(row.activityCount).toBe(1);
  expect(row.peopleCount).toBe(1);
  expect(row.animalCount).toBe(1);
  expect(row.weatherCount).toBe(1);
});
```

- [ ] **Step 2: Uruchom i potwierdź niepowodzenie**

Run: `npx vitest run tests/routes/timeline.test.ts`
Expected: FAIL — `peopleCount` jest `undefined`

- [ ] **Step 3: Rozszerz zapytanie**

W `src/routes/timeline.ts` zamień zapytanie i mapowanie:

```typescript
    const rows = await prisma.$queryRaw<
      Array<{
        bucket: string; count: bigint; activityCount: bigint;
        peopleCount: bigint; animalCount: bigint; weatherCount: bigint;
      }>
    >(Prisma.sql`
      SELECT strftime(${fmt}, timestamp / 1000, 'unixepoch') AS bucket,
             COUNT(*) AS count,
             SUM(CASE WHEN hasActivity THEN 1 ELSE 0 END) AS activityCount,
             SUM(CASE WHEN aiPeopleCount > 0 THEN 1 ELSE 0 END) AS peopleCount,
             SUM(CASE WHEN aiAnimalKinds IS NOT NULL THEN 1 ELSE 0 END) AS animalCount,
             SUM(CASE WHEN weatherVisibility = 'dense_fog'
                        OR weatherPrecipitation IN ('snow','heavy_rain') THEN 1 ELSE 0 END) AS weatherCount
      FROM MediaFile
      WHERE cameraId = ${cameraId}
      GROUP BY bucket
      ORDER BY bucket ASC
    `);
    return rows.map((r) => ({
      bucket: r.bucket,
      count: Number(r.count),
      activityCount: Number(r.activityCount),
      peopleCount: Number(r.peopleCount),
      animalCount: Number(r.animalCount),
      weatherCount: Number(r.weatherCount),
    }));
```

- [ ] **Step 4: Uruchom testy**

Run: `npx vitest run tests/routes/timeline.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/routes/timeline.ts tests/routes/timeline.test.ts
git commit -m "API: histogram counts both passes as separate series"
```

---

### Task 12: Naprawa `/api/activity/rescan`

**Files:**
- Modify: `src/routes/activity.ts:44-52`
- Test: `tests/routes/activity.test.ts` (utwórz, jeśli nie istnieje)

**Interfaces:**
- Consumes: nic
- Produces: `POST /api/activity/rescan?keepScores=true` przelicza próg bez kasowania wyników

Dziś ta trasa kasuje `activityScore`, więc zmiana samego progu wymusza ponowne dekodowanie 209 tysięcy plików, choć wynik już jest w bazie.

- [ ] **Step 1: Napisz test**

`tests/routes/activity.test.ts`:

```typescript
import { describe, it, expect, afterAll, beforeEach } from "vitest";
import Fastify from "fastify";
import { makeTestDb } from "../helpers/testDb.js";
import { registerActivityRoutes } from "../../src/routes/activity.js";

const { prisma } = makeTestDb();
afterAll(async () => { await prisma.$disconnect(); });
beforeEach(async () => {
  await prisma.mediaFile.deleteMany();
  await prisma.camera.deleteMany();
});

describe("POST /api/activity/rescan", () => {
  it("with keepScores keeps the stored scores and only clears the verdict", async () => {
    const cam = await prisma.camera.create({ data: { motionEyeId: 1, name: "Cam" } });
    await prisma.mediaFile.create({
      data: {
        cameraId: cam.id, fileType: "image", remotePath: "a.jpg", localPath: "/m/a.jpg",
        timestamp: new Date(), isDownloaded: true,
        activityScore: 0.12, hasActivity: true, activityScannedAt: new Date(),
      },
    });
    const app = Fastify();
    registerActivityRoutes(app, {
      prisma,
      control: { paused: false, scanning: false },
      enabled: true,
    });

    await app.inject({ method: "POST", url: "/api/activity/rescan?keepScores=true" });
    const mf = await prisma.mediaFile.findFirstOrThrow();
    expect(mf.activityScore).toBe(0.12); // no re-decode needed
    expect(mf.activityScannedAt).toBeNull();
    expect(mf.hasActivity).toBe(false);
  });
});
```

- [ ] **Step 2: Uruchom i potwierdź niepowodzenie**

Run: `npx vitest run tests/routes/activity.test.ts`
Expected: FAIL — `activityScore` wychodzi `null`

- [ ] **Step 3: Popraw trasę**

W `src/routes/activity.ts` zamień treść handlera `rescan`:

```typescript
  // Clear activity results so the scanner re-processes frames after a tuning change.
  // With keepScores=true the stored per-frame scores survive: re-applying a threshold
  // does not require decoding 209k JPEGs again, only re-evaluating numbers already held.
  app.post("/api/activity/rescan", async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const keepScores = q.keepScores === "true";
    const res = await prisma.mediaFile.updateMany({
      where: { activityScannedAt: { not: null } },
      data: keepScores
        ? { activityScannedAt: null, hasActivity: false }
        : { activityScannedAt: null, hasActivity: false, activityScore: null },
    });
    return { reset: res.count, keptScores: keepScores };
  });
```

- [ ] **Step 4: Uruchom testy**

Run: `npx vitest run tests/routes/activity.test.ts && npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/routes/activity.ts tests/routes/activity.test.ts
git commit -m "API: activity rescan can re-apply a threshold without wiping scores"
```

---

### Task 13: Frontend — typy i klient API

**Files:**
- Modify: `web/src/api.ts:5-40` (typy), `web/src/api.ts:66-88` (funkcje)

**Interfaces:**
- Consumes: kształty odpowiedzi z Task 9, 10, 11
- Produces: `AiStatus`, rozszerzone `MediaFile` i `HistogramBucket`, `api.aiStatus()`, `api.pauseAi()`, `api.resumeAi()`, `api.media(..., { detections, scannedBy })`

Frontend nie ma testów — weryfikacja przez `cd web && npm run build`.

- [ ] **Step 1: Rozszerz typy**

W `web/src/api.ts` dopisz do `MediaFile`:

```typescript
  // Extended pass (null until the vision model has seen this frame).
  aiScannedAt: string | null;
  aiPeopleCount: number | null;
  aiAnimalKinds: string | null; // ",bird,dog," or null
  weatherVisibility: string | null;
  weatherPrecipitation: string | null;
  weatherSnowOnGround: boolean | null;
  isNightIr: boolean | null;
```

do `HistogramBucket`:

```typescript
  peopleCount: number;
  animalCount: number;
  weatherCount: number;
```

i dodaj nowy typ:

```typescript
export interface AiStatus {
  enabled: boolean;
  paused: boolean;
  scanning: boolean;
  modelLoaded: boolean;
  model: string;
  lastProbeAt: string | null;
  totalLocalImages: number;
  scanned: number;
  pending: number;
  weatherScanned: number;
  withPeople: number;
  withAnimals: number;
  withWeather: number;
  avgLatencyMs: number | null;
  lastError: string | null;
}
```

- [ ] **Step 2: Rozszerz klienta**

W `api.media` dodaj do typu `opts` i do budowania parametrów:

```typescript
      detections?: string[];
      scannedBy?: "basic" | "ai" | "both" | "none";
```

```typescript
    if (opts.detections?.length) p.set("detections", opts.detections.join(","));
    if (opts.scannedBy) p.set("scannedBy", opts.scannedBy);
```

I dopisz do obiektu `api`:

```typescript
  aiStatus: () => getJson<AiStatus>("/api/ai/status"),
  pauseAi: () => fetch("/api/ai/pause", { method: "POST" }).then((r) => r.json()),
  resumeAi: () => fetch("/api/ai/resume", { method: "POST" }).then((r) => r.json()),
```

- [ ] **Step 3: Zbuduj frontend**

Run: `cd web && npm run build`
Expected: build przechodzi bez błędów typów

- [ ] **Step 4: Commit**

```bash
git add web/src/api.ts
git commit -m "Web: API client types for the extended pass"
```

---

### Task 14: Frontend — panel filtrów z przełącznikami rodzajów

**Files:**
- Create: `web/src/components/DetectionFilter.tsx`
- Modify: `web/src/App.tsx:28` (stan), `web/src/App.tsx:43,61` (wywołania `api.media`), `web/src/App.tsx:168-180` (nagłówek)

**Interfaces:**
- Consumes: `api.media({ detections, scannedBy })` z Task 13
- Produces: `<DetectionFilter selected={string[]} onChange={(next: string[]) => void} counts={Record<string, number>} aiAvailable={boolean} />`

- [ ] **Step 1: Utwórz komponent panelu**

`web/src/components/DetectionFilter.tsx`:

```tsx
interface DetectionFilterProps {
  selected: string[];
  onChange: (next: string[]) => void;
  /** Per-kind counts for the current date range; omit a key to hide its count. */
  counts: Record<string, number>;
  /** False when the vision model has never labelled anything — the group is dimmed. */
  aiAvailable: boolean;
}

const BASIC = [{ id: "motion", label: "ruch w kadrze" }];

const EXTENDED = [
  { id: "people", label: "osoba" },
  { id: "animal", label: "zwierzę — dowolne" },
  { id: "animal:bird", label: "ptak", indent: true },
  { id: "animal:dog", label: "pies", indent: true },
  { id: "animal:horse", label: "koń", indent: true },
  { id: "animal:deer", label: "sarna", indent: true },
  { id: "animal:other", label: "inne", indent: true },
  { id: "fog", label: "gęsta mgła" },
  { id: "snow", label: "opad śniegu" },
  { id: "snow_ground", label: "śnieg na ziemi" },
  { id: "night", label: "noc (podczerwień)" },
];

/**
 * Every kind toggles on its own; selecting several is a union. Nothing selected shows
 * everything. The two groups are separated because they come from two independent passes
 * and the user needs to know which pass produced a label.
 */
export function DetectionFilter({ selected, onChange, counts, aiAvailable }: DetectionFilterProps) {
  const toggle = (id: string) =>
    onChange(selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]);

  const row = (item: { id: string; label: string; indent?: boolean }, disabled = false) => (
    <label
      key={item.id}
      className={`flex cursor-pointer items-center gap-2 py-0.5 font-mono text-xs ${
        item.indent ? "pl-5" : ""
      } ${disabled ? "cursor-default opacity-40" : "hover:text-fg"} ${
        selected.includes(item.id) ? "text-amber" : "text-muted"
      }`}
    >
      <input
        type="checkbox"
        className="accent-amber"
        checked={selected.includes(item.id)}
        disabled={disabled}
        onChange={() => toggle(item.id)}
      />
      <span className="flex-1">{item.label}</span>
      {counts[item.id] !== undefined && (
        <span className="tabular-nums text-muted">{counts[item.id]}</span>
      )}
    </label>
  );

  return (
    <div className="flex flex-wrap gap-6">
      <fieldset className="min-w-[190px]">
        <legend className="mb-1 font-mono text-[10px] uppercase tracking-widest text-muted">
          Przebieg podstawowy
        </legend>
        {BASIC.map((i) => row(i))}
      </fieldset>

      <fieldset className="min-w-[230px]">
        <legend className="mb-1 font-mono text-[10px] uppercase tracking-widest text-muted">
          Przebieg rozszerzony
        </legend>
        {!aiAvailable && (
          <p className="mb-1 max-w-[230px] font-mono text-[10px] leading-snug text-muted">
            Model jeszcze nic nie oznaczył. Włącz go w LM Studio, żeby te filtry zadziałały.
          </p>
        )}
        {EXTENDED.map((i) => row(i, !aiAvailable))}
      </fieldset>

      <div className="flex items-end gap-3 font-mono text-xs">
        <button onClick={() => onChange([])} className="text-muted hover:text-fg">
          wyczyść
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Wepnij do `App.tsx`**

Dodaj importy na górze `App.tsx`:

```tsx
import { DetectionFilter } from "./components/DetectionFilter";
import type { AiStatus } from "./api";
```

Zamień stan `activityOnly` na listę rodzajów:

```tsx
  const [detections, setDetections] = useState<string[]>([]);
  const [aiStatus, setAiStatus] = useState<AiStatus | null>(null);
```

W obu miejscach, gdzie wołane jest `api.media(...)`, zamień `activityOnly` na `detections`:

```tsx
      const page = await api.media(cam.id, { from, limit: 150, detections });
```

```tsx
    const page = await api.media(camera.id, { cursor, limit: 150, detections });
```

i zaktualizuj tablice zależności `useCallback` z `[activityOnly]` na `[detections]` oraz z `[camera, cursor, loading, activityOnly]` na `[camera, cursor, loading, detections]`.

W nagłówku zamień pojedynczy przycisk „tylko aktywność" na:

```tsx
          <DetectionFilter
            selected={detections}
            onChange={setDetections}
            counts={{
              motion: buckets.reduce((a, b) => a + b.activityCount, 0),
              people: aiStatus?.withPeople ?? 0,
              animal: aiStatus?.withAnimals ?? 0,
            }}
            aiAvailable={(aiStatus?.scanned ?? 0) > 0}
          />
```

Dodaj pobranie stanu przy montowaniu:

```tsx
  useEffect(() => {
    void api.aiStatus().then(setAiStatus).catch(() => setAiStatus(null));
  }, [pokes]);
```

- [ ] **Step 3: Zbuduj**

Run: `cd web && npm run build`
Expected: build przechodzi

- [ ] **Step 4: Sprawdź ręcznie**

Run: `npm run dev` (backend) i `cd web && npm run dev`
Sprawdź: przełączniki włączają się niezależnie; zaznaczenie dwóch daje sumę; wyczyszczenie pokazuje wszystko; grupa rozszerzona jest wygaszona z notatką, gdy `AI_TAGGING_ENABLED=false`.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/DetectionFilter.tsx web/src/App.tsx
git commit -m "Web: per-kind detection filter grouped by pass"
```

---

### Task 15: Frontend — odznaki, tray i oś czasu

**Files:**
- Modify: `web/src/components/Thumb.tsx:118-130`, `web/src/components/ScanStatusTray.tsx`, `web/src/components/Timeline.tsx`

**Interfaces:**
- Consumes: rozszerzone `MediaFile`, `AiStatus`, `HistogramBucket` z Task 13

- [ ] **Step 1: Odznaki na kafelku**

W `web/src/components/Thumb.tsx`, pod istniejącą odznaką aktywności (nie zamiast niej — oba przebiegi są równorzędne), dodaj:

```tsx
      {/* extended-pass badges — visually distinct from the amber activity dot above,
          so it is obvious which pass produced which label */}
      {(media.aiPeopleCount ?? 0) > 0 && (
        <span
          className="pointer-events-none absolute bottom-1.5 left-1.5 z-10 rounded-sm bg-sky-400/90 px-1 py-0.5 font-mono text-[8px] font-semibold uppercase tracking-wider text-ink"
          title={`${media.aiPeopleCount} osoba/osób`}
        >
          osoba
        </span>
      )}
      {media.aiAnimalKinds && (
        <span
          className="pointer-events-none absolute bottom-1.5 left-14 z-10 rounded-sm bg-emerald-400/90 px-1 py-0.5 font-mono text-[8px] font-semibold uppercase tracking-wider text-ink"
          title={`zwierzę: ${media.aiAnimalKinds.replaceAll(",", " ").trim()}`}
        >
          {media.aiAnimalKinds.split(",").filter(Boolean)[0]}
        </span>
      )}
      {media.weatherVisibility === "dense_fog" && (
        <span className="pointer-events-none absolute top-1.5 left-1.5 z-10 rounded-sm bg-slate-300/90 px-1 py-0.5 font-mono text-[8px] font-semibold uppercase tracking-wider text-ink">
          mgła
        </span>
      )}
      {media.weatherPrecipitation === "snow" && (
        <span className="pointer-events-none absolute top-1.5 left-12 z-10 rounded-sm bg-white/90 px-1 py-0.5 font-mono text-[8px] font-semibold uppercase tracking-wider text-ink">
          śnieg
        </span>
      )}
```

- [ ] **Step 2: Dwa wiersze w `ScanStatusTray`**

W `web/src/components/ScanStatusTray.tsx` rozszerz istniejący import typów:

```tsx
import type { ScanStatus, AiStatus } from "../api";
```

Dodaj drugie odpytywanie i drugi wiersz. Stan modelu **nie jest błędem** — to normalny tryb pracy:

```tsx
  const [ai, setAi] = useState<AiStatus | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    async function poll() {
      try {
        const s = await api.aiStatus();
        if (stopped) return;
        setAi(s);
        timer = setTimeout(poll, s.scanning ? 3000 : 15000);
      } catch {
        timer = setTimeout(poll, 15000);
      }
    }
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, []);
```

i w renderze, pod istniejącym wierszem przebiegu podstawowego:

```tsx
      {ai?.enabled && (
        <div className="flex items-center gap-2 font-mono text-[10px] text-muted">
          <span className={ai.modelLoaded ? "text-emerald-400" : "text-muted"}>
            {ai.modelLoaded ? "model załadowany" : "model niedostępny"}
          </span>
          <span className="tabular-nums">
            {ai.scanned.toLocaleString("pl")} / {ai.totalLocalImages.toLocaleString("pl")}
          </span>
          {ai.avgLatencyMs != null && <span className="tabular-nums">{ai.avgLatencyMs} ms/klatkę</span>}
          <button
            onClick={() => void (ai.paused ? api.resumeAi() : api.pauseAi())}
            className="hover:text-fg"
          >
            {ai.paused ? "wznów" : "pauza"}
          </button>
        </div>
      )}
```

- [ ] **Step 3: Pasma na osi czasu**

W `web/src/components/Timeline.tsx:115` obok istniejącego `activityRatio` policz dwa kolejne wskaźniki:

```tsx
              const activityRatio = b.count > 0 ? b.activityCount / b.count : 0;
              const peopleRatio = b.count > 0 ? b.peopleCount / b.count : 0;
              const animalRatio = b.count > 0 ? b.animalCount / b.count : 0;
```

Zaktualizuj podpowiedź w `title` (linia 120):

```tsx
                  title={`${b.bucket} · ${b.count} klatek · ruch ${b.activityCount} · osoby ${b.peopleCount} · zwierzęta ${b.animalCount}`}
```

I pod istniejącym bursztynowym wypełnieniem (linia 132-135) dodaj dwa **wąskie pionowe paski przy krawędziach** słupka — celowo nie kolejne wypełnienia od dołu, bo te nakładałyby się na bursztynowe i sugerowałyby, że przebiegi się sumują, a one są niezależne:

```tsx
                    {/* Extended pass — drawn as narrow edge rails, not as another
                        bottom-up fill, because the two passes are independent: a frame
                        can be flagged by one, both or neither, and stacking would imply
                        a total that does not exist. */}
                    {!active && peopleRatio > 0 && (
                      <span
                        className="absolute bottom-0 left-0 w-[2px] bg-sky-400/90"
                        style={{ height: `${Math.max(6, peopleRatio * 100)}%` }}
                      />
                    )}
                    {!active && animalRatio > 0 && (
                      <span
                        className="absolute bottom-0 right-0 w-[2px] bg-emerald-400/90"
                        style={{ height: `${Math.max(6, animalRatio * 100)}%` }}
                      />
                    )}
```

`Math.max(6, …)` daje minimalną widoczną wysokość: jedna sarna na 576 klatek doby to 0,17 %, czyli inaczej niewidoczne — a to jest dokładnie ten przypadek, którego szukasz.

- [ ] **Step 4: Zbuduj i sprawdź**

Run: `cd web && npm run build`
Expected: build przechodzi

- [ ] **Step 5: Commit**

```bash
git add web/src/components/Thumb.tsx web/src/components/ScanStatusTray.tsx web/src/components/Timeline.tsx
git commit -m "Web: per-pass badges, two-row scan tray, separate timeline bands"
```

---

### Task 16: Harness ewaluacyjny `npm run ai:eval`

**Files:**
- Create: `tests/ai/fixtures/reference-set.json`, `scripts/ai-eval.ts`
- Modify: `package.json` (skrypt `ai:eval`)

**Interfaces:**
- Consumes: `askSemantics`, `askWeather`, `probeModelLoaded`
- Produces: `npm run ai:eval` — zwraca kod 1, gdy którykolwiek próg z rozdziału 10 specyfikacji nie jest spełniony

To jest jedyna obrona przed cichą regresją po zmianie promptu, modelu albo wersji LM Studio.

- [ ] **Step 1: Zapisz zbiór referencyjny**

`tests/ai/fixtures/reference-set.json` — etykiety, bez plików JPEG (te zostają na NAS-ie):

```json
{
  "mediaRoot": "/srv/dev-disk-by-uuid-0fbe9eb7-0480-4d04-ad1d-e2dfa236ad00/nasty4/Wideo/Kukle/motioneye/Camera1",
  "frames": [
    { "path": "2025-07-20/08-55-00.jpg", "people": 1, "animals": [] },
    { "path": "2025-07-20/10-05-00.jpg", "people": 1, "animals": [] },
    { "path": "2025-07-20/11-45-00.jpg", "people": 2, "animals": [] },
    { "path": "2025-07-20/12-35-00.jpg", "people": 1, "animals": [] },
    { "path": "2025-07-20/13-00-00.jpg", "people": 1, "animals": [] },
    { "path": "2025-07-20/21-05-00.jpg", "people": 1, "animals": [] },
    { "path": "2025-03-31/17-55-00.jpg", "people": 1, "animals": [] },
    { "path": "2025-03-31/07-35-00.jpg", "people": 0, "animals": ["bird"] },
    { "path": "2025-04-01/08-25-00.jpg", "people": 0, "animals": ["bird", "bird"] },
    { "path": "2025-04-12/05-55-00.jpg", "people": 0, "animals": ["dog"] },
    { "path": "2025-11-11/12-30-00.jpg", "people": 0, "animals": ["horse", "horse"] },
    { "path": "2026-03-10/12-00-00.jpg", "people": 0, "animals": [] },
    { "path": "2026-03-10/00-00-00.jpg", "people": 0, "animals": [] },
    { "path": "2025-12-05/09-00-00.jpg", "people": 0, "animals": [] },
    { "path": "2025-12-05/12-00-00.jpg", "people": 0, "animals": [] }
  ],
  "weather": [
    { "path": "2025-09-26/06-27-30.jpg", "visibility": "dense_fog" },
    { "path": "2025-09-26/05-52-30.jpg", "visibility": "dense_fog" },
    { "path": "2025-09-26/07-55-00.jpg", "visibility": "clear" },
    { "path": "2025-07-27/09-20-00.jpg", "visibility": "clear" },
    { "path": "2025-12-29/09-05-00.jpg", "precipitation": "snow" },
    { "path": "2025-12-29/17-57-30.jpg", "precipitation": "snow" },
    { "path": "2025-12-29/16-30-00.jpg", "precipitation": "none" }
  ]
}
```

Pełny zbiór 67 klatek jest w raporcie `docs/reports/2026-08-04-detekcja-aktywnosci-raport.html` — powyższa lista to podzbiór wystarczający do bramkowania regresji. Ścieżki są względne do `mediaRoot`; przy uruchomieniu poza NAS-em ustaw `EVAL_MEDIA_ROOT`.

- [ ] **Step 2: Napisz harness**

`scripts/ai-eval.ts`:

```typescript
/**
 * Regression gate for the extended pass. Requires the model to be loaded in LM Studio.
 * Exits non-zero when any threshold from the spec is missed, so a prompt or model change
 * cannot silently degrade detection.
 *
 *   npm run ai:eval
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { probeModelLoaded, askSemantics, askWeather, type AskOptions } from "../src/ai/lmstudio.js";
import { normalizeAnimals } from "../src/ai/normalize.js";

const fixture = JSON.parse(readFileSync("tests/ai/fixtures/reference-set.json", "utf8"));
const root = process.env.EVAL_MEDIA_ROOT ?? fixture.mediaRoot;
const ask: AskOptions = {
  url: process.env.AI_LMSTUDIO_URL ?? "http://192.168.0.11:1234",
  model: process.env.AI_MODEL ?? "qwen/qwen3-vl-8b",
  timeoutMs: 60000,
};
const width = Number(process.env.AI_IMAGE_WIDTH ?? "1024");

if (!(await probeModelLoaded({ ...ask, timeoutMs: 5000 }))) {
  console.error(`Model ${ask.model} is not loaded in LM Studio at ${ask.url}.`);
  process.exit(2);
}

const jpeg = (p: string) =>
  sharp(join(root, p)).resize({ width, withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer();

let personHit = 0, personTotal = 0, personFalse = 0, personNegTotal = 0;
let animalHit = 0, animalTotal = 0, animalInvented = 0;
const latencies: number[] = [];

for (const f of fixture.frames) {
  const t0 = Date.now();
  const r = await askSemantics(ask, await jpeg(f.path));
  latencies.push(Date.now() - t0);
  const kinds = normalizeAnimals(r.animals).kinds;

  if (f.people > 0) { personTotal++; if (r.peopleCount > 0) personHit++; }
  else { personNegTotal++; if (r.peopleCount > 0) personFalse++; }

  if (f.animals.length > 0) { animalTotal++; if (kinds.length > 0) animalHit++; }
  else if (kinds.length > 0) { animalInvented++; }

  console.log(`${f.path.padEnd(28)} people=${r.peopleCount} animals=${JSON.stringify(kinds)}`);
}

let fogHit = 0, fogTotal = 0, snowHit = 0, snowTotal = 0;
const wLatencies: number[] = [];
for (const w of fixture.weather) {
  const t0 = Date.now();
  const r = await askWeather(ask, await jpeg(w.path));
  wLatencies.push(Date.now() - t0);
  if (w.visibility === "dense_fog") { fogTotal++; if (r.visibility === "dense_fog") fogHit++; }
  if (w.precipitation === "snow") { snowTotal++; if (r.precipitation === "snow") snowHit++; }
  if (w.precipitation === "none") { snowTotal++; if (r.precipitation === "none") snowHit++; }
  console.log(`${w.path.padEnd(28)} visibility=${r.visibility} precipitation=${r.precipitation}`);
}

const median = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1];

const checks: Array<[string, boolean, string]> = [
  ["person recall", personHit === personTotal, `${personHit}/${personTotal}`],
  ["person false alarms", personFalse === 0, `${personFalse}/${personNegTotal}`],
  ["animal recall", animalHit === animalTotal, `${animalHit}/${animalTotal}`],
  ["invented animals", animalInvented === 0, String(animalInvented)],
  ["dense fog", fogHit === fogTotal, `${fogHit}/${fogTotal}`],
  ["snow", snowHit === snowTotal, `${snowHit}/${snowTotal}`],
  ["semantic latency <= 2000 ms", median(latencies) <= 2000, `${median(latencies)} ms`],
  ["weather latency <= 4000 ms", median(wLatencies) <= 4000, `${median(wLatencies)} ms`],
];

console.log("\n=== thresholds ===");
let failed = false;
for (const [name, ok, detail] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(30)} ${detail}`);
  if (!ok) failed = true;
}
process.exit(failed ? 1 : 0);
```

- [ ] **Step 3: Dodaj skrypt do `package.json`**

```json
    "ai:eval": "tsx scripts/ai-eval.ts",
```

- [ ] **Step 4: Uruchom przy załadowanym modelu**

Run: `npm run ai:eval`
Expected: wszystkie progi PASS; przy wyładowanym modelu kod wyjścia 2 z czytelnym komunikatem

- [ ] **Step 5: Commit**

```bash
git add scripts/ai-eval.ts tests/ai/fixtures/reference-set.json package.json
git commit -m "AI: regression gate against the hand-labelled reference set"
```

---

### Task 17: Wdrożenie

**Files:**
- Modify: `docker-compose.yml:26-36`, `.env.example`

**Interfaces:**
- Consumes: zmienne z Task 2

- [ ] **Step 1: Dodaj zmienne do `docker-compose.yml`**

W sekcji `environment`, pod istniejącym blokiem `ACTIVITY_*` (który zostaje bez zmian):

```yaml
      # Extended pass: semantic labels from a vision model in LM Studio on the workstation.
      # Optional and OFF by default — the gallery is fully usable without it. When on, it
      # probes every AI_PROBE_INTERVAL_SECONDS whether the model is loaded, and only then
      # scans. All traffic is LAN; the GSM link is never touched.
      AI_TAGGING_ENABLED: "${AI_TAGGING_ENABLED:-false}"
      AI_LMSTUDIO_URL: "${AI_LMSTUDIO_URL:-http://192.168.0.11:1234}"
      AI_MODEL: "${AI_MODEL:-qwen/qwen3-vl-8b}"
      AI_PROBE_INTERVAL_SECONDS: "${AI_PROBE_INTERVAL_SECONDS:-300}"
      AI_IMAGE_WIDTH: "${AI_IMAGE_WIDTH:-1024}"
      AI_PROMPT_VERSION: "${AI_PROMPT_VERSION:-semantics-v1}"
      AI_WEATHER_PROMPT_VERSION: "${AI_WEATHER_PROMPT_VERSION:-weather-v1}"
      AI_WEATHER_MIN_GAP_SECONDS: "${AI_WEATHER_MIN_GAP_SECONDS:-600}"
      AI_BATCH: "${AI_BATCH:-200}"
      AI_REQUEST_TIMEOUT_MS: "${AI_REQUEST_TIMEOUT_MS:-60000}"
      AI_MAX_FAILURES: "${AI_MAX_FAILURES:-5}"
```

- [ ] **Step 2: Dopisz do `.env.example`** te same klucze z krótkim komentarzem, że wymagają włączonego „Serve on Local Network" w LM Studio i przepuszczonego portu 1234 w zaporze Windows.

- [ ] **Step 3: Sprawdź osiągalność z kontenera**

Po wdrożeniu, przy załadowanym modelu:

```bash
curl -s http://192.168.0.24:8768/api/ai/status | grep modelLoaded
```
Expected: `"modelLoaded": true`. Jeśli `false` przy działającym LM Studio — sprawdź „Serve on Local Network" i zaporę Windows; to jest najbardziej prawdopodobny punkt awarii pierwszego wdrożenia.

- [ ] **Step 4: Commit**

```bash
git add docker-compose.yml .env.example
git commit -m "Deploy: AI_* environment for the extended pass, disabled by default"
```

---

## Kolejność i zależności

Zadania 1–2 są fundamentem. 3–6 to niezależne cegiełki klienta (można je robić równolegle). 7 wymaga 3–6. 8 wymaga 7. 9–12 wymagają 1 i mogą iść równolegle z 13–15. 16 wymaga 5–6. 17 wymaga 2.

Po zadaniu 12 backend jest kompletny i można wdrożyć bez frontendu — przebieg rozszerzony będzie działał i wypełniał bazę, tylko bez interfejsu do filtrowania.
