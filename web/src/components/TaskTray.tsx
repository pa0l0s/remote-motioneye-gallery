import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { api } from "../api";
import type { DownloadJob } from "../api";
import { fmtBytes } from "../lib/format";

interface TaskTrayProps {
  /** Bumped whenever a new job is created, to start polling immediately. */
  pokes: number;
  onJobsSettled: () => void;
}

const ACTIVE = (j: DownloadJob) => j.status === "running";

export function TaskTray({ pokes, onJobsSettled }: TaskTrayProps) {
  const [jobs, setJobs] = useState<DownloadJob[]>([]);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    let hadActive = false;

    async function poll() {
      try {
        const list = await api.listDownloads();
        if (stopped) return;
        setJobs(list);
        const active = list.some(ACTIVE);
        if (hadActive && !active) onJobsSettled(); // a batch just finished -> refresh grid
        hadActive = active;
        timer = setTimeout(poll, active ? 1000 : 4000);
      } catch {
        timer = setTimeout(poll, 4000);
      }
    }
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [pokes, onJobsSettled]);

  const visible = jobs.filter((j) => ACTIVE(j) || Date.now() - j.updatedAt < 8000);
  if (visible.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-40 w-80 font-mono">
      <div className="overflow-hidden rounded-lg border border-hairline bg-surface-2/95 shadow-2xl backdrop-blur">
        <button
          onClick={() => setOpen((o) => !o)}
          className="flex w-full items-center justify-between border-b border-hairline px-3 py-2 text-[10px] uppercase tracking-[0.2em] text-muted"
        >
          <span className="flex items-center gap-2">
            {visible.some(ACTIVE) && (
              <span className="live-dot inline-block h-1.5 w-1.5 rounded-full bg-amber" />
            )}
            downloads
          </span>
          <span>{open ? "▾" : "▸"}</span>
        </button>

        <AnimatePresence initial={false}>
          {open && (
            <motion.div
              initial={{ height: 0 }}
              animate={{ height: "auto" }}
              exit={{ height: 0 }}
              className="overflow-hidden"
            >
              <div className="max-h-72 overflow-y-auto">
                {visible.map((j) => {
                  const pct = j.total > 0 ? Math.round(((j.done + j.failed) / j.total) * 100) : 100;
                  return (
                    <div key={j.id} className="border-b border-hairline/50 px-3 py-2.5">
                      <div className="flex items-center justify-between text-[11px] text-fg">
                        <span className="truncate pr-2">{j.label}</span>
                        <span className="shrink-0 text-muted">
                          {j.done}/{j.total}
                        </span>
                      </div>
                      <div className="my-1.5 h-1 w-full overflow-hidden rounded-full bg-hairline">
                        <div
                          className={`h-full transition-all duration-300 ${
                            j.status === "error"
                              ? "bg-amber"
                              : j.status === "canceled"
                                ? "bg-muted"
                                : "bg-teal"
                          }`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <div className="flex items-center justify-between text-[10px] text-muted">
                        <span>
                          {j.status === "running" ? "downloading" : j.status}
                          {j.failed > 0 ? ` · ${j.failed} failed` : ""}
                        </span>
                        <span className="flex items-center gap-2">
                          <span>{fmtBytes(j.bytes)}</span>
                          {j.status === "running" && (
                            <button
                              onClick={() => api.cancelDownload(j.id)}
                              className="text-amber hover:underline"
                            >
                              cancel
                            </button>
                          )}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
