import { buildScopeLabel, type TimeScopeSelection } from "../time-scope";

type PanelScopeControlsProps = {
  panelName: string;
  scope: TimeScopeSelection;
  scopeLabel: string;
  override: TimeScopeSelection | null;
  onOverrideChange: (next: TimeScopeSelection | null) => void;
};

export function PanelScopeControls({
  panelName,
  scope,
  scopeLabel,
  override,
  onOverrideChange
}: PanelScopeControlsProps) {
  const value = override ?? scope;

  return (
    <div className="panel-scope-controls">
      <span className="panel-scope-status">
        {override ? `Override active: ${buildScopeLabel(override)}` : `Following global: ${scopeLabel}`}
      </span>
      <div className="panel-scope-fields">
        <select
          aria-label={`${panelName} mode`}
          value={override?.mode ?? "global"}
          onChange={(event) => {
            const mode = event.target.value;

            if (mode === "global") {
              onOverrideChange(null);
              return;
            }

            const range = value.mode === "custom" ? "day" : value.range;
            onOverrideChange({
              mode: mode as "calendar" | "rolling" | "lifetime",
              range
            });
          }}
        >
          <option value="global">Follow Global</option>
          <option value="calendar">Natural Calendar</option>
          <option value="rolling">Rolling Window</option>
          <option value="lifetime">All Time</option>
        </select>
        <select
          aria-label={`${panelName} range`}
          disabled={!override || override.mode === "lifetime" || override.mode === "custom"}
          value={value.mode === "custom" ? "day" : value.range}
          onChange={(event) => {
            if (!override || override.mode === "custom" || override.mode === "lifetime") {
              return;
            }

            onOverrideChange({
              mode: override.mode,
              range: event.target.value as "day" | "week" | "month"
            });
          }}
        >
          <option value="day">Day</option>
          <option value="week">Week</option>
          <option value="month">Month</option>
        </select>
        {override ? (
          <button onClick={() => onOverrideChange(null)} type="button">
            Use Global Scope
          </button>
        ) : null}
      </div>
    </div>
  );
}
