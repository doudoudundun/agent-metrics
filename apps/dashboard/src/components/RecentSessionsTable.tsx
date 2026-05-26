import type { SessionRow } from "../api";

type RecentSessionsTableProps = {
  rows: SessionRow[];
  selectedSessionId: string | null;
  onSelect: (sessionId: string) => void;
};

export function RecentSessionsTable({
  rows,
  selectedSessionId,
  onSelect
}: RecentSessionsTableProps) {
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
              <tr data-selected={row.sessionId === selectedSessionId} key={row.sessionId}>
                <td>
                  <button
                    className="session-select"
                    onClick={() => onSelect(row.sessionId)}
                    type="button"
                  >
                    {row.sessionId}
                  </button>
                </td>
                <td className="workspace-cell">{row.workspacePath}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
