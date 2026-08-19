import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { motion } from "motion/react";
import { api } from "./api";
import type { AiStatus, Camera, HistogramBucket, MediaFile } from "./api";
import { Thumb } from "./components/Thumb";
import { Timeline } from "./components/Timeline";
import { Lightbox } from "./components/Lightbox";
import { TaskTray } from "./components/TaskTray";
import { ScanStatusTray } from "./components/ScanStatusTray";
import { DetectionFilter } from "./components/DetectionFilter";
import { fmtDate } from "./lib/format";

const GAP = 8;
const MIN_CELL = 190;

export function App() {
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [camera, setCamera] = useState<Camera | null>(null);
  const [buckets, setBuckets] = useState<HistogramBucket[]>([]);
  const [activeBucket, setActiveBucket] = useState<string | undefined>(undefined);
  const [currentFrom, setCurrentFrom] = useState<string | undefined>(undefined);
  const [items, setItems] = useState<MediaFile[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [pokes, setPokes] = useState(0);
  const [detections, setDetections] = useState<string[]>([]);
  const [aiStatus, setAiStatus] = useState<AiStatus | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    api.cameras().then((cs) => {
      setCameras(cs);
      if (cs[0]) setCamera(cs[0]);
    });
  }, []);

  const loadFirstPage = useCallback(
    async (cam: Camera, from?: string) => {
      setLoading(true);
      const page = await api.media(cam.id, { from, limit: 150, detections });
      setItems(page.items);
      setCursor(page.nextCursor);
      setLoading(false);
      scrollRef.current?.scrollTo({ top: 0 });
    },
    [detections],
  );

  useEffect(() => {
    if (!camera) return;
    api.histogram(camera.id, "day").then(setBuckets);
    void loadFirstPage(camera);
  }, [camera, loadFirstPage]);

  const loadMore = useCallback(async () => {
    if (!camera || !cursor || loading) return;
    setLoading(true);
    const page = await api.media(camera.id, { cursor, limit: 150, detections });
    setItems((prev) => [...prev, ...page.items]);
    setCursor(page.nextCursor);
    setLoading(false);
  }, [camera, cursor, loading, detections]);

  // Re-fetch the current view (used after a download batch settles so cached flips on).
  const refreshView = useCallback(() => {
    if (camera) void loadFirstPage(camera, currentFrom);
    if (camera) api.histogram(camera.id, "day").then(setBuckets);
  }, [camera, currentFrom, loadFirstPage]);

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

  // Plain function (re-created each render) so it sees fresh items/cols/rowH.
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < rowH * 3) void loadMore();
    // Sync the timeline's selected day to whatever day is at the top of the viewport.
    const firstRow = Math.floor(el.scrollTop / rowH);
    const idx = Math.min(items.length - 1, Math.max(0, firstRow * cols));
    const it = items[idx];
    if (it) {
      const day = new Date(it.timestamp).toISOString().slice(0, 10);
      setActiveBucket((prev) => (prev === day ? prev : day));
    }
  };

  const pickBucket = (b: string) => {
    if (!camera) return;
    setActiveBucket(b);
    setCurrentFrom(`${b}T00:00:00Z`);
    void loadFirstPage(camera, `${b}T00:00:00Z`);
  };

  const toggleSelect = (id: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const downloadSelected = async () => {
    if (!camera || selected.size === 0) return;
    await api.createDownload({ cameraId: camera.id, mediaIds: [...selected] });
    setSelected(new Set());
    setPokes((p) => p + 1);
  };

  const downloadDay = async () => {
    if (!camera || !activeBucket) return;
    await api.createDownload({ cameraId: camera.id, day: activeBucket });
    setPokes((p) => p + 1);
  };

  const markDownloaded = useCallback(
    (id: number) =>
      setItems((prev) => prev.map((m) => (m.id === id ? { ...m, isDownloaded: true } : m))),
    [],
  );

  // Drives the extended-pass filter group's availability and counts (DetectionFilter
  // below). Refreshed on its own timer, not just on `pokes` (download jobs): loop B
  // keeps labelling frames in the background whether or not the user ever downloads
  // anything, so without this the filter group would stay dimmed with stale counts for
  // a whole session even after the model came up and started working. 20 s is loose
  // enough not to compete with ScanStatusTray's own /api/ai/status poll for freshness
  // that matters here (people/animal counts), while still updating within a session.
  //
  // Two things stop this from polling forever regardless of feature state, mirroring
  // ScanStatusTray's own /api/ai/status loop: AI_TAGGING_ENABLED is a startup flag, not
  // something that flips at runtime, so once a response reports enabled:false there is
  // nothing left to catch and the timer stops entirely. And while enabled, the interval
  // backs off to 60 s whenever the model isn't loaded (the owner's workstation being
  // off is the common resting state, not something that needs 20 s-fresh polling) --
  // but it keeps running, because the model coming back up must still be noticed.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = () => {
      void api
        .aiStatus()
        .then((s) => {
          if (cancelled) return;
          setAiStatus(s);
          if (!s.enabled) return; // disabled at startup: nothing will ever change, stop polling
          timer = setTimeout(poll, s.modelLoaded ? 20000 : 60000);
        })
        .catch(() => {
          if (cancelled) return;
          setAiStatus(null);
          timer = setTimeout(poll, 20000);
        });
    };
    poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [pokes]);

  // Changing which kinds are shown re-scopes the grid to "everything matching, from the
  // top" — the previously selected day no longer describes what's on screen, so drop it.
  // Otherwise the timeline keeps showing a stale day badge and "download day" would still
  // target a day the user isn't looking at anymore.
  const changeDetections = (next: string[]) => {
    setDetections(next);
    setCurrentFrom(undefined);
    setActiveBucket(undefined);
  };

  const open = (m: MediaFile) => setOpenIndex(items.findIndex((x) => x.id === m.id));
  const total = buckets.reduce((s, b) => s + b.count, 0);
  const totalActivity = buckets.reduce((s, b) => s + b.activityCount, 0);

  return (
    <div className="atmosphere grain relative flex h-full flex-col">
      {/* ---- Header ---- */}
      {/* z-20, one above the sibling sections below: they are all `relative z-10`, so as
          later siblings they would paint over anything the header overlays — including the
          detection-filter popover, whose own z-index only applies inside this header's
          stacking context. The fixed trays sit at z-40 and still win, as they should. */}
      <header className="relative z-20 flex items-center justify-between border-b border-hairline px-6 py-4">
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
          <DetectionFilter
            selected={detections}
            onChange={changeDetections}
            counts={{
              motion: totalActivity,
              people: aiStatus?.withPeople ?? 0,
              animal: aiStatus?.withAnimals ?? 0,
              "animal:spider": aiStatus?.withSpiders ?? 0,
            }}
            aiAvailable={(aiStatus?.scanned ?? 0) > 0}
            aiEnabled={aiStatus?.enabled ?? false}
          />
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
      <div className="relative z-10 h-28 border-b border-hairline bg-surface/30">
        <div className="flex items-center justify-between px-6 pt-2 font-mono text-[10px] uppercase tracking-[0.25em] text-muted">
          <span>activity timeline</span>
          <span className="flex items-center gap-3">
            {activeBucket && <span className="text-amber">{fmtDate(`${activeBucket}T00:00:00Z`)}</span>}
            {activeBucket && (
              <button
                onClick={downloadDay}
                className="rounded border border-hairline px-2 py-1 text-[10px] uppercase tracking-[0.2em] text-fg transition hover:shadow-glow"
              >
                ↓ download day
              </button>
            )}
          </span>
        </div>
        <div className="h-[88px]">
          <Timeline buckets={buckets} activeBucket={activeBucket} onPick={pickBucket} />
        </div>
      </div>

      {/* ---- Selection toolbar ---- */}
      {selected.size > 0 && (
        <motion.div
          initial={{ y: -8, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          className="relative z-10 flex items-center justify-between border-b border-amber/30 bg-amber/5 px-6 py-2 font-mono text-xs"
        >
          <span className="text-amber">{selected.size} selected</span>
          <span className="flex items-center gap-3">
            <button onClick={() => setSelected(new Set())} className="text-muted hover:text-fg">
              clear
            </button>
            <button
              onClick={downloadSelected}
              className="rounded border border-amber bg-amber px-3 py-1 font-medium text-ink transition hover:opacity-90"
            >
              ↓ download selected
            </button>
          </span>
        </motion.div>
      )}

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
                  <Thumb
                    key={m.id}
                    media={m}
                    onOpen={open}
                    selected={selected.has(m.id)}
                    onToggleSelect={toggleSelect}
                  />
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
        onDownloaded={markDownloaded}
      />

      <TaskTray pokes={pokes} onJobsSettled={refreshView} />
      <ScanStatusTray onScanProgress={refreshView} />
    </div>
  );
}
