import { useEffect, useRef, useState } from "react";

interface DetectionFilterProps {
  selected: string[];
  onChange: (next: string[]) => void;
  /** Per-kind counts for the current date range; omit a key to hide its count. */
  counts: Record<string, number>;
  /** False when the vision model has never labelled anything — the group is dimmed. */
  aiAvailable: boolean;
  /** False when the extended pass is off at the config level (AI_TAGGING_ENABLED=false)
   *  — distinct from aiAvailable, which can be false even while enabled (model just
   *  hasn't loaded yet, or hasn't caught up). Picks which hint the empty group shows. */
  aiEnabled: boolean;
}

const BASIC = [{ id: "motion", label: "ruch w kadrze" }];

const EXTENDED = [
  { id: "people", label: "osoba" },
  { id: "animal", label: "zwierzę — dowolne" },
  { id: "animal:bird", label: "ptak", indent: true },
  { id: "animal:dog", label: "pies", indent: true },
  { id: "animal:horse", label: "koń", indent: true },
  { id: "animal:deer", label: "sarna", indent: true },
  { id: "animal:other", label: "inne", indent: true },
  { id: "fog", label: "gęsta mgła" },
  { id: "snow", label: "opad śniegu" },
  { id: "snow_ground", label: "śnieg na ziemi" },
  { id: "night", label: "noc (podczerwień)" },
];

const LABELS: Record<string, string> = Object.fromEntries(
  [...BASIC, ...EXTENDED].map((i) => [i.id, i.label]),
);

/**
 * Every kind toggles on its own; selecting several is a union. Nothing selected shows
 * everything. The two groups are separated because they come from two independent passes
 * and the user needs to know which pass produced a label.
 *
 * The panel is collapsed by default and opens as an overlay rather than inline: twelve
 * checkbox rows in the page header cost ~230px of vertical space permanently, above the
 * timeline and the grid. Overlaying means opening it never reflows the content behind it.
 *
 * The trigger always names the active filters (or their count once there are several), so
 * a collapsed panel can never hide the fact that the grid is filtered — the failure mode
 * that makes collapsible filters frustrating.
 */
export function DetectionFilter({
  selected,
  onChange,
  counts,
  aiAvailable,
  aiEnabled,
}: DetectionFilterProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Close on Escape or on a click outside. Both listeners are only attached while open,
  // so a closed panel costs nothing.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  const toggle = (id: string) =>
    onChange(selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]);

  // One or two active kinds read better as names than as a bare number.
  const summary =
    selected.length === 0
      ? "wszystkie"
      : selected.length <= 2
        ? selected.map((id) => LABELS[id] ?? id).join(", ")
        : `${selected.length} rodzaje`;

  const row = (item: { id: string; label: string; indent?: boolean }, disabled = false) => (
    <label
      key={item.id}
      className={`flex cursor-pointer items-center gap-2 py-0.5 font-mono text-xs ${
        item.indent ? "pl-5" : ""
      } ${disabled ? "cursor-default opacity-40" : "hover:text-fg"} ${
        selected.includes(item.id) ? "text-amber" : "text-muted"
      }`}
    >
      <input
        type="checkbox"
        className="accent-amber"
        checked={selected.includes(item.id)}
        disabled={disabled}
        onChange={() => toggle(item.id)}
      />
      <span className="flex-1">{item.label}</span>
      {counts[item.id] !== undefined && (
        <span className="tabular-nums text-muted">{counts[item.id]}</span>
      )}
    </label>
  );

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={`flex items-center gap-2 rounded-sm border px-3 py-1.5 font-mono text-xs transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:outline-amber ${
          selected.length
            ? "border-amber/50 text-amber"
            : "border-hairline text-muted hover:text-fg"
        }`}
      >
        <span>filtry</span>
        <span className="max-w-[180px] truncate opacity-80">{summary}</span>
        <span aria-hidden className={`transition-transform ${open ? "rotate-180" : ""}`}>
          ▾
        </span>
      </button>

      {open && (
        <div className="absolute right-0 top-full z-30 mt-2 rounded-md border border-hairline bg-surface px-4 py-3 shadow-glow">
          <div className="flex gap-6">
          <fieldset className="min-w-[190px]">
            <legend className="mb-1 font-mono text-[10px] uppercase tracking-widest text-muted">
              Przebieg podstawowy
            </legend>
            {BASIC.map((i) => row(i))}
          </fieldset>

          <fieldset className="min-w-[230px]">
            <legend className="mb-1 font-mono text-[10px] uppercase tracking-widest text-muted">
              Przebieg rozszerzony
            </legend>
            {!aiAvailable && (
              <p className="mb-1 max-w-[230px] font-mono text-[10px] leading-snug text-muted">
                {aiEnabled
                  ? "Model jeszcze nic nie oznaczył. Włącz go w LM Studio, żeby te filtry zadziałały."
                  : "Przebieg rozszerzony jest wyłączony w konfiguracji serwera."}
              </p>
            )}
            {EXTENDED.map((i) => row(i, !aiAvailable))}
          </fieldset>
          </div>

          <div className="mt-3 flex items-center justify-between border-t border-hairline pt-2 font-mono text-[10px] text-muted">
            <span>
              {selected.length === 0
                ? "nic nie zaznaczone — widać wszystkie klatki"
                : "klatka pasuje, gdy spełnia którykolwiek zaznaczony rodzaj"}
            </span>
            <button
              onClick={() => onChange([])}
              disabled={selected.length === 0}
              className="text-xs hover:text-fg disabled:cursor-default disabled:opacity-40"
            >
              wyczyść
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
