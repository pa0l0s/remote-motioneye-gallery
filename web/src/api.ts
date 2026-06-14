export interface Camera {
  id: number;
  name: string;
}

export interface MediaFile {
  id: number;
  cameraId: number;
  fileType: "image" | "video";
  remotePath: string;
  timestamp: string;
  sizeBytes: number | null;
  isDownloaded: boolean;
  thumbReady: boolean;
}

export interface MediaPage {
  items: MediaFile[];
  nextCursor: string | null;
}

export interface HistogramBucket {
  bucket: string;
  count: number;
}

export interface DownloadJob {
  id: string;
  cameraId: number;
  label: string;
  total: number;
  done: number;
  failed: number;
  bytes: number;
  status: "running" | "done" | "error" | "canceled";
  createdAt: number;
  updatedAt: number;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json() as Promise<T>;
}

export const api = {
  cameras: () => getJson<Camera[]>("/api/cameras"),
  histogram: (cameraId: number, bucket: "day" | "hour" | "minute" = "day") =>
    getJson<HistogramBucket[]>(`/api/cameras/${cameraId}/histogram?bucket=${bucket}`),
  seek: (cameraId: number, atIso: string) =>
    getJson<{ index: number; mediaId: number | null }>(
      `/api/cameras/${cameraId}/seek?at=${encodeURIComponent(atIso)}`,
    ),
  media: (
    cameraId: number,
    opts: { cursor?: string | null; limit?: number; from?: string; to?: string } = {},
  ) => {
    const p = new URLSearchParams({ cameraId: String(cameraId), limit: String(opts.limit ?? 150) });
    if (opts.cursor) p.set("cursor", opts.cursor);
    if (opts.from) p.set("from", opts.from);
    if (opts.to) p.set("to", opts.to);
    return getJson<MediaPage>(`/api/media?${p.toString()}`);
  },
  thumbUrl: (id: number) => `/api/media/${id}/thumb`,
  fileUrl: (id: number) => `/api/media/${id}/file`,

  createDownload: (body: { cameraId: number; mediaIds?: number[]; day?: string }) =>
    fetch("/api/downloads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => r.json() as Promise<DownloadJob | { id: null; total: number; message: string }>),
  listDownloads: () => getJson<DownloadJob[]>("/api/downloads"),
  cancelDownload: (id: string) =>
    fetch(`/api/downloads/${id}/cancel`, { method: "POST" }).then((r) => r.json()),
};
