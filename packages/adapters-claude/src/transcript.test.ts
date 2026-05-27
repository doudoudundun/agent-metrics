import { describe, expect, it } from "vitest";
import { AnyEventSchema } from "@agent-metrics/event-schema";
import {
  extractClaudeTranscriptObservations,
  normalizeClaudeTranscriptObservation
} from "./transcript.js";

describe("extractClaudeTranscriptObservations", () => {
  it("maps a user transcript row into one prompt observation", () => {
    const observations = extractClaudeTranscriptObservations({
      type: "user",
      sessionId: "ses_1",
      cwd: "D:/projects/dev/agent-metrics",
      promptId: "prompt_1",
      timestamp: "2026-05-27T10:00:00.000Z",
      message: {
        role: "user",
        content: "Explain why this build failed"
      }
    });

    expect(observations).toEqual([
      {
        kind: "prompt_submitted",
        sessionId: "ses_1",
        workspacePath: "D:/projects/dev/agent-metrics",
        timestamp: "2026-05-27T10:00:00.000Z",
        promptId: "prompt_1",
        promptChars: 29
      }
    ]);
  });

  it("emits assistant response and usage observations for a terminal assistant row", () => {
    const observations = extractClaudeTranscriptObservations({
      type: "assistant",
      sessionId: "ses_1",
      cwd: "D:/projects/dev/agent-metrics",
      timestamp: "2026-05-27T10:00:10.000Z",
      message: {
        id: "msg_1",
        role: "assistant",
        model: "sonnet-test",
        stop_reason: "end_turn",
        content: [
          { type: "text", text: "Here is" },
          { type: "text", text: "the fix." }
        ],
        usage: {
          input_tokens: 120,
          output_tokens: 48,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 16,
          server_tool_use: { web_search_requests: 0 }
        }
      }
    });

    expect(observations).toEqual([
      {
        kind: "assistant_responded",
        sessionId: "ses_1",
        workspacePath: "D:/projects/dev/agent-metrics",
        timestamp: "2026-05-27T10:00:10.000Z",
        messageId: "msg_1",
        model: "sonnet-test",
        stopReason: "end_turn",
        responseChars: 16
      },
      {
        kind: "token_usage_recorded",
        sessionId: "ses_1",
        workspacePath: "D:/projects/dev/agent-metrics",
        timestamp: "2026-05-27T10:00:10.000Z",
        messageId: "msg_1",
        model: "sonnet-test",
        inputTokens: 120,
        outputTokens: 48,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 16,
        serverToolUse: "{\"web_search_requests\":0}"
      }
    ]);
  });

  it("does not emit assistant.responded for intermediate tool_use assistant rows", () => {
    const observations = extractClaudeTranscriptObservations({
      type: "assistant",
      sessionId: "ses_1",
      cwd: "D:/projects/dev/agent-metrics",
      timestamp: "2026-05-27T10:00:10.000Z",
      message: {
        id: "msg_1",
        role: "assistant",
        model: "sonnet-test",
        stop_reason: "tool_use",
        content: [{ type: "text", text: "Need to call a tool." }],
        usage: {
          input_tokens: 120,
          output_tokens: 48,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 16,
          server_tool_use: { web_search_requests: 0 }
        }
      }
    });

    expect(observations).toEqual([
      {
        kind: "token_usage_recorded",
        sessionId: "ses_1",
        workspacePath: "D:/projects/dev/agent-metrics",
        timestamp: "2026-05-27T10:00:10.000Z",
        messageId: "msg_1",
        model: "sonnet-test",
        inputTokens: 120,
        outputTokens: 48,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 16,
        serverToolUse: "{\"web_search_requests\":0}"
      }
    ]);
  });

  it("does not emit assistant observations when only a transcript row id exists", () => {
    const observations = extractClaudeTranscriptObservations({
      type: "assistant",
      id: "row_1",
      sessionId: "ses_1",
      cwd: "D:/projects/dev/agent-metrics",
      timestamp: "2026-05-27T10:00:10.000Z",
      message: {
        role: "assistant",
        model: "sonnet-test",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Here is the fix." }],
        usage: {
          input_tokens: 120,
          output_tokens: 48,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 16,
          server_tool_use: { web_search_requests: 0 }
        }
      }
    });

    expect(observations).toEqual([]);
  });

  it("does not emit prompt observations without a stable prompt identity", () => {
    const observations = extractClaudeTranscriptObservations({
      type: "user",
      sessionId: "ses_1",
      cwd: "D:/projects/dev/agent-metrics",
      timestamp: "2026-05-27T10:00:00.000Z",
      message: {
        id: "message_1",
        role: "user",
        content: "Explain why this build failed"
      }
    });

    expect(observations).toEqual([]);
  });

  it("uses transcript user uuid as the prompt id fallback", () => {
    const observations = extractClaudeTranscriptObservations({
      type: "user",
      uuid: "user_row_1",
      sessionId: "ses_1",
      cwd: "D:/projects/dev/agent-metrics",
      timestamp: "2026-05-27T10:00:00.000Z",
      message: {
        role: "user",
        content: [{ type: "text", text: "Ship it." }]
      }
    });

    expect(observations).toEqual([
      {
        kind: "prompt_submitted",
        sessionId: "ses_1",
        workspacePath: "D:/projects/dev/agent-metrics",
        timestamp: "2026-05-27T10:00:00.000Z",
        promptId: "user_row_1",
        promptChars: 8
      }
    ]);
  });

  it("supports transcript alias fields and role fallback behavior", () => {
    const promptObservations = extractClaudeTranscriptObservations({
      session_id: "ses_1",
      workspace_path: "D:/projects/dev/agent-metrics",
      prompt_id: "prompt_1",
      timestamp: "2026-05-27T10:00:00.000Z",
      message: {
        role: "user",
        content: "Ship it."
      }
    });

    const assistantObservations = extractClaudeTranscriptObservations({
      session_id: "ses_1",
      workspace_path: "D:/projects/dev/agent-metrics",
      timestamp: "2026-05-27T10:00:10.000Z",
      message_id: "msg_1",
      message: {
        model: "sonnet-test",
        role: "assistant",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Done." }]
      }
    });

    expect(promptObservations).toEqual([
      {
        kind: "prompt_submitted",
        sessionId: "ses_1",
        workspacePath: "D:/projects/dev/agent-metrics",
        timestamp: "2026-05-27T10:00:00.000Z",
        promptId: "prompt_1",
        promptChars: 8
      }
    ]);

    expect(assistantObservations).toEqual([
      {
        kind: "assistant_responded",
        sessionId: "ses_1",
        workspacePath: "D:/projects/dev/agent-metrics",
        timestamp: "2026-05-27T10:00:10.000Z",
        messageId: "msg_1",
        model: "sonnet-test",
        stopReason: "end_turn",
        responseChars: 5
      }
    ]);
  });

  it("drops malformed rows instead of inventing session, workspace, or current timestamps", () => {
    expect(
      extractClaudeTranscriptObservations({
        type: "user",
        promptId: "prompt_1",
        message: {
          role: "user",
          content: "Explain why this build failed"
        }
      })
    ).toEqual([]);

    expect(
      extractClaudeTranscriptObservations({
        type: "assistant",
        sessionId: "ses_1",
        cwd: "D:/projects/dev/agent-metrics",
        timestamp: "not-a-timestamp",
        message: {
          id: "msg_1",
          role: "assistant",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "Done." }]
        }
      })
    ).toEqual([]);
  });

  it("drops malformed usage observations instead of inventing zero token counts", () => {
    const observations = extractClaudeTranscriptObservations({
      type: "assistant",
      sessionId: "ses_1",
      cwd: "D:/projects/dev/agent-metrics",
      timestamp: "2026-05-27T10:00:10.000Z",
      message: {
        id: "msg_1",
        role: "assistant",
        model: "sonnet-test",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Done." }],
        usage: {
          input_tokens: "120",
          output_tokens: 48,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 16,
          server_tool_use: { web_search_requests: 0 }
        }
      }
    });

    expect(observations).toEqual([
      {
        kind: "assistant_responded",
        sessionId: "ses_1",
        workspacePath: "D:/projects/dev/agent-metrics",
        timestamp: "2026-05-27T10:00:10.000Z",
        messageId: "msg_1",
        model: "sonnet-test",
        stopReason: "end_turn",
        responseChars: 5
      }
    ]);
  });

  it("normalizes transcript observations into AnyEvent-compatible payloads", () => {
    const [promptObservation] = extractClaudeTranscriptObservations({
      type: "user",
      sessionId: "ses_1",
      cwd: "D:/projects/dev/agent-metrics",
      promptId: "prompt_1",
      timestamp: "2026-05-27T10:00:00.000Z",
      message: {
        role: "user",
        content: [{ type: "text", text: "Ship it." }]
      }
    });

    const [, usageObservation] = extractClaudeTranscriptObservations({
      type: "assistant",
      sessionId: "ses_1",
      cwd: "D:/projects/dev/agent-metrics",
      timestamp: "2026-05-27T10:00:10.000Z",
      message: {
        id: "msg_1",
        role: "assistant",
        model: "sonnet-test",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Done." }],
        usage: {
          input_tokens: 12,
          output_tokens: 5,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 1,
          server_tool_use: { web_search_requests: 0 }
        }
      }
    });

    const promptEvent = normalizeClaudeTranscriptObservation(promptObservation);
    const usageEvent = normalizeClaudeTranscriptObservation(usageObservation);

    expect(AnyEventSchema.safeParse(promptEvent).success).toBe(true);
    expect(promptEvent).toMatchObject({
      type: "prompt.submitted",
      prompt_id: "prompt_1",
      prompt_chars: 8
    });
    expect(AnyEventSchema.safeParse(usageEvent).success).toBe(true);
    expect(usageEvent).toMatchObject({
      type: "token.usage.recorded",
      message_id: "msg_1",
      model: "sonnet-test",
      server_tool_use: "{\"web_search_requests\":0}",
      usage_source: "claude-transcript"
    });
  });
});
