export type SessionKey = {
  sourceInstanceId: string;
  sessionId: string;
};

type SessionTableRow = SessionKey & {
  workspacePath: string;
  turnCount: number;
  totalTokens: number;
  lastModel: string | null;
};

type RecentSessionsTableProps = {
  errorMessage?: string | null;
  loading?: boolean;
  rows: SessionTableRow[];
  selectedSession: SessionKey | null;
  onSelect: (session: SessionKey) => void;
};

const NUMBER_FORMAT = new Intl.NumberFormat("en-US");

export function sessionIdentity(row: SessionKey): string {
  return `${row.sourceInstanceId}:${row.sessionId}`;
}

export function RecentSessionsTable({
  errorMessage,
  loading = false,
  rows,
  selectedSession,
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
                <tr
                  data-selected={
                    selectedSession !== null && sessionIdentity(row) === sessionIdentity(selectedSession)
                  }
                  key={sessionIdentity(row)}
                >
                  <td>
                    <button
                      className="session-select"
                      onClick={() => onSelect({ sourceInstanceId: row.sourceInstanceId, sessionId: row.sessionId })}
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
