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
  emptyMessage?: string;
};

/** Heaviest tools kept individually; lighter ones fold into a single "Others" row. */
const TOOL_RANKING_LIMIT = 5;

export function ToolRankingTable({
  rows,
  scope,
  scopeLabel,
  override,
  onOverrideChange,
  statusMessage,
  emptyMessage
}: ToolRankingTableProps) {
  const { visibleRows, othersRow } = buildRanking(rows);

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
        <span>{buildCountLabel(visibleRows.length, rows.length)}</span>
      </div>
      {statusMessage ? <p className="panel-scope-message">{statusMessage}</p> : null}
      {rows.length > 0 ? (
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
              {visibleRows.map((row) => (
                <tr key={row.toolName}>
                  <td>{row.toolName}</td>
                  <td>{row.count}</td>
                  <td>{row.failures}</td>
                  <td>{row.averageDurationMs} ms</td>
                </tr>
              ))}
              {othersRow !== null ? (
                <tr data-aggregate="true">
                  <td>{othersRow.toolName}</td>
                  <td>{othersRow.count}</td>
                  <td>{othersRow.failures}</td>
                  <td>{othersRow.averageDurationMs} ms</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="panel-empty">{emptyMessage ?? "No tool activity in this scope."}</p>
      )}
    </section>
  );
}

function buildRanking(rows: ToolRow[]): { visibleRows: ToolRow[]; othersRow: ToolRow | null } {
  const ranked = [...rows].sort(
    (left, right) => right.count - left.count || left.toolName.localeCompare(right.toolName)
  );

  // Folding a single leftover away hides more than it clarifies.
  if (ranked.length <= TOOL_RANKING_LIMIT + 1) {
    return { visibleRows: ranked, othersRow: null };
  }

  return {
    visibleRows: ranked.slice(0, TOOL_RANKING_LIMIT),
    othersRow: sumOthers(ranked.slice(TOOL_RANKING_LIMIT))
  };
}

function sumOthers(rows: ToolRow[]): ToolRow {
  const count = rows.reduce((total, row) => total + row.count, 0);
  const failures = rows.reduce((total, row) => total + row.failures, 0);
  const durationTotal = rows.reduce((total, row) => total + row.averageDurationMs * row.count, 0);

  return {
    toolName: `Others (${rows.length})`,
    count,
    failures,
    averageDurationMs: count > 0 ? Math.round(durationTotal / count) : 0
  };
}

function buildCountLabel(rowCount: number, totalCount: number): string {
  if (rowCount >= totalCount) {
    return `${totalCount} tracked`;
  }

  return `Top ${rowCount} of ${totalCount}`;
}