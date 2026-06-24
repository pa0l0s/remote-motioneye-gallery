import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { HistogramBucket } from "../api";

interface TimelineProps {
  buckets: HistogramBucket[];
  activeBucket?: string;
  onPick: (bucket: string) => void;
}

const BAR_WIDTH = 7;
const BAR_GAP = 3;
const STEP = BAR_WIDTH + BAR_GAP;
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

  const dragging = useRef(false);
  const moved = useRef(false);
  const startX = useRef(0);
  const startScroll = useRef(0);
  const [grabbing, setGrabbing] = useState(false);

  // Wheel over the timeline scrolls it horizontally and never lets the gesture fall
  // through to the grid. Non-passive native listener so preventDefault() works. The
  // container is always rendered (even while empty) so this attaches exactly once.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (delta === 0) return;
      e.preventDefault();
      el.scrollLeft += delta;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Keep the active day visible: when it changes (e.g. driven by grid scroll) and the
  // bar is off-screen, bring it into view without fighting a manual horizontal scroll.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !activeBucket) return;
    const idx = buckets.findIndex((b) => b.bucket === activeBucket);
    if (idx < 0) return;
    const left = idx * STEP;
    if (left < el.scrollLeft || left > el.scrollLeft + el.clientWidth - STEP) {
      el.scrollTo({ left: left - el.clientWidth / 2, behavior: "smooth" });
    }
  }, [activeBucket, buckets]);

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

  const onBarClick = useCallback(
    (bucket: string) => {
      if (moved.current) return; // a real drag should not pick a day
      onPick(bucket);
    },
    [onPick],
  );

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
      {buckets.length === 0 ? (
        <div className="flex h-full items-center font-mono text-xs text-muted">
          awaiting index data…
        </div>
      ) : (
        <>
          {/* Bars */}
          <div className="flex flex-1 items-end pt-2" style={{ gap: `${BAR_GAP}px` }}>
            {buckets.map((b) => {
              const h = 12 + (b.count / max) * 100;
              const active = b.bucket === activeBucket;
              const activityRatio = b.count > 0 ? b.activityCount / b.count : 0;
              return (
                <button
                  key={b.bucket}
                  onClick={() => onBarClick(b.bucket)}
                  title={`${b.bucket} · ${b.count} frames · ${b.activityCount} with activity`}
                  className="group relative flex h-full shrink-0 flex-col items-center justify-end"
                  style={{ width: `${BAR_WIDTH}px` }}
                >
                  <span
                    className={`relative w-full overflow-hidden rounded-sm transition-all duration-200 ${
                      active ? "bg-amber shadow-glow" : "bg-teal/30 group-hover:bg-teal/50"
                    }`}
                    style={{ height: `${h}%` }}
                  >
                    {/* activity heat: amber fill from the bottom, proportional to the day's
                        activity ratio (hidden on the active bar, which is already amber). */}
                    {!active && activityRatio > 0 && (
                      <span
                        className="absolute bottom-0 left-0 w-full bg-amber/80"
                        style={{ height: `${Math.max(8, activityRatio * 100)}%` }}
                      />
                    )}
                  </span>
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
        </>
      )}
    </div>
  );
}
