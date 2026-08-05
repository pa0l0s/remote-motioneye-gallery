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

/**
 * Every kind toggles on its own; selecting several is a union. Nothing selected shows
 * everything. The two groups are separated because they come from two independent passes
 * and the user needs to know which pass produced a label.
 */
export function DetectionFilter({ selected, onChange, counts, aiAvailable, aiEnabled }: DetectionFilterProps) {
  const toggle = (id: string) =>
    onChange(selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]);

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
    <div className="flex flex-wrap gap-6">
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

      <div className="flex items-end gap-3 font-mono text-xs">
        <button onClick={() => onChange([])} className="text-muted hover:text-fg">
          wyczyść
        </button>
      </div>
    </div>
  );
}
