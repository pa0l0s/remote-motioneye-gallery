# Smart MotionEye Proxy Gallery — Design Spec

**Date:** 2026-06-13
**App name:** `motioneye-proxy-gallery`
**Status:** Approved for planning

> Public repo note: no real credentials, tokens, IPs, or host-specific paths appear in
> this document. All such values are referenced by env-var name only and live in a local,
> gitignored `deploy.local.env`.

## 1. Purpose & Constraints

Build a Dockerized "Smart Proxy Gallery" over a remote MotionEye archive that is a
**time-series of surveillance frames** (one image every few seconds, 100,000+ frames),
not a casual photo gallery. It must browse, search, and scrub that timeline smoothly, let
the user generate timelapse videos from any period, and minimize data transfer over a
weak, metered GSM link.

- Remote MotionEye is reached at `MOTIONEYE_URL` with `MOTIONEYE_USER` / `MOTIONEYE_PASSWORD`.
- The remote has 100,000+ files; fetching the full list times out and drains data.
- Core goal: index incrementally per-date, cache media locally on demand, and serve local
  copies at **0 GSM bytes** whenever possible.
- Professional, dynamic, stylish dark-mode UX throughout.
- Deployed as a Portainer stack on a private LAN host.

## 2. Key Decisions (locked during brainstorming)

1. **Camera scope:** all cameras discovered from MotionEye `/config/list`.
2. **Index strategy:** remote-driven crawl (authoritative list from remote), reconciled
   against local disk so already-synced historic files are marked downloaded for free.
3. **Auth / SSO:** validate kukle-power's existing `itsdangerous` signed `admin_session`
   cookie. **No JWT.** No changes to kukle-power (read-only).
4. **Build/deploy:** custom image built **on the host** via compose `build:`; `deploy.sh`
   syncs source to the host and (re)creates the Portainer stack via API.
5. **Media root:** mount the parent `motioneye/` folder so each camera folder sits side by
   side, mirroring remote `/var/lib/motioneye/`.
6. **Timeline navigation:** a zoomable activity-density timeline (year → minute) plus a
   precise date/time search that jumps the virtualized grid to a moment.
7. **Timelapse:** user-defined period + fps + frame sampling + resolution/quality + camera;
   missing frames are auto-downloaded (sampling applied first to bound the fetch), encoded
   to mp4/H.264.
8. **Background jobs:** timelapse runs server-side as a single in-process worker, persisted
   in the DB (survives restart, resumable), progress streamed via SSE. The gallery stays
   fully usable during generation; progress is always visible in a persistent task tray.

## 3. Corrected Assumption: SSO is itsdangerous, not JWT

project.md assumed a JWT SSO mechanism. Inspecting the kukle-power project (read-only)
shows reality:

- It uses `itsdangerous.URLSafeTimedSerializer(SECRET_KEY)`.
- The session token is `serializer.dumps("admin")`, stored in cookie `admin_session`
  with `httponly=True`, `samesite="lax"`, `max_age=30 days`, no explicit domain/path
  (host-only, path `/`).
- The shared secret is provided to both apps via the `SECRET_KEY` env var (never committed).

**Consequences for the Gallery:**

- Served on the **same hostname** as kukle-power. Browser cookies ignore port, so the
  existing `admin_session` cookie is sent to the Gallery automatically.
- The Gallery shares `SECRET_KEY` (via env) and **re-validates the same cookie** by
  reimplementing itsdangerous `URLSafeTimedSerializer` verification in Node:
  - Default salt `"itsdangerous"`, django-concat key derivation
    (`HMAC-SHA1(secret, salt + b"signer")`), HMAC-SHA1 signature over
    `payload + "." + timestamp`, URL-safe base64, compact-JSON payload.
  - Verification enforces `max_age` (30 days) like kukle-power.
- The kukle-power "Gallery" link simply navigates to the Gallery URL. No token minting,
  no new login form.
- Missing/invalid cookie → `401 Unauthorized` (API) or redirect back to the kukle-power
  login page (HTML routes).
- `AUTH_ENABLED` env flag allows disabling auth for local development only.

## 4. Technical Stack

- **Backend:** Node 22 + TypeScript, **Fastify** (lowest overhead of the candidates),
  with in-process background workers (indexer + timelapse).
- **DB:** SQLite via Prisma, file stored in the config volume.
- **Thumbnails:** `sharp` for image thumbnails; `ffmpeg` (ffmpeg-static + fluent-ffmpeg)
  for video poster frames and timelapse encoding.
