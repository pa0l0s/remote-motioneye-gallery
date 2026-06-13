import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import type { MediaFile } from "../api";
import { api } from "../api";
import { fmtTime } from "../lib/format";

interface ThumbProps {
  media: MediaFile;
  onOpen: (m: MediaFile) => void;
}

/** A single grid cell. Lazily requests its thumbnail only once visible. */
export function Thumb({ media, onOpen }: ThumbProps) {
  const ref = useRef<HTMLButtonElement>(null);
  const [visible, setVisible] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [errored, setErrored] = useState(false);

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
    <button
      ref={ref}
      onClick={() => onOpen(media)}
      className="group relative aspect-[4/3] overflow-hidden rounded-md border border-hairline bg-surface outline-none"
    >
      {!loaded && !errored && <div className="skeleton absolute inset-0" />}
      {visible && !errored && (
        <motion.img
          src={api.thumbUrl(media.id)}
          alt={media.remotePath}
          loading="lazy"
          onLoad={() => setLoaded(true)}
          onError={() => setErrored(true)}
          initial={{ opacity: 0, scale: 1.04 }}
          animate={{ opacity: loaded ? 1 : 0, scale: loaded ? 1 : 1.04 }}
          transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
          className="h-full w-full object-cover"
        />
      )}
      {errored && (
        <div className="absolute inset-0 grid place-items-center text-[10px] uppercase tracking-widest text-muted">
          no signal
        </div>
      )}

      {/* Hover scrim + timestamp readout */}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
      <div className="pointer-events-none absolute bottom-1.5 left-2 font-mono text-[11px] text-fg/90 opacity-0 transition-opacity duration-300 group-hover:opacity-100">
        {fmtTime(media.timestamp)}
      </div>

      {/* cache state pip */}
      <span
        className={`pointer-events-none absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full ${
          media.isDownloaded ? "bg-teal" : "bg-amber/60"
        }`}
        title={media.isDownloaded ? "cached locally" : "remote"}
      />
      <div className="pointer-events-none absolute inset-0 rounded-md ring-0 ring-amber/0 transition-all duration-200 group-hover:shadow-glow" />
    </button>
  );
}
