import { useEffect } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { MediaFile } from "../api";
import { api } from "../api";
import { fmtDateTime, fmtBytes } from "../lib/format";

interface LightboxProps {
  media: MediaFile | null;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
}

export function Lightbox({ media, onClose, onPrev, onNext }: LightboxProps) {
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
            <div className="overflow-hidden rounded-lg border border-hairline shadow-2xl">
              {media.fileType === "video" ? (
                <video src={api.fileUrl(media.id)} controls autoPlay className="max-h-[80vh]" />
              ) : (
                <img
                  src={api.fileUrl(media.id)}
                  alt={media.remotePath}
                  className="max-h-[80vh] w-auto object-contain"
                />
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
