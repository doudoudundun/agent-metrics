import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { SessionDetailResponse, SessionTimelineEntry } from "@agent-metrics/contracts";
import { SessionTimelinePanel } from "./SessionTimelinePanel";

function entry(
  partial: Pick<SessionTimelineEntry, "createdAt" | "type"> & Partial<SessionTimelineEntry>
): SessionTimelineEntry {
  return {
    eventId: partial.eventId ?? `evt-${partial.createdAt}`,
    createdAt: partial.createdAt,
    type: partial.type,
    sourceVendor: "claude-code",
    sourceAdapters: ["claude-transcript"],
    toolCallId: null,
    toolName: partial.toolName ?? null,
    status: partial.status ?? null,
    durationMs: partial.durationMs ?? null,
    providerId: null,
    providerHost: null,
    filesChanged: partial.filesChanged ?? [],
    insertions: partial.insertions ?? null,
    deletions: partial.deletions ?? null,
    promptId: partial.promptId ?? null,
    promptChars: partial.promptChars ?? null,
    messageId: partial.messageId ?? null,
    model: partial.model ?? null,
    stopReason: partial.stopReason ?? null,
    responseChars: partial.responseChars ?? null,
    inputTokens: partial.inputTokens ?? null,
    outputTokens: partial.outputTokens ?? null,
    cacheReadTokens: partial.cacheReadTokens ?? null,
    cacheCreationTokens: partial.cacheCreationTokens ?? null,
    totalTokens: partial.totalTokens ?? null,
    usageSource: partial.usageSource ?? null
  };
}

const detail: SessionDetailResponse = {
  mode: "calendar",
  range: "day",
  timezone: "Asia/Shanghai",
  windowStart: "2026-05-24T16:00:00.000Z",
  windowEnd: "2026-05-25T16:00:00.000Z",
  updatedAt: "2026-05-25T08:00:03.000Z",
  sourceInstanceId: "claude:default",
  sessionId: "ses_1",
  workspacePath: "D:/projects/dev/agent-metrics",
  sourceVendor: "claude-code",
  sourceAdapters: ["claude-transcript"],
  context: {
    executionPath: "D:/projects/dev/agent-metrics/.claude/tmp",
    skillsLoaded: true,
    skillNames: ["commit-analyzer"]
  },
  timeline: {
    rows: [
      entry({ createdAt: "2026-05-25T08:00:00.000Z", type: "session.started", status: "started" }),
      entry({
        createdAt: "2026-05-25T08:00:00.500Z",
        type: "prompt.submitted",
        status: "submitted",
        promptId: "prompt_1",
        promptChars: 19
      }),
      entry({
        createdAt: "2026-05-25T08:00:01.000Z",
        type: "tool.succeeded",
        toolName: "Read",
        status: "succeeded",
        durationMs: 14
      }),
      entry({
        createdAt: "2026-05-25T08:00:01.500Z",
        type: "assistant.responded",
        status: "responded",
        messageId: "msg_1",
        model: "gpt-5-codex",
        stopReason: "end_turn",
        responseChars: 42
      }),
      entry({
        createdAt: "2026-05-25T08:00:01.750Z",
        type: "token.usage.recorded",
        status: "recorded",
        messageId: "msg_1",
        model: "unknown",
        inputTokens: 120,
        outputTokens: 34,
        cacheReadTokens: 8,
        cacheCreationTokens: 12,
        totalTokens: 174,
        usageSource: "claude-transcript"
      }),
      entry({
        createdAt: "2026-05-25T08:00:02.000Z",
        type: "code.edit.applied",
        toolName: "Edit",
        status: "applied",
        filesChanged: ["src/app.ts"],
        insertions: 3,
        deletions: 1
      }),
      entry({ createdAt: "2026-05-25T08:00:03.000Z", type: "session.ended", status: "ended" }),
      ...Array.from({ length: 5 }, (_, index) =>
        entry({
          createdAt: `2026-05-25T08:00:0${index + 4}.000Z`,
          type: "tool.succeeded",
          toolName: `Tool ${index}`,
          status: "succeeded",
          durationMs: index
        })
      )
    ],
    nextCursor: null
  }
};

describe("SessionTimelinePanel", () => {
  it("renders token usage, model metadata, timestamps, and paginates long session timelines", () => {
    render(<SessionTimelinePanel detail={detail} />);

    const assistantRow = screen.getByText("Assistant msg_1").closest("article");
    const tokenRow = screen.getByText("Token usage msg_1").closest("article");

    expect(assistantRow).not.toBeNull();
    expect(tokenRow).not.toBeNull();
    expect(within(assistantRow!).getByText("2026-05-25 08:00:01")).toBeInTheDocument();
    expect(within(assistantRow!).getByText("gpt-5-codex")).toBeInTheDocument();
    expect(within(tokenRow!).getByText("174 total")).toBeInTheDocument();
    expect(within(tokenRow!).getByText("in 120 / out 34 / cache 20")).toBeInTheDocument();
    expect(screen.getByText("1-8 of 12")).toBeInTheDocument();
    expect(screen.queryByText("Tool 4")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Next Page" }));

    expect(screen.getByText("Tool 4")).toBeInTheDocument();
    expect(screen.queryByText("174 total")).not.toBeInTheDocument();
    expect(screen.getByText("9-12 of 12")).toBeInTheDocument();
  });
});
