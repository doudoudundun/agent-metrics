import { buildScopeLabel, isSameScope, type TimeScopeSelection } from "../time-scope";

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
] satisfies TimeScopeSelection[];

export function TimeScopeToolbar({ selection, onChange }: TimeScopeToolbarProps) {
  return (
    <div className="time-scope-toolbar" aria-label="Dashboard time scope" role="toolbar">
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
  );
}
