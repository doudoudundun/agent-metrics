import {
  buildScopeLabel,
  customScopeFromLocalDates,
  isSameScope,
  toolbarDatesForScope,
  type PresetTimeScope,
  type TimeScopeSelection
} from "../time-scope";

type TimeScopeToolbarProps = {
  selection: TimeScopeSelection;
  onChange: (selection: TimeScopeSelection) => void;
};

const SCOPE_OPTIONS = [
  { mode: "calendar", range: "day" },
  { mode: "calendar", range: "week" },
  { mode: "calendar", range: "month" },
  { mode: "rolling", range: "day" },
  { mode: "rolling", range: "week" },
  { mode: "rolling", range: "month" },
  { mode: "lifetime", range: "day" }
] satisfies PresetTimeScope[];

export function TimeScopeToolbar({ selection, onChange }: TimeScopeToolbarProps) {
  const customSelected = selection.mode === "custom";
  const customDates = toolbarDatesForScope(selection);

  const applyDates = (startDate: string, endDate: string) => {
    if (!startDate || !endDate) {
      return;
    }
    onChange(customScopeFromLocalDates(startDate, endDate));
  };

  return (
    <div className="time-scope-toolbar" aria-label="Dashboard time scope" role="toolbar">
      <div className="time-scope-custom" data-active={customSelected}>
        <span className="time-scope-custom__legend">Custom range</span>
        <label className="time-scope-custom__field">
          <span>From</span>
          <input
            aria-label="Custom range start"
            max={customDates.endDate || undefined}
            onChange={(event) => {
              if (!event.target.value) {
                return;
              }
              applyDates(event.target.value, customDates.endDate || event.target.value);
            }}
            type="date"
            value={customDates.startDate}
          />
        </label>
        <label className="time-scope-custom__field">
          <span>To</span>
          <input
            aria-label="Custom range end"
            min={customDates.startDate || undefined}
            onChange={(event) => {
              if (!event.target.value) {
                return;
              }
              applyDates(customDates.startDate || event.target.value, event.target.value);
            }}
            type="date"
            value={customDates.endDate}
          />
        </label>
      </div>
      <div className="time-scope-presets">
        {SCOPE_OPTIONS.map((option) => {
          const selected = isSameScope(option, selection);

          return (
            <button
              aria-pressed={selected}
              className="time-scope-button"
              data-selected={selected}
              key={`${option.mode}-${option.range}`}
              onClick={() => {
                if (!selected) {
                  onChange(option);
                }
              }}
              type="button"
            >
              {buildScopeLabel(option)}
            </button>
          );
        })}
      </div>
    </div>
  );
}
