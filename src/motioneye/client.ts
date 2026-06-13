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
  path: string; // path relative to the camera root, e.g. "/2026-06-13/16-07-30.jpg"
  timestamp?: number; // float epoch seconds (with_stat=true)
  mimeType?: string; // e.g. "image/jpeg" | "video/mp4"
  sizeStr?: string; // e.g. "606.2 kB"
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
}
