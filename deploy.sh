#!/usr/bin/env bash
# Deploy motioneye-proxy-gallery to the Portainer host, then clean up Docker build
# leftovers and report disk usage. The NAS root filesystem is small, so EVERY deploy
# prunes dangling images (a rebuild leaves the previous image as <none>:<none>).
#
#   ./deploy.sh
#
# Reads all secrets/paths from deploy.local.env (gitignored). Nothing sensitive is
# committed. Docker operations go through the Portainer API (the SSH user is not in the
# docker group); `df -h /` is read over SSH.
#
# Safety: only `docker image prune` for DANGLING images is run. Volumes are never pruned.
set -euo pipefail

cd "$(dirname "$0")"
if [[ ! -f deploy.local.env ]]; then
  echo "ERROR: deploy.local.env not found (copy .env.example and fill it in)." >&2
  exit 1
fi
set -a
# shellcheck disable=SC1091
. ./deploy.local.env
set +a

: "${PORTAINER_URL:?set in deploy.local.env}"
: "${PORTAINER_API_KEY:?set in deploy.local.env}"
ENDPOINT_ID="${ENDPOINT_ID:-2}"
STACK_NAME="${STACK_NAME:-motioneye-proxy-gallery}"
GALLERY_PORT="${GALLERY_PORT:-8768}"
HOST="$(printf '%s' "$PORTAINER_URL" | sed -E 's#^https?://([^:/]+).*#\1#')"
NAS_SSH="${NAS_SSH:-paolo@${HOST}}"

export ENDPOINT_ID STACK_NAME GALLERY_PORT

echo "==> deploy ${STACK_NAME} to ${HOST} (endpoint ${ENDPOINT_ID}), then prune + report"

python3 - <<'PY'
import json, os, time, urllib.request, urllib.error

B   = os.environ["PORTAINER_URL"].rstrip("/")
K   = os.environ["PORTAINER_API_KEY"]
EID = os.environ["ENDPOINT_ID"]
NAME= os.environ["STACK_NAME"]
PORT= os.environ["GALLERY_PORT"]
HOST= os.environ["PORTAINER_URL"]

def req(method, path, body=None, timeout=600):
    r = urllib.request.Request(B + path, method=method,
        headers={"X-API-Key": K, "Content-Type": "application/json"})
    if body is not None:
        r.data = json.dumps(body).encode()
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            raw = resp.read()
            return resp.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:300]

def env_pairs():
    keys = ["GALLERY_PORT","AUTH_ENABLED","MOTIONEYE_URL","MOTIONEYE_USER",
            "MOTIONEYE_PASSWORD","SECRET_KEY","KUKLE_POWER_LOGIN_URL","CONFIG_DIR",
            "MEDIA_ROOT","MEDIA_RO_SUFFIX","REMOTE_CONCURRENCY","INDEX_EMPTY_DAY_LIMIT",
            "INDEX_START_DATE"]
    out = []
    for k in keys:
        v = os.environ.get(k)
        if v is not None and v != "":
            out.append({"name": k, "value": v})
    return out

def reclaimable_gb():
    st, df = req("GET", f"/endpoints/{EID}/docker/system/df", timeout=60)
    if not isinstance(df, dict):
        return None
    imgs = df.get("Images", [])
    dangling = [i for i in imgs if (i.get("RepoTags") in (None, [], ["<none>:<none>"]))]
    return round(sum(i.get("Size", 0) for i in dangling) / 1e9, 2), len(dangling)

# --- find stack by name ---
st, stacks = req("GET", "/stacks")
sid = next((s["Id"] for s in stacks if s.get("Name") == NAME), None)
if sid is None:
    raise SystemExit(f"stack '{NAME}' not found")
print(f"   stack id = {sid}")

# --- git redeploy (repull main + rebuild) ---
st, _ = req("PUT", f"/stacks/{sid}/git/redeploy?endpointId={EID}",
    {"env": env_pairs(), "prune": False, "pullImage": False,
     "repositoryReferenceName": "refs/heads/main", "repositoryAuthentication": False})
print(f"   redeploy -> HTTP {st}")
if st >= 400:
    raise SystemExit("redeploy failed")

# --- wait for health ---
url = f"http://{__import__('urllib.parse', fromlist=['urlparse']).urlparse(HOST).hostname}:{PORT}/health"
ok = False
for _ in range(40):
    time.sleep(6)
    try:
        with urllib.request.urlopen(url, timeout=8) as r:
            if r.status == 200:
                ok = True
                break
    except Exception:
        pass
print(f"   health {url} -> {'ok' if ok else 'NOT READY'}")

# --- cleanup: prune DANGLING images only ---
before = reclaimable_gb()
st, pr = req("POST",
    f"/endpoints/{EID}/docker/images/prune?filters=%7B%22dangling%22%3A%5B%22true%22%5D%7D",
    timeout=180)
reclaimed = round((pr.get("SpaceReclaimed", 0) / 1e9), 2) if isinstance(pr, dict) else "?"
after = reclaimable_gb()
print(f"   docker image prune -f (dangling) -> HTTP {st}, reclaimed {reclaimed} GB")
if before: print(f"   dangling reclaimable before: {before[0]} GB ({before[1]} images)")
if after:  print(f"   dangling reclaimable after:  {after[0]} GB ({after[1]} images)")
PY

echo "==> df -h / on ${NAS_SSH}"
ssh -o BatchMode=yes -o ConnectTimeout=10 "${NAS_SSH}" 'df -h /' 2>/dev/null || \
  echo "   (could not read df over SSH)"

echo "==> done"