- **Frontend:** React + Vite + TypeScript + Tailwind + Framer Motion; virtualized grid
  via `@tanstack/react-virtual`; custom HTML5 video player; canvas/SVG timeline.
- **Realtime:** Server-Sent Events (SSE) for job progress.
- **Design language:** strict dark mode (deep blacks, dark grays, glowing accents),
  taste-skill "Soft" variant — high MOTION_INTENSITY, medium VISUAL_DENSITY. Skeleton
  loaders, expand-to-lightbox transitions, elegant hover. No em-dashes in UI copy
  (taste-skill rule).
- **Deploy:** Docker + Docker Compose; single custom image on `node:22-slim` base.

## 5. MotionEye Client (signed internal API)

MotionEye's documented "draft" API is unimplemented; the real endpoints are the signed
internal ones used by its own frontend, as encoded in the official `motioneye-client`:

- `GET /config/list` — list cameras.
- `GET /picture/{id}/list?prefix=<dir>&with_stat=false` — non-recursive list of pictures
  under a path prefix.
- `GET /movie/{id}/list?prefix=<dir>&with_stat=false` — same for movies.
- `GET /picture/{id}/download/{path}` — full picture.
- `GET /movie/{id}/playback/{path}` — full movie.
- `GET /picture|movie/{id}/preview/{path}` — native lightweight preview (fallback option).

**Auth (verified against the live server 2026-06-13):** append `_username` and
`_signature=<hex>` query params. `_username` must be present **before** signing (the
server strips only `_signature`). `key = sha1(password).hexdigest()`. The signature is
**plain `sha1("METHOD:path:body:key")`** (NOT HMAC), lowercase hex, where `path` has the
scheme/host blanked, query params sorted by name, values re-encoded like
`encodeURIComponent`, and every char outside `[a-zA-Z0-9/?_.=&{}\[\]":, -]` replaced with
`-`. Confirmed working: `/config/list` returns `{cameras:[{id,name,...}]}` (currently 1
camera: `Camera1`, id=1).

**Verified listing shape:** `GET /picture/{id}/list?prefix=YYYY-MM-DD&with_stat=true`
returns `{cameraName, mediaList:[{path:"/2026-06-13/16-07-30.jpg", mimeType:"image/jpeg",
timestamp:1781359650.05, sizeStr:"606.2 kB", momentStr, momentStrShort}]}`. `timestamp` is
an exact float epoch (no filename parsing needed); `sizeStr` gives a cheap data estimate.
A per-date listing is fast (~570 pics/day); the **no-prefix full list times out** (the
100k problem, reproduced), so the indexer must walk per-date and never fetch the full list.

### 5.1 Shared remote-fetch gate

All remote MotionEye access (indexer listings, on-demand media downloads, timelapse frame
downloads) goes through a **single rate-limited queue** with a small concurrency cap
(default 1-2). This prevents the background indexer and a running timelapse from saturating
the weak GSM link simultaneously, and centralizes timeout/retry/backoff.

## 6. Data Model (Prisma / SQLite)

- `Camera(id, motionEyeId, name, createdAt)`
- `MediaFile(id, cameraId, fileType[image|video], remotePath, localPath, thumbnailPath,
  timestamp, sizeBytes?, isDownloaded, thumbReady, createdAt)`
  - Unique constraint on `(cameraId, remotePath)`.
  - Indexed on `(cameraId, timestamp)` — powers grid pagination, histogram, and seek.
- `IndexCursor(cameraId, lastDateDir, lastRunAt, status)` — resume-after-drop state.
- `TimelapseJob(id, cameraId, fromTs, toTs, fps, everyNth, width?, quality, status
  [pending|downloading|encoding|done|failed|canceled], phase?, progress[0..1], framesTotal,
  framesReady, outputPath?, error?, createdAt, updatedAt)` — persisted background jobs.

## 7. Indexer (remote-driven, reconcile local)

1. Discover cameras via `/config/list`; upsert `Camera` rows.
2. **Walk by calendar date** (the full list times out). Starting from today and going
   backward, request `list?prefix=YYYY-MM-DD&with_stat=true` for pictures and movies one
   date at a time. Stop after a configurable run of consecutive empty days
   (`INDEX_EMPTY_DAY_LIMIT`, default 30) or a configured `INDEX_START_DATE` floor. Never
   request the unfiltered list.
