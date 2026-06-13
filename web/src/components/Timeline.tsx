import { useMemo } from "react";
import type { HistogramBucket } from "../api";

interface TimelineProps {
  buckets: HistogramBucket[];
  activeBucket?: string;
  onPick: (bucket: string) => void;
}

/** Activity-density timeline: one bar per day, height scaled to frame count. */
export function Timeline({ buckets, activeBucket, onPick }: TimelineProps) {
  const max = useMemo(() => Math.max(1, ...buckets.map((b) => b.count)), [buckets]);

  if (buckets.length === 0) {
    return (
      <div className="flex h-full items-center px-4 font-mono text-xs text-muted">
        awaiting index data…
      </div>
    );
  }

  return (
    <div className="flex h-full items-end gap-[3px] overflow-x-auto px-4 pb-3 pt-2">
      {buckets.map((b) => {
        const h = 12 + (b.count / max) * 100;
        const active = b.bucket === activeBucket;
        return (
          <button
            key={b.bucket}
            onClick={() => onPick(b.bucket)}
            title={`${b.bucket} · ${b.count} frames`}
            className="group relative flex w-[7px] shrink-0 flex-col items-center justify-end"
            style={{ height: "100%" }}
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
  );
}
