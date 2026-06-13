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
    .map((p): [string, string] => {
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
