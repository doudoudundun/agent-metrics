import type { SessionRow } from "../api";

type RecentSessionsTableProps = {
  errorMessage?: string | null;
  loading?: boolean;
  rows: SessionRow[];
  selectedSessionId: string | null;
  onSelect: (sessionId: string) => void;
};

const NUMBER_FORMAT = new Intl.NumberFormat("en-US");

export function RecentSessionsTable({
  errorMessage,
  loading = false,
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
      {rows.length > 0 ? (
        <div className="table-shell">
          <table>
            <thead>
              <tr>
                <th>Session</th>
                <th>Workspace</th>
                <th>Turns</th>
                <th>Tokens</th>
                <th>Model</th>
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
                  <td>{NUMBER_FORMAT.format(row.turnCount)}</td>
                  <td>{NUMBER_FORMAT.format(row.totalTokens)}</td>
                  <td>{row.lastModel ?? "unknown"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="panel-empty">
          {loading ? "Loading recent sessions..." : errorMessage ? `Recent sessions unavailable: ${errorMessage}` : "No recent sessions in this scope."}
        </p>
      )}
    </section>
  );
}
