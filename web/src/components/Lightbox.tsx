import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { MediaFile } from "../api";
import { api } from "../api";
import { fmtDateTime, fmtBytes } from "../lib/format";

interface LightboxProps {
  media: MediaFile | null;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
  /** Fired when an image finishes downloading, so the grid can refresh its thumbnail. */
  onDownloaded?: (id: number) => void;
}

type Phase = "fetching" | "downloading" | "loaded" | "error";

/**
 * Downloads the full image via fetch so we can show progress. The backend pulls the
 * frame from the remote camera first (slow over GSM) then streams it, so we stay in an
 * indeterminate "fetching" state until the first byte arrives, then show byte progress.
 */
function useImageDownload(media: MediaFile | null) {
  const [phase, setPhase] = useState<Phase>("fetching");
  const [received, setReceived] = useState(0);
  const [url, setUrl] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const isImage = media?.fileType === "image";

  useEffect(() => {
    if (!media || !isImage) return;
    const ac = new AbortController();
    let objectUrl: string | null = null;
    setPhase("fetching");
    setReceived(0);
    setUrl(null);

    (async () => {
      try {
        const res = await fetch(api.fileUrl(media.id), { signal: ac.signal });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        const reader = res.body.getReader();
        const chunks: Uint8Array[] = [];
        let got = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            chunks.push(value);
            got += value.length;
            setReceived(got);
            setPhase("downloading");
          }
        }
        if (got === 0) throw new Error("empty image");
        objectUrl = URL.createObjectURL(new Blob(chunks as BlobPart[], { type: "image/jpeg" }));
        setUrl(objectUrl);
        setPhase("loaded");
      } catch (err) {
        if (!ac.signal.aborted) setPhase("error");
      }
    })();

    return () => {
      ac.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [media?.id, isImage, attempt]);

  return { phase, received, url, retry: () => setAttempt((a) => a + 1) };
}

export function Lightbox({ media, onClose, onPrev, onNext, onDownloaded }: LightboxProps) {
  const { phase, received, url, retry } = useImageDownload(media);
  const total = media?.sizeBytes ?? 0;
  const pct = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0;

  // When an image finishes downloading, let the grid flip it to "cached" so its
  // thumbnail loads instead of staying a placeholder.
  useEffect(() => {
    if (phase === "loaded" && media && media.fileType === "image") onDownloaded?.(media.id);
  }, [phase, media?.id]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft") onPrev();
      if (e.key === "ArrowRight") onNext();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, onPrev, onNext]);

  return (
    <AnimatePresence>
      {media && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/85 backdrop-blur-md"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
        >
          <motion.div
            className="relative max-h-[88vh] max-w-[92vw]"
            initial={{ scale: 0.92, opacity: 0, y: 16 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.95, opacity: 0, y: 8 }}
            transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="relative grid min-h-[40vh] min-w-[40vw] place-items-center overflow-hidden rounded-lg border border-hairline bg-surface/40 shadow-2xl">
              {media.fileType === "video" ? (
                <video src={api.fileUrl(media.id)} controls autoPlay className="max-h-[80vh]" />
              ) : (
                <>
                  {url && (
                    <motion.img
                      src={url}
                      alt={media.remotePath}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ duration: 0.4 }}
                      className="max-h-[80vh] w-auto object-contain"
                    />
                  )}

                  {phase !== "loaded" && phase !== "error" && (
                    <div className="flex w-72 flex-col items-center gap-3 p-8 text-center">
                      <div className="h-8 w-8 animate-spin rounded-full border-2 border-hairline border-t-amber" />
                      <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-muted">
                        {media.isDownloaded ? "loading frame" : "fetching from camera over GSM"}
                      </div>
                      <div className="h-1 w-full overflow-hidden rounded-full bg-hairline">
                        <div
                          className={`h-full bg-amber transition-all duration-300 ${
                            phase === "fetching" ? "w-1/4 animate-pulse" : ""
                          }`}
                          style={phase === "downloading" ? { width: `${pct}%` } : undefined}
                        />
                      </div>
                      <div className="font-mono text-[10px] text-muted">
                        {phase === "downloading"
                          ? `${fmtBytes(received)} / ${fmtBytes(total)}  ·  ${pct}%`
                          : "contacting remote, this can take a few seconds"}
                      </div>
                    </div>
                  )}

                  {phase === "error" && (
                    <div className="flex w-72 flex-col items-center gap-3 p-8 text-center">
                      <div className="font-mono text-xs uppercase tracking-[0.2em] text-amber">
                        could not load frame
                      </div>
                      <div className="font-mono text-[10px] text-muted">
                        the remote may be unreachable or the file is missing
                      </div>
                      <button
                        onClick={retry}
                        className="rounded-md border border-hairline px-4 py-1.5 font-mono text-xs text-fg transition hover:shadow-glow"
                      >
                        retry
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>

            <div className="mt-3 flex items-center justify-between font-mono text-xs text-muted">
              <span className="text-fg">{fmtDateTime(media.timestamp)}</span>
              <span>
                {media.fileType.toUpperCase()} · {fmtBytes(media.sizeBytes)} ·{" "}
                <span className={media.isDownloaded ? "text-teal" : "text-amber"}>
                  {media.isDownloaded ? "cached" : "remote"}
                </span>
              </span>
            </div>

            <button
              onClick={onPrev}
              className="absolute left-0 top-1/2 -translate-x-14 -translate-y-1/2 rounded-full border border-hairline bg-surface/80 px-3 py-2 text-fg transition hover:shadow-glow"
              aria-label="previous"
            >
              ‹
            </button>
            <button
              onClick={onNext}
              className="absolute right-0 top-1/2 translate-x-14 -translate-y-1/2 rounded-full border border-hairline bg-surface/80 px-3 py-2 text-fg transition hover:shadow-glow"
              aria-label="next"
            >
              ›
            </button>
          </motion.div>

          <button
            onClick={onClose}
            className="absolute right-5 top-5 rounded-full border border-hairline bg-surface/80 px-3 py-1.5 font-mono text-xs text-muted transition hover:text-fg"
          >
            ESC
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
