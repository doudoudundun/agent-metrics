import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SessionTimelinePanel } from "./SessionTimelinePanel";

describe("SessionTimelinePanel", () => {
  it("renders token usage, model metadata, timestamps, and paginates long session timelines", () => {
    render(
      <SessionTimelinePanel
        detail={{
          sessionId: "ses_1",
          workspacePath: "D:/projects/dev/agent-metrics",
          sourceVendor: "claude-code",
          sourceAdapter: "claude-transcript",
          context: {
            executionPath: "D:/projects/dev/agent-metrics/.claude/tmp",
            skillsLoaded: true,
            skillNames: ["commit-analyzer"]
          },
          timeline: [
            {
              createdAt: "2026-05-25T08:00:00.000Z",
              type: "session.started",
              toolName: "",
              status: "started",
              durationMs: 0,
              filesChanged: [],
              insertions: 0,
              deletions: 0,
              promptId: null,
              promptChars: null,
              messageId: null,
              model: null,
              stopReason: null,
              responseChars: null,
              inputTokens: null,
              outputTokens: null,
              cacheReadTokens: null,
              cacheCreationTokens: null,
              totalTokens: null,
              usageSource: null
            },
            {
              createdAt: "2026-05-25T08:00:00.500Z",
              type: "prompt.submitted",
              toolName: "",
              status: "submitted",
              durationMs: 0,
              filesChanged: [],
              insertions: 0,
              deletions: 0,
              promptId: "prompt_1",
              promptChars: 19,
              messageId: null,
              model: null,
              stopReason: null,
              responseChars: null,
              inputTokens: null,
              outputTokens: null,
              cacheReadTokens: null,
              cacheCreationTokens: null,
              totalTokens: null,
              usageSource: null
            },
            {
              createdAt: "2026-05-25T08:00:01.000Z",
              type: "tool.succeeded",
              toolName: "Read",
              status: "succeeded",
              durationMs: 14,
              filesChanged: [],
              insertions: 0,
              deletions: 0,
              promptId: null,
              promptChars: null,
              messageId: null,
              model: null,
              stopReason: null,
              responseChars: null,
              inputTokens: null,
              outputTokens: null,
              cacheReadTokens: null,
              cacheCreationTokens: null,
              totalTokens: null,
              usageSource: null
            },
            {
              createdAt: "2026-05-25T08:00:01.500Z",
              type: "assistant.responded",
              toolName: "",
              status: "responded",
              durationMs: 0,
              filesChanged: [],
              insertions: 0,
              deletions: 0,
              promptId: null,
              promptChars: null,
              messageId: "msg_1",
              model: "gpt-5-codex",
              stopReason: "end_turn",
              responseChars: 42,
              inputTokens: null,
              outputTokens: null,
              cacheReadTokens: null,
              cacheCreationTokens: null,
              totalTokens: null,
              usageSource: null
            },
            {
              createdAt: "2026-05-25T08:00:01.750Z",
              type: "token.usage.recorded",
              toolName: "",
              status: "recorded",
              durationMs: 0,
              filesChanged: [],
              insertions: 0,
              deletions: 0,
              promptId: null,
              promptChars: null,
              messageId: "msg_1",
              model: "unknown",
              stopReason: null,
              responseChars: null,
              inputTokens: 120,
              outputTokens: 34,
              cacheReadTokens: 8,
              cacheCreationTokens: 12,
              totalTokens: 174,
              usageSource: "claude-transcript"
            },
            {
              createdAt: "2026-05-25T08:00:02.000Z",
              type: "code.edit.applied",
              toolName: "Edit",
              status: "applied",
              durationMs: 0,
              filesChanged: ["src/app.ts"],
              insertions: 3,
              deletions: 1,
              promptId: null,
              promptChars: null,
              messageId: null,
              model: null,
              stopReason: null,
              responseChars: null,
              inputTokens: null,
              outputTokens: null,
              cacheReadTokens: null,
              cacheCreationTokens: null,
              totalTokens: null,
              usageSource: null
            },
            {
              createdAt: "2026-05-25T08:00:03.000Z",
              type: "session.ended",
              toolName: "",
              status: "ended",
              durationMs: 0,
              filesChanged: [],
              insertions: 0,
              deletions: 0,
              promptId: null,
              promptChars: null,
              messageId: null,
              model: null,
              stopReason: null,
              responseChars: null,
              inputTokens: null,
              outputTokens: null,
              cacheReadTokens: null,
              cacheCreationTokens: null,
              totalTokens: null,
              usageSource: null
            },
            ...Array.from({ length: 5 }, (_, index) => ({
              createdAt: `2026-05-25T08:00:0${index + 4}.000Z`,
              type: `tool.event.${index}`,
              toolName: `Tool ${index}`,
              status: "succeeded",
              durationMs: index,
              filesChanged: [],
              insertions: 0,
              deletions: 0,
              promptId: null,
              promptChars: null,
              messageId: null,
              model: null,
              stopReason: null,
              responseChars: null,
              inputTokens: null,
              outputTokens: null,
              cacheReadTokens: null,
              cacheCreationTokens: null,
              totalTokens: null,
              usageSource: null
            }))
          ]
        }}
      />
    );

    const assistantRow = screen.getByText("Assistant msg_1").closest("article");
    const tokenRow = screen.getByText("Token usage msg_1").closest("article");

    expect(assistantRow).not.toBeNull();
    expect(tokenRow).not.toBeNull();
    expect(within(assistantRow!).getByText("2026-05-25 08:00:01")).toBeInTheDocument();
    expect(within(assistantRow!).getByText("gpt-5-codex")).toBeInTheDocument();
    expect(within(tokenRow!).getByText("174 total")).toBeInTheDocument();
    expect(within(tokenRow!).getByText("in 120 / out 34 / cache 20")).toBeInTheDocument();
    expect(screen.getByText("1-8 of 12")).toBeInTheDocument();
    expect(screen.queryByText("tool.event.4")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Next Page" }));

    expect(screen.getByText("Tool 4")).toBeInTheDocument();
    expect(screen.queryByText("174 total")).not.toBeInTheDocument();
    expect(screen.getByText("9-12 of 12")).toBeInTheDocument();
  });
});
