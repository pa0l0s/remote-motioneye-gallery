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
