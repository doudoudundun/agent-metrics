import type { ToolRow } from "../api";

type ToolRankingTableProps = {
  rows: ToolRow[];
};

export function ToolRankingTable({ rows }: ToolRankingTableProps) {
  return (
    <section className="panel table-panel">
      <div className="panel-heading">
        <h2>Tool Rankings</h2>
        <span>{rows.length} tracked</span>
      </div>
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