3. Store **metadata only** from the listing: `remotePath` (the `path` field), `timestamp`
   (the exact float epoch from the response), `fileType` (from `mimeType`), and
   `sizeBytes` (parsed from `sizeStr`). For each row, stat the local disk
   (`MEDIA_ROOT/<camera>/<path>`); if the file already exists (pre-synced history), set
   `isDownloaded=true` without any download.
4. **Resilience:** all requests go through the shared remote-fetch gate (§5.1) with
   per-request timeout, retry with exponential backoff, and a persistent `IndexCursor` so a
   GSM drop resumes at the next date. Failures are logged to the config volume; the worker
   continues rather than aborting the whole run.
5. Indexing runs as a background loop with a configurable interval; newest dates first so
   recent media appears soonest.

## 8. Media Proxy & Caching

- `GET /api/media/:id/file`
  - Local file exists → stream it (0 GSM bytes).
  - Missing → download from remote `download`/`playback`, write to the media volume
    **preserving the date folder structure**, **never overwriting** an existing file
    (skip write if present), mark `isDownloaded=true`, then serve.
- `GET /api/media/:id/thumb`
  - Cached thumb exists in config volume → serve.
  - Absent → ensure the full file is local (download once if needed), generate thumbnail
    with sharp (images) or an ffmpeg poster frame (videos), cache in the **config volume**,
    mark `thumbReady=true`, serve.
- **Data-saving rule:** thumbnails are generated **lazily, only when a grid cell scrolls
  into view** — never eagerly for all 100k. Historic local files thumbnail for free; only
  newly-viewed remote files cost GSM, once each, then cached forever.
- **Thumbnail isolation:** all thumbnails/metadata/cache live in the config volume only;
  the media volume stays pristine.

## 9. Timeline Navigation (time-series browsing)

- **Histogram endpoint:** `GET /api/cameras/:id/histogram?from&to&bucket=day|hour|minute`
  → array of `{ bucketStart, count }`. SQL `GROUP BY` on the timestamp truncated to the
  bucket, range-scanned via the `(cameraId, timestamp)` index. Buckets keep the payload
  tiny regardless of 100k+ frames.
- **Seek endpoint:** `GET /api/cameras/:id/seek?at=<iso>` → `{ mediaId, index }`, where
  `index = COUNT(timestamp < at)` for that camera. Lets the virtualized grid scroll
  directly to a moment.
- **Grid feed:** `GET /api/media?cameraId&from&to&cursor&limit` ordered by timestamp,
  keyset-paginated for smooth virtual scroll over 100k+ rows.
- **Frontend:** a zoomable activity-density timeline (canvas/SVG bars from the histogram),
  drag to scrub, scroll/pinch to zoom across year → month → day → hour → minute, plus a
  precise date/time jump box. Selecting a point calls seek and positions the grid. A
  range selection on the timeline feeds the timelapse builder.

## 10. Timelapse Subsystem

- **Pre-flight estimate (data-cost guardrail):** `GET /api/timelapse/estimate?cameraId&
  fromTs&toTs&everyNth` → `{ framesSampled, framesLocal, framesToDownload,
  estDownloadBytes }`, where `estDownloadBytes` sums `sizeBytes` of the not-yet-local
  sampled frames. The UI shows this ("N frames, M to download, ~X MB over GSM") and the
  user must confirm before a job starts. `everyNth` is the primary lever to shrink it.
- **Create:** `POST /api/timelapse` with `{ cameraId, fromTs, toTs, fps, everyNth, width?,
  quality }` → creates a `TimelapseJob` (status `pending`) and returns its id.
- **Worker (single in-process job at a time):**
  1. Query the camera's `image` frames in `[fromTs, toTs]` ordered by timestamp; apply
     `everyNth` sampling **first**, so only the frames the video will use are considered.
  2. **Download phase:** for sampled frames where `isDownloaded=false`, fetch from remote
     (reusing the media-proxy download path), preserve structure, mark downloaded; update
     `framesReady` / `progress`. (User chose auto-download of missing frames; sampling
     keeps the fetch bounded.)
  3. **Encode phase:** feed the ordered local frames to ffmpeg → mp4/H.264 at the chosen
     `fps`, scaled to `width` (null = source), `quality` preset → write to
     `CONFIG_DIR/timelapses/<id>.mp4`.
  4. `status=done`, `outputPath` set.
- **Progress / control:**
  - `GET /api/timelapse/:id/events` — SSE stream of `{ status, phase, progress,
    framesReady, framesTotal }`.
  - `GET /api/timelapse` — list jobs (for the task tray on load).
  - `POST /api/timelapse/:id/retry` — re-run a `failed` job; already-downloaded frames are
    skipped (`isDownloaded` persists), so a mid-download GSM drop resumes cheaply.
  - `POST /api/timelapse/:id/cancel` — stop a running/pending job.
  - `GET /api/timelapse/:id/download` — stream the finished mp4.
