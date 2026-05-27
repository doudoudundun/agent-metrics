import { buildScopeLabel, DEFAULT_TIME_SCOPE, type TimeScopeSelection } from "../time-scope";

type PanelScopeControlsProps = {
  panelName: string;
  scopeLabel: string;
  override: TimeScopeSelection | null;
  onOverrideChange: (next: TimeScopeSelection | null) => void;
};

export function PanelScopeControls({
  panelName,
  scopeLabel,
  override,
  onOverrideChange
}: PanelScopeControlsProps) {
  const range = override?.range ?? DEFAULT_TIME_SCOPE.range;

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

            onOverrideChange({
              mode: mode as TimeScopeSelection["mode"],
              range
            });
          }}
        >
          <option value="global">Follow Global</option>
          <option value="calendar">Natural Calendar</option>
          <option value="rolling">Rolling Window</option>
          <option value="lifetime">Lifetime</option>
        </select>
        <select
          aria-label={`${panelName} range`}
          disabled={!override || override.mode === "lifetime"}
          value={range}
          onChange={(event) => {
            if (!override) {
              return;
            }

            onOverrideChange({
              ...override,
              range: event.target.value as TimeScopeSelection["range"]
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
