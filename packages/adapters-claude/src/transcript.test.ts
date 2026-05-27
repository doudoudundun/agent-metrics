import { describe, expect, it } from "vitest";
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
      expect.objectContaining({
        kind: "prompt_submitted",
        sessionId: "ses_1",
        promptId: "prompt_1",
        promptChars: 29
      })
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

    expect(observations.map((entry) => entry.kind)).toEqual([
      "assistant_responded",
      "token_usage_recorded"
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

    expect(promptEvent.type).toBe("prompt.submitted");
    expect(usageEvent).toMatchObject({
      type: "token.usage.recorded",
      message_id: "msg_1",
      model: "sonnet-test",
      server_tool_use: "{\"web_search_requests\":0}",
      usage_source: "claude-transcript"
    });
  });
});
