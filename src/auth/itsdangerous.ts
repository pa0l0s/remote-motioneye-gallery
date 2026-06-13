import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export interface VerifyResult {
  valid: boolean;
  payload?: unknown;
}

function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

function deriveKey(secret: string): Buffer {
  // django-concat: sha1(salt + b"signer" + secret)
  return createHash("sha1")
    .update(
      Buffer.concat([Buffer.from("itsdangerous"), Buffer.from("signer"), Buffer.from(secret)]),
    )
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
    if (raw.startsWith(".")) {
      // zlib-compressed payloads are not expected for "admin"; bail safely.
      return { valid: false };
    }
    const bytes = b64urlDecode(raw);
    const payload = JSON.parse(bytes.toString("utf8"));
    return { valid: true, payload };
  } catch {
    return { valid: false };
  }
}
