import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import type { MediaFile } from "../api";
import { api } from "../api";
import { fmtTime } from "../lib/format";

interface ThumbProps {
  media: MediaFile;
  onOpen: (m: MediaFile) => void;
  selected: boolean;
  onToggleSelect: (id: number) => void;
}

/**
 * A grid cell. Thumbnails are LOCAL-ONLY: if the frame isn't downloaded we show a
 * placeholder and never request anything from the remote (no GSM). The thumbnail request
 * is made only for already-local frames, and only once the cell is visible.
 */
export function Thumb({ media, onOpen, selected, onToggleSelect }: ThumbProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [errored, setErrored] = useState(false);

  const local = media.isDownloaded;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setVisible(true);
          io.disconnect();
        }
      },
      { rootMargin: "300px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className={`group relative aspect-[4/3] overflow-hidden rounded-md border bg-surface ${
        selected
          ? "border-amber shadow-glow"
          : media.hasActivity
            ? "border-amber/40"
            : "border-hairline"
      }`}
    >
      <button onClick={() => onOpen(media)} className="absolute inset-0 h-full w-full outline-none">
        {local && !loaded && !errored && <div className="skeleton absolute inset-0" />}
        {local && visible && !errored && (
          <motion.img
            src={api.thumbUrl(media.id)}
            alt=""
            loading="lazy"
            onLoad={() => setLoaded(true)}
            onError={() => setErrored(true)}
            initial={{ opacity: 0, scale: 1.04 }}
            animate={{ opacity: loaded ? 1 : 0, scale: loaded ? 1 : 1.04 }}
            transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
            className="h-full w-full object-cover"
          />
        )}
        {(!local || errored) && (
          <div className="absolute inset-0 grid place-items-center">
            <div className="flex flex-col items-center gap-1 text-muted">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" className="opacity-40">
                <path
                  d="M4 17l5-6 4 4 3-3 4 5M4 7h16"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <span className="font-mono text-[9px] uppercase tracking-widest">
                {errored ? "no signal" : "remote"}
              </span>
            </div>
          </div>
        )}

        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
        <div className="pointer-events-none absolute bottom-1.5 left-2 font-mono text-[11px] text-fg/90 opacity-0 transition-opacity duration-300 group-hover:opacity-100">
          {fmtTime(media.timestamp)}
        </div>
      </button>

      {/* selection checkbox */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onToggleSelect(media.id);
        }}
        aria-label={selected ? "deselect" : "select"}
        className={`absolute left-1.5 top-1.5 z-10 grid h-5 w-5 place-items-center rounded border text-[11px] transition ${
          selected
            ? "border-amber bg-amber text-ink"
            : "border-hairline bg-ink/60 text-transparent opacity-0 group-hover:opacity-100"
        }`}
      >
        ✓
      </button>

      {/* cache state pip */}
      <span
        className={`pointer-events-none absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full ${
          local ? "bg-teal" : "bg-amber/60"
        }`}
        title={local ? "cached locally" : "remote (not downloaded)"}
      />

      {/* activity-detected badge */}
      {media.hasActivity && (
        <span
          className="pointer-events-none absolute bottom-1.5 right-1.5 z-10 flex items-center gap-1 rounded-sm bg-amber/90 px-1 py-0.5 font-mono text-[8px] font-semibold uppercase tracking-wider text-ink shadow-glow"
          title={
            media.activityScore != null
              ? `activity detected (${(media.activityScore * 100).toFixed(1)}% changed)`
              : "activity detected"
          }
        >
          <svg width="8" height="8" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path
              d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"
              stroke="currentColor"
              strokeWidth="2"
            />
            <circle cx="12" cy="12" r="3" fill="currentColor" />
          </svg>
          activity
        </span>
      )}
    </div>
  );
}
