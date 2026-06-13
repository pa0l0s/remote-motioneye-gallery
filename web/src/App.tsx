import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { motion } from "motion/react";
import { api } from "./api";
import type { Camera, HistogramBucket, MediaFile } from "./api";
import { Thumb } from "./components/Thumb";
import { Timeline } from "./components/Timeline";
import { Lightbox } from "./components/Lightbox";
import { fmtDate } from "./lib/format";

const GAP = 8;
const MIN_CELL = 190;

export function App() {
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [camera, setCamera] = useState<Camera | null>(null);
  const [buckets, setBuckets] = useState<HistogramBucket[]>([]);
  const [activeBucket, setActiveBucket] = useState<string | undefined>(undefined);
  const [items, setItems] = useState<MediaFile[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  // --- bootstrap ---
  useEffect(() => {
    api.cameras().then((cs) => {
      setCameras(cs);
      if (cs[0]) setCamera(cs[0]);
    });
  }, []);

  const loadFirstPage = useCallback(async (cam: Camera, from?: string) => {
    setLoading(true);
    const page = await api.media(cam.id, { from, limit: 150 });
    setItems(page.items);
    setCursor(page.nextCursor);
    setLoading(false);
    scrollRef.current?.scrollTo({ top: 0 });
  }, []);

  useEffect(() => {
    if (!camera) return;
    api.histogram(camera.id, "day").then(setBuckets);
    void loadFirstPage(camera);
  }, [camera, loadFirstPage]);

  const loadMore = useCallback(async () => {
    if (!camera || !cursor || loading) return;
    setLoading(true);
    const page = await api.media(camera.id, { cursor, limit: 150 });
    setItems((prev) => [...prev, ...page.items]);
    setCursor(page.nextCursor);
    setLoading(false);
  }, [camera, cursor, loading]);

  // --- responsive column count ---
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const cols = Math.max(1, Math.floor((width + GAP) / (MIN_CELL + GAP)));
  const cellW = cols > 0 ? (width - GAP * (cols - 1)) / cols : MIN_CELL;
  const rowH = cellW * 0.75 + GAP;
  const rowCount = Math.ceil(items.length / cols);

  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowH,
    overscan: 4,
  });

  // infinite load when near the end
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < rowH * 3) void loadMore();
  }, [loadMore, rowH]);

  const pickBucket = (b: string) => {
    if (!camera) return;
    setActiveBucket(b);
    void loadFirstPage(camera, `${b}T00:00:00Z`);
  };

  const open = (m: MediaFile) => setOpenIndex(items.findIndex((x) => x.id === m.id));
  const total = buckets.reduce((s, b) => s + b.count, 0);

  return (
    <div className="atmosphere grain relative flex h-full flex-col">
      {/* ---- Header ---- */}
      <header className="relative z-10 flex items-center justify-between border-b border-hairline px-6 py-4">
        <div className="flex items-baseline gap-4">
          <h1 className="font-display text-2xl font-extrabold tracking-tight text-fg">
            NIGHT<span className="text-amber">·</span>WATCH
          </h1>
          <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.2em] text-muted">
            <span className="live-dot inline-block h-1.5 w-1.5 rounded-full bg-teal" />
            motioneye proxy
          </div>
        </div>

        <div className="flex items-center gap-6">
          {cameras.length > 1 && (
            <select
              value={camera?.id}
              onChange={(e) => setCamera(cameras.find((c) => c.id === Number(e.target.value)) ?? null)}
              className="rounded-md border border-hairline bg-surface px-3 py-1.5 font-mono text-xs text-fg outline-none"
            >
              {cameras.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          )}
          <div className="text-right font-mono text-xs text-muted">
            <div className="text-fg">{camera?.name ?? "—"}</div>
            <div>{total.toLocaleString()} frames indexed</div>
          </div>
        </div>
      </header>

      {/* ---- Timeline band ---- */}
      <div className="relative z-10 h-24 border-b border-hairline bg-surface/30">
        <div className="flex items-center justify-between px-6 pt-2 font-mono text-[10px] uppercase tracking-[0.25em] text-muted">
          <span>activity timeline</span>
          {activeBucket && <span className="text-amber">{fmtDate(`${activeBucket}T00:00:00Z`)}</span>}
        </div>
        <div className="h-[72px]">
          <Timeline buckets={buckets} activeBucket={activeBucket} onPick={pickBucket} />
        </div>
      </div>

      {/* ---- Grid ---- */}
      <div ref={scrollRef} onScroll={onScroll} className="relative z-10 flex-1 overflow-auto px-6 py-5">
        {items.length === 0 && !loading && (
          <div className="grid h-full place-items-center font-mono text-sm text-muted">
            <div className="text-center">
              <div className="mb-2 text-amber">no frames yet</div>
              indexing the archive… this populates as the worker walks dates.
            </div>
          </div>
        )}

        <div style={{ height: rowVirtualizer.getTotalSize(), position: "relative" }}>
          {rowVirtualizer.getVirtualItems().map((vRow) => {
            const start = vRow.index * cols;
            const rowItems = items.slice(start, start + cols);
            return (
              <div
                key={vRow.key}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${vRow.start}px)`,
                  height: rowH,
                  display: "grid",
                  gridTemplateColumns: `repeat(${cols}, 1fr)`,
                  gap: GAP,
                }}
              >
                {rowItems.map((m) => (
                  <Thumb key={m.id} media={m} onOpen={open} />
                ))}
              </div>
            );
          })}
        </div>

        {loading && (
          <div className="py-6 text-center font-mono text-xs text-muted">loading frames…</div>
        )}
      </div>

      {/* ---- Footer status ---- */}
      <motion.footer
        initial={{ y: 20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.2 }}
        className="relative z-10 flex items-center justify-between border-t border-hairline px-6 py-2 font-mono text-[10px] uppercase tracking-[0.2em] text-muted"
      >
        <span>{items.length.toLocaleString()} loaded</span>
        <span className="flex items-center gap-4">
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-teal" /> cached
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber/60" /> remote
          </span>
        </span>
      </motion.footer>

      <Lightbox
        media={openIndex !== null ? (items[openIndex] ?? null) : null}
        onClose={() => setOpenIndex(null)}
        onPrev={() => setOpenIndex((i) => (i === null ? null : Math.max(0, i - 1)))}
        onNext={() => setOpenIndex((i) => (i === null ? null : Math.min(items.length - 1, i + 1)))}
      />
    </div>
  );
}
