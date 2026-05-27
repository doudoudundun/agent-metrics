import { useEffect, useState } from "react";
import type { SessionDetailResponse } from "../api";

const TIMELINE_PAGE_SIZE = 8;

export function SessionTimelinePanel(input: {
  detail: SessionDetailResponse | null;
  loading?: boolean;
  statusMessage?: string | null;
}) {
  const detail = input.detail;
  const loading = input.loading ?? false;
  const statusMessage = input.statusMessage;
  const [pageIndex, setPageIndex] = useState(0);
  const pageCount = detail ? Math.max(1, Math.ceil(detail.timeline.length / TIMELINE_PAGE_SIZE)) : 1;
  const safePageIndex = Math.min(pageIndex, pageCount - 1);
  const visibleTimeline = detail
    ? detail.timeline.slice(
      safePageIndex * TIMELINE_PAGE_SIZE,
      (safePageIndex + 1) * TIMELINE_PAGE_SIZE
    )
    : [];
  const pageStart = detail ? safePageIndex * TIMELINE_PAGE_SIZE + 1 : 0;
  const pageEnd = detail
    ? Math.min((safePageIndex + 1) * TIMELINE_PAGE_SIZE, detail.timeline.length)
    : 0;

  useEffect(() => {
    setPageIndex(0);
  }, [detail?.sessionId, detail?.timeline.length]);

  return (
    <section className="panel timeline-panel">
      <div className="panel-heading">
        <h2>Session Timeline</h2>
        <span>{detail ? `${detail.timeline.length} events` : "No session selected"}</span>
      </div>
      {detail ? (
        <>
          <div className="timeline-list">
            {visibleTimeline.map((entry, index) => (
            <article className="timeline-row" key={`${entry.type}-${entry.toolName}-${index}`}>
              <div className="timeline-main">
                <strong>{entry.type}</strong>
                <span>{entry.toolName || "Session"}</span>
              </div>
              <div className="timeline-meta">
                <span>{entry.status}</span>
                <span>{entry.durationMs} ms</span>
                {entry.filesChanged.length > 0 ? (
                  <span>{entry.filesChanged.join(", ")}</span>
                ) : null}
                {entry.insertions > 0 || entry.deletions > 0 ? (
                  <span>
                    +{entry.insertions} / -{entry.deletions}
                  </span>
                ) : null}
              </div>
            </article>
            ))}
          </div>
          {detail.timeline.length > TIMELINE_PAGE_SIZE ? (
            <div className="timeline-pagination">
              <span>
                {pageStart}-{pageEnd} of {detail.timeline.length}
              </span>
              <div className="timeline-pagination-actions">
                <button
                  disabled={safePageIndex === 0}
                  onClick={() => setPageIndex((current) => Math.max(0, current - 1))}
                  type="button"
                >
                  Previous Page
                </button>
                <button
                  disabled={safePageIndex >= pageCount - 1}
                  onClick={() => setPageIndex((current) => Math.min(pageCount - 1, current + 1))}
                  type="button"
                >
                  Next Page
                </button>
              </div>
            </div>
          ) : null}
        </>
      ) : (
        <p className="timeline-empty">
          {statusMessage ?? (loading ? "Loading session activity..." : "Select a session to inspect its hook timeline.")}
        </p>
      )}
    </section>
  );
}
