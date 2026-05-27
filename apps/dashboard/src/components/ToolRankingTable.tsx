import type { ToolRow } from "../api";
import type { TimeScopeSelection } from "../time-scope";
import { PanelScopeControls } from "./PanelScopeControls";

type ToolRankingTableProps = {
  rows: ToolRow[];
  scope: TimeScopeSelection;
  scopeLabel: string;
  override: TimeScopeSelection | null;
  onOverrideChange: (next: TimeScopeSelection | null) => void;
  statusMessage?: string | null;
};

export function ToolRankingTable({
  rows,
  scope,
  scopeLabel,
  override,
  onOverrideChange,
  statusMessage
}: ToolRankingTableProps) {
  return (
    <section className="panel table-panel">
      <div className="panel-heading panel-heading-scoped">
        <div className="panel-title-block">
          <h2>Tool Rankings</h2>
          <PanelScopeControls
            panelName="Tool Rankings"
            scope={scope}
            scopeLabel={scopeLabel}
            override={override}
            onOverrideChange={onOverrideChange}
          />
        </div>
        <span>{rows.length} tracked</span>
      </div>
      {statusMessage ? <p className="panel-scope-message">{statusMessage}</p> : null}
      <div className="table-shell">
        <table>
          <thead>
            <tr>
              <th>Tool</th>
              <th>Calls</th>
              <th>Failures</th>
              <th>Avg Duration</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.toolName}>
                <td>{row.toolName}</td>
                <td>{row.count}</td>
                <td>{row.failures}</td>
                <td>{row.averageDurationMs} ms</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
