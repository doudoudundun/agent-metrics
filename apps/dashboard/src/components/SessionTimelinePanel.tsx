import { useEffect, useState } from "react";
import type { SessionDetailResponse, SessionTimelineEntry } from "../api";

const TIMELINE_PAGE_SIZE = 8;
const NUMBER_FORMAT = new Intl.NumberFormat("en-US");

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
          <div className="timeline-context">
            <span>{detail.sourceVendor}</span>
            <span>{detail.sourceAdapter}</span>
            <span>{detail.workspacePath}</span>
            {detail.context?.executionPath ? <span>{detail.context.executionPath}</span> : null}
            {detail.context?.skillsLoaded
              ? <span>skills: {detail.context.skillNames.join(", ") || "loaded"}</span>
              : null}
          </div>
          <div className="timeline-list">
            {visibleTimeline.map((entry, index) => (
              <article className="timeline-row" key={`${entry.type}-${entry.toolName}-${index}`}>
                <div className="timeline-main">
                  <span className="timeline-kind">{buildTimelineKindLabel(entry.type)}</span>
                  <strong>{buildTimelineTitle(entry)}</strong>
                  <span className="timeline-time">{formatTimestamp(entry.createdAt)}</span>
                </div>
                <div className="timeline-meta">
                  {buildTimelineMeta(entry).map((item) => (
                    <span key={`${entry.type}-${item}`}>{item}</span>
                  ))}
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
          {statusMessage ??
            (loading
              ? "Loading session activity..."
              : "Select a session to inspect its hook timeline.")}
        </p>
      )}
    </section>
  );
}

function buildTimelineKindLabel(type: string): string {
  if (type.startsWith("prompt.")) {
    return "Prompt";
  }

  if (type.startsWith("assistant.")) {
    return "Assistant";
  }

  if (type.startsWith("token.")) {
    return "Token";
  }

  if (type.startsWith("tool.")) {
    return "Tool";
  }

  if (type.startsWith("code.edit.")) {
    return "Edit";
  }

  if (type.startsWith("session.")) {
    return "Session";
  }

  return "Event";
}

function buildTimelineTitle(entry: SessionTimelineEntry): string {
  if (entry.type.startsWith("prompt.")) {
    return entry.promptId ? `Prompt ${entry.promptId}` : "Prompt submitted";
  }

  if (entry.type.startsWith("assistant.")) {
    return entry.messageId ? `Assistant ${entry.messageId}` : "Assistant response";
  }

  if (entry.type.startsWith("token.")) {
    return entry.messageId ? `Token usage ${entry.messageId}` : "Token usage";
  }

  if (entry.type.startsWith("tool.")) {
    return entry.toolName || entry.type;
  }

  if (entry.type.startsWith("code.edit.")) {
    return entry.toolName ? `${entry.toolName} applied changes` : "Edit applied";
  }

  if (entry.type === "session.started") {
    return "Session started";
  }

  if (entry.type === "session.ended") {
    return "Session ended";
  }

  return entry.type;
}

function buildTimelineMeta(entry: SessionTimelineEntry): string[] {
  const items = [`type ${entry.type}`];

  if (entry.status) {
    items.push(entry.status);
  }

  if (entry.durationMs > 0) {
    items.push(`${NUMBER_FORMAT.format(entry.durationMs)} ms`);
  }

  if (entry.type.startsWith("prompt.")) {
    if (entry.promptChars !== null) {
      items.push(`${NUMBER_FORMAT.format(entry.promptChars)} chars`);
    }

    return items;
  }

  if (entry.type.startsWith("assistant.")) {
    if (entry.model) {
      items.push(formatModelLabel(entry.model));
    }

    if (entry.responseChars !== null) {
      items.push(`${NUMBER_FORMAT.format(entry.responseChars)} chars`);
    }

    if (entry.stopReason) {
      items.push(entry.stopReason);
    }

    return items;
  }

  if (entry.type.startsWith("token.")) {
    if (entry.model) {
      items.push(formatModelLabel(entry.model));
    }

    if (entry.totalTokens !== null) {
      items.push(`${NUMBER_FORMAT.format(entry.totalTokens)} total`);
    }

    if (
      entry.inputTokens !== null &&
      entry.outputTokens !== null &&
      entry.cacheReadTokens !== null &&
      entry.cacheCreationTokens !== null
    ) {
      items.push(
        `in ${NUMBER_FORMAT.format(entry.inputTokens)} / out ${NUMBER_FORMAT.format(entry.outputTokens)} / cache ${NUMBER_FORMAT.format(entry.cacheReadTokens + entry.cacheCreationTokens)}`
      );
    }

    if (entry.usageSource) {
      items.push(entry.usageSource);
    }

    return items;
  }

  if (entry.type.startsWith("code.edit.")) {
    if (entry.filesChanged.length > 0) {
      items.push(entry.filesChanged.join(", "));
    }

    if (entry.insertions > 0 || entry.deletions > 0) {
      items.push(`+${entry.insertions} / -${entry.deletions}`);
    }

    return items;
  }

  return items;
}

function formatTimestamp(value: string): string {
  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toISOString().slice(0, 19).replace("T", " ");
}

function formatModelLabel(model: string): string {
  if (model.trim().length === 0 || model.trim().toLowerCase() === "unknown") {
    return "Unknown model";
  }

  return model;
}
