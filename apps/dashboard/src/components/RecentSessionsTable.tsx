import type { SessionRow } from "../api";

type RecentSessionsTableProps = {
  rows: SessionRow[];
};

export function RecentSessionsTable({ rows }: RecentSessionsTableProps) {
  return (
    <section className="panel table-panel">
      <div className="panel-heading">
        <h2>Recent Sessions</h2>
        <span>{rows.length} recent</span>
      </div>
      <div className="table-shell">
        <table>
          <thead>
            <tr>
              <th>Session</th>
              <th>Workspace</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.sessionId}>
                <td>{row.sessionId}</td>
                <td className="workspace-cell">{row.workspacePath}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
