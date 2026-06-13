# Smart MotionEye Proxy Gallery — Design Spec

**Date:** 2026-06-13
**App name:** `motioneye-proxy-gallery`
**Status:** Approved for planning

> Public repo note: no real credentials, tokens, IPs, or host-specific paths appear in
> this document. All such values are referenced by env-var name only and live in a local,
> gitignored `deploy.local.env`.

## 1. Purpose & Constraints

Build a Dockerized "Smart Proxy Gallery" that displays photos and videos from a remote
MotionEye instance while minimizing data transfer over a weak, metered GSM link.

- Remote MotionEye is reached at `MOTIONEYE_URL` with `MOTIONEYE_USER` / `MOTIONEYE_PASSWORD`.
- The remote has 100,000+ files; fetching the full list times out and drains data.
- Core goal: index incrementally per-date, cache media locally on demand, and serve local
  copies at **0 GSM bytes** whenever possible.
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
  with an in-process background indexer worker.
- **DB:** SQLite via Prisma, file stored in the config volume.
- **Thumbnails:** `sharp` for image thumbnails; `ffmpeg` (ffmpeg-static + fluent-ffmpeg)
  for video poster frames.
- **Frontend:** React + Vite + TypeScript + Tailwind + Framer Motion; virtualized grid
  via `@tanstack/react-virtual`; custom HTML5 video player.
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

**Auth:** append `_username` and `_signature=<hex>` query params, where
`key = sha1(password).hexdigest()` and the signature is computed over
`method:normalized_path:body:key` (HMAC-SHA1, lowercase hex). Exact normalization is
TDD'd against `motioneye-client` behavior.

## 6. Data Model (Prisma / SQLite)

- `Camera(id, motionEyeId, name, createdAt)`
- `MediaFile(id, cameraId, fileType[image|video], remotePath, localPath, thumbnailPath,
  timestamp, sizeBytes?, isDownloaded, thumbReady, createdAt)`
  - Unique constraint on `(cameraId, remotePath)`.
  - Indexed on `(cameraId, timestamp)` for grid pagination.
- `IndexCursor(cameraId, lastDateDir, lastRunAt, status)` — resume-after-drop state.

## 7. Indexer (remote-driven, reconcile local)

1. Discover cameras via `/config/list`; upsert `Camera` rows.
2. Per camera, list top-level entries to enumerate date dirs (`YYYY-MM-DD`).
3. Crawl **one date dir at a time** via `list?prefix=YYYY-MM-DD&with_stat=false` for both
   pictures and movies. Never request the full unfiltered list.
4. Store **metadata only** (remote path + timestamp parsed from filename). For each row,
   stat the local disk; if the file already exists (pre-synced history), set
   `isDownloaded=true` without any download.
5. **Resilience:** per-request timeout, retry with exponential backoff, persistent
   `IndexCursor` so a GSM drop resumes at the next date dir. Failures logged to the config
   volume; the worker continues rather than aborting the whole run.
6. Indexing runs as a background loop with a configurable interval; newest dates first so
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

## 9. Frontend UX

- Virtualized grid backed by `/api/media?cameraId=&cursor=&limit=` over the local DB,
  handling 100k+ rows smoothly.
- Filters by camera and date; skeleton placeholders while thumbs load.
- Framer Motion expand-to-lightbox with smooth image expansion; custom HTML5 video player
  with smooth buffering for movie files.
- Strict dark mode with glowing accents and micro-interactions per taste-skill.

## 10. Volumes & Deployment

All host-specific values (paths, IPs, API keys) live only in the gitignored
`deploy.local.env`, referenced here by name:

- **Config/DB/logs/thumbnails:** `CONFIG_DIR` on the host
  (e.g. `.../DockerConfig/motioneye-proxy-gallery`).
- **Media root:** `MEDIA_ROOT` on the host (the parent of the per-camera folders;
  existing files never modified).
- **Portainer API:** `PORTAINER_URL` + `PORTAINER_API_KEY` (used by `deploy.sh` only).
- **deploy.sh:** rsync source to the host, then create/update the Portainer stack via API
  (compose `build:` builds the image on the host). Pushes env values into the stack Env
  array, mirroring kukle-power's deploy pattern. Reads real values from `deploy.local.env`.

## 11. Testing Strategy (TDD)

- MotionEye signature computation vs known-good values from `motioneye-client`.
- itsdangerous cookie verification vs a real token generated by the Python library with
  the shared `SECRET_KEY` (including expiry handling).
- Indexer cursor/resume logic across simulated network drops; "file exists locally →
  isDownloaded without fetch" reconciliation.
- Proxy paths: "exists → 0-fetch stream" and "missing → download + preserve structure +
  never overwrite" and thumbnail generation for image vs video.

## 12. Environment Variables

Names only; real values stay in `deploy.local.env` (gitignored) and a committed
`.env.example` documents the keys with placeholder values.

- `MOTIONEYE_URL`, `MOTIONEYE_USER`, `MOTIONEYE_PASSWORD`
- `SECRET_KEY` (shared with kukle-power)
- `AUTH_ENABLED` (default true; false for local dev)
- `KUKLE_POWER_LOGIN_URL` (redirect target on auth failure)
- `CONFIG_DIR`, `MEDIA_ROOT`
- `INDEX_INTERVAL_SECONDS`, `REQUEST_TIMEOUT_MS`, `MAX_RETRIES`
- `PORTAINER_URL`, `PORTAINER_API_KEY`, `STACK_NAME` (deploy.sh only)

## 13. Out of Scope (v1)

- Minting tokens / modifying kukle-power.
- Multi-user roles (kukle-power is single-admin).
- Bulk pre-download / sync-all (defeats the data-saving goal).
- Per-camera storage paths beyond the shared `motioneye/` parent.
