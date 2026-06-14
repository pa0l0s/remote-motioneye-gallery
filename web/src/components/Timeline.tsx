import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { HistogramBucket } from "../api";

interface TimelineProps {
  buckets: HistogramBucket[];
  activeBucket?: string;
  onPick: (bucket: string) => void;
}

const BAR_WIDTH = 7;
const BAR_GAP = 3;
const TICK_EVERY = 5; // label every Nth day
const DRAG_THRESHOLD = 5; // px movement below which a drag counts as a click

/** Day-of-month from a YYYY-MM-DD bucket, zero-padded (UTC-safe, no Date parsing). */
function dayLabel(bucket: string): string {
  return bucket.slice(8, 10);
}

/** Activity-density timeline: one bar per day, height scaled to frame count. */
export function Timeline({ buckets, activeBucket, onPick }: TimelineProps) {
  const max = useMemo(() => Math.max(1, ...buckets.map((b) => b.count)), [buckets]);

  const scrollRef = useRef<HTMLDivElement>(null);

  // Drag-pan state. We track via refs so listeners stay cheap, and a tiny bit of
  // React state only to toggle the grabbing cursor.
  const dragging = useRef(false);
  const moved = useRef(false);
  const startX = useRef(0);
  const startScroll = useRef(0);
  const [grabbing, setGrabbing] = useState(false);

  // Translate vertical wheel gestures into horizontal scroll, and keep the page
  // from scrolling while the pointer is over the timeline. Registered as a
  // non-passive native listener so preventDefault() actually takes effect.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      // Honour an existing horizontal gesture (trackpads); otherwise remap Y -> X.
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (delta === 0) return;
      el.scrollLeft += delta;
      e.preventDefault();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const el = scrollRef.current;
    if (!el) return;
    dragging.current = true;
    moved.current = false;
    startX.current = e.clientX;
    startScroll.current = el.scrollLeft;
    setGrabbing(true);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const el = scrollRef.current;
    if (!el || !dragging.current) return;
    const dx = e.clientX - startX.current;
    if (Math.abs(dx) > DRAG_THRESHOLD) moved.current = true;
    el.scrollLeft = startScroll.current - dx;
  }, []);

  const endDrag = useCallback(() => {
    dragging.current = false;
    setGrabbing(false);
  }, []);

  // Suppress the click that follows a real drag so it doesn't pick a bucket.
  const onBarClick = useCallback(
    (bucket: string) => {
      if (moved.current) return;
      onPick(bucket);
    },
    [onPick],
  );

  if (buckets.length === 0) {
    return (
      <div className="flex h-full items-center px-4 font-mono text-xs text-muted">
        awaiting index data…
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerLeave={endDrag}
      className={`flex h-full select-none flex-col overflow-x-auto px-4 ${
        grabbing ? "cursor-grabbing" : "cursor-grab"
      }`}
    >
      {/* Bars */}
      <div
        className="flex flex-1 items-end pt-2"
        style={{ gap: `${BAR_GAP}px` }}
      >
        {buckets.map((b) => {
          const h = 12 + (b.count / max) * 100;
          const active = b.bucket === activeBucket;
          return (
            <button
              key={b.bucket}
              onClick={() => onBarClick(b.bucket)}
              title={`${b.bucket} · ${b.count} frames`}
              className="group relative flex h-full shrink-0 flex-col items-center justify-end"
              style={{ width: `${BAR_WIDTH}px` }}
            >
              <span
                className={`w-full rounded-sm transition-all duration-200 ${
                  active
                    ? "bg-amber shadow-glow"
                    : "bg-teal/30 group-hover:bg-amber/70"
                }`}
                style={{ height: `${h}%` }}
              />
            </button>
          );
        })}
      </div>

      {/* Date scale: a tick label under every Nth bar, aligned to its column. */}
      <div className="flex shrink-0 pb-1 pt-1" style={{ gap: `${BAR_GAP}px` }}>
        {buckets.map((b, i) => (
          <div
            key={b.bucket}
            className="shrink-0 text-center font-mono text-[9px] leading-none text-muted"
            style={{ width: `${BAR_WIDTH}px` }}
          >
            {i % TICK_EVERY === 0 ? dayLabel(b.bucket) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
