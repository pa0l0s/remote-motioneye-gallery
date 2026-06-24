import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { api } from "../api";
import type { ScanStatus } from "../api";

interface ScanStatusTrayProps {
  /** Called when newly-detected activity lands, so the grid/timeline can refresh. */
  onScanProgress: () => void;
}

/**
 * Footer tray (bottom-left) showing background activity-scan coverage. The scan is
 * local-only — it spends CPU, not GSM data — so this shows frames analyzed, not bytes.
 */
export function ScanStatusTray({ onScanProgress }: ScanStatusTrayProps) {
  const [status, setStatus] = useState<ScanStatus | null>(null);
  const [open, setOpen] = useState(true);
  const lastWithActivity = useRef(0);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;

    async function poll() {
      try {
        const s = await api.activityStatus();
        if (stopped) return;
        setStatus(s);
        if (s.withActivity > lastWithActivity.current && lastWithActivity.current > 0) {
          onScanProgress(); // new activity detected -> refresh visible grid/timeline
        }
        lastWithActivity.current = s.withActivity;
        const busy = s.scanning && !s.paused && s.pending > 0;
        timer = setTimeout(poll, busy ? 2000 : 8000);
      } catch {
        timer = setTimeout(poll, 8000);
      }
    }
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [onScanProgress]);

  if (!status || !status.enabled || status.totalLocalImages === 0) return null;

  const pct = status.totalLocalImages > 0 ? Math.round((status.scanned / status.totalLocalImages) * 100) : 100;
  const done = status.pending === 0;
  const active = status.scanning && !status.paused && !done;

  const toggle = async () => {
    if (status.paused) await api.resumeScan();
    else await api.pauseScan();
    setStatus({ ...status, paused: !status.paused });
  };

  return (
    <div className="fixed bottom-4 left-4 z-40 w-72 font-mono">
      <div className="overflow-hidden rounded-lg border border-hairline bg-surface-2/95 shadow-2xl backdrop-blur">
        <button
          onClick={() => setOpen((o) => !o)}
          className="flex w-full items-center justify-between border-b border-hairline px-3 py-2 text-[10px] uppercase tracking-[0.2em] text-muted"
        >
          <span className="flex items-center gap-2">
            {active && <span className="live-dot inline-block h-1.5 w-1.5 rounded-full bg-amber" />}
            activity scan
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
              <div className="px-3 py-2.5">
                <div className="flex items-center justify-between text-[11px] text-fg">
                  <span>{done ? "scan complete" : status.paused ? "paused" : "scanning…"}</span>
                  <span className="text-muted">
                    {status.scanned.toLocaleString()}/{status.totalLocalImages.toLocaleString()}
                  </span>
                </div>
                <div className="my-1.5 h-1 w-full overflow-hidden rounded-full bg-hairline">
                  <div
                    className={`h-full transition-all duration-300 ${done ? "bg-teal" : "bg-amber"}`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <div className="flex items-center justify-between text-[10px] text-muted">
                  <span>
                    {pct}% · {status.withActivity.toLocaleString()} with activity
                  </span>
                  {!done && (
                    <button onClick={toggle} className="text-amber hover:underline">
                      {status.paused ? "resume" : "pause"}
                    </button>
                  )}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