- **Output isolation:** timelapse mp4s live in the config volume, never the media volume.

## 11. Background Task UX (non-blocking, always visible)

- The gallery remains **fully interactive** during timelapse generation (jobs run
  server-side). The user can browse, scrub, and queue more jobs.
- A **persistent task tray docked bottom-right** (download-manager pattern) is always
  visible while any job is active. It shows a compact live progress pill per job and
  expands on click into job cards with phase (download % → encode %), animated progress,
  and retry/cancel. A finished job offers inline playback / download.
- The frontend keeps a **global SSE subscription** so progress updates everywhere and
  survives navigation. On load it calls `GET /api/timelapse` to restore active jobs.
- Header carries nav + camera/date filters + the timeline; the tray stays out of the way
  bottom-right so it never competes with primary controls.

## 12. Frontend UX (overall)

- Virtualized grid over the local DB handling 100k+ time-ordered frames smoothly, with
  skeleton placeholders while thumbs load.
- Framer Motion expand-to-lightbox; custom HTML5 video player for movie files and finished
  timelapses, with smooth buffering.
- Strict dark mode with glowing accents and micro-interactions per taste-skill; a polished,
  professional, dynamic feel throughout.

## 13. Volumes & Deployment

All host-specific values (paths, IPs, API keys) live only in the gitignored
`deploy.local.env`, referenced here by name:

- **Config/DB/logs/thumbnails/timelapses:** `CONFIG_DIR` on the host
  (e.g. `.../DockerConfig/motioneye-proxy-gallery`).
- **Media root:** `MEDIA_ROOT` on the host (the parent of the per-camera folders;
  existing files never modified).
- **Portainer API:** `PORTAINER_URL` + `PORTAINER_API_KEY` (used by `deploy.sh` only).
- **deploy.sh:** rsync source to the host, then create/update the Portainer stack via API
  (compose `build:` builds the image on the host). Pushes env values into the stack Env
  array, mirroring kukle-power's deploy pattern. Reads real values from `deploy.local.env`.

## 14. Testing Strategy (TDD)

- MotionEye signature computation vs known-good values from `motioneye-client`.
- itsdangerous cookie verification vs a real token generated by the Python library with
  the shared `SECRET_KEY` (including expiry handling).
- Indexer cursor/resume logic across simulated network drops; "file exists locally →
  isDownloaded without fetch" reconciliation.
- Proxy paths: "exists → 0-fetch stream" and "missing → download + preserve structure +
  never overwrite"; thumbnail generation for image vs video.
- Histogram bucketing and seek index math against a seeded DB.
- Timelapse worker: sampling math (everyNth), resume-skips-downloaded, status/progress
  transitions, retry of a failed job; ffmpeg invocation arguments.

## 15. Environment Variables

Names only; real values stay in `deploy.local.env` (gitignored) and a committed
`.env.example` documents the keys with placeholder values.

- `MOTIONEYE_URL`, `MOTIONEYE_USER`, `MOTIONEYE_PASSWORD`
- `SECRET_KEY` (shared with kukle-power)
- `AUTH_ENABLED` (default true; false for local dev)
- `KUKLE_POWER_LOGIN_URL` (redirect target on auth failure)
- `CONFIG_DIR`, `MEDIA_ROOT`
- `INDEX_INTERVAL_SECONDS`, `REQUEST_TIMEOUT_MS`, `MAX_RETRIES`
- `INDEX_EMPTY_DAY_LIMIT` (stop after N consecutive empty days; default 30),
  `INDEX_START_DATE` (optional floor, ISO date)
- `REMOTE_CONCURRENCY` (shared remote-fetch gate cap; default 1)
- `PORTAINER_URL`, `PORTAINER_API_KEY`, `STACK_NAME` (deploy.sh only)

## 16. Out of Scope (v1)

- Minting tokens / modifying kukle-power.
- Multi-user roles (kukle-power is single-admin).
- Blanket "sync everything" mirroring. Gallery browsing stays lazy/0-byte; the only bulk
  fetch is a user-initiated timelapse, bounded by frame sampling and made resumable.
- Per-camera storage paths beyond the shared `motioneye/` parent.
- Concurrent timelapse encoding (one job at a time by design, to bound GSM + CPU).
